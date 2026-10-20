import EnveMemoryKit
import SwiftUI

/// What the AI is asked about. Changing any of it starts a new conversation.
struct ChatContext: Equatable {
    enum Source: String { case branch, topic }

    var mode: ChatMode = .ask
    var projectID: String?
    var scope: ItemPicker.Choice?
    /// Where the actions mode looks: the chosen notes, or every note matching a topic.
    var source: Source = .branch
    var topic = ""

    var trimmedTopic: String { topic.trimmingCharacters(in: .whitespacesAndNewlines) }
    var usesBranch: Bool { mode == .edit || (mode == .actions && source == .branch) }
    var usesTopic: Bool { mode == .actions && source == .topic }

    var requestProject: String? { mode == .ask || usesTopic ? projectID : nil }
    var requestRoot: String? { usesBranch ? scope?.id : nil }
    var requestQuery: String? { usesTopic ? trimmedTopic : nil }

    var isReady: Bool { usesBranch ? scope != nil : (!usesTopic || !trimmedTopic.isEmpty) }
}

/// The conversation lives only on this screen until the user saves it; nothing is cached or queued.
struct AIChatView: View {
    let savedConversationID: String?
    private let meetingSeed: MeetingChatSeed?

    /// A meeting seed sets the starting context and draft once; it's never sent on its own.
    init(savedConversationID: String? = nil, meetingSeed: MeetingChatSeed? = nil) {
        self.savedConversationID = savedConversationID
        self.meetingSeed = meetingSeed
        if let meetingSeed {
            _context = State(initialValue: meetingSeed.context)
            _draft = State(initialValue: meetingSeed.prompt)
        }
    }

    @Environment(Connection.self) private var connection
    @Environment(ProjectStore.self) private var projects
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    @State private var context = ChatContext()
    /// Set while a saved conversation's context is applied, so applying it doesn't start over.
    @State private var restoredContext: ChatContext?
    @State private var turns: [ChatTurn] = []
    @State private var conversation = UUID()
    @State private var draft = ""
    @State private var pending: String?
    @State private var error: String?
    @State private var omitted = 0
    @State private var startedOver = false
    @State private var status: AIStatus?
    @State private var statusError: String?
    @State private var choosingScope = false
    @State private var confirmingNewChat = false
    @State private var reviewing: ChatTurn?
    @State private var organized: [ChatTurn.ID: OrganizationResult] = [:]
    @State private var acted: [ChatTurn.ID: ActionResult] = [:]
    @State private var undoneActions: Set<ChatTurn.ID> = []
    @State private var dictation = Dictation()
    @State private var saved: SavedChat?
    @State private var naming = false
    @State private var title = ""
    @State private var saving = false
    @State private var savedAnswers: Set<ChatTurn.ID> = []
    @State private var browsing = false
    @State private var resuming = false
    @State private var resumedInitial = false
    /// Saved preferences without a project; organize requests across the library can use only these.
    @State private var organizePreferences: [OrganizationPreference] = []
    @State private var chosenPreferences: Set<String> = []

    /// The saved copy this conversation updates, and how many exchanges it held when saved.
    struct SavedChat {
        let id: String
        let title: String
        let turnCount: Int
    }

