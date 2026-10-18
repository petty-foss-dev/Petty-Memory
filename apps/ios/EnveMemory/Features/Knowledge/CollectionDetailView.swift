import EnveMemoryKit
import SwiftUI

struct CollectionDetailView: View {
    let collectionID: String

    @Environment(Connection.self) private var connection
    @Environment(ProjectStore.self) private var projects
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var page: CollectionRowsPage?
    @State private var rows: [CollectionRow] = []
    @State private var layout: CollectionLayout?
    @State private var error: String?
    @State private var loadingMore = false
    @State private var editingDefinition = false
    @State private var editingRow: CollectionRow?
    @State private var confirmingArchive = false
    @State private var boardRevision = 0

    private var collection: KnowledgeCollection? { page?.collection }
    private var shownLayout: CollectionLayout {
        let chosen = layout ?? collection?.layout ?? .table
        return chosen == .kanban && collection?.groupField == nil ? .table : chosen
    }

    var body: some View {
        HearthScreen(title: collection?.name ?? "Collection", overline: "Collection") {
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            if let reason = connection.knowledgeReadReason { OnlineOnlyNote(reason: reason) }
            if let collection, let page {
                summary(collection, page: page)
                layoutPicker(collection)
                if collection.fields.isEmpty {
                    EmptyStateView(symbol: "tablecells.badge.ellipsis", title: "No fields yet",
                                   message: "Edit the collection to add text, number, date, checkbox or choice fields.")
                }
                switch shownLayout {
                case .table:
                    CollectionTable(collection: collection, rows: rows, open: open, edit: edit)
                    moreButton
                case .cards:
                    CollectionCards(collection: collection, rows: rows, open: open, edit: edit)
                    moreButton
                case .kanban:
                    CollectionBoard(collection: collection, groups: page.groups ?? [], canEdit: connection.knowledgeWriteReason == nil,
                                    open: open, edit: edit) { Task { await load() } }
                        .id(boardRevision)
                }
                if rows.isEmpty, shownLayout != .kanban {
                    EmptyStateView(symbol: "tray", title: "Nothing matches",
                                   message: page.matched == 0 ? "No ordinary items match this collection's scope yet." : "The filters leave out every matching item.")
                }
            } else if error == nil, connection.knowledgeReadReason == nil {
                ProgressView().frame(maxWidth: .infinity).padding(.top, HearthSpacing.xxxl)
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Edit fields, sort and filters", systemImage: "slider.horizontal.3") { editingDefinition = true }
                    Button("Archive collection", systemImage: "archivebox", role: .destructive) { confirmingArchive = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .disabled(collection == nil || connection.knowledgeWriteReason != nil)
                .accessibilityLabel("Collection actions")
                .accessibilityIdentifier("CollectionMenu")
            }
        }
        .sheet(isPresented: $editingDefinition) {
            if let collection {
                CollectionForm(existing: collection) { _ in Task { await load() } }
                    .environment(\.hearth, hearth)
            }
        }
        .sheet(item: $editingRow) { row in
            if let collection {
                FieldValuesSheet(collection: collection, row: row) { updated in apply(updated) }
                    .environment(\.hearth, hearth)
            }
        }
        .confirmationDialog("Archive “\(collection?.name ?? "")”?", isPresented: $confirmingArchive, titleVisibility: .visible) {
            Button("Archive collection", role: .destructive, action: archive)
        } message: {
            Text("The definition becomes an archived note. Field values stay on their items and return if the collection is restored.")
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private func summary(_ collection: KnowledgeCollection, page: CollectionRowsPage) -> some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Text(collection.scopeSummary(projectName: projects.label(for:)))
                .font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
            FlowLayout(spacing: HearthSpacing.sm) {
                StatPill(label: "showing", value: page.total.formatted())
                StatPill(label: "matched", value: page.matched.formatted())
                StatPill(label: "evaluated", value: page.evaluated.formatted())
            }
            .accessibilityIdentifier("CollectionCounts")
            if page.capped {
                KnowledgeNote(text: "More items match than your computer evaluates at once, so only the \(page.evaluated.formatted()) most recently updated were filtered and sorted. Narrow the scope to cover everything.",
                              symbol: "exclamationmark.triangle")
                    .accessibilityIdentifier("CollectionCapped")
            }
            if !collection.sort.isEmpty || !collection.filters.isEmpty {
                FlowLayout(spacing: HearthSpacing.xs) {
                    ForEach(collection.sort, id: \.self) { chip(collection.sortLabel($0), symbol: "arrow.up.arrow.down") }
                    ForEach(collection.filters, id: \.self) { chip(collection.filterLabel($0), symbol: "line.3.horizontal.decrease") }
                }
            }
        }
    }

    private func chip(_ text: String, symbol: String) -> some View {
        Label(text, systemImage: symbol)
            .font(HearthFont.caption)
            .foregroundStyle(hearth.textSecondary)
            .padding(.horizontal, HearthSpacing.sm)
            .padding(.vertical, HearthSpacing.xs)
            .background(Capsule(style: .continuous).fill(hearth.surfaceSunken))
    }

    private func layoutPicker(_ collection: KnowledgeCollection) -> some View {
        VStack(alignment: .leading, spacing: HearthSpacing.xs) {
            Picker("Layout", selection: Binding(get: { shownLayout }, set: { layout = $0 })) {
                ForEach(CollectionLayout.allCases, id: \.self) { Label($0.title, systemImage: $0.symbol).tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("CollectionLayoutSwitch")
            if layout == .kanban, collection.groupField == nil {
                Text("Kanban needs a choice field to group by. Edit the collection to choose one.")
                    .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
            }
        }
    }

    @ViewBuilder
    private var moreButton: some View {
        if page?.next != nil {
            Button { Task { await loadMore() } } label: {
                if loadingMore { ProgressView() } else { Text("Load more") }
            }
            .buttonStyle(.hearthSecondary)
            .disabled(loadingMore)
            .accessibilityIdentifier("CollectionLoadMore")
        }
    }

    private func open(_ row: CollectionRow) { router.open(.item(row.item.id)) }

    private func edit(_ row: CollectionRow) {
        guard connection.knowledgeWriteReason == nil else {
            router.show(connection.knowledgeWriteReason ?? "")
            return
        }
        editingRow = row
    }

    private func apply(_ updated: CollectionRow) {
        if let index = rows.firstIndex(where: { $0.id == updated.id }) { rows[index] = updated }
        if shownLayout == .kanban || collection?.filters.isEmpty == false || collection?.sort.isEmpty == false {
            Task { await load() }
        }
    }

    private func load() async {
        guard connection.knowledgeReadReason == nil, let client = connection.privateClient else { return }
        do {
            let first = try await client.send(.collectionRows(collectionID), as: CollectionRowsPage.self)
            page = first
            rows = first.rows
            boardRevision += 1
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
    }

    private func loadMore() async {
        guard let next = page?.next, let client = connection.privateClient, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let more = try await client.send(.collectionRows(collectionID, offset: next), as: CollectionRowsPage.self)
            let known = Set(rows.map(\.id))
            rows += more.rows.filter { !known.contains($0.id) }
            page = more
        } catch {
            connection.note(error)
            router.show(error.onlineOnlyMessage)
        }
    }

    private func archive() {
        guard let client = connection.privateClient else { return }
        Task {
            do {
                _ = try await client.send(.archiveCollection(collectionID), as: ArchiveResult.self)
                dismiss()
                router.show("Collection archived")
            } catch {
                connection.note(error)
                router.show(error.onlineOnlyMessage)
            }
        }
    }
}

private struct CollectionTable: View {
    let collection: KnowledgeCollection
    let rows: [CollectionRow]
    let open: (CollectionRow) -> Void
    let edit: (CollectionRow) -> Void

    @Environment(\.hearth) private var hearth

    private let titleWidth: CGFloat = 200
    private let fieldWidth: CGFloat = 140

    var body: some View {
        HearthCard(padding: 0) {
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    ForEach(rows) { row in
                        HearthDivider()
                        line(row)
                    }
                }
            }
        }
        .accessibilityIdentifier("CollectionTable")
    }

    private var header: some View {
        HStack(spacing: 0) {
            Text("Title").frame(width: titleWidth, alignment: .leading)
            ForEach(collection.fields) { field in
                Label(field.name, systemImage: field.type.symbol).lineLimit(1).frame(width: fieldWidth, alignment: .leading)
            }
        }
        .font(HearthFont.caption.weight(.semibold))
        .foregroundStyle(hearth.textSecondary)
        .padding(.horizontal, HearthSpacing.md)
        .padding(.vertical, HearthSpacing.sm)
        .accessibilityElement(children: .combine)
    }

    private func line(_ row: CollectionRow) -> some View {
        HStack(spacing: 0) {
            Button { open(row) } label: {
                Text(row.item.displayTitle).font(HearthFont.subheadline).foregroundStyle(hearth.textPrimary).lineLimit(2)
                    .frame(width: titleWidth, alignment: .leading)
            }
            .buttonStyle(.plain)
            ForEach(collection.fields) { field in
                Button { edit(row) } label: {
                    Text(row.values[field.id].map { $0.display(for: field) } ?? "—")
                        .font(HearthFont.footnote)
                        .foregroundStyle(row.values[field.id] == nil ? hearth.textTertiary : hearth.textPrimary)
                        .lineLimit(2)
                        .frame(width: fieldWidth, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(field.name): \(row.values[field.id].map { $0.display(for: field) } ?? "empty")")
                .accessibilityHint("Edits this row's fields")
            }
        }
        .padding(.horizontal, HearthSpacing.md)
        .padding(.vertical, HearthSpacing.sm)
        .accessibilityIdentifier("CollectionTableRow")
    }
}

private struct CollectionCards: View {
    let collection: KnowledgeCollection
    let rows: [CollectionRow]
    let open: (CollectionRow) -> Void
    let edit: (CollectionRow) -> Void

    var body: some View {
        LazyVStack(spacing: HearthSpacing.md) {
            ForEach(rows) { row in
                CollectionRowCard(collection: collection, row: row, open: { open(row) }, edit: { edit(row) })
            }
        }
        .accessibilityIdentifier("CollectionCards")
    }
}

struct CollectionRowCard<Extra: View>: View {
    let collection: KnowledgeCollection
    let row: CollectionRow
    var hiding: String?
    let open: () -> Void
    let edit: () -> Void
    @ViewBuilder var extra: Extra

    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Button(action: open) {
                    HStack(alignment: .top, spacing: HearthSpacing.sm) {
                        TypeGlyph(symbol: row.item.type.symbol)
                        Text(row.item.displayTitle).font(HearthFont.cardTitle).foregroundStyle(hearth.textPrimary)
                            .lineLimit(3).multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .buttonStyle(.plain)
                ForEach(collection.fields.filter { $0.id != hiding }) { field in
                    if let value = row.values[field.id] {
                        HStack(alignment: .firstTextBaseline) {
                            Text(field.name).font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                            Spacer(minLength: HearthSpacing.sm)
                            Text(value.display(for: field)).font(HearthFont.footnote).multilineTextAlignment(.trailing)
                        }
                    }
                }
                HStack {
                    Button("Edit fields", systemImage: "pencil", action: edit).font(HearthFont.subheadline)
                        .accessibilityIdentifier("CollectionEditRow")
                    Spacer()
                    extra
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("CollectionCard")
    }
}

extension CollectionRowCard where Extra == EmptyView {
    init(collection: KnowledgeCollection, row: CollectionRow, hiding: String? = nil, open: @escaping () -> Void, edit: @escaping () -> Void) {
        self.init(collection: collection, row: row, hiding: hiding, open: open, edit: edit) { EmptyView() }
    }
}
