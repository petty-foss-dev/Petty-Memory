import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import Vision

/// An image the user chose, copied into a temporary folder this app owns until it's uploaded or discarded.
struct CapturedImage: Equatable {
    let url: URL
    let mimeType: String
    let preview: UIImage

    var filename: String { url.lastPathComponent }
    var folder: URL { url.deletingLastPathComponent() }

    static func newFolder() throws -> URL {
        let folder = URL.temporaryDirectory.appending(path: "Capture/\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    /// Checks the copy is an image ImageIO can read; an unreadable one is removed.
    static func open(_ url: URL) throws -> CapturedImage {
        let bytes = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard bytes <= TextRecognition.maxBytes else {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            throw TextRecognition.Failure.tooLarge
        }
        let type = UTType(filenameExtension: url.pathExtension)
        guard type?.conforms(to: .image) == true, let preview = TextRecognition.upright(url, maxPixel: 900) else {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            throw TextRecognition.Failure.unsupported
        }
        return CapturedImage(url: url, mimeType: type?.preferredMIMEType ?? "image/jpeg", preview: UIImage(cgImage: preview))
    }

    /// Files from the Files app stay where they are; only a copy is read, inside the security scope.
    static func importing(_ source: URL) throws -> CapturedImage {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let bytes = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard bytes <= TextRecognition.maxBytes else { throw TextRecognition.Failure.tooLarge }
        let destination = try newFolder().appending(path: source.lastPathComponent)
        try FileManager.default.copyItem(at: source, to: destination)
        return try open(destination)
    }

    static func photo(_ image: UIImage) throws -> CapturedImage {
        guard let data = image.jpegData(compressionQuality: 0.9) else { throw TextRecognition.Failure.unsupported }
        let destination = try newFolder().appending(path: "Photo.jpg")
        try data.write(to: destination)
        return try open(destination)
    }
}

/// On-device text recognition with Vision. Nothing is sent anywhere.
nonisolated enum TextRecognition {
    nonisolated enum Failure: LocalizedError {
        case unsupported
        case tooLarge

        var errorDescription: String? {
            switch self {
            case .unsupported: "Petty Memory can't read this file as an image. Choose a photo, screenshot or scan (JPEG, PNG, HEIC)."
            case .tooLarge: "Choose an image smaller than 20 MB. Crop it or export a smaller copy first."
            }
        }
    }

    /// Big enough for small print without decoding a 48-megapixel photo at full size.
    static let recognitionPixels = 4096
    static let maxBytes = 20 * 1024 * 1024

    /// Downsampled with its EXIF orientation applied, so the pixels are upright.
    static func upright(_ url: URL, maxPixel: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// Runs off the main actor; an empty string means no text was found.
    @concurrent static func recognize(_ url: URL) async throws -> String {
        guard let image = upright(url, maxPixel: recognitionPixels) else { throw Failure.unsupported }
        try Task.checkCancellation()
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.automaticallyDetectsLanguage = true
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
        try Task.checkCancellation()
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}

/// A Photos selection received as a file, so the image is never held whole in memory.
nonisolated struct PickedImage: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            let bytes = try received.file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard bytes <= TextRecognition.maxBytes else { throw TextRecognition.Failure.tooLarge }
            let folder = URL.temporaryDirectory.appending(path: "Capture/\(UUID().uuidString)", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let destination = folder.appending(path: received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: destination)
            return PickedImage(url: destination)
        }
    }
}

struct CameraPicker: UIViewControllerRepresentable {
    let onCapture: (UIImage?) -> Void

    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCapture: onCapture) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCapture: (UIImage?) -> Void

        init(onCapture: @escaping (UIImage?) -> Void) { self.onCapture = onCapture }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onCapture(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onCapture(nil) }
    }
}

/// Choose an image, extract its text on this iPhone when asked, and edit it before it's saved with the original.
struct ImageCaptureFields: View {
    @Binding var image: CapturedImage?
    @Binding var text: String
    @Binding var processing: Bool

    @Environment(\.hearth) private var hearth

    @State private var photo: PhotosPickerItem?
    @State private var importing = false
    @State private var usingCamera = false
    @State private var loadingID: UUID?
    /// The current extraction; a cancelled one may still finish in Vision, and its result is ignored.
    @State private var recognizing: UUID?
    @State private var recognition: Task<Void, Never>?
    @State private var photoLoad: Task<Void, Never>?
    @State private var notice: String?

