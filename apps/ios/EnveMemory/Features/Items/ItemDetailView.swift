import EnveMemoryKit
import QuickLook
import SwiftUI

struct ItemDetailView: View {
    let itemID: String

    @Environment(Connection.self) private var connection
    @Environment(OutboxService.self) private var outbox
    @Environment(EditorHistory.self) private var history
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var detail: ItemDetail?
    @State private var note = MarkdownDocument("")
    @State private var content = MarkdownDocument("")
    @State private var references: ReferenceList?
    @State private var progress: ChecklistProgress?
    @State private var cachedAt: Date?
    @State private var error: String?
    @State private var preview: URL?
    @State private var downloading: String?
    @State private var completing = false
    @State private var sheet: ItemSheet?

    struct ItemSheet: Identifiable {
        enum Kind: String { case edit, ai, share, move }
        let kind: Kind
        let item: Item
        var id: String { kind.rawValue }
    }

    var body: some View {
        HearthScreen {
            if let cachedAt { CachedBanner(savedAt: cachedAt) }
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            if let detail {
                ItemDetailContent(detail: detail, note: note, content: content, references: references, progress: progress,
                                  downloading: downloading, completing: completing, open: open, complete: complete)
                    .environment(\.referenceTitles, referenceTitles)
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity).padding(.top, HearthSpacing.xxxl)
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let item = detail?.item {
                ToolbarItem(placement: .primaryAction) { PinButton(item: item) }
            }
            if let url = detail?.item.url.flatMap(URL.init(string:)) {
                ToolbarItem(placement: .primaryAction) {
                    ShareLink(item: url)
                }
            }
            if let item = detail?.item {
                ToolbarItem(placement: .primaryAction) {
                    ItemMenu(item: item, isQueued: outbox.pending.created[item.id] != nil) { sheet = ItemSheet(kind: $0, item: item) }
                }
            }
        }
        .sheet(item: $sheet) { sheet in
            sheetContent(sheet.kind, item: sheet.item).environment(\.hearth, hearth)
        }
        .quickLookPreview($preview)
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
        .onChange(of: outbox.pending.bodies[itemID]) { _, queued in
            if let queued { note = MarkdownDocument(queued) }
        }
    }

    @ViewBuilder
    private func sheetContent(_ kind: ItemSheet.Kind, item: Item) -> some View {
        switch kind {
        case .edit: ItemEditor(item: item)
        case .ai: AIEditSheet(item: item)
        case .share: ShareLinkSheet(item: item)
        case .move:
            MoveDestinationPicker(item: item) { parent, before in
                Task { await history.perform([.move(id: item.id, parentId: parent, beforeId: before)], label: "Move “\(item.displayTitle)”", sent: "Moved") }
            }
        }
    }

