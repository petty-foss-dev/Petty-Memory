import EnveMemoryKit
import SwiftUI

struct CollectionsView: View {
    @Environment(Connection.self) private var connection
    @Environment(ProjectStore.self) private var projects
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var collections: [KnowledgeCollection] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var creating = false

    var body: some View {
        HearthScreen(title: "Collections", overline: "Knowledge") {
            KnowledgeNote(text: "A collection gives ordinary items typed fields: text, numbers, dates, checkboxes and choices. Values are stored on the items themselves, so they keep their history and travel with export and sync. Your computer filters and sorts the newest 1,000 matching items.")
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            Button { creating = true } label: { Label("New collection", systemImage: "plus") }
                .buttonStyle(.hearthPrimary)
                .disabled(connection.knowledgeWriteReason != nil)
                .accessibilityIdentifier("NewCollection")
            if let reason = connection.knowledgeWriteReason { OnlineOnlyNote(reason: reason) }
            if collections.isEmpty {
                if loaded, error == nil {
                    EmptyStateView(symbol: KnowledgeArea.collections.symbol, title: "No collections yet",
                                   message: "Track reading status on links, prices on purchases or stages on project notes.")
                }
            } else {
                RowStack(data: collections) { collection in
                    Button { router.open(.collection(collection.id)) } label: { row(collection) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("CollectionRow")
                }
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $creating) {
            CollectionForm(existing: nil) { router.open(.collection($0.id)) }
                .environment(\.hearth, hearth)
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private func row(_ collection: KnowledgeCollection) -> some View {
        HStack(alignment: .top, spacing: HearthSpacing.md) {
            TypeGlyph(symbol: collection.layout.symbol)
            VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                Text(collection.name).font(HearthFont.cardTitle).foregroundStyle(hearth.textPrimary).lineLimit(2)
                Text(collection.scopeSummary(projectName: projects.label(for:)))
                    .font(HearthFont.caption).foregroundStyle(hearth.textTertiary).lineLimit(2)
                Text(collection.fields.isEmpty ? "No fields yet" : collection.fields.map(\.name).joined(separator: " · "))
                    .font(HearthFont.caption).foregroundStyle(hearth.textSecondary).lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, HearthSpacing.sm)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        guard connection.knowledgeReadReason == nil, let client = connection.privateClient else { loaded = true; return }
        do {
            collections = try await client.send(.collections, as: [KnowledgeCollection].self)
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
        loaded = true
    }
}

extension CollectionLayout {
    var title: String {
        switch self {
        case .table: "Table"
        case .cards: "Cards"
        case .kanban: "Kanban"
        }
    }

    var symbol: String {
        switch self {
        case .table: "tablecells"
        case .cards: "rectangle.grid.1x2"
        case .kanban: "rectangle.split.3x1"
        }
    }
}

extension PropertyType {
    var title: String {
        switch self {
        case .text: "Text"
        case .number: "Number"
        case .date: "Date"
        case .checkbox: "Checkbox"
        case .select: "Choice"
        }
    }

    var symbol: String {
        switch self {
        case .text: "textformat"
        case .number: "number"
        case .date: "calendar"
        case .checkbox: "checkmark.square"
        case .select: "list.bullet.circle"
        }
    }
}

extension FilterOp {
    func title(for type: PropertyType) -> String {
        switch self {
        case .equals: "is"
        case .notEquals: "is not"
        case .contains: "contains"
        case .lt: type == .date ? "before" : "less than"
        case .lte: type == .date ? "on or before" : "at most"
        case .gt: type == .date ? "after" : "more than"
        case .gte: type == .date ? "on or after" : "at least"
        case .empty: "is empty"
        case .notEmpty: "is not empty"
        }
    }
}

extension KnowledgeCollection {
    func scopeSummary(projectName: (String?) -> String) -> String {
        var parts: [String] = []
        if let query = scope.query { parts.append("“\(query)”") }
        if let project = scope.project { parts.append(projectName(project)) }
        parts.append(scope.type?.pluralLabel ?? "All item types")
        return parts.joined(separator: " · ")
    }

    func sortLabel(_ sort: CollectionSort) -> String {
        let name = switch sort.field {
        case "title": "Title"
        case "createdAt": "Created"
        case "updatedAt": "Updated"
        default: field(sort.field)?.name ?? "A removed field"
        }
        return "\(name) \(sort.direction == .asc ? "↑" : "↓")"
    }

    func filterLabel(_ filter: CollectionFilter) -> String {
        guard let field = field(filter.field) else { return "A removed field" }
        let value = filter.value.map { $0.display(for: field) } ?? ""
        return [field.name, filter.op.title(for: field.type), value].filter { !$0.isEmpty }.joined(separator: " ")
    }
}
