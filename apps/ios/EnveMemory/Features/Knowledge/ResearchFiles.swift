import CryptoKit
import EnveMemoryKit
import Foundation
import UniformTypeIdentifiers

struct ResearchScratch {
    let folder: URL

    init() {
        folder = URL.temporaryDirectory.appending(path: "Research/\(UUID().uuidString)", directoryHint: .isDirectory)
    }

    func discard() {
        try? FileManager.default.removeItem(at: folder)
    }
}

nonisolated enum ResearchFiles {
    nonisolated enum Failure: LocalizedError {
        case tooLarge(limit: Int, kind: String)
        case changed
        case unreadable

        var errorDescription: String? {
            switch self {
            case .tooLarge(let limit, let kind):
                "This \(kind) is larger than \(limit.formatted(.byteCount(style: .file))), the most the phone opens for research. Open it on your computer instead."
            case .changed: "The file your computer sent isn't the one this page describes. It may have just been replaced; reload and try again."
            case .unreadable: "This file couldn't be read."
            }
        }
    }

    /// Maps the downloaded original and checks it is the exact attachment the server described.
    @concurrent static func verified(_ url: URL, sha256: String) async throws -> Data {
        let data = try Data(contentsOf: url, options: .alwaysMapped)
        try Task.checkCancellation()
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == sha256 else { throw Failure.changed }
        return data
    }

    /// Copies a file the person picked, inside its security scope, after checking its size. Only the copy is read later.
    static func importCopy(_ source: URL, limit: Int, kind: String) throws -> URL {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let bytes = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard bytes > 0 else { throw Failure.unreadable }
        guard bytes <= limit else { throw Failure.tooLarge(limit: limit, kind: kind) }
        let folder = URL.temporaryDirectory.appending(path: "Capture/\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appending(path: source.lastPathComponent)
        try FileManager.default.copyItem(at: source, to: destination)
        return destination
    }

    /// Reads a caption file the person picked as text, inside its security scope.
    static func captionText(_ source: URL) throws -> String {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let bytes = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard bytes <= ResearchLimits.captionBytes else { throw Failure.tooLarge(limit: ResearchLimits.captionBytes, kind: "caption file") }
        let data = try Data(contentsOf: source)
        guard let text = String(data: data, encoding: .utf8) else { throw Failure.unreadable }
        return text
    }

    static func mimeType(for url: URL) -> String {
        UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }

    static let captionTypes: [UTType] = [UTType(filenameExtension: "vtt"), UTType(filenameExtension: "srt"), .json, .plainText].compactMap(\.self)
}

extension APIClient {
    /// The original, downloaded into the screen's scratch folder under its attachment id and checked against `sha256`.
    func researchOriginal(_ attachment: Attachment, itemID: String, sha256: String, limit: Int, kind: String, into scratch: ResearchScratch) async throws -> (url: URL, data: Data) {
        guard attachment.size <= limit else { throw ResearchFiles.Failure.tooLarge(limit: limit, kind: kind) }
        guard attachment.sha256 == sha256 else { throw ResearchFiles.Failure.changed }
        let url = try await download(attachment, itemID: itemID, into: scratch.folder)
        return (url, try await ResearchFiles.verified(url, sha256: sha256))
    }
}