    private var referenceTitles: [String: String] {
        Dictionary((references?.outgoing ?? []).map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first })
    }

    private func load() async {
        guard connection.client != nil else { return }
        if let created = outbox.pending.createdEntry(itemID) {
            // Still in the outbox, so the server doesn't have it yet.
            detail = ItemDetail(item: created.item)
            note = MarkdownDocument(outbox.pending.bodies[itemID] ?? created.item.body)
            cachedAt = nil
            error = nil
            return
        }
        do {
            let loaded = try await connection.load(.item(itemID), as: ItemDetail.self)
            detail = loaded.value
            cachedAt = loaded.cachedAt
            note = MarkdownDocument(outbox.pending.bodies[itemID] ?? loaded.value.item.body)
            content = MarkdownDocument(loaded.value.content)
            error = nil
            guard !loaded.value.item.isSecret else { return }
            references = try? await connection.load(.references(itemID), as: ReferenceList.self).value
            if loaded.value.item.presentation.checklist {
                progress = try? await connection.load(.checklist(itemID), as: ChecklistProgress.self).value
            }
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func open(_ attachment: Attachment) {
        guard let client = connection.client, downloading == nil else { return }
        downloading = attachment.id
        Task {
            defer { downloading = nil }
            do {
                let folder = URL.cachesDirectory.appending(path: "Attachments", directoryHint: .isDirectory)
                preview = try await client.download(attachment, itemID: itemID, into: folder)
                if let item = detail?.item { ItemActions(outbox: outbox, router: router).markOpened(item) }
            } catch {
                router.show(error.localizedDescription)
            }
        }
    }

    private func complete() {
        guard let item = detail?.item else { return }
        completing = true
        Task {
            if await !TaskCompleter(outbox: outbox, router: router).complete(item) { completing = false }
        }
    }
}

private struct ItemDetailContent: View {
    let detail: ItemDetail
    let note: MarkdownDocument
    let content: MarkdownDocument
    let references: ReferenceList?
    let progress: ChecklistProgress?
    let downloading: String?
    let completing: Bool
    let open: (Attachment) -> Void
    let complete: () -> Void

    @Environment(Router.self) private var router
    @Environment(OutboxService.self) private var outbox
    @Environment(\.openURL) private var openURL
    @Environment(\.hearth) private var hearth

    private var item: Item { detail.item }

    var body: some View {
        header
        if item.isSecret {
            SecretNoteCard(itemID: item.id)
        } else {
            if let task = item.task { taskCard(task) }
            if item.task == nil, item.type != .decision { OrganizeCard(item: item) }
            if let ai = item.metadata.ai, ai.isReady, ai.summary?.isEmpty == false || ai.isPending {
                SuggestionsCard(ai: ai, itemID: item.id)
            }
            if !note.isEmpty {
                HStack {
                    Overline(item.type == .bookmark || item.type == .file ? "Your note" : "Note")
                    Spacer()
                    if outbox.pending.bodies[item.id] != nil { QueuedBadge() }
                }
                HearthCard(padding: HearthSpacing.xl) { MarkdownView(document: note) }
            }
            if item.type != .decision { PresentationCard(item: item, progress: progress) }
        }
        if !detail.tags.isEmpty {
            FlowLayout {
                ForEach(detail.tags, id: \.self) { TagChip(tag: $0) }
            }
        }
        // A secret note's files are ciphertext; they open in the vault.
        if !detail.attachments.isEmpty, !item.isSecret { attachments }
        archive
        ConnectionsSection(item: item, relations: detail.relations, references: references)
        footer
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Overline([item.type.label, item.project?.name].compactMap(\.self).joined(separator: " · "))
            Text(outbox.pending.titles[item.id] ?? item.displayTitle)
                .font(HearthFont.itemTitle)
                .foregroundStyle(hearth.textPrimary)
                .textSelection(.enabled)
                .accessibilityAddTraits(.isHeader)
            if let source = sourceLine {
                Text(source)
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
            }
            if let url = item.url.flatMap(URL.init(string:)) {
                Button {
                    openURL(url)
                    ItemActions(outbox: outbox, router: router).markOpened(item)
                } label: {
                    Label("Open original", systemImage: "safari")
                }
                .buttonStyle(.hearthSecondary)
                .padding(.top, HearthSpacing.xs)
                .accessibilityHint(url.absoluteString)
            }
        }
    }

    private var sourceLine: String? {
        let meta = item.metadata
        let site = meta.siteName ?? item.url.flatMap { URL(string: $0)?.host() }
        let published = meta.publishedAt.flatMap(JSONCoding.parseTimestamp)?.formatted(date: .abbreviated, time: .omitted)
        let parts = [site, meta.byline, published].compactMap { $0?.isEmpty == false ? $0 : nil }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func taskCard(_ task: TaskFields) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            HStack(spacing: HearthSpacing.md) {
                VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                    Text(task.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(HearthFont.headline)
                    Text([task.priority == .normal ? nil : "\(task.priority.rawValue.capitalized) priority",
                          task.dueDate.map { "Due \(DueFormat.label($0))" }].compactMap(\.self).joined(separator: " · "))
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                }
                Spacer()
                if !task.status.isFinished {
                    Button(completing ? "Done" : "Complete", action: complete)
                        .buttonStyle(.hearthPrimary)
                        .fixedSize()
                        .disabled(completing)
                }
            }
        }
    }

    private var attachments: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Overline("Attachments")
            RowStack(data: detail.attachments) { attachment in
                Button { open(attachment) } label: {
                    HStack(spacing: HearthSpacing.md) {
                        TypeGlyph(symbol: attachment.mimeType.hasPrefix("image/") ? "photo" : attachment.mimeType == "application/pdf" ? "doc.richtext" : "doc")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(attachment.filename).font(HearthFont.subheadline).lineLimit(1)
                            Text("\(attachment.size.formatted(.byteCount(style: .file))) · \(attachment.mimeType)")
                                .font(HearthFont.caption)
                                .foregroundStyle(hearth.textTertiary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if downloading == attachment.id {
                            ProgressView()
                        } else {
                            Image(systemName: "eye").foregroundStyle(hearth.accent)
                        }
                    }
                    .padding(.vertical, HearthSpacing.xs)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Downloads and previews the file")
            }
        }
    }

    @ViewBuilder
    private var archive: some View {
        let ingest = item.metadata.ingest
        if !content.isEmpty {
            HStack {
                Overline("Archived copy")
                Spacer()
                if let words = item.metadata.wordCount {
                    Text("\(words.formatted()) words").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                }
            }
            // A quiet surface for long reading: no glow, generous measure.
            MarkdownView(document: content)
                .padding(HearthSpacing.xl)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: HearthRadius.card, style: .continuous).fill(hearth.surface))
                .overlay(RoundedRectangle(cornerRadius: HearthRadius.card, style: .continuous).strokeBorder(hearth.hairline))
                .textSelection(.enabled)
        } else if ingest?.status == "pending" {
            Label("Archiving a copy on your computer…", systemImage: "hourglass")
                .font(HearthFont.footnote)
                .foregroundStyle(hearth.textSecondary)
        } else if ingest?.status == "failed" {
            Label("Couldn't archive this page\(ingest?.error.map { ": \($0)" } ?? ".")", systemImage: "exclamationmark.triangle")
                .font(HearthFont.footnote)
                .foregroundStyle(hearth.textSecondary)
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Saved \(item.createdAt.formatted(date: .abbreviated, time: .shortened)) by \(item.source)")
            if item.updatedAt != item.createdAt {
                Text("Updated \(item.updatedAt.formatted(.relative(presentation: .named)))")
            }
        }
        .font(HearthFont.caption)
        .foregroundStyle(hearth.textTertiary)
        .padding(.top, HearthSpacing.sm)
    }
}

