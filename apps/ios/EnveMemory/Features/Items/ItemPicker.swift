import EnveMemoryKit
import SwiftUI

/// Find an item to reference or connect: recent items, or search results as you type.
struct ItemPicker: View {
    struct Choice: Hashable {
        let id: String
        let title: String
    }

    let title: String
    var excluding: Set<String> = []
    let onPick: (Choice) -> Void

    @Environment(Connection.self) private var connection
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var query = ""
    @State private var choices: [Choice] = []
    @State private var cursor: String?
    @State private var limit = Self.pageSize
    @State private var hasMore = false
    @State private var loadingMore = false
    @State private var error: String?

    private static let pageSize = 30
    /// The most results one search returns; recent items page without a limit.
    private static let searchCap = 200

    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(hearth.danger) }
                Section(query.isEmpty ? "Recent" : "Matches") {
                    ForEach(choices.filter { !excluding.contains($0.id) }, id: \.id) { choice in
                        Button {
                            onPick(choice)
                            dismiss()
                        } label: {
                            Text(choice.title).lineLimit(2).foregroundStyle(hearth.textPrimary)
                        }
                    }
                    if hasMore {
                        Button { Task { await loadMore() } } label: {
                            if loadingMore { ProgressView().frame(maxWidth: .infinity) } else { Text("Show more") }
                        }
                        .disabled(loadingMore)
                        .accessibilityIdentifier("ItemPickerMore")
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search your memory")
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task(id: query) { await search() }
        }
        .tint(hearth.accent)
    }

    private var text: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func search() async {
        do {
            if !text.isEmpty { try await Task.sleep(for: .milliseconds(250)) }
            limit = Self.pageSize
            choices = []
            cursor = nil
            try await fetch()
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func loadMore() async {
        loadingMore = true
        defer { loadingMore = false }
        do {
            if !text.isEmpty { limit = min(limit * 2, Self.searchCap) }
            try await fetch()
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Recent items follow the `before` cursor; search has no offset, so a longer list asks again for more results.
    private func fetch() async throws {
        if text.isEmpty {
            let items = try await connection.load(.items(ItemFilter(limit: Self.pageSize, before: cursor)), as: [Item].self).value
            let seen = Set(choices.map(\.id))
            choices += items.filter { !$0.isSecret && !seen.contains($0.id) }.map { Choice(id: $0.id, title: $0.displayTitle) }
            cursor = items.last?.pageCursor
            hasMore = items.count == Self.pageSize
        } else {
            let hits = try await connection.load(.search(text, filter: ItemFilter(limit: limit)), as: [SearchHit].self).value
            choices = hits.map { Choice(id: $0.id, title: $0.title.isEmpty ? ($0.preview ?? $0.type.label) : $0.title) }
            hasMore = hits.count == limit && limit < Self.searchCap
        }
    }
}