    private var loading: Bool { loadingID != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.md) {
            if let image {
                chosen(image)
            } else {
                Text("Choose a photo, screenshot or scan. Text is read on this iPhone only when you tap Extract text, and the original image is saved with your note.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
            }
            sources
            if loading { ProgressView().frame(maxWidth: .infinity) }
            if let notice {
                Text(notice)
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textSecondary)
                    .accessibilityIdentifier("ImageTextNotice")
            }
            if image != nil {
                TextField("Recognized text appears here. Edit it before saving.", text: $text, axis: .vertical)
                    .lineLimit(6...20)
                    .hearthField()
                    .disabled(recognizing != nil)
                    .accessibilityIdentifier("ImageTextDraft")
            }
        }
        .onChange(of: photo) { _, item in
            guard let item else { return }
            photo = nil
            photoLoad?.cancel()
            loadingID = nil
            photoLoad = Task { await load(item) }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image]) { result in
            switch result {
            case .success(let url): replace { try CapturedImage.importing(url) }
            case .failure(let error): notice = error.localizedDescription
            }
        }
        .fullScreenCover(isPresented: $usingCamera) {
            CameraPicker { shot in
                usingCamera = false
                if let shot { replace { try CapturedImage.photo(shot) } }
            }
            .ignoresSafeArea()
        }
        .onDisappear {
            recognition?.cancel()
            photoLoad?.cancel()
            recognizing = nil
            loadingID = nil
            processing = false
        }
    }

    private func chosen(_ image: CapturedImage) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Image(uiImage: image.preview)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 240)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: HearthRadius.inner, style: .continuous))
                    .accessibilityLabel("Chosen image")
                Text(image.filename).font(HearthFont.caption).foregroundStyle(hearth.textTertiary).lineLimit(1)
                if recognizing != nil {
                    HStack {
                        Label { Text("Reading text on this iPhone…") } icon: { ProgressView() }
                            .font(HearthFont.footnote)
                        Spacer()
                        Button("Cancel") { stopRecognition() }.font(HearthFont.subheadline)
                    }
                } else {
                    Button("Extract text", systemImage: "text.viewfinder", action: extract)
                        .buttonStyle(.hearthSecondary)
                        .accessibilityIdentifier("ImageExtractText")
                }
            }
        }
    }

    private var sources: some View {
        let photoTitle = image == nil ? "Photos" : "Another photo"
        return FlowLayout(spacing: HearthSpacing.sm) {
            PhotosPicker(selection: $photo, matching: .images) {
                Label(photoTitle, systemImage: "photo.on.rectangle")
                    .font(HearthFont.subheadline)
            }
            .accessibilityIdentifier("ImageFromPhotos")
            Button { importing = true } label: {
                Label("Files", systemImage: "folder").font(HearthFont.subheadline)
            }
            .accessibilityIdentifier("ImageFromFiles")
            if CameraPicker.isAvailable {
                Button { usingCamera = true } label: {
                    Label("Camera", systemImage: "camera").font(HearthFont.subheadline)
                }
            }
        }
        .disabled(loading || recognizing != nil)
    }

    private func load(_ item: PhotosPickerItem) async {
        let run = UUID()
        loadingID = run
        processing = true
        defer { if loadingID == run { loadingID = nil; processing = recognizing != nil } }
        do {
            guard let picked = try await item.loadTransferable(type: PickedImage.self) else { return }
            guard !Task.isCancelled, loadingID == run else {
                try? FileManager.default.removeItem(at: picked.url.deletingLastPathComponent())
                return
            }
            replace { try CapturedImage.open(picked.url) }
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, loadingID == run else { return }
            notice = error.localizedDescription
        }
    }

    /// The previous temporary copy goes; text already in the draft stays.
    private func replace(_ make: () throws -> CapturedImage) {
        do {
            let next = try make()
            if let image { try? FileManager.default.removeItem(at: image.folder) }
            image = next
            notice = nil
        } catch {
            notice = error.localizedDescription
        }
    }

    private func extract() {
        guard let url = image?.url else { return }
        let run = UUID()
        notice = nil
        recognizing = run
        processing = true
        recognition = Task {
            defer { if recognizing == run { recognizing = nil; processing = loading } }
            do {
                let found = try await TextRecognition.recognize(url).trimmingCharacters(in: .whitespacesAndNewlines)
                guard recognizing == run, url == image?.url else { return }
                if found.isEmpty {
                    notice = "No text found in this image. You can type it yourself, or try a sharper, well-lit photo."
                } else {
                    text = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? found : text + "\n\n" + found
                    notice = "Check the text before saving; recognition can misread words."
                }
            } catch is CancellationError {
                return
            } catch {
                notice = error.localizedDescription
            }
        }
    }

    private func stopRecognition() {
        recognition?.cancel()
        recognizing = nil
        processing = loading
        notice = "Stopped. Nothing was added."
    }
}
