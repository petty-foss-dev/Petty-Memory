import EnveMemoryKit
import SwiftUI

/// One branch of the outline: its path, the item itself, and its children a page at a time, with every queued
/// placement, check and new note shown on top. Structural changes are journalled actions with Undo and Redo.
struct OutlineView: View {
    let parentID: String?

    @Environment(Connection.self) private var connection
    @Environment(OutboxService.self) private var outbox
    @Environment(EditorHistory.self) private var history
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var parent: OutlineEntry?
    @State private var ancestors: [Item] = []
    @State private var entries: [OutlineEntry] = []
    @State private var total = 0
    /// Rows that queued moves bring in from branches this screen hasn't loaded.
    @State private var known: [String: OutlineEntry] = [:]
    @State private var progress: ChecklistProgress?
    @State private var cachedAt: Date?
    @State private var error: String?
    @State private var loaded = false
    @State private var loadingMore = false
    @State private var showCompleted = false
    @State private var busy: Set<String> = []
    @State private var moving: OutlineEntry?
    @State private var editing: Item?

    private let pageSize = 50

    var body: some View {
        HearthScreen(title: parentID == nil ? "Outline" : nil, overline: parentID == nil ? "Everything, nested" : nil) {
            if let cachedAt { CachedBanner(savedAt: cachedAt) }
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            if parentID != nil {
                OutlineBreadcrumbs(ancestors: ancestors)
                if let parent {
                    OutlineHeader(entry: parent, presentation: presentation(parent.item), progress: progress,
                                  title: outbox.pending.titles[parent.id], edit: { editing = parent.item })
                } else if error == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, HearthSpacing.xl)
                }
            }
            if loaded || !entries.isEmpty { children }
            if canAddChildren { OutlineComposer(parentID: parentID) }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) { UndoRedoButtons() }
        }
        .sheet(item: $moving) { entry in
            MoveDestinationPicker(item: entry.item) { destination, before in
                Task { await history.perform([.move(id: entry.id, parentId: destination, beforeId: before)],
                                             label: "Move “\(entry.item.displayTitle)”", sent: "Moved") }
            }
            .environment(\.hearth, hearth)
        }
        .sheet(item: $editing) { ItemEditor(item: $0).environment(\.hearth, hearth) }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
        .task(id: outbox.pending.placedIDs) { await lookUpPlaced() }
    }

    private var canAddChildren: Bool {
        guard let parent else { return parentID == nil }
        return OutlineMover.canHold(parent)
    }

    private var arranged: OutlinePage { outbox.pending.arrange(entries, total: total, under: parentID, known: known) }

    private var parentPresentation: ItemPresentation? { parent.map { presentation($0.item) } }

    private var hidesCompleted: Bool { parentPresentation?.hideCompleted == true && !showCompleted }

    /// This branch and everything above it, for checks queued on an ancestor.
    private var path: [String] { [parentID].compactMap(\.self) + ancestors.map(\.id) }

    @ViewBuilder
    private var children: some View {
        let page = arranged
        let visible = hidesCompleted ? page.items.filter { !checked($0.item) } : page.items
        let hidden = page.items.count - visible.count
        HStack {
            Overline(parentID == nil ? "Top level" : page.total == 1 ? "1 item inside" : "\(page.total) items inside")
            Spacer()
            if hidden > 0 || (showCompleted && parentPresentation?.hideCompleted == true) {
                Button(showCompleted ? "Hide completed" : "Show \(hidden) completed") { showCompleted.toggle() }
                    .font(HearthFont.caption)
            }
        }
        let legacy = outbox.pending.notes(under: parentID)
        if visible.isEmpty, legacy.isEmpty {
            if loaded, error == nil {
                EmptyStateView(symbol: "list.bullet.indent", title: page.items.isEmpty ? "Nothing inside yet" : "All done",
                               message: page.items.isEmpty ? "Add a note below to start this branch." : "Completed items are hidden.")
            }
        } else {
            HearthCard(padding: HearthSpacing.md) {
                VStack(spacing: 0) {
                    ForEach(Array(visible.enumerated()), id: \.element.id) { index, entry in
                        if index > 0 { HearthDivider().padding(.leading, HearthSpacing.xxxl) }
                        row(entry, among: page.items)
                    }
                    ForEach(legacy) { note in
                        HearthDivider().padding(.leading, HearthSpacing.xxxl)
                        QueuedNoteRow(title: note.title)
                    }
                }
            }
        }
        if page.items.count < page.total {
            Button { Task { await loadMore() } } label: {
                if loadingMore { ProgressView() } else { Text("Show more (\(page.total - page.items.count))") }
            }
            .buttonStyle(.hearthSecondary)
            .disabled(loadingMore)
        }
    }

    private func row(_ entry: OutlineEntry, among siblings: [OutlineEntry]) -> some View {
        let pending = outbox.pending
        let merge = OutlineMover.mergeTarget(for: entry, among: siblings, in: parentID)
        return OutlineRow(
            entry: entry,
            title: pending.titles[entry.id] ?? entry.item.displayTitle,
            presentation: presentation(entry.item),
            isChecked: checked(entry.item),
            showsCheckbox: showsCheckbox(entry.item),
            isQueued: pending.isPending(entry.id),
            isBusy: busy.contains(entry.id),
            canOutdent: parent != nil,
            mergeTarget: merge.map { pending.titles[$0.id] ?? $0.item.displayTitle },
            actions: OutlineRow.Actions(
                toggle: { toggle(entry) },
                open: { open(entry) },
                details: { router.open(.item(entry.id)) },
                edit: { editing = entry.item },
                shift: { direction in shift(entry, direction) },
                indent: { perform(entry, "Indent", OutlineMover.indent(entry, among: arranged.items), sent: "Indented") },
                outdent: { outdent(entry) },
                moveTo: { moving = entry },
                merge: { if let merge { perform(entry, "Merge", .merge(id: entry.id, previousId: merge.id), sent: "Merged") } }
            )
        )
    }

    private func presentation(_ item: Item) -> ItemPresentation {
        outbox.pending.presentation(of: item)
    }

    private func checked(_ item: Item) -> Bool {
        outbox.pending.checked(item.id, path: path) ?? item.isChecked
    }

    private func showsCheckbox(_ item: Item) -> Bool {
        guard item.type != .decision, !item.isSecret else { return false }
        return item.task != nil || parentPresentation?.checklist == true || presentation(item).checklist || checked(item)
    }

    private func open(_ entry: OutlineEntry) {
        if entry.item.isSecret {
            router.open(.vaultNote(entry.id))
        } else {
            router.open(.outline(entry.id))
        }
    }

    private func toggle(_ entry: OutlineEntry) {
        let value = !checked(entry.item)
        perform(entry, value ? "Check" : "Uncheck", .check(id: entry.id, checked: value), sent: value ? "Checked" : "Unchecked")
    }

    private func shift(_ entry: OutlineEntry, _ direction: OutlineMover.Direction) {
        run(entry) {
            // Moving down past the last loaded row needs the row after it.
            if direction == .down, arranged.items.count < arranged.total, arranged.items.suffix(2).contains(where: { $0.id == entry.id }) {
                await loadMore()
            }
            let command = OutlineMover.shift(entry, among: arranged.items, in: parentID, direction)
            await send(entry, direction == .up ? "Move up" : "Move down", command, sent: "Moved")
        }
    }

    private func outdent(_ entry: OutlineEntry) {
        guard let parent else { return }
        run(entry) {
            do {
                let siblings = try await branch(parent.parentId, until: parent.id)
                await send(entry, "Outdent", OutlineMover.outdent(entry, from: parent, among: siblings), sent: "Outdented")
            } catch is CancellationError {
                return
            } catch {
                router.show(error.localizedDescription)
            }
        }
    }

    /// A branch as it's shown, loaded page by page until `id` and the row after it are in.
    private func branch(_ parentID: String?, until id: String) async throws -> [OutlineEntry] {
        var rows: [OutlineEntry] = []
        var total = 0
        repeat {
            let page = try await connection.load(.outline(parent: parentID, offset: rows.count, limit: 200), as: OutlinePage.self).value
            rows += page.items
            total = page.total
            let shown = outbox.pending.arrange(rows, total: total, under: parentID, known: known).items
            if let index = shown.firstIndex(where: { $0.id == id }), index + 1 < shown.count { return shown }
            if page.items.isEmpty { break }
        } while rows.count < total
        return outbox.pending.arrange(rows, total: total, under: parentID, known: known).items
    }

    private func perform(_ entry: OutlineEntry, _ verb: String, _ command: EditorCommand?, sent: String) {
        run(entry) { await send(entry, verb, command, sent: sent) }
    }

    private func send(_ entry: OutlineEntry, _ verb: String, _ command: EditorCommand?, sent: String) async {
        guard let command else {
            router.show("It can't move that way.")
            return
        }
        await history.perform([command], label: "\(verb) “\(entry.item.displayTitle)”", sent: sent)
    }

    private func run(_ entry: OutlineEntry, _ work: @escaping () async -> Void) {
        guard !busy.contains(entry.id) else { return }
        busy.insert(entry.id)
        Task {
            await work()
            busy.remove(entry.id)
        }
    }

    private func load() async {
        guard connection.client != nil else { return }
        if let parentID, let created = await createdEntry(parentID) {
            // Still in the outbox: the server doesn't know it yet, so everything here is what's queued.
            parent = created
            ancestors = await pendingAncestors(of: created)
            entries = []
            total = 0
            cachedAt = nil
            error = nil
            loaded = true
            return
        }
        do {
            let page = try await connection.load(.outline(parent: parentID, limit: min(200, max(pageSize, entries.count))), as: OutlinePage.self)
            var stale = page.cachedAt
            if let parentID {
                async let entry = connection.load(.outlineEntry(parentID), as: OutlineEntry.self)
                async let path = connection.load(.ancestors(parentID), as: [Item].self)
                let (loadedEntry, loadedPath) = try await (entry, path)
                parent = loadedEntry.value
                ancestors = loadedPath.value
                stale = stale ?? loadedEntry.cachedAt
                progress = try? await connection.load(.checklist(parentID), as: ChecklistProgress.self).value
            }
            entries = page.value.items
            total = page.value.total
            cachedAt = stale
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    /// A queued note's row; the second half of a split takes its original's parent, read from the saved library if need be.
    private func createdEntry(_ id: String) async -> OutlineEntry? {
        guard let original = outbox.pending.created[id].map({ $0.follows }) else { return nil }
        guard let original else { return outbox.pending.createdEntry(id) }
        let parent: String? = if let queued = outbox.pending.createdEntry(original) {
            queued.parentId
        } else {
            try? await connection.load(.outlineEntry(original), as: OutlineEntry.self).value.parentId
        }
        return outbox.pending.createdEntry(id) { _ in .some(parent) }
    }

    private func pendingAncestors(of entry: OutlineEntry) async -> [Item] {
        var chain: [Item] = []
        var next = entry.parentId
        while let id = next, let created = await createdEntry(id) {
            chain.insert(created.item, at: 0)
            next = created.parentId
        }
        guard let id = next else { return chain }
        async let item = try? connection.load(.outlineEntry(id), as: OutlineEntry.self).value.item
        async let above = try? connection.load(.ancestors(id), as: [Item].self).value
        return await (above ?? []) + [await item].compactMap(\.self) + chain
    }

    private func lookUpPlaced() async {
        let missing = outbox.pending.placedIDs.subtracting(entries.map(\.id))
        known = missing.isEmpty ? [:] : await connection.library?.entries(missing) ?? [:]
    }

    @discardableResult
    private func loadMore() async -> Bool {
        guard !loadingMore else { return false }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await connection.load(.outline(parent: parentID, offset: entries.count, limit: pageSize), as: OutlinePage.self).value
            let known = Set(entries.map(\.id))
            entries += page.items.filter { !known.contains($0.id) }
            total = page.total
            return !page.items.isEmpty
        } catch is CancellationError {
            return false
        } catch {
            router.show(error.localizedDescription)
            return false
        }
    }
}

