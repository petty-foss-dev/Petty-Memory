import EnveMemoryKit
import SwiftUI

extension SavedView {
    func summary(projectName: (String) -> String?) -> String {
        var parts: [String] = []
        if !query.isEmpty { parts.append("“\(query)”") }
        if let project = filter.project { parts.append(projectName(project) ?? "A project") }
        if filter.inbox == true { parts.append("Inbox") }
        if let type = filter.type { parts.append(type.label) }
        if let status = filter.taskStatus { parts.append(status.label) }
        if let tag = filter.tag { parts.append("#\(tag)") }
        if filter.pinned == true { parts.append("Pinned") }
        if let intent = filter.intent { parts.append(intent.label) }
        if let days = filter.unopenedDays { parts.append("Unopened \(days)+ days") }
        if filter.reminders == true { parts.append("Has a reminder") }
        if filter.review == true { parts.append("Marked for review") }
        if let attention = filter.attention { parts.append("\(attention.rawValue.capitalized) attention") }
        return parts.isEmpty ? "Everything, newest first" : parts.joined(separator: " · ")
    }
}

extension TaskStatus {
    static let all: [TaskStatus] = [.open, .inProgress, .done, .cancelled]
    var label: String { rawValue.replacingOccurrences(of: "_", with: " ").capitalized }
}

struct SavedViewsView: View {
    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(ProjectStore.self) private var projects
    @Environment(\.hearth) private var hearth

    @State private var views: [SavedView] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var cachedAt: Date?
    @State private var creating = false

