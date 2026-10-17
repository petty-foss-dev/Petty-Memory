import EnveMemoryKit
import SwiftUI

/// Active tasks grouped by project. A List, for swipe-to-complete.
struct TasksView: View {
    @Environment(Connection.self) private var connection
    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth
    @Environment(\.bottomBarInset) private var bottomInset

    @State private var tasks: [Item] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var completing: Set<String> = []
    @State private var hasMore = false
    @State private var loadingMore = false
    @State private var cachedAt: Date?

    private let pageSize = 50

    private struct Group: Identifiable {
        let id: String
        let name: String
        let tasks: [Item]
    }

    var body: some View {
        List {
            header
                .listRowInsets(EdgeInsets(top: HearthSpacing.sm, leading: HearthSpacing.lg, bottom: HearthSpacing.sm, trailing: HearthSpacing.lg))
            if let cachedAt {
                CachedBanner(savedAt: cachedAt)
                    .listRowInsets(rowInsets)
            }
            if let error {
                ErrorBanner(message: error) { Task { await load() } }
                    .listRowInsets(rowInsets)
            }
            if loaded, tasks.isEmpty, error == nil {
                EmptyStateView(symbol: "checkmark.seal", title: "All clear", message: "No open tasks. Add one with the + button.")
            }
            ForEach(groups) { group in
                Section {
                    ForEach(group.tasks) { task in
                        row(task)
                    }
                } header: {
                    Text(group.name)
                        .font(HearthFont.sectionTitle)
                        .foregroundStyle(hearth.textPrimary)
                        .textCase(nil)
                        .padding(.top, HearthSpacing.sm)
                }
            }
            if hasMore {
                // The List is lazy, so this row appears only when scrolled to the end.
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .task { await loadMore() }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listSectionSeparator(.hidden)
        .safeAreaPadding(.bottom, bottomInset)
        .hearthChrome()
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private var rowInsets: EdgeInsets {
        EdgeInsets(top: HearthSpacing.xs, leading: HearthSpacing.lg, bottom: HearthSpacing.xs, trailing: HearthSpacing.lg)
    }

    private var header: some View {
        HStack(alignment: .lastTextBaseline) {
            Text("Tasks")
                .font(HearthFont.screenTitle)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            Button { router.capture = .task } label: {
                Image(systemName: "plus")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(hearth.onAccent)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(hearth.accent))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New task")
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    private func row(_ task: Item) -> some View {
        TaskRow(task: task, isCompleting: completing.contains(task.id),
                onComplete: { complete(task) }, onOpen: { router.open(.item(task.id)) })
            .padding(.horizontal, HearthSpacing.md)
            .background(RoundedRectangle(cornerRadius: HearthRadius.inner, style: .continuous).fill(hearth.surface))
            .overlay(RoundedRectangle(cornerRadius: HearthRadius.inner, style: .continuous).strokeBorder(hearth.hairline))
            .listRowInsets(rowInsets)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button { complete(task) } label: { Label("Complete", systemImage: "checkmark") }
                    .tint(hearth.accent)
            }
    }

    private var groups: [Group] {
        var order: [String] = []
        var buckets: [String: (String, [Item])] = [:]
        for task in tasks {
            let key = task.project?.id ?? ""
            if buckets[key] == nil {
                order.append(key)
                buckets[key] = (task.project?.name ?? "No project", [])
            }
            buckets[key]?.1.append(task)
        }
        return order
            .sorted { lhs, rhs in lhs.isEmpty != rhs.isEmpty ? !lhs.isEmpty : buckets[lhs]!.0.localizedCompare(buckets[rhs]!.0) == .orderedAscending }
            .map { Group(id: $0, name: buckets[$0]!.0, tasks: buckets[$0]!.1) }
    }

    private func load() async {
        guard connection.client != nil else { return }
        do {
            let loaded = try await connection.load(.tasks(status: .active, limit: pageSize), as: [Item].self)
            let page = loaded.value
            tasks = page
            cachedAt = loaded.cachedAt
            hasMore = page.count == pageSize && loaded.cachedAt == nil
            completing = []
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func loadMore() async {
        guard let client = connection.client, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await client.tasks(status: .active, limit: pageSize, offset: tasks.count)
            let known = Set(tasks.map(\.id))
            tasks += page.filter { !known.contains($0.id) }
            hasMore = page.count == pageSize
        } catch is CancellationError {
            return
        } catch {
            hasMore = false
            self.error = error.localizedDescription
        }
    }

    private func complete(_ task: Item) {
        guard !completing.contains(task.id) else { return }
        completing.insert(task.id)
        Task {
            if await !TaskCompleter(outbox: outbox, router: router).complete(task) {
                completing.remove(task.id)
            }
        }
    }
}
