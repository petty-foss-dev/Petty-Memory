import EnveMemoryKit
import Observation
import SwiftUI

/// Lives on the router so the query and results survive tab switches.
@Observable
final class SearchModel {
    struct Key: Hashable {
        var query: String
        var type: ItemType?
        var projectID: String?
    }

    var query = ""
    var type: ItemType?
    var projectID: String?
    private(set) var hits: [SearchHit] = []
    private(set) var error: String?
    private(set) var searchedKey: Key?
    private(set) var isSearching = false
    /// Set when the results are an earlier answer to the same search, saved on this phone.
    private(set) var cachedAt: Date?

    var key: Key { Key(query: query.trimmingCharacters(in: .whitespacesAndNewlines), type: type, projectID: projectID) }

    func run(_ key: Key, connection: Connection) async {
        guard connection.client != nil, !key.query.isEmpty else {
            hits = []
            searchedKey = nil
            cachedAt = nil
            return
        }
        do {
            try await Task.sleep(for: .milliseconds(300))
            isSearching = true
            defer { isSearching = false }
            let loaded = try await connection.load(.search(key.query, filter: ItemFilter(project: key.projectID, type: key.type, limit: 40)),
                                                   as: [SearchHit].self)
            hits = loaded.value
            cachedAt = loaded.cachedAt
            error = nil
            searchedKey = key
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct SearchView: View {
    @Environment(Router.self) private var router
    @Environment(Connection.self) private var connection
    @Environment(ProjectStore.self) private var projects
    @Environment(\.hearth) private var hearth
    @FocusState private var focused: Bool

    private var model: SearchModel { router.search }

    var body: some View {
        @Bindable var model = model
        HearthScreen(title: "Search") {
            HStack(spacing: HearthSpacing.sm) {
                Image(systemName: "magnifyingglass").foregroundStyle(hearth.textTertiary)
                TextField("Search notes, links, tasks, files", text: $model.query)
                    .focused($focused)
                    .submitLabel(.search)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("SearchField")
                if !model.query.isEmpty {
                    Button { model.query = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(hearth.textTertiary)
                    }
                    .accessibilityLabel("Clear search")
                }
            }
            .hearthField()
            filters
            results
        }
        .task(id: model.key) { await model.run(model.key, connection: connection) }
        .task { _ = try? await projects.load(connection) }
        .onAppear { if model.query.isEmpty { focused = true } }
    }

    private var filters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: HearthSpacing.sm) {
                Menu {
                    Button("All projects") { model.projectID = nil }
                    ForEach(projects.refs, id: \.id) { project in
                        Button(project.name) { model.projectID = project.id }
                    }
                } label: {
                    FilterChip(title: projects.name(for: model.projectID) ?? "All projects", systemImage: "folder",
                               isSelected: model.projectID != nil) {}
                        .allowsHitTesting(false)
                }
                FilterChip(title: "All", isSelected: model.type == nil) { model.type = nil }
                ForEach(ItemType.filterable, id: \.self) { type in
                    FilterChip(title: type.pluralLabel, isSelected: model.type == type) {
                        model.type = model.type == type ? nil : type
                    }
                }
            }
        }
        .scrollClipDisabled()
    }

    @ViewBuilder
    private var results: some View {
        if let error = model.error {
            ErrorBanner(message: error) { Task { await model.run(model.key, connection: connection) } }
        }
        if let cachedAt = model.cachedAt, !model.key.query.isEmpty { CachedBanner(savedAt: cachedAt) }
        if model.key.query.isEmpty {
            EmptyStateView(symbol: "sparkle.magnifyingglass", title: "Search your memory",
                           message: "Finds exact words and, when semantic search is on, things that mean the same.")
        } else if model.hits.isEmpty {
            if model.searchedKey == model.key {
                EmptyStateView(symbol: "questionmark.circle", title: "No matches", message: "Try other words or clear the filters.")
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, HearthSpacing.xl)
            }
        } else {
            Overline(model.hits.count == 1 ? "1 result" : "\(model.hits.count) results")
            RowStack(data: model.hits) { hit in
                Button { router.open(.item(hit.id)) } label: { SearchHitRow(hit: hit) }
                    .buttonStyle(.plain)
            }
        }
    }
}

private struct SearchHitRow: View {
    let hit: SearchHit
    @Environment(\.hearth) private var hearth

    var body: some View {
        HStack(alignment: .top, spacing: HearthSpacing.md) {
            TypeGlyph(symbol: hit.taskStatus == .done ? "checkmark.circle.fill" : hit.type.symbol)
            VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                Text(heading)
                    .font(HearthFont.cardTitle)
                    .lineLimit(2)
                if !hit.snippet.isEmpty, hit.snippet.filter({ $0 != "[" && $0 != "]" }) != heading {
                    Text(Snippet.attributed(hit.snippet, highlight: hearth.accent, title: hit.title))
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                        .lineLimit(3)
                }
                HStack(spacing: HearthSpacing.xs) {
                    Text(meta)
                        .lineLimit(1)
                    Spacer(minLength: HearthSpacing.sm)
                    matchBadge
                        .fixedSize()
                }
                .font(HearthFont.caption)
                .foregroundStyle(hearth.textTertiary)
            }
        }
        .padding(.vertical, HearthSpacing.sm)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// Untitled notes lead with the start of the note.
    private var heading: String {
        if !hit.title.isEmpty { return hit.title }
        let preview = hit.preview?.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces) ?? ""
        return preview.isEmpty ? hit.type.label : preview
    }

    private var meta: String {
        [hit.type.label, hit.project?.name].compactMap(\.self).joined(separator: " · ")
    }

    private var matchBadge: some View {
        let (symbol, label) = switch hit.match {
        case .keyword: ("textformat", "words")
        case .semantic: ("sparkle", "meaning")
        case .both: ("sparkles", "words + meaning")
        }
        return Label(label, systemImage: symbol)
            .labelStyle(.titleAndIcon)
            .accessibilityLabel("Matched on \(label)")
    }
}