    var body: some View {
        HearthScreen(title: "Saved views", overline: "Library") {
            if let cachedAt { SavedResultsBanner(savedAt: cachedAt) }
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            Button { creating = true } label: { Label("New view", systemImage: "plus") }
                .buttonStyle(.hearthPrimary)
                .disabled(connection.onlineOnlyReason != nil)
                .accessibilityIdentifier("NewSavedView")
            if let reason = connection.onlineOnlyReason { OnlineOnlyNote(reason: reason) }
            if views.isEmpty {
                if loaded, error == nil {
                    EmptyStateView(symbol: "line.3.horizontal.decrease.circle", title: "No saved views yet",
                                   message: "Keep a search and filters together, like open tasks in a project tagged “hardware”, or everything marked for review. Your server works out the results, newest first.")
                }
            } else {
                RowStack(data: views) { view in
                    Button { router.open(.savedView(view.id)) } label: {
                        HStack(alignment: .top, spacing: HearthSpacing.md) {
                            TypeGlyph(symbol: "line.3.horizontal.decrease.circle")
                            VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                                Text(view.name).font(HearthFont.cardTitle).foregroundStyle(hearth.textPrimary).lineLimit(2)
                                Text(view.summary { projects.name(for: $0) })
                                    .font(HearthFont.caption)
                                    .foregroundStyle(hearth.textTertiary)
                                    .lineLimit(2)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, HearthSpacing.sm)
                        .contentShape(Rectangle())
                        .accessibilityElement(children: .combine)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $creating) {
            SavedViewForm(existing: nil) { router.open(.savedView($0.id)) }
                .environment(\.hearth, hearth)
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private func load() async {
        guard connection.client != nil else { return }
        do {
            let loaded = try await connection.load(.views, as: [SavedView].self)
            views = loaded.value
            cachedAt = loaded.cachedAt
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
            connection.note(error)
        }
        loaded = true
    }
}

/// One saved view's results, newest first, paged with the server's `next` cursor.
struct SavedViewResultsView: View {
    let viewID: String

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(ProjectStore.self) private var projects
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var view: SavedView?
    @State private var items: [Item] = []
    @State private var next: String?
    @State private var cachedAt: Date?
    @State private var error: String?
    @State private var loaded = false
    @State private var loadingMore = false
    @State private var editing = false
    @State private var confirmingRemove = false
    @State private var removing = false

    private let pageSize = 50

    var body: some View {
        HearthScreen(title: view?.name ?? "Saved view", overline: "Saved view") {
            if let cachedAt { SavedResultsBanner(savedAt: cachedAt) }
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            if let view {
                Text(view.summary { projects.name(for: $0) })
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                    .accessibilityIdentifier("SavedViewSummary")
            }
            if items.isEmpty {
                if loaded, error == nil {
                    EmptyStateView(symbol: "line.3.horizontal.decrease.circle", title: "Nothing matches right now",
                                   message: "Results follow your library as it changes. Edit the view to widen its search or filters.")
                }
            } else {
                RowStack(data: items) { item in
                    Button { router.open(.item(item.id)) } label: { ItemRow(item: item) }
                        .buttonStyle(.plain)
                }
                if next != nil, cachedAt == nil {
                    Button { Task { await loadMore() } } label: {
                        if loadingMore { ProgressView() } else { Text("Show more") }
                    }
                    .buttonStyle(.hearthSecondary)
                    .disabled(loadingMore)
                    .accessibilityIdentifier("SavedViewShowMore")
                } else if next != nil {
                    Text("More results load when you're connected.")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textTertiary)
                }
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Edit view", systemImage: "pencil") { editing = true }
                    Button("Remove view", systemImage: "trash", role: .destructive) { confirmingRemove = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .disabled(view == nil || connection.onlineOnlyReason != nil || removing)
                .accessibilityLabel(connection.isOnline ? "View actions" : "View actions, need a connection")
                .accessibilityIdentifier("SavedViewMenu")
            }
        }
        .confirmationDialog("Remove “\(view?.name ?? "this view")”?", isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Remove view", role: .destructive, action: remove)
        } message: {
            Text("Only the saved view goes. The items it shows stay in your library.")
        }
        .sheet(isPresented: $editing) {
            if let view {
                SavedViewForm(existing: view) { self.view = $0 }
                    .environment(\.hearth, hearth)
            }
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private func load() async {
        guard connection.client != nil, !removing else { return }
        do {
            let definition = try await connection.load(.view(viewID), as: SavedView.self)
            let page = try await connection.load(.viewItems(viewID, limit: pageSize), as: ViewPage.self)
            view = definition.value
            items = page.value.items
            next = page.value.next
            cachedAt = page.cachedAt ?? definition.cachedAt
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
            connection.note(error)
        }
        loaded = true
    }

    private func loadMore() async {
        guard let client = connection.client, let cursor = next, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await client.send(.viewItems(viewID, before: cursor, limit: pageSize), as: ViewPage.self)
            let known = Set(items.map(\.id))
            items += page.items.filter { !known.contains($0.id) }
            next = page.next
        } catch {
            router.show(error.onlineOnlyMessage)
            connection.note(error)
        }
    }

    private func remove() {
        guard let client = connection.client else { return }
        removing = true
        Task {
            do {
                _ = try await client.data(for: .removeView(viewID))
                dismiss()
                connection.didWrite()
                router.show("Saved view removed")
            } catch {
                removing = false
                connection.note(error)
                router.show(error.onlineOnlyMessage)
            }
        }
    }
}

/// Create or edit a saved view: a name, optional words to match, and filters that all have to hold.
struct SavedViewForm: View {
    let existing: SavedView?
    let saved: (SavedView) -> Void

    enum Scope: Hashable {
        case any, inbox
        case project(String)
    }

    @Environment(Connection.self) private var connection
    @Environment(ProjectStore.self) private var projects
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var name: String
    @State private var query: String
    @State private var scope: Scope
    @State private var type: ItemType?
    @State private var taskStatus: TaskStatus?
    @State private var tag: String
    @State private var intent: Intent?
    @State private var attention: ItemPresentation.Attention?
    @State private var pinned: Bool
    @State private var reminders: Bool
    @State private var review: Bool
    @State private var unopened: Bool
    @State private var unopenedDays: Int
    @State private var saving = false
    @State private var error: String?

    init(existing: SavedView?, saved: @escaping (SavedView) -> Void) {
        self.existing = existing
        self.saved = saved
        let filter = existing?.filter ?? SavedViewFilter()
        _name = State(initialValue: existing?.name ?? "")
        _query = State(initialValue: existing?.query ?? "")
        _scope = State(initialValue: filter.project.map(Scope.project) ?? (filter.inbox == true ? .inbox : .any))
        _type = State(initialValue: filter.type)
        _taskStatus = State(initialValue: filter.taskStatus)
        _tag = State(initialValue: filter.tag ?? "")
        _intent = State(initialValue: filter.intent)
        _attention = State(initialValue: filter.attention)
        _pinned = State(initialValue: filter.pinned == true)
        _reminders = State(initialValue: filter.reminders == true)
        _review = State(initialValue: filter.review == true)
        _unopened = State(initialValue: filter.unopenedDays != nil)
        _unopenedDays = State(initialValue: filter.unopenedDays ?? 30)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let reason = connection.onlineOnlyReason {
                    Section { OnlineOnlyNote(reason: reason) }
                }
                Section {
                    TextField("Name", text: $name, prompt: Text("Open relay work"))
                        .accessibilityIdentifier("SavedViewName")
                    TextField("Words to match", text: $query, prompt: Text("Words to match (optional)"))
                        .textInputAutocapitalization(.never)
                        .accessibilityIdentifier("SavedViewQuery")
                } footer: {
                    if trimmedName.count > SavedViewInput.maxName {
                        Text("Names can be up to \(SavedViewInput.maxName) characters.").foregroundStyle(hearth.danger)
                    } else if trimmedQuery.count > SavedViewInput.maxQuery {
                        Text("Words to match can be up to \(SavedViewInput.maxQuery) characters.").foregroundStyle(hearth.danger)
                    } else {
                        Text("Keywords match saved titles, notes, addresses and archived text. Every filter must match. Secret notes, archived items, saved views and templates never show.")
                    }
                }
                Section("Filters") {
                    Picker("Project", selection: $scope) {
                        Text("Any").tag(Scope.any)
                        Text("Inbox").tag(Scope.inbox)
                        ForEach(projects.refs, id: \.id) { Text($0.name).tag(Scope.project($0.id)) }
                        if case .project(let id) = scope, projects.name(for: id) == nil {
                            Text("Current project").tag(scope)
                        }
                    }
                    Picker("Type", selection: $type) {
                        Text("Any").tag(ItemType?.none)
                        ForEach(ItemType.filterable, id: \.self) { Text($0.label).tag(Optional($0)) }
                    }
                    Picker("Task status", selection: $taskStatus) {
                        Text("Any").tag(TaskStatus?.none)
                        ForEach(TaskStatus.all, id: \.self) { Text($0.label).tag(Optional($0)) }
                    }
                    TextField("Tag", text: $tag, prompt: Text("Tag (optional)"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Picker("Intent", selection: $intent) {
                        Text("Any").tag(Intent?.none)
                        ForEach(Intent.all, id: \.self) { Text($0.label).tag(Optional($0)) }
                    }
                    Picker("Attention", selection: $attention) {
                        Text("Any").tag(ItemPresentation.Attention?.none)
                        ForEach(ItemPresentation.Attention.allCases, id: \.self) { Text($0.rawValue.capitalized).tag(Optional($0)) }
                    }
                }
                Section {
                    Toggle("Pinned", isOn: $pinned)
                    Toggle("Has a reminder", isOn: $reminders)
                    Toggle("Marked for review", isOn: $review)
                    Toggle("Unopened links", isOn: $unopened)
                    if unopened {
                        TextField("Minimum age (days)", value: $unopenedDays, format: .number)
                            .keyboardType(.numberPad)
                        if !(0...36500).contains(unopenedDays) {
                            Text("Choose 0 to 36,500 days.").foregroundStyle(hearth.danger)
                        }
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(hearth.danger) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(hearth.background)
            .navigationTitle(existing == nil ? "New view" : "Edit view")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save", action: save)
                        .disabled(!canSave)
                        .accessibilityIdentifier("SavedViewSave")
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(saving)
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedTag: String { tag.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var canSave: Bool {
        !saving && connection.onlineOnlyReason == nil && !trimmedName.isEmpty && trimmedName.count <= SavedViewInput.maxName
            && trimmedQuery.count <= SavedViewInput.maxQuery && (!unopened || (0...36500).contains(unopenedDays))
    }

    private var filter: SavedViewFilter {
        var project: String?
        if case .project(let id) = scope { project = id }
        return SavedViewFilter(project: project, inbox: scope == .inbox ? true : nil, type: type, tag: trimmedTag.isEmpty ? nil : trimmedTag,
                               taskStatus: taskStatus, pinned: pinned ? true : nil, intent: intent, unopenedDays: unopened ? unopenedDays : nil,
                               reminders: reminders ? true : nil, review: review ? true : nil, attention: attention)
    }

    private func save() {
        guard let client = connection.client else { return }
        saving = true
        error = nil
        Task {
            defer { saving = false }
            do {
                let input = SavedViewInput(name: trimmedName, query: trimmedQuery, filter: filter)
                let endpoint = try existing.map { try Endpoint.updateView($0.id, input) } ?? Endpoint.createView(input)
                let view = try await client.send(endpoint, as: SavedView.self)
                connection.didWrite()
                dismiss()
                saved(view)
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }
}