/// Undo and Redo for journalled actions, named for what they'd reverse.
struct UndoRedoButtons: View {
    @Environment(EditorHistory.self) private var history

    var body: some View {
        Button { Task { await history.undo() } } label: {
            Image(systemName: "arrow.uturn.backward")
        }
        .disabled(history.undoLabel == nil || history.isBusy)
        .accessibilityLabel(history.undoLabel.map { "Undo \($0)" } ?? "Undo")
        .accessibilityIdentifier("StructuralUndo")
        Button { Task { await history.redo() } } label: {
            Image(systemName: "arrow.uturn.forward")
        }
        .disabled(history.redoLabel == nil || history.isBusy)
        .accessibilityLabel(history.redoLabel.map { "Redo \($0)" } ?? "Redo")
        .accessibilityIdentifier("StructuralRedo")
    }
}

private struct OutlineBreadcrumbs: View {
    let ancestors: [Item]

    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: HearthSpacing.xs) {
                crumb("Outline") { router.open(.outline(nil)) }
                ForEach(ancestors) { ancestor in
                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(hearth.textTertiary).accessibilityHidden(true)
                    crumb(ancestor.displayTitle) { router.open(.outline(ancestor.id)) }
                }
            }
            .padding(.top, HearthSpacing.sm)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Path")
    }

    private func crumb(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).lineLimit(1).font(HearthFont.footnote).foregroundStyle(hearth.accent)
        }
        .buttonStyle(.plain)
    }
}