/// Outline, history, AI and sharing for one item. Each entry appears only where the server would accept it.
private struct ItemMenu: View {
    let item: Item
    /// Created on this phone and not sent yet: only what can queue is offered.
    let isQueued: Bool
    let present: (ItemDetailView.ItemSheet.Kind) -> Void

    @Environment(Router.self) private var router

    private var isOrdinary: Bool { item.type != .decision && !item.isSecret }

    var body: some View {
        Menu {
            if isOrdinary {
                Button("Edit", systemImage: "pencil") { present(.edit) }
            }
            if item.isSecret {
                Button("Open in vault", systemImage: "lock.open") { router.open(.vaultNote(item.id)) }
            }
            Button("Show in outline", systemImage: "list.bullet.indent") { router.open(.outline(item.id)) }
            if item.type != .decision {
                Button("Move…", systemImage: "arrow.up.and.down.and.arrow.left.and.right") { present(.move) }
            }
            if !isQueued { Button("History", systemImage: "clock.arrow.circlepath") { router.open(.history(item.id)) } }
            if isOrdinary, item.archivedAt == nil, !isQueued {
                Button("Edit with AI…", systemImage: "sparkles") { present(.ai) }
                Button("Public link…", systemImage: "link") { present(.share) }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("More actions")
        .accessibilityIdentifier("ItemMenu")
    }
}

/// A secret note's ordinary fields are only a label; its text opens in the vault.
private struct SecretNoteCard: View {
    let itemID: String

    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            HStack(spacing: HearthSpacing.md) {
                TypeGlyph(symbol: "lock.fill")
                VStack(alignment: .leading, spacing: 2) {
                    Text("Encrypted").font(HearthFont.subheadline)
                    Text("Unlock the vault on this phone to read it.").font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button("Open") { router.open(.vaultNote(itemID)) }.font(HearthFont.subheadline)
            }
        }
    }
}
