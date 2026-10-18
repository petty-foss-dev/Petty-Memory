import EnveMemoryKit
import SwiftUI

/// Text from an image already in the library, read by the computer. Nothing is saved unless the person saves it as a note.
struct AttachmentTextSheet: View {
    let item: Item
    let attachment: Attachment

    @Environment(Connection.self) private var connection
    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var text = ""
    @State private var engine: String?
    @State private var working = false
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            HearthScreen {
                Label(attachment.filename, systemImage: "photo")
                    .font(HearthFont.subheadline)
                    .lineLimit(1)
                if let reason {
                    OnlineOnlyNote(reason: reason)
                } else if working {
                    Label { Text("Your computer is reading the text…") } icon: { ProgressView() }
                        .font(HearthFont.footnote)
                } else if let engine {
                    if text.isEmpty {
                        Text("No text found in this image. You can type it below if you like.")
                            .font(HearthFont.footnote)
                            .foregroundStyle(hearth.textSecondary)
                    }
                    Text("Read by \(engine) on your computer. Check it before saving; recognition can misread words.")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textTertiary)
                    TextField("Text", text: $text, axis: .vertical)
                        .lineLimit(6...24)
                        .hearthField()
                        .accessibilityIdentifier("AttachmentText")
                    HStack(spacing: HearthSpacing.sm) {
                        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
                            .buttonStyle(.hearthSecondary)
                            .disabled(text.isEmpty)
                        Button(saving ? "Saving…" : "Save as note", systemImage: "note.text.badge.plus", action: save)
                            .buttonStyle(.hearthPrimary)
                            .disabled(saving || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("AttachmentTextSave")
                    }
                    Text("The note links back to “\(item.displayTitle)”. The image itself isn't changed.")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textTertiary)
                }
                if let error { ErrorBanner(message: error) { Task { await extract() } } }
            }
            .navigationTitle("Extract text")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
        .tint(hearth.accent)
        .task { await extract() }
    }

    private var reason: String? {
        guard connection.isOnline else { return "Reading text from a saved image needs a connection to your computer. Nothing is queued." }
        guard connection.scopes.contains("write") else { return "This pairing is read-only. Extracting text needs read and write access." }
        return nil
    }

    private func extract() async {
        guard reason == nil, engine == nil, let client = connection.privateClient else { return }
        working = true
        error = nil
        defer { working = false }
        do {
            let extracted = try await client.send(.extractText(attachmentId: attachment.id), as: ExtractedText.self)
            text = extracted.text.trimmingCharacters(in: .whitespacesAndNewlines)
            engine = extracted.engine
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
    }

    private func save() {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines) + "\n\nFrom " + InlineReference.token(id: item.id, label: item.displayTitle)
        guard let endpoint = try? Endpoint.capture(CaptureRequest(title: "Text from \(item.displayTitle)", note: body, project: item.project?.id)) else { return }
        saving = true
        Task {
            defer { saving = false }
            if router.report(await outbox.submit(endpoint, kind: .note, title: "Text from \(item.displayTitle)"), sent: "Saved as a note") { dismiss() }
        }
    }
}