private struct OutlineHeader: View {
    let entry: OutlineEntry
    let presentation: ItemPresentation
    let progress: ChecklistProgress?
    let title: String?
    let edit: () -> Void

    @Environment(Router.self) private var router
    @Environment(OutboxService.self) private var outbox
    @Environment(\.hearth) private var hearth

    var body: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Text(title ?? entry.item.displayTitle)
                .font(presentation.kind == .text ? HearthFont.itemTitle : HearthFont.screenTitle)
                .accessibilityAddTraits(.isHeader)
            PresentationBadges(presentation: presentation, progress: progress)
            let body = outbox.pending.bodies[entry.id] ?? entry.item.body
            if !body.isEmpty, !entry.item.isSecret {
                ReferenceText(text: body).font(HearthFont.callout).foregroundStyle(hearth.textSecondary).lineLimit(6)
            }
            HStack(spacing: HearthSpacing.sm) {
                Button("Details", systemImage: "info.circle") { router.open(.item(entry.id)) }
                if entry.item.type != .decision, !entry.item.isSecret {
                    Button("Edit", systemImage: "pencil", action: edit)
                }
            }
            .buttonStyle(.hearthQuiet)
        }
    }
}

/// Attention, review mark and checklist progress, shown wherever an item's presentation matters.
struct PresentationBadges: View {
    let presentation: ItemPresentation
    var progress: ChecklistProgress?

