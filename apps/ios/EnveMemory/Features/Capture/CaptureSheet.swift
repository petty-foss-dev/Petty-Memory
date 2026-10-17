import EnveMemoryKit
import SwiftUI

struct CaptureSheet: View {
    let initialKind: CaptureKind

    @Environment(OutboxService.self) private var outbox
    @Environment(ProjectStore.self) private var projects
    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth
    @Environment(\.dismiss) private var dismiss
    @Environment(ReminderScheduler.self) private var reminders

    @State private var kind: CaptureKind = .note
    @State private var title = ""
    @State private var text = ""
    @State private var url = ""
    @State private var projectID: String?
    @State private var tags = ""
    @State private var hasDue = false
    @State private var due = Calendar.current.date(byAdding: .day, value: 1, to: .now) ?? .now
    @State private var priority = TaskPriority.normal
    @State private var intent: Intent?
    @State private var remind: ReminderPreset?
    @State private var saving = false
    @FocusState private var focus: Field?

    enum Field { case title, text, url }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: HearthSpacing.lg) {
                    Picker("Kind", selection: $kind) {
                        ForEach(CaptureKind.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    fields
                    if kind == .link {
                        Overline("Keep it for")
                        IntentChips(intent: $intent)
                    }
                    if kind != .task {
                        Overline("Remind me")
                        ReminderChips(preset: $remind)
                    }
                    ProjectPicker(projectID: $projectID, projects: projects.refs)
                    TextField("Tags, comma separated", text: $tags)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .hearthField()
                }
                .padding(HearthSpacing.lg)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(hearth.background.ignoresSafeArea())
            .navigationTitle("New \(kind.title.lowercased())")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .fontWeight(.semibold)
                        .disabled(!canSave || saving)
                        .accessibilityIdentifier("CaptureSave")
                }
            }
        }
        .tint(hearth.accent)
        .presentationDetents([.large])
        .onAppear {
            kind = initialKind
            projectID = SharedSettings().lastProjectID.flatMap { id in projects.refs.contains { $0.id == id } ? id : nil }
        }
        .task {
            // Focus set during the sheet's presentation animation is dropped.
            try? await Task.sleep(for: .milliseconds(450))
            focus = initialKind == .link ? .url : initialKind == .task ? .title : .text
        }
        .task { _ = try? await projects.load(connection) }
    }

    @ViewBuilder
    private var fields: some View {
        switch kind {
        case .note:
            TextField("Title (optional)", text: $title)
                .focused($focus, equals: .title)
                .hearthField()
            TextField("What's on your mind?", text: $text, axis: .vertical)
                .lineLimit(6...16)
                .focused($focus, equals: .text)
                .hearthField()
                .accessibilityIdentifier("CaptureBody")
        case .link:
            TextField("https://", text: $url)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focus, equals: .url)
                .hearthField()
            TextField("Title (optional)", text: $title)
                .focused($focus, equals: .title)
                .hearthField()
            TextField("Why you're saving it (optional)", text: $text, axis: .vertical)
                .lineLimit(3...10)
                .focused($focus, equals: .text)
                .hearthField()
        case .task:
            TextField("What needs doing?", text: $title)
                .focused($focus, equals: .title)
                .hearthField()
                .accessibilityIdentifier("CaptureTaskTitle")
            TextField("Notes (optional)", text: $text, axis: .vertical)
                .lineLimit(3...10)
                .focused($focus, equals: .text)
                .hearthField()
            HearthCard(padding: HearthSpacing.md) {
                VStack(alignment: .leading, spacing: HearthSpacing.md) {
                    Toggle("Due date", isOn: $hasDue)
                    if hasDue {
                        DatePicker("Due", selection: $due, displayedComponents: .date)
                    }
                    Picker("Priority", selection: $priority) {
                        ForEach(TaskPriority.all, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
            }
        }
    }

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedText: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var linkURL: URL? { URL.web(url) }

    private var canSave: Bool {
        switch kind {
        case .note: !trimmedText.isEmpty || !trimmedTitle.isEmpty
        case .link: linkURL != nil
        case .task: !trimmedTitle.isEmpty
        }
    }

    private func save() {
        let remindAt = kind == .task ? nil : remind?.date()
        let tagList = Tags.parse(tags)
        let title = trimmedTitle.isEmpty ? nil : trimmedTitle
        let body = trimmedText.isEmpty ? nil : trimmedText
        let endpoint: Endpoint?
        let label: String
        switch kind {
        case .note:
            endpoint = try? .capture(CaptureRequest(title: title, note: body ?? "", project: projectID, tags: tagList.isEmpty ? nil : tagList,
                                                    remind: remindAt))
            label = title ?? String((body ?? "").prefix(60))
        case .link:
            let link = linkURL?.absoluteString ?? url
            endpoint = try? .capture(CaptureRequest(url: link, title: title, note: body, project: projectID, tags: tagList.isEmpty ? nil : tagList,
                                                    intent: intent, remind: remindAt))
            label = title ?? link
        case .task:
            endpoint = try? .createItem(NewItemRequest(type: .task, title: title, body: body, project: projectID, tags: tagList,
                                                       due: hasDue ? DueDate.format(due) : nil, priority: priority))
            label = title ?? "Task"
        }
        guard let endpoint else { return }
        SharedSettings().lastProjectID = projectID
        saving = true
        Task {
            if remindAt != nil { await reminders.requestAuthorizationIfNeeded() }
            let outcome = await outbox.submit(endpoint, kind: OutboxEntry.Kind(kind), title: label)
            if let remindAt {
                switch outcome {
                case .sent(let data): await LocalReminders.schedule(after: data, queued: nil, title: label, at: remindAt)
                case .queued(let entry): await LocalReminders.schedule(after: nil, queued: entry, title: label, at: remindAt)
                case .failed: break
                }
            }
            saving = false
            if router.report(outcome, sent: "\(kind.title) saved") { dismiss() }
        }
    }
}

extension OutboxEntry.Kind {
    init(_ kind: CaptureKind) {
        switch kind {
        case .note: self = .note
        case .link: self = .link
        case .task: self = .task
        }
    }
}
