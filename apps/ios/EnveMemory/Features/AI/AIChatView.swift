import EnveMemoryKit
import SwiftUI

/// The conversation lives only on this screen: never saved, cached or queued.
struct AIChatView: View {
    @Environment(Connection.self) private var connection
    @Environment(ProjectStore.self) private var projects
    @Environment(\.hearth) private var hearth
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    @State private var mode: ChatMode = .ask
    @State private var projectID: String?
    @State private var scope: ItemPicker.Choice?
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
    @State private var dictation = Dictation()

    var body: some View {
        HearthScreen(title: "AI chat", overline: "Library") {
            ProviderDisclosure(status: status, error: statusError, isOnline: connection.isOnline) { Task { await loadStatus() } }
            controls
            if startedOver, turns.isEmpty, pending == nil {
                Label("New conversation. Changes you already applied stay in your notes.", systemImage: "arrow.counterclockwise")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                    .accessibilityIdentifier("ChatStartedOver")
            }
            ForEach(turns) { turn in
                QuestionBubble(text: turn.question)
                ReplyCard(turn: turn, organized: organized[turn.id]) { reviewing = turn }
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
            composer
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
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
            Text("This conversation is cleared from this screen. Changes you already applied stay in your notes.")
        }
        .sheet(isPresented: $choosingScope) {
            ItemPicker(title: "Notes to change", type: .note) { scope = $0 }
                .environment(\.hearth, hearth)
        }
        .sheet(item: $reviewing) { turn in
            Group {
                switch turn.reply {
                case .answer: EmptyView()
                case .proposal(let proposal): AIEditSheet(rootID: proposal.rootId, initialProposal: proposal)
                case .organization(let proposal):
                    OrganizationReviewSheet(proposal: proposal, result: Binding(get: { organized[turn.id] }, set: { organized[turn.id] = $0 }))
                }
            }
            .environment(\.hearth, hearth)
        }
        .onChange(of: mode) { startOver() }
        .onChange(of: projectID) { startOver() }
        .onChange(of: scope) { startOver() }
        .onChange(of: connection.pairing) {
            startOver()
            status = nil
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { dictation.stop() }
        }
        .onDisappear { dictation.stop() }
        .task(id: connection.isOnline) { await loadStatus() }
    }

    @ViewBuilder
    private var controls: some View {
        Picker("Mode", selection: $mode) {
            Text("Ask").tag(ChatMode.ask)
            Text("Change notes").tag(ChatMode.edit)
            Text("Organize").tag(ChatMode.organize)
        }
        .pickerStyle(.segmented)
        .disabled(pending != nil)
        .accessibilityIdentifier("ChatMode")
        switch mode {
        case .ask:
            Text("Answers come only from your library, with numbered sources you can open.")
                .font(HearthFont.footnote)
                .foregroundStyle(hearth.textSecondary)
            HStack {
                Text("Search in").font(HearthFont.subheadline)
                Spacer()
                Picker("Search in", selection: $projectID) {
                    Text("All projects").tag(String?.none)
                    ForEach(projects.refs, id: \.id) { Text($0.name).tag(Optional($0.id)) }
                }
                .disabled(pending != nil)
                .accessibilityIdentifier("ChatProject")
            }
        case .edit:
            Text("The AI proposes changes to the note you choose and the notes inside it. You review each one; nothing changes until you apply it, and nothing is deleted.")
                .font(HearthFont.footnote)
                .foregroundStyle(hearth.textSecondary)
            Button { choosingScope = true } label: {
                Label(scope.map { "Changing “\($0.title)”" } ?? "Choose notes to change", systemImage: "list.bullet.indent")
                    .lineLimit(2)
            }
            .buttonStyle(.hearthSecondary)
            .disabled(pending != nil)
            .accessibilityIdentifier("ChatScope")
        case .organize:
            Text("Say which notes and how, for example “Organize all notes about gardening into a PARA system.” The AI finds every matching note across your library and proposes headings and a place for each. Moving a note brings the notes inside it along, and projects stay as they are. Nothing moves until you review and apply it.")
                .font(HearthFont.footnote)
                .foregroundStyle(hearth.textSecondary)
                .accessibilityIdentifier("ChatOrganizeHelp")
        }
    }

    @ViewBuilder
    private var starters: some View {
        let options: [(String, String)] = switch mode {
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
        switch mode {
        case .ask: "Ask about your library"
        case .edit: "Say what should change"
        case .organize: "Which notes, and how should they be organized?"
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
        if mode != .ask, !connection.scopes.contains("write") {
            return "This pairing is read-only. Pair with read and write access to have the AI propose changes; you can still ask questions."
        }
        return nil
    }

    private var canSend: Bool {
        // Dictation must be stopped first, so the draft is checked before it's sent.
        blocked == nil && status?.configured == true && pending == nil && !dictation.isListening && !question.isEmpty
            && ChatRequest.length(question) <= ChatRequest.maxMessageLength && (mode != .edit || scope != nil)
    }

    private func send() {
        guard canSend, let client = connection.privateClient else { return }
        let text = question
        let request = ChatRequest(mode: mode, history: turns.flatMap(\.messages), message: text,
                                  project: mode == .ask ? projectID : nil, rootId: mode == .edit ? scope?.id : nil)
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

    /// Mode, project and notes all shape what the AI sees, so a change leaves the old context behind.
    private func startOver() {
        dictation.stop()
        startedOver = !turns.isEmpty || startedOver
        turns = []
        organized = [:]
        conversation = UUID()
        pending = nil
        error = nil
        omitted = 0
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
        guard let status else { return "The conversation stays on this screen and is never saved." }
        guard status.configured else {
            return "Choose an AI provider in Petty Memory's settings on your computer, then come back. Search and everything else work without one."
        }
        let route = status.cloud
            ? "Your computer sends your messages and the matching notes to \(status.label)."
            : "Your messages and notes go only to this AI, through your computer."
        return route + " The conversation stays on this screen and is never saved."
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
    let review: () -> Void

    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            switch turn.reply {
            case .answer(let answer): cited(answer)
            case .proposal(let proposal): proposed(proposal)
            case .organization(let proposal): organization(proposal)
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
                    Button { router.open(.item(source.id)) } label: {
                        Label {
                            Text(verbatim: "[\(source.n)] \(source.title.isEmpty ? (source.url ?? source.type.label) : source.title)")
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                        } icon: {
                            Image(systemName: source.type.symbol)
                        }
                        .font(HearthFont.footnote)
                    }
                    .accessibilityIdentifier("ChatSource")
                }
            }
        }
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
}
