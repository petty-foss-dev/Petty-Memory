import EnveMemoryKit
import SwiftUI

/// An item's versions, newest first. Read live from the server; history is never kept on the phone.
struct HistoryView: View {
    let itemID: String

    @Environment(Connection.self) private var connection
    @Environment(\.hearth) private var hearth

    @State private var versions: [ItemVersionSummary] = []
    @State private var total = 0
    @State private var error: String?
    @State private var loaded = false
    @State private var loadingMore = false
    @State private var selected: ItemVersionSummary?

    private let pageSize = 30

    var body: some View {
        HearthScreen(title: "History", overline: "Versions") {
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            if !loaded, error == nil {
                ProgressView().frame(maxWidth: .infinity).padding(.top, HearthSpacing.xxxl)
            } else if versions.isEmpty, error == nil {
                EmptyStateView(symbol: "clock.arrow.circlepath", title: "No history yet", message: "Changes from now on are kept here.")
            } else {
                RowStack(data: versions) { version in
                    Button { selected = version } label: { VersionRow(version: version) }
                        .buttonStyle(.plain)
                }
                if versions.count < total {
                    Button { Task { await loadMore() } } label: {
                        if loadingMore { ProgressView() } else { Text("Show older") }
                    }
                    .buttonStyle(.hearthSecondary)
                    .disabled(loadingMore)
                } else if versions.last?.isBaseline == true {
                    Label("History starts here, when this library was upgraded. Its state then is kept as a starting point; earlier changes weren't recorded.",
                          systemImage: "info.circle")
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                }
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $selected) { version in
            VersionDetailView(summary: version, newest: versions.first, previous: previous(of: version))
                .environment(\.hearth, hearth)
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private func previous(of version: ItemVersionSummary) -> ItemVersionSummary? {
        guard let index = versions.firstIndex(of: version), index + 1 < versions.count else { return nil }
        return versions[index + 1]
    }

    private func load() async {
        guard let client = connection.client else { return }
        do {
            let page = try await client.send(.versions(itemID, limit: min(200, max(pageSize, versions.count))), as: VersionPage.self)
            versions = page.items
            total = page.total
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = (error as? APIError)?.allowsCachedFallback == true
                ? "History needs a connection to your server; it isn't kept on this phone."
                : error.localizedDescription
        }
        loaded = true
    }

    private func loadMore() async {
        guard let client = connection.client, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await client.send(.versions(itemID, offset: versions.count, limit: pageSize), as: VersionPage.self)
            let known = Set(versions.map(\.id))
            versions += page.items.filter { !known.contains($0.id) }
            total = page.total
        } catch {
            self.error = error.localizedDescription
        }
    }
}

extension ItemVersionSummary {
    var label: String {
        switch op {
        case "baseline": "Starting point"
        case "create": "Created"
        case "update": "Edited"
        case "move": "Moved"
        case "restore": "Restored"
        case "delete": "Deleted"
        case "archive": "Archived"
        case "unarchive": "Unarchived"
        case "check": "Checked off"
        case "present": "Style changed"
        case "tag": "Tags changed"
        case "pin", "unpin": "Pin changed"
        default: op.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

private struct VersionRow: View {
    let version: ItemVersionSummary

    @Environment(\.hearth) private var hearth

    var body: some View {
        HStack(spacing: HearthSpacing.md) {
            TypeGlyph(symbol: version.isBaseline ? "flag" : version.isDeletion ? "trash" : "clock")
            VStack(alignment: .leading, spacing: 2) {
                Text(version.label).font(HearthFont.subheadline)
                Text("\(version.at.formatted(date: .abbreviated, time: .shortened)) · \(version.actor)")
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(hearth.textTertiary)
        }
        .padding(.vertical, HearthSpacing.xs)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
