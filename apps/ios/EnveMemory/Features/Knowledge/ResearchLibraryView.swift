import EnveMemoryKit
import SwiftUI
import UniformTypeIdentifiers

struct ResearchLibraryView: View {
    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var sources: [ItemDetail] = []
    @State private var next: String?
    @State private var loaded = false
    @State private var loadingMore = false
    @State private var error: String?
    @State private var importing = false
    @State private var recording = false
    @State private var pendingUpload: PendingUpload?

    struct PendingUpload: Identifiable {
        let id = UUID()
        let url: URL
        let mimeType: String
    }

    var body: some View {
        HearthScreen(title: "PDFs and recordings", overline: "Knowledge") {
            KnowledgeNote(text: "Read saved PDFs page by page, quote and annotate exact passages, and turn scanned pages into reviewed text on this iPhone. Recordings play with their timed transcripts. Originals are never changed; quotes, annotations and transcripts are saved as ordinary notes that point back to them.")
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            HStack(spacing: HearthSpacing.sm) {
                Button { importing = true } label: { Label("Import", systemImage: "square.and.arrow.down") }
                    .buttonStyle(.hearthSecondary)
                    .accessibilityIdentifier("ResearchImport")
                Button { recording = true } label: { Label("Record", systemImage: "mic.circle") }
                    .buttonStyle(.hearthSecondary)
                    .accessibilityIdentifier("ResearchRecord")
            }
            Text("Import a PDF up to \(ResearchLimits.pdfPreviewBytes.formatted(.byteCount(style: .file))) or audio up to \(ResearchLimits.audioBytes.formatted(.byteCount(style: .file))). Nothing is saved until you tap Save, and saving works like any file you share to Petty Memory: it waits in the outbox while you're offline.")
                .font(HearthFont.caption)
                .foregroundStyle(hearth.textTertiary)
            if let reason = connection.knowledgeReadReason { OnlineOnlyNote(reason: reason) }
            if sources.isEmpty {
                if loaded, error == nil, connection.knowledgeReadReason == nil {
                    EmptyStateView(symbol: KnowledgeArea.research.symbol, title: "No PDFs or recordings yet",
                                   message: "Import one above, share one to Petty Memory, or save one on your computer.")
                }
            } else {
                RowStack(data: sources) { detail in
                    Button { router.open(.research(ResearchLocation(sourceId: detail.id))) } label: { row(detail) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("ResearchSourceRow")
                }
                if next != nil {
                    Button { Task { await loadMore() } } label: {
                        if loadingMore { ProgressView() } else { Text("Show older") }
                    }
                    .buttonStyle(.hearthSecondary)
                    .disabled(loadingMore)
                    .accessibilityIdentifier("ResearchShowOlder")
                }
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf, .audio]) { result in
            switch result {
            case .success(let url): prepare(url)
            case .failure(let error): router.show(error.localizedDescription)
            }
        }
        .sheet(item: $pendingUpload) { upload in
            ResearchUploadSheet(fileURL: upload.url, mimeType: upload.mimeType, discardsOnClose: true)
                .environment(\.hearth, hearth)
        }
        .sheet(isPresented: $recording) {
            RecordingSheet().environment(\.hearth, hearth)
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private func row(_ detail: ItemDetail) -> some View {
        let file = detail.attachments.first { $0.isPDF || $0.isAudio }
        return HStack(alignment: .top, spacing: HearthSpacing.md) {
            TypeGlyph(symbol: file?.isPDF == true ? "doc.richtext" : "waveform")
            VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                Text(detail.item.displayTitle).font(HearthFont.cardTitle).foregroundStyle(hearth.textPrimary).lineLimit(2)
                Text([file?.isPDF == true ? "PDF" : "Recording", file.map { $0.size.formatted(.byteCount(style: .file)) }, detail.item.project?.name]
                    .compactMap(\.self).joined(separator: " · "))
                    .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, HearthSpacing.sm)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func prepare(_ url: URL) {
        let isPDF = UTType(filenameExtension: url.pathExtension)?.conforms(to: .pdf) == true
        do {
            let copy = try ResearchFiles.importCopy(url, limit: isPDF ? ResearchLimits.pdfPreviewBytes : ResearchLimits.audioBytes,
                                                    kind: isPDF ? "PDF" : "recording")
            pendingUpload = PendingUpload(url: copy, mimeType: isPDF ? "application/pdf" : ResearchFiles.mimeType(for: copy))
        } catch {
            router.show(error.localizedDescription)
        }
    }

    private func load() async {
        guard connection.knowledgeReadReason == nil, let client = connection.privateClient else { loaded = true; return }
        do {
            let page = try await client.send(.researchSources(), as: ResearchSourcesPage.self)
            sources = page.items
            next = page.next
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
        loaded = true
    }

    private func loadMore() async {
        guard let cursor = next, let client = connection.privateClient, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await client.send(.researchSources(before: cursor), as: ResearchSourcesPage.self)
            let known = Set(sources.map(\.id))
            sources += page.items.filter { !known.contains($0.id) }
            next = page.next
        } catch {
            connection.note(error)
            router.show(error.onlineOnlyMessage)
        }
    }
}

struct ResearchUploadSheet: View {
    let fileURL: URL
    let mimeType: String
    /// Imported copies are temporary; a recording's file belongs to its sheet.
    let discardsOnClose: Bool
    var saved: () -> Void = {}

    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var title = ""
    @State private var note = ""
    @State private var project: String?
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(fileURL.lastPathComponent, systemImage: mimeType == "application/pdf" ? "doc.richtext" : "waveform")
                    if let size = try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                        Text(size.formatted(.byteCount(style: .file))).font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                    }
                }
                Section {
                    TextField("Title", text: $title, prompt: Text(fileURL.deletingPathExtension().lastPathComponent))
                        .accessibilityIdentifier("ResearchUploadTitle")
                    ProjectChoice(title: "Project", selection: $project, noneLabel: "Inbox")
                    TextField("Note", text: $note, prompt: Text("Note (optional)"), axis: .vertical)
                        .lineLimit(2...6)
                } footer: {
                    Text("Saved as an ordinary file. Your computer extracts PDF page text after it arrives; recordings can then get timed transcripts.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(hearth.background)
            .navigationTitle("Save file")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Discard", role: .destructive) { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save", action: save)
                        .disabled(saving)
                        .accessibilityIdentifier("ResearchUploadSave")
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(saving)
        .onDisappear {
            // A queued upload has moved its file into the outbox; whatever is left here is a sent or discarded copy.
            if discardsOnClose { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        }
    }

    private func save() {
        saving = true
        let upload = FileUpload(filename: fileURL.lastPathComponent, mimeType: mimeType, title: title.trimmed.isEmpty ? nil : title.trimmed,
                                note: note.trimmed.isEmpty ? nil : note.trimmed, project: project)
        Task {
            defer { saving = false }
            let outcome = await outbox.submit(.upload(upload), kind: .file, title: upload.title ?? upload.filename, file: fileURL)
            if router.report(outcome, sent: mimeType == "application/pdf" ? "PDF saved" : "Recording saved") {
                saved()
                dismiss()
            }
        }
    }
}
