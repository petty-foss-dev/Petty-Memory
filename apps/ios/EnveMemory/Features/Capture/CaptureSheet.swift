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
    @Environment(\.scenePhase) private var scenePhase
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
    @State private var image: CapturedImage?
    @State private var processingImage = false
    @State private var dictation = Dictation()
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
                    fields.disabled(saving)
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
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
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
        .interactiveDismissDisabled(saving)
        .onAppear {
            kind = initialKind
            projectID = SharedSettings().lastProjectID.flatMap { id in projects.refs.contains { $0.id == id } ? id : nil }
        }
        .task {
            // Focus set during the sheet's presentation animation is dropped.
            try? await Task.sleep(for: .milliseconds(450))
            switch initialKind {
            case .link: focus = .url
            case .task: focus = .title
            case .note: focus = .text
            case .image: break
            }
        }
        .task { _ = try? await projects.load(connection) }
        .onChange(of: kind) { dictation.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { dictation.stop() }
        }
        .onDisappear {
            dictation.stop()
            // A queued upload has already moved its file into the outbox; anything left here is a discarded or sent copy.
            if let image { try? FileManager.default.removeItem(at: image.folder) }
        }
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
                .disabled(dictation.isListening)
                .accessibilityIdentifier("CaptureBody")
            NoteDictation(dictation: dictation, text: $text, disabled: saving)
        case .image:
            ImageCaptureFields(image: $image, text: $text, processing: $processingImage)
            TextField("Title (optional)", text: $title)
                .focused($focus, equals: .title)
                .hearthField()
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

    /// Dictation must be stopped first, so what was heard is checked before it's saved.
    private var canSave: Bool {
        guard !dictation.isListening, !processingImage else { return false }
        return switch kind {
        case .note: !trimmedText.isEmpty || !trimmedTitle.isEmpty
        case .link: linkURL != nil
        case .task: !trimmedTitle.isEmpty
        case .image: image != nil
        }
    }

    private func save() {
        guard canSave, !saving else { return }
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
        case .image:
            guard let image else { return }
            // The original image is uploaded as it was chosen, with the reviewed text as its note.
            endpoint = .upload(FileUpload(filename: image.filename, mimeType: image.mimeType, title: title, note: body, project: projectID,
                                          tags: tagList, remind: remindAt))
            label = title ?? image.filename
        }
        guard let endpoint else { return }
        let file = kind == .image ? image?.url : nil
        SharedSettings().lastProjectID = projectID
        saving = true
        Task {
            if remindAt != nil { await reminders.requestAuthorizationIfNeeded() }
            let outcome = await outbox.submit(endpoint, kind: OutboxEntry.Kind(kind), title: label, file: file)
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
        case .image: self = .file
        }
    }
}

/// Dictates into the note after what's already typed. It never saves; the person reviews the text and taps Save.
private struct NoteDictation: View {
    let dictation: Dictation
    @Binding var text: String
    let disabled: Bool

    @Environment(\.hearth) private var hearth
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.xs) {
            HStack(spacing: HearthSpacing.sm) {
                if dictation.isListening {
                    Button { dictation.stop() } label: {
                        Label("Stop", systemImage: "stop.circle.fill").foregroundStyle(hearth.danger)
                    }
                    .accessibilityLabel("Stop dictation")
                    .accessibilityIdentifier("CaptureDictateStop")
                    Label("Listening…", systemImage: "waveform")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textSecondary)
                        .symbolEffect(.variableColor.iterative, isActive: true)
                } else {
                    Button {
                        Task { await dictation.start(after: text) { text = $0 } }
                    } label: {
                        Label("Dictate", systemImage: "mic")
                    }
                    .disabled(disabled || !dictation.isAvailable)
                    .accessibilityIdentifier("CaptureDictate")
                }
            }
            .font(HearthFont.subheadline)
            if let problem = dictation.problem {
                HStack(alignment: .firstTextBaseline, spacing: HearthSpacing.sm) {
                    Text(problem.message)
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if problem.offersSettings, let settings = URL(string: UIApplication.openSettingsURLString) {
                        Button("Settings") { openURL(settings) }.font(HearthFont.caption)
                    }
                }
            }
            Text(dictation.disclosure)
                .font(HearthFont.caption)
                .foregroundStyle(hearth.textTertiary)
        }
    }
}