    var body: some View {
        HearthScreen(title: "AI chat", overline: "Library") {
            ProviderDisclosure(status: status, error: statusError, isOnline: connection.isOnline) { Task { await loadStatus() } }
            controls
            if let meetingSeed, meetingSeed.context == context, turns.isEmpty, pending == nil {
                Label("Drafted from your meeting “\(meetingSeed.title)”. Check the message below, then send it; nothing is sent until you do.",
                      systemImage: "person.2.wave.2")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                    .accessibilityIdentifier("ChatMeetingSeed")
            }
            if let saved { savedNote(saved) }
            if startedOver, turns.isEmpty, pending == nil {
                Label("New conversation. Changes you already applied stay in your notes.", systemImage: "arrow.counterclockwise")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                    .accessibilityIdentifier("ChatStartedOver")
            }
            if resuming { ProgressView().frame(maxWidth: .infinity) }
            ForEach(turns) { turn in
                QuestionBubble(text: turn.question)
                ReplyCard(turn: turn, organized: organized[turn.id], acted: acted[turn.id], actionsUndone: undoneActions.contains(turn.id), answerSaved: savedAnswers.contains(turn.id),
                          canSaveAnswer: writeBlocked == nil, review: { reviewing = turn }, saveAnswer: { saveAnswer(turn) })
            }
            if let pending {
                QuestionBubble(text: pending)
                Label { Text("Thinking…") } icon: { ProgressView() }
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                    .accessibilityIdentifier("ChatPending")
            }
            if turns.isEmpty, pending == nil { starters }
            if omitted > 0 {
                Text("This conversation is long, so its oldest \(omitted) messages weren't sent with the last one. Start a new chat to begin fresh.")
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textTertiary)
                    .accessibilityIdentifier("ChatHistoryNotice")
            }
            if let error { ErrorBanner(message: error) }
            if let blocked { OnlineOnlyNote(reason: blocked) }
            if !turns.isEmpty, let writeBlocked { OnlineOnlyNote(reason: writeBlocked) }
            composer
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Saved chats", systemImage: "tray.full") { browsing = true }
                    .disabled(pending != nil)
                    .accessibilityIdentifier("ChatSavedList")
            }
            ToolbarItem(placement: .primaryAction) {
                Button(saved == nil ? "Save chat" : "Update saved chat", systemImage: "square.and.arrow.down", action: beginSave)
                    .disabled(turns.isEmpty || pending != nil || saving || writeBlocked != nil)
                    .accessibilityIdentifier("ChatSave")
            }
            ToolbarItem(placement: .primaryAction) {
                Button("New chat", systemImage: "square.and.pencil") { confirmingNewChat = true }
                    .disabled(turns.isEmpty || pending != nil)
                    .accessibilityIdentifier("ChatNew")
            }
        }
        .confirmationDialog("Start a new chat?", isPresented: $confirmingNewChat, titleVisibility: .visible) {
            Button("Start new chat") { startOver() }
                .accessibilityIdentifier("ChatNewConfirm")
        } message: {
            Text(isDirty ? "This conversation isn't saved and is cleared from this screen. Changes you already applied stay in your notes."
                         : "This conversation is cleared from this screen. Changes you already applied stay in your notes.")
        }
        .alert(saved == nil ? "Save conversation" : "Update saved conversation", isPresented: $naming) {
            TextField("Title", text: $title)
            Button("Save", action: save)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(saveMessage)
        }
        .sheet(isPresented: $choosingScope) {
            ItemPicker(title: context.mode == .edit ? "Notes to change" : "Notes to act on", type: .note) { context.scope = $0 }
                .environment(\.hearth, hearth)
        }
        .sheet(isPresented: $browsing) {
            NavigationStack {
                SavedChatsView(currentID: saved?.id, replacesUnsaved: hasUnsavedWork) { id in
                    browsing = false
                    Task { await resume(id) }
                }
            }
            .environment(\.hearth, hearth)
        }
        .sheet(item: $reviewing) { turn in
            Group {
                switch turn.reply {
                case .answer: EmptyView()
                case .proposal(let proposal): AIEditSheet(rootID: proposal.rootId, initialProposal: proposal)
                case .organization(let proposal):
                    OrganizationReviewSheet(proposal: proposal, result: Binding(get: { organized[turn.id] }, set: { organized[turn.id] = $0 }))
                case .actions(let proposal):
                    ActionReviewSheet(proposal: proposal, result: Binding(get: { acted[turn.id] }, set: { result in
                        if result == nil, acted[turn.id] != nil { undoneActions.insert(turn.id) }
                        acted[turn.id] = result
                    }))
                }
            }
            .environment(\.hearth, hearth)
        }
        .onChange(of: context) { _, new in
            if new == restoredContext { restoredContext = nil } else { startOver() }
        }
        .onChange(of: connection.pairing) {
            startOver()
            status = nil
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { dictation.stop() }
        }
        .onDisappear { dictation.stop() }
        .task(id: connection.isOnline) { await loadStatus() }
        .task(id: PreferenceTrigger(mode: context.mode, isOnline: connection.isOnline)) { await loadPreferences() }
        .task {
            guard !resumedInitial, let savedConversationID else { return }
            resumedInitial = true
            await resume(savedConversationID)
        }
    }

    @ViewBuilder
    private var controls: some View {
        Picker("Mode", selection: $context.mode) {
            Text("Ask").tag(ChatMode.ask)
            Text("Change notes").tag(ChatMode.edit)
            Text("Organize").tag(ChatMode.organize)
            Text("Actions").tag(ChatMode.actions)
        }
        .pickerStyle(.segmented)
        .disabled(pending != nil)
        .accessibilityIdentifier("ChatMode")
        switch context.mode {
        case .ask:
            help("Answers come only from your library, with numbered sources you can open.")
            projectPicker
        case .edit:
            help("The AI proposes changes to the note you choose and the notes inside it. You review each one; nothing changes until you apply it, and nothing is deleted.")
            scopeButton
        case .organize:
            help("Say which notes and how, for example “Organize all notes about gardening into a PARA system.” The AI finds every matching note across your library and proposes headings and a place for each. Moving a note brings the notes inside it along, and projects stay as they are. Nothing moves until you review and apply it.")
                .accessibilityIdentifier("ChatOrganizeHelp")
            PreferenceSelection(preferences: organizePreferences, selected: $chosenPreferences,
                                explanation: "Tick saved preferences to send with your next request. Only ones without a project apply across the library; nothing is used unless you tick it.")
                .disabled(pending != nil)
                .accessibilityIdentifier("ChatOrganizePreferences")
        case .actions:
            help("The AI proposes tasks, tags, reminders and a short brief from the notes you choose or every note about a topic. You review each one; nothing changes until you apply it, and nothing is deleted.")
                .accessibilityIdentifier("ChatActionsHelp")
            Picker("Look at", selection: $context.source) {
                Text("Chosen notes").tag(ChatContext.Source.branch)
                Text("A topic").tag(ChatContext.Source.topic)
            }
            .pickerStyle(.segmented)
            .disabled(pending != nil)
            .accessibilityIdentifier("ChatActionSource")
            if context.source == .branch {
                scopeButton
            } else {
                TextField("Topic, for example “garden”", text: $context.topic)
                    .hearthField()
                    .disabled(pending != nil)
                    .accessibilityIdentifier("ChatTopic")
                projectPicker
            }
        }
    }

    private func help(_ text: String) -> some View {
        Text(text)
            .font(HearthFont.footnote)
            .foregroundStyle(hearth.textSecondary)
    }

    private var projectPicker: some View {
        HStack {
            Text("Search in").font(HearthFont.subheadline)
            Spacer()
            Picker("Search in", selection: $context.projectID) {
                Text("All projects").tag(String?.none)
                ForEach(projects.refs, id: \.id) { Text($0.name).tag(Optional($0.id)) }
            }
            .disabled(pending != nil)
            .accessibilityIdentifier("ChatProject")
        }
    }

    private var scopeButton: some View {
        Button { choosingScope = true } label: {
            Label(context.scope.map { "\(context.mode == .edit ? "Changing" : "Looking at") “\($0.title)”" } ?? "Choose notes",
                  systemImage: "list.bullet.indent")
                .lineLimit(2)
        }
        .buttonStyle(.hearthSecondary)
        .disabled(pending != nil)
        .accessibilityIdentifier("ChatScope")
    }

    private func savedNote(_ saved: SavedChat) -> some View {
        Label {
            Text(isDirty ? "Saved as “\(saved.title)”. Newer messages aren't saved yet; tap Save to update it."
                         : "Saved as “\(saved.title)”. Proposals are kept as summaries and can't be applied again from a saved chat.")
        } icon: {
            Image(systemName: "tray.full")
        }
        .font(HearthFont.footnote)
        .foregroundStyle(hearth.textSecondary)
        .accessibilityIdentifier("ChatSavedNote")
    }

    @ViewBuilder
    private var starters: some View {
        let options: [(String, String)] = switch context.mode {
        case .ask: [
            ("What have I saved about…", "What have I saved about "),
            ("What did I decide about…", "What did I decide about "),
            ("Summarize my notes on…", "Summarize my notes on "),
        ]
        case .edit: [
            ("Organize notes", "Organize these notes: group related ones under headings and put them in a sensible order."),
            ("Correct wording", "Correct spelling, grammar and wording without changing the meaning."),
            ("Turn into checklist", "Turn this into a checklist."),
        ]
        case .organize: [
            ("Organize notes about…", "Organize all notes about "),
            ("Example: gardening into PARA", "Organize all notes about gardening into a PARA system."),
        ]
        case .actions: [
            ("Tasks for open loops", "Suggest tasks for anything these notes leave unfinished."),
            ("Suggest tags", "Suggest tags that would help me find these notes again."),
            ("Reminders to revisit", "Suggest reminders for notes worth revisiting soon."),
            ("Write a brief", "Write a short brief that sums up these notes."),
        ]
        }
        FlowLayout(spacing: HearthSpacing.sm) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                FilterChip(title: option.0, isSelected: false) {
                    dictation.stop()
                    draft = option.1
                }
            }
        }
        .disabled(dictation.isListening)
    }

    private var composer: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                TextField(placeholder, text: $draft, axis: .vertical)
                    .lineLimit(1...8)
                    .font(HearthFont.body)
                    .disabled(pending != nil || dictation.isListening)
                    .accessibilityIdentifier("ChatDraft")
                if ChatRequest.length(draft) > ChatRequest.maxMessageLength - 500 {
                    Text("\(ChatRequest.length(draft)) of \(ChatRequest.maxMessageLength) characters")
                        .font(HearthFont.caption)
                        .foregroundStyle(ChatRequest.length(draft) > ChatRequest.maxMessageLength ? hearth.danger : hearth.textTertiary)
                }
                HStack(spacing: HearthSpacing.sm) {
                    dictateButton
                    Spacer()
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(canSend ? hearth.accent : hearth.textTertiary)
                    }
                    .disabled(!canSend)
                    .accessibilityLabel("Send")
                    .accessibilityIdentifier("ChatSend")
                }
                dictationNotes
            }
        }
    }

    @ViewBuilder
    private var dictateButton: some View {
        if dictation.isListening {
            Button { dictation.stop() } label: {
                Label("Stop", systemImage: "stop.circle.fill").foregroundStyle(hearth.danger)
            }
            .font(HearthFont.subheadline)
            .accessibilityLabel("Stop dictation")
            .accessibilityIdentifier("ChatDictateStop")
            Label("Listening…", systemImage: "waveform")
                .font(HearthFont.caption)
                .foregroundStyle(hearth.textSecondary)
                .symbolEffect(.variableColor.iterative, isActive: true)
        } else {
            Button {
                Task { await dictation.start(after: draft) { draft = $0 } }
            } label: {
                Label("Dictate", systemImage: "mic")
            }
            .font(HearthFont.subheadline)
            .disabled(pending != nil || !dictation.isAvailable)
            .accessibilityIdentifier("ChatDictate")
        }
    }

    @ViewBuilder
    private var dictationNotes: some View {
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
            .accessibilityIdentifier("DictationProblem")
        }
        Text(dictation.disclosure)
            .font(HearthFont.caption)
            .foregroundStyle(hearth.textTertiary)
            .accessibilityIdentifier("DictationDisclosure")
    }

    private var placeholder: String {
        switch context.mode {
        case .ask: "Ask about your library"
        case .edit: "Say what should change"
        case .organize: "Which notes, and how should they be organized?"
        case .actions: "What should the AI suggest?"
        }
    }

    private var question: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var blocked: String? {
        switch connection.status {
        case .unknown, .checking: return "Connecting to your computer…"
        case .offline: return "AI chat needs a connection to your computer. Nothing is saved or queued while you're offline."
        case .unauthorized: return "This phone's pairing was revoked. Pair again to use AI chat."
        case .online: break
        }
        if status?.configured == false { return "Set up an AI on your computer to chat." }
        if context.mode != .ask, !connection.scopes.contains("write") {
            return "This pairing is read-only. Pair with read and write access to have the AI propose changes; you can still ask questions."
        }
        return nil
    }

    /// Why saving this conversation or an answer is unavailable; never queued for later.
    private var writeBlocked: String? {
        guard connection.isOnline else { return "Saving a conversation or an answer needs a connection to your computer. Nothing is saved or queued offline." }
        guard connection.scopes.contains("write") else { return "This pairing is read-only, so conversations and answers can't be saved from this phone." }
        return nil
    }

    private var canSend: Bool {
        // Dictation must be stopped first, so the draft is checked before it's sent.
        blocked == nil && status?.configured == true && pending == nil && !dictation.isListening && !resuming && !question.isEmpty
            && ChatRequest.length(question) <= ChatRequest.maxMessageLength && context.isReady
            && (context.mode != .organize || !PreferenceSelection.tooLong(organizePreferences, chosenPreferences))
    }

    private var isDirty: Bool { turns.count != (saved?.turnCount ?? 0) }
    private var hasUnsavedWork: Bool { isDirty || !question.isEmpty }

    private var saveInput: ConversationInput {
        ConversationInput(id: saved?.id, title: title, mode: context.mode, project: context.requestProject, rootId: context.requestRoot,
                          query: context.requestQuery, messages: turns.flatMap(\.messages))
    }

    private var saveMessage: String {
        let kept = "It's kept in your library on your computer, so you can reopen it here or there. Proposals are kept as summaries and can't be applied again."
        let omitted = saveInput.omitted
        return omitted > 0 ? kept + " The oldest \(omitted) messages are past the saved-chat limit and are left out." : kept
    }

    private func send() {
        guard canSend, let client = connection.privateClient else { return }
        let text = question
        let request = ChatRequest(mode: context.mode, history: turns.flatMap(\.messages), message: text,
                                  project: context.requestProject, rootId: context.requestRoot, query: context.requestQuery,
                                  preferences: organizePreferences.map(\.id).filter(chosenPreferences.contains))
        let conversation = conversation
        pending = text
        error = nil
        Task {
            do {
                let reply = try await client.send(.chat(request), as: ChatResponse.self)
                guard conversation == self.conversation else { return }
                turns.append(ChatTurn(question: text, reply: reply))
                omitted = request.omitted
                draft = ""
            } catch {
                guard conversation == self.conversation else { return }
                connection.note(error)
                if case .unreachable = error as? APIError {
                    self.error = "Couldn't reach your computer. Your message is still here; nothing was saved or queued."
                } else if !(error is CancellationError) {
                    self.error = error.localizedDescription
                }
            }
            pending = nil
        }
    }

    private func beginSave() {
        title = saved?.title ?? ConversationInput.suggestedTitle(for: turns.flatMap(\.messages))
        naming = true
    }

    /// Saved only on request: a new conversation the first time, the same one after that.
    private func save() {
        guard writeBlocked == nil, let client = connection.privateClient else { return }
        let input = saveInput
        guard !input.messages.isEmpty else {
            error = "This conversation is too long to save from the phone."
            return
        }
        let conversation = conversation
        let count = turns.count
        saving = true
        error = nil
        Task {
            defer { saving = false }
            do {
                let stored = try await client.send(.saveConversation(input), as: SavedConversation.self)
                guard conversation == self.conversation else { return }
                saved = SavedChat(id: stored.id, title: stored.title, turnCount: count)
                router.show(input.id == nil ? "Conversation saved" : "Saved conversation updated")
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }

    /// An answer becomes an ordinary note; its numbered sources become references to the items they cite.
    private func saveAnswer(_ turn: ChatTurn) {
        guard writeBlocked == nil, case .answer(let answer) = turn.reply, let client = connection.privateClient,
              let endpoint = try? Endpoint.capture(CaptureRequest(title: String(turn.question.prefix(ConversationInput.maxTitle)),
                                                                  note: answer.noteBody, project: context.requestProject)) else { return }
        savedAnswers.insert(turn.id)
        Task {
            do {
                let result = try await client.send(endpoint, as: CaptureResult.self)
                connection.didWrite()
                router.show("Answer saved as “\(result.item.displayTitle)”")
            } catch is CancellationError {
                savedAnswers.remove(turn.id)
            } catch {
                savedAnswers.remove(turn.id)
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }

    private func resume(_ id: String) async {
        guard let client = connection.privateClient else { return }
        dictation.stop()
        resuming = true
        error = nil
        defer { resuming = false }
        do {
            let stored = try await client.send(.conversation(id), as: SavedConversation.self)
            var scope: ItemPicker.Choice?
            if let rootId = stored.rootId {
                let entry = try? await connection.load(.outlineEntry(rootId), as: OutlineEntry.self).value
                scope = ItemPicker.Choice(id: rootId, title: entry?.item.displayTitle ?? "Saved notes")
            }
            restore(stored, scope: scope)
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = (error as? APIError)?.allowsCachedFallback == true
                ? "Saved conversations open only while your computer is reachable."
                : error.localizedDescription
        }
    }

    /// Earlier replies come back as plain text: a saved proposal is only its summary and can't be applied.
    private func restore(_ stored: SavedConversation, scope: ItemPicker.Choice?) {
        let next = ChatContext(mode: stored.mode, projectID: stored.project, scope: scope,
                               source: stored.query == nil ? .branch : .topic, topic: stored.query ?? "")
        restoredContext = next == context ? nil : next
        context = next
        turns = stored.exchanges.map { ChatTurn(question: $0.question, reply: .answer(CitedAnswer(answer: $0.answer, sources: []))) }
        organized = [:]
        acted = [:]
        undoneActions = []
        savedAnswers = []
        conversation = UUID()
        pending = nil
        omitted = 0
        startedOver = false
        draft = stored.messages.last?.role == .user ? stored.messages.last!.content : ""
        saved = SavedChat(id: stored.id, title: stored.title, turnCount: turns.count)
    }

    /// Mode, project and notes all shape what the AI sees, so a change leaves the old context (and its saved copy) behind.
    private func startOver() {
        dictation.stop()
        startedOver = !turns.isEmpty || startedOver
        turns = []
        organized = [:]
        acted = [:]
        undoneActions = []
        savedAnswers = []
        saved = nil
        conversation = UUID()
        pending = nil
        error = nil
        omitted = 0
    }

    private func loadPreferences() async {
        guard context.mode == .organize, connection.isOnline, let client = connection.privateClient else { return }
        do {
            let global = try await client.send(.preferences(), as: [OrganizationPreference].self).filter(\.isGlobal)
            organizePreferences = global
            chosenPreferences.formIntersection(global.map(\.id))
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
        }
    }

    private func loadStatus() async {
        guard connection.isOnline, let client = connection.privateClient else { return }
        do {
            status = try await client.send(.aiStatus, as: AIStatus.self)
            statusError = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            statusError = error.localizedDescription
        }
    }
}

private struct PreferenceTrigger: Equatable {
    let mode: ChatMode
    let isOnline: Bool
}

struct ChatTurn: Identifiable {
    let id = UUID()
    let question: String
    let reply: ChatResponse

    /// Proposals are remembered by their summary only.
    var messages: [ChatMessage] {
        let said = switch reply {
        case .answer(let answer): answer.answer
        case .proposal(let proposal):
            "Proposed \(proposal.operations.count) \(proposal.operations.count == 1 ? "change" : "changes"). \(proposal.summary)"
        case .organization(let proposal):
            "Proposed organizing \(proposal.matchedCount) notes about “\(proposal.query)” under “\(proposal.destination.title)” for review. \(proposal.summary)"
        case .actions(let proposal):
            "Proposed \(proposal.operations.count) \(proposal.operations.count == 1 ? "action" : "actions") for review. \(proposal.summary)"
        }
        let content = said.trimmingCharacters(in: .whitespacesAndNewlines)
        return [ChatMessage(role: .user, content: question), ChatMessage(role: .assistant, content: content.isEmpty ? "(No answer.)" : content)]
    }
}

private struct ProviderDisclosure: View {
    let status: AIStatus?
    let error: String?
    let isOnline: Bool
    let retry: () -> Void

    @Environment(\.hearth) private var hearth

    var body: some View {
        if let error {
            ErrorBanner(message: error, retry: retry)
        } else {
            HearthCard(padding: HearthSpacing.md) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(HearthFont.subheadline)
                        Text(detail).font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
                    }
                } icon: {
                    Image(systemName: status?.cloud == true ? "cloud" : "desktopcomputer").foregroundStyle(hearth.accent)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("AIProviderDisclosure")
        }
    }

    private var title: String {
        guard let status else { return isOnline ? "Checking your computer's AI…" : "Your computer's AI" }
        guard status.configured else { return "No AI is set up" }
        return [status.label, status.model].compactMap(\.self).joined(separator: " · ")
    }

    private var detail: String {
        guard let status else { return "The conversation stays on this screen unless you save it." }
        guard status.configured else {
            return "Choose an AI provider in Petty Memory's settings on your computer, then come back. Search and everything else work without one."
        }
        let route = status.cloud
            ? "Your computer sends your messages and the matching notes to \(status.label)."
            : "Your messages and notes go only to this AI, through your computer."
        return route + " The conversation stays on this screen unless you save it."
    }
}

private struct QuestionBubble: View {
    let text: String

    @Environment(\.hearth) private var hearth

    var body: some View {
        Text(verbatim: text)
            .font(HearthFont.body)
            .foregroundStyle(hearth.accentText)
            .padding(HearthSpacing.md)
            .background(RoundedRectangle(cornerRadius: HearthRadius.inner, style: .continuous).fill(hearth.accentMuted))
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, HearthSpacing.xxxl)
            .textSelection(.enabled)
            .accessibilityIdentifier("ChatQuestion")
    }
}

/// The model's words are shown as plain text: never rendered as Markdown or followed as links.
private struct ReplyCard: View {
    let turn: ChatTurn
    let organized: OrganizationResult?
    let acted: ActionResult?
    let actionsUndone: Bool
    let answerSaved: Bool
    let canSaveAnswer: Bool
    let review: () -> Void
    let saveAnswer: () -> Void

    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            switch turn.reply {
            case .answer(let answer): cited(answer)
            case .proposal(let proposal): proposed(proposal)
            case .organization(let proposal): organization(proposal)
            case .actions(let proposal): actions(proposal)
            }
        }
    }

    private func cited(_ answer: CitedAnswer) -> some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Text(verbatim: answer.answer)
                .font(HearthFont.body)
                .textSelection(.enabled)
                .accessibilityIdentifier("ChatAnswer")
            if !answer.sources.isEmpty {
                Overline("Sources")
                ForEach(answer.sources, id: \.n) { source in
                    HStack(alignment: .firstTextBaseline, spacing: HearthSpacing.sm) {
                        // A located source opens the original PDF page or recording moment; the note it came from stays one tap away.
                        Button {
                            router.open(source.locator.map { Route.research($0.location) } ?? .item(source.id))
                        } label: {
                            Label {
                                Text(verbatim: "[\(source.n)] \(source.title.isEmpty ? (source.url ?? source.type.label) : source.title)\(Self.place(source.locator))")
                                    .lineLimit(2)
                                    .multilineTextAlignment(.leading)
                            } icon: {
                                Image(systemName: source.locator?.kind == "audio" ? "waveform" : source.locator != nil ? "doc.richtext" : source.type.symbol)
                            }
                            .font(HearthFont.footnote)
                        }
                        .accessibilityIdentifier("ChatSource")
                        if source.locator != nil {
                            Spacer(minLength: 0)
                            Button { router.open(.item(source.id)) } label: { Image(systemName: "note.text") }
                                .font(HearthFont.footnote)
                                .accessibilityLabel("Open the cited note")
                                .accessibilityIdentifier("ChatSourceNote")
                        }
                    }
                }
            }
            Button(answerSaved ? "Saved as a note" : "Save as note", systemImage: answerSaved ? "checkmark" : "note.text.badge.plus", action: saveAnswer)
                .font(HearthFont.subheadline)
                .disabled(answerSaved || !canSaveAnswer)
                .accessibilityIdentifier("ChatSaveAnswer")
        }
    }

    private static func place(_ locator: CitedAnswer.Locator?) -> String {
        guard let locator else { return "" }
        if locator.kind == "pdf", let page = locator.page { return " · p. \(page)" }
        if locator.kind == "audio", let start = locator.start { return " · \(Timestamp.label(start))" }
        return ""
    }

    private func proposed(_ proposal: EditProposal) -> some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Label {
                Text(verbatim: proposal.summary.isEmpty ? "Proposed changes" : proposal.summary)
            } icon: {
                Image(systemName: "sparkles")
            }
            .font(HearthFont.callout)
            if proposal.operations.isEmpty {
                Text("No changes proposed. Try describing the change differently.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
            } else {
                Text("\(proposal.operations.count) proposed \(proposal.operations.count == 1 ? "change" : "changes"). Nothing has changed yet.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                Button("Review changes", systemImage: "checklist", action: review)
                    .buttonStyle(.hearthSecondary)
                    .accessibilityIdentifier("ChatReview")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ChatProposal")
    }

    private func organization(_ proposal: OrganizationProposal) -> some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Label {
                Text(verbatim: proposal.summary.isEmpty ? "Proposed organization" : proposal.summary)
            } icon: {
                Image(systemName: "folder.badge.gearshape")
            }
            .font(HearthFont.callout)
            if let organized {
                Text(verbatim: "Moved \(organized.moved) of \(proposal.items.count) notes under “\(proposal.destination.title)”. Open the review to undo.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
            } else {
                Text(OrganizationReviewSheet.overview(proposal) + " Nothing has moved yet.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
            }
            Button(organized == nil ? "Review organization" : "Open review", systemImage: "list.bullet.indent", action: review)
                .buttonStyle(.hearthSecondary)
                .accessibilityIdentifier("ChatReviewOrganization")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ChatOrganization")
    }

    private func actions(_ proposal: ActionProposal) -> some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Label {
                Text(verbatim: proposal.summary.isEmpty ? "Proposed actions" : proposal.summary)
            } icon: {
                Image(systemName: "checklist")
            }
            .font(HearthFont.callout)
            if actionsUndone {
                Text("Undone. Nothing from these actions is applied. Ask again for a fresh proposal.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
            } else if proposal.operations.isEmpty {
                Text("No actions proposed. Try asking differently, or choose other notes.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
            } else {
                Text(acted.map { "Applied \($0.createdIds.count + $0.updatedIds.count) changes. Open the review to undo." }
                     ?? "\(proposal.operations.count) proposed \(proposal.operations.count == 1 ? "action" : "actions"). Nothing has changed yet.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                Button(acted == nil ? "Review actions" : "Open review", systemImage: "checklist", action: review)
                    .buttonStyle(.hearthSecondary)
                    .accessibilityIdentifier("ChatReviewActions")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ChatActions")
    }
}