    @Environment(\.hearth) private var hearth

    var body: some View {
        let badges = items
        if !badges.isEmpty {
            FlowLayout(spacing: HearthSpacing.sm) {
                ForEach(badges, id: \.0) { label, symbol in
                    Label(label, systemImage: symbol)
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textSecondary)
                        .padding(.horizontal, HearthSpacing.sm)
                        .padding(.vertical, HearthSpacing.xs)
                        .background(Capsule().fill(hearth.accentMuted))
                }
            }
        }
    }

    private var items: [(String, String)] {
        var result: [(String, String)] = []
        if presentation.attention == .high { result.append(("High attention", "exclamationmark.circle")) }
        if presentation.attention == .low { result.append(("Low attention", "arrow.down.circle")) }
        if presentation.review { result.append(("Marked for review", "eye")) }
        if presentation.checklist, let progress, progress.total > 0 { result.append(("\(progress.done) of \(progress.total) done", "checklist")) }
        if presentation.autoOrganize { result.append(("Auto-organize on", "wand.and.stars")) }
        return result
    }
}

private struct QueuedNoteRow: View {
    let title: String

    @Environment(\.hearth) private var hearth

    var body: some View {
        HStack(spacing: HearthSpacing.md) {
            Image(systemName: "circle.dotted").foregroundStyle(hearth.textTertiary).frame(width: 28)
            Text(title).font(HearthFont.body).foregroundStyle(hearth.textSecondary).frame(maxWidth: .infinity, alignment: .leading)
            QueuedBadge()
        }
        .padding(.vertical, HearthSpacing.sm)
        .accessibilityElement(children: .combine)
    }
}

/// Adds a note at the end of this branch, with its own id so it can be opened and filled in before it's sent.
private struct OutlineComposer: View {
    let parentID: String?

    @Environment(EditorHistory.self) private var history
    @Environment(\.hearth) private var hearth

    @State private var text = ""
    @State private var sending = false
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: HearthSpacing.sm) {
            TextField(parentID == nil ? "Add a top-level note" : "Add a note inside", text: $text, axis: .vertical)
                .lineLimit(1...4)
                .focused($focused)
                .submitLabel(.done)
                .onSubmit(add)
                .hearthField()
                .accessibilityIdentifier("OutlineComposer")
            Button(action: add) {
                Image(systemName: "plus.circle.fill").font(.system(size: 30)).foregroundStyle(canAdd ? hearth.accent : hearth.textTertiary)
            }
            .disabled(!canAdd)
            .accessibilityLabel("Add note")
        }
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canAdd: Bool { !trimmed.isEmpty && !sending }

    private func add() {
        guard canAdd else { return }
        let value = trimmed
        sending = true
        Task {
            defer { sending = false }
            let lines = value.split(separator: "\n", maxSplits: 1).map(String.init)
            let command = EditorCommand.create(id: UUIDv7.make(), parentId: parentID, title: lines[0], body: lines.count > 1 ? lines[1] : nil)
            if await history.perform([command], label: "Add “\(String(lines[0].prefix(40)))”", sent: "Added") {
                text = ""
            }
        }
    }
}
