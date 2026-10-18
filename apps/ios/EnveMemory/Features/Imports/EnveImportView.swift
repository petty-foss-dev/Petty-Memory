import EnveMemoryKit
import SwiftUI
import UniformTypeIdentifiers

/// Imports book highlights from an Enve export the person chooses. Only that file is read; the computer validates and dedupes.
struct EnveImportView: View {
    @Environment(Connection.self) private var connection
    @Environment(ProjectStore.self) private var projects
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var choosing = false
    @State private var file: String?
    @State private var text: String?
    @State private var preview: EnveImportPreview?
    @State private var projectID: String?
    @State private var working = false
    @State private var result: EnveImportResult?
    @State private var error: String?

    private static let shown = 20
    private static let types: [UTType] = [.json, .plainText, .text] + [UTType("net.daringfireball.markdown")].compactMap(\.self)

    var body: some View {
        HearthScreen(title: "Import highlights", overline: "Enve") {
            Text("Bring in highlights and notes exported from Enve Book Player as JSON or Markdown, up to \(EnveImport.maxBytes.formatted(.byteCount(style: .file))). Each passage becomes a note with its book, author and location. Importing the same export again skips passages you already have. Only the file you choose is read; Petty Memory never opens another app's data.")
                .font(HearthFont.footnote)
                .foregroundStyle(hearth.textSecondary)
            if let reason { OnlineOnlyNote(reason: reason) }
            Button(file == nil ? "Choose an export" : "Choose another export", systemImage: "doc.badge.arrow.up") { choosing = true }
                .buttonStyle(.hearthSecondary)
                .disabled(working || reason != nil)
                .accessibilityIdentifier("EnveImportChoose")
            if let file {
                Label(file, systemImage: "doc.text")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                    .lineLimit(1)
            }
            if working { ProgressView().frame(maxWidth: .infinity) }
            if let error { ErrorBanner(message: error) }
            if let result {
                summary(result)
            } else if let preview {
                review(preview)
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .fileImporter(isPresented: $choosing, allowedContentTypes: Self.types) { outcome in
            switch outcome {
            case .success(let url): read(url)
            case .failure(let failure): error = failure.localizedDescription
            }
        }
    }

    private var reason: String? {
        switch connection.status {
        case .online where !connection.scopes.contains("write"): "This pairing is read-only. Importing needs read and write access."
        case .online: nil
        case .unknown, .checking: "Connecting to your computer…"
        case .offline: "Importing needs a connection to your computer. Nothing is queued."
        case .unauthorized: "This phone's pairing was revoked. Pair again to import."
        }
    }

    @ViewBuilder
    private func review(_ preview: EnveImportPreview) -> some View {
        Overline("Preview")
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(counts(preview)).font(HearthFont.subheadline)
                Text("Read as \(preview.format).").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("EnveImportCounts")
        }
        if preview.entries.isEmpty {
            EmptyStateView(symbol: "books.vertical", title: "Nothing to import",
                           message: "This export has no passages Petty Memory can use. Check that it's an Enve highlights export.")
        } else {
            RowStack(data: Array(preview.entries.prefix(Self.shown))) { HighlightRow(highlight: $0) }
            if preview.entries.count > Self.shown {
                Text("And \(preview.entries.count - Self.shown) more.")
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textTertiary)
            }
            Overline("File them in")
            ProjectPicker(projectID: $projectID, projects: projects.refs)
            Button(working ? "Importing…" : preview.entries.count == 1 ? "Import 1 passage" : "Import \(preview.entries.count) passages", action: runImport)
                .buttonStyle(.hearthPrimary)
                .disabled(working || reason != nil)
                .accessibilityIdentifier("EnveImportRun")
        }
    }

    private func counts(_ preview: EnveImportPreview) -> String {
        let passages = preview.entries.count == 1 ? "1 passage" : "\(preview.entries.count) passages"
        let books = preview.books == 1 ? "1 book" : "\(preview.books) books"
        return preview.skipped > 0 ? "\(passages) from \(books) · \(preview.skipped) skipped" : "\(passages) from \(books)"
    }

    private func summary(_ result: EnveImportResult) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Label(result.created == 1 ? "Imported 1 passage" : "Imported \(result.created) passages", systemImage: "checkmark.circle")
                    .font(HearthFont.headline)
                if result.skipped > 0 {
                    Text("\(result.skipped) skipped because they're already in your library or couldn't be used.")
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                }
                ForEach(Array(result.failed.prefix(10).enumerated()), id: \.offset) { _, failure in
                    Text(verbatim: "\(failure.source): \(failure.error)")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.danger)
                }
                if let projectID, let project = projects.refs.first(where: { $0.id == projectID }) {
                    Button("Open \(project.name)", systemImage: "folder") { router.open(.project(project.id)) }
                        .buttonStyle(.hearthSecondary)
                }
            }
        }
        .accessibilityIdentifier("EnveImportResult")
    }

    /// Reads the chosen file inside its security scope, refusing anything too large before loading it.
    private func read(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        preview = nil
        result = nil
        error = nil
        file = url.lastPathComponent
        do {
            if let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > EnveImport.maxBytes {
                throw EnveImport.Problem.tooLarge(size)
            }
            let contents = try EnveImport.text(from: Data(contentsOf: url))
            text = contents
            Task { await loadPreview(contents) }
        } catch {
            text = nil
            self.error = error.localizedDescription
        }
    }

    private func loadPreview(_ contents: String) async {
        guard let client = connection.privateClient else { return }
        working = true
        defer { working = false }
        do {
            preview = try await client.send(.previewEnveImport(contents), as: EnveImportPreview.self)
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
    }

    private func runImport() {
        guard reason == nil, let text, let client = connection.privateClient else { return }
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                let imported = try await client.send(.importEnveHighlights(text, project: projectID), as: EnveImportResult.self)
                result = imported
                connection.didWrite()
                router.show(imported.created == 1 ? "Imported 1 passage" : "Imported \(imported.created) passages")
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }
}

private struct HighlightRow: View {
    let highlight: EnveHighlight

    @Environment(\.hearth) private var hearth

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: highlight.text).font(HearthFont.subheadline).lineLimit(3)
            if let note = highlight.note, !note.isEmpty {
                Text(verbatim: note).font(HearthFont.caption).foregroundStyle(hearth.textSecondary).lineLimit(2)
            }
            Text(verbatim: source).font(HearthFont.caption).foregroundStyle(hearth.textTertiary).lineLimit(2)
            if let url = highlight.sourceURL {
                Link("Open source", destination: url).font(HearthFont.caption)
            }
        }
        .padding(.vertical, HearthSpacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("EnveHighlight")
    }

    private var source: String {
        let host = highlight.sourceUrl.flatMap { URL(string: $0)?.host() }
        return [highlight.bookTitle, highlight.author, highlight.location, host.map { "Link to \($0)" }]
            .compactMap { $0?.isEmpty == false ? $0 : nil }
            .joined(separator: " · ")
    }
}
