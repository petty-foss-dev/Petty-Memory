import EnveMemoryKit
import SwiftUI

struct WorkflowsView: View {
    @Environment(Connection.self) private var connection
    @Environment(ProjectStore.self) private var projects
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var recipes: [Recipe] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var editing: Editing?
    @State private var running: Recipe?
    @State private var archiving: Recipe?
    /// The latest proposal per workflow, kept here so its undo receipt outlives the review sheet.
    @State private var runs: [String: RecipeRun] = [:]
    @State private var reviewing: String?
    @State private var pendingReview: String?

    struct Editing: Identifiable {
        let recipe: Recipe?
        var id: String { recipe?.id ?? "new" }
    }

    struct RecipeRun {
        let proposal: ActionProposal
        var result: ActionResult?
        var undone = false
    }

    var body: some View {
        HearthScreen(title: "AI workflows", overline: "Knowledge") {
            KnowledgeNote(text: "A workflow is a saved instruction for one branch or one keyword topic. Each run asks your computer's AI for tasks, tags, reminders or a brief from what's there now. You review every proposed action, apply the ones you keep, and can undo them. Runs never apply anything on their own.")
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            Button { editing = Editing(recipe: nil) } label: { Label("New workflow", systemImage: "plus") }
                .buttonStyle(.hearthPrimary)
                .disabled(connection.knowledgeWriteReason != nil)
                .accessibilityIdentifier("NewWorkflow")
            if let reason = connection.knowledgeWriteReason { OnlineOnlyNote(reason: reason) }
            if recipes.isEmpty {
                if loaded, error == nil {
                    EmptyStateView(symbol: KnowledgeArea.workflows.symbol, title: "No workflows yet",
                                   message: "Save something you ask often, like “Turn open questions in my meeting notes into tasks”, and run it whenever you like.")
                }
            } else {
                ForEach(recipes) { recipe in card(recipe) }
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editing) { editing in
            RecipeForm(existing: editing.recipe) { saved in
                if let index = recipes.firstIndex(where: { $0.id == saved.id }) { recipes[index] = saved } else { recipes.append(saved) }
                runs[saved.id] = nil
            }
            .environment(\.hearth, hearth)
        }
        .sheet(item: $running, onDismiss: {
            // The review opens once the run sheet has gone, so the two presentations don't collide.
            reviewing = pendingReview
            pendingReview = nil
        }) { recipe in
            RecipeRunSheet(recipe: recipe) { proposal in
                runs[recipe.id] = RecipeRun(proposal: proposal)
                pendingReview = recipe.id
            }
            .environment(\.hearth, hearth)
        }
        .sheet(item: Binding(get: { reviewing.map(ReviewKey.init) }, set: { reviewing = $0?.id })) { key in
            if let run = runs[key.id] {
                ActionReviewSheet(proposal: run.proposal, result: Binding(get: { runs[key.id]?.result }, set: { result in
                    if result == nil, runs[key.id]?.result != nil { runs[key.id]?.undone = true }
                    runs[key.id]?.result = result
                }))
                .environment(\.hearth, hearth)
            }
        }
        .confirmationDialog("Archive “\(archiving?.name ?? "")”?", isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil } }),
                            titleVisibility: .visible, presenting: archiving) { recipe in
            Button("Archive workflow", role: .destructive) { archive(recipe) }
        } message: { _ in
            Text("Only the definition is archived, as a note you can restore on your computer. Actions you already applied stay.")
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private struct ReviewKey: Identifiable { let id: String }

    private func card(_ recipe: Recipe) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                        Text(recipe.name).font(HearthFont.cardTitle)
                        Text(scopeLine(recipe.scope)).font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Menu {
                        Button("Edit", systemImage: "pencil") { editing = Editing(recipe: recipe) }
                        Button("Archive", systemImage: "archivebox", role: .destructive) { archiving = recipe }
                    } label: {
                        Image(systemName: "ellipsis.circle").foregroundStyle(hearth.accent)
                    }
                    .disabled(connection.knowledgeWriteReason != nil)
                    .accessibilityLabel("Actions for \(recipe.name)")
                    .accessibilityIdentifier("WorkflowMenu")
                }
                Text(verbatim: recipe.instruction).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary).lineLimit(4)
                if let run = runs[recipe.id] { runLine(run, recipeID: recipe.id) }
                Button { running = recipe } label: { Label("Run", systemImage: "play.fill") }
                    .buttonStyle(.hearthSecondary)
                    .disabled(connection.knowledgeWriteReason != nil)
                    .accessibilityIdentifier("WorkflowRun")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("WorkflowCard")
    }

    private func runLine(_ run: RecipeRun, recipeID: String) -> some View {
        HStack(spacing: HearthSpacing.sm) {
            Text(run.undone ? "Last run undone." : run.result.map { "Applied \($0.createdIds.count + $0.updatedIds.count) changes." }
                 ?? "\(run.proposal.operations.count) proposed actions waiting for review.")
                .font(HearthFont.caption)
                .foregroundStyle(hearth.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !run.undone {
                Button(run.result == nil ? "Review" : "Open review") { reviewing = recipeID }
                    .font(HearthFont.subheadline)
                    .accessibilityIdentifier("WorkflowReview")
            }
        }
    }

    private func scopeLine(_ scope: RecipeScope) -> String {
        if let query = scope.query {
            return "Notes about “\(query)”" + (scope.project.map { " in \(projects.label(for: $0))" } ?? "")
        }
        return "One branch and the notes inside it"
    }

    private func load() async {
        guard connection.knowledgeReadReason == nil, let client = connection.privateClient else { loaded = true; return }
        do {
            recipes = try await client.send(.recipes, as: [Recipe].self)
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
        loaded = true
    }

    private func archive(_ recipe: Recipe) {
        guard let client = connection.privateClient else { return }
        Task {
            do {
                _ = try await client.send(.archiveRecipe(recipe.id), as: ArchiveResult.self)
                recipes.removeAll { $0.id == recipe.id }
                router.show("Workflow archived")
            } catch {
                connection.note(error)
                router.show(error.onlineOnlyMessage)
            }
        }
    }
}

struct RecipeForm: View {
    let existing: Recipe?
    let saved: (Recipe) -> Void

    enum Source: Hashable { case branch, topic }

    @Environment(Connection.self) private var connection
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var name: String
    @State private var instruction: String
    @State private var source: Source
    @State private var branch: ItemPicker.Choice?
    @State private var topic: String
    @State private var project: String?
    @State private var choosingBranch = false
    @State private var saving = false
    @State private var error: String?

    init(existing: Recipe?, saved: @escaping (Recipe) -> Void) {
        self.existing = existing
        self.saved = saved
        _name = State(initialValue: existing?.name ?? "")
        _instruction = State(initialValue: existing?.instruction ?? "")
        _source = State(initialValue: existing?.scope.query != nil ? .topic : .branch)
        _branch = State(initialValue: existing?.scope.rootId.map { ItemPicker.Choice(id: $0, title: "Current branch") })
        _topic = State(initialValue: existing?.scope.query ?? "")
        _project = State(initialValue: existing?.scope.project)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let reason = connection.knowledgeWriteReason { Section { OnlineOnlyNote(reason: reason) } }
                Section {
                    TextField("Name", text: $name, prompt: Text("Meeting follow-ups"))
                        .accessibilityIdentifier("WorkflowName")
                }
                Section {
                    TextField("Instruction", text: $instruction, prompt: Text("Suggest tasks for open questions and a short brief."), axis: .vertical)
                        .lineLimit(4...12)
                        .accessibilityIdentifier("WorkflowInstruction")
                } header: {
                    Text("What the AI should propose")
                } footer: {
                    Text("\(instruction.trimmed.utf16.count) of \(KnowledgeLimits.recipeInstruction) characters. The AI proposes tasks, tags, reminders and briefs; you review each one.")
                        .foregroundStyle(instruction.trimmed.utf16.count > KnowledgeLimits.recipeInstruction ? hearth.danger : hearth.textTertiary)
                }
                Section {
                    Picker("Look at", selection: $source) {
                        Text("One branch").tag(Source.branch)
                        Text("A topic").tag(Source.topic)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("WorkflowSource")
                    if source == .branch {
                        Button { choosingBranch = true } label: {
                            Label(branch.map { "“\($0.title)” and the notes inside it" } ?? "Choose a branch", systemImage: "list.bullet.indent")
                        }
                        .accessibilityIdentifier("WorkflowBranch")
                    } else {
                        TextField("Topic", text: $topic, prompt: Text("garden"))
                            .textInputAutocapitalization(.never)
                            .accessibilityIdentifier("WorkflowTopic")
                        ProjectChoice(title: "Project", selection: $project, noneLabel: "Any project")
                    }
                } header: {
                    Text("Scope")
                } footer: {
                    Text(source == .branch ? "Each run reads the branch as it is then. Its project decides which project preferences can be used."
                                           : "Each run reads every ordinary note matching all the topic's words, optionally within one project.")
                }
                if let error { Section { Text(error).foregroundStyle(hearth.danger) } }
            }
            .scrollContentBackground(.hidden)
            .background(hearth.background)
            .navigationTitle(existing == nil ? "New workflow" : "Edit workflow")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save", action: save)
                        .disabled(!canSave)
                        .accessibilityIdentifier("WorkflowSave")
                }
            }
            .sheet(isPresented: $choosingBranch) {
                ItemPicker(title: "Branch to read") { branch = $0 }
                    .environment(\.hearth, hearth)
            }
            .task { await loadBranchTitle() }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(saving)
    }

    private var scope: RecipeScope? {
        switch source {
        case .branch: branch.map { .branch($0.id) }
        case .topic: topic.trimmed.isEmpty ? nil : .topic(topic.trimmed, project: project)
        }
    }

    private var canSave: Bool {
        !saving && connection.knowledgeWriteReason == nil && scope != nil && !name.trimmed.isEmpty && name.trimmed.utf16.count <= KnowledgeLimits.name
            && !instruction.trimmed.isEmpty && instruction.trimmed.utf16.count <= KnowledgeLimits.recipeInstruction
            && topic.trimmed.utf16.count <= KnowledgeLimits.query
    }

    private func loadBranchTitle() async {
        guard let id = branch?.id, branch?.title == "Current branch",
              let entry = try? await connection.load(.outlineEntry(id), as: OutlineEntry.self).value else { return }
        if branch?.id == id { branch = ItemPicker.Choice(id: id, title: entry.item.displayTitle) }
    }

    private func save() {
        guard canSave, let scope, let client = connection.privateClient else { return }
        saving = true
        error = nil
        let input = RecipeInput(id: existing?.id, name: name.trimmed, instruction: instruction.trimmed, scope: scope)
        Task {
            defer { saving = false }
            do {
                let recipe = try await client.send(.saveRecipe(input), as: Recipe.self)
                saved(recipe)
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }
}

private struct RecipeRunSheet: View {
    let recipe: Recipe
    let proposed: (ActionProposal) -> Void

    @Environment(Connection.self) private var connection
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var preferences: [OrganizationPreference] = []
    @State private var selected: Set<String> = []
    @State private var runProject: String?
    @State private var loading = true
    @State private var running = false
    @State private var status: AIStatus?
    @State private var error: String?
    @State private var emptyReply: String?

    var body: some View {
        NavigationStack {
            HearthScreen {
                Text(recipe.name).font(HearthFont.sectionTitle)
                Text(verbatim: recipe.instruction).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
                if let status, !status.configured {
                    OnlineOnlyNote(reason: "No AI is set up on your computer. Choose a provider in Petty Memory's settings there, then run this again.")
                } else if let status {
                    KnowledgeNote(text: status.cloud ? "Your computer sends the instruction and the matching notes to \(status.label)." : "The instruction and notes go only to \(status.label), through your computer.",
                                  symbol: status.cloud ? "cloud" : "desktopcomputer")
                }
                if loading {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    PreferenceSelection(preferences: preferences, selected: $selected,
                                        explanation: runProject == nil
                                            ? "Only preferences you tick are sent with this run. Project preferences appear when the workflow runs in that project."
                                            : "Only preferences you tick are sent with this run: ones without a project, and this project's own.")
                }
                if let emptyReply { KnowledgeNote(text: emptyReply, symbol: "checkmark.seal") }
                if let error { ErrorBanner(message: error) }
                if let reason = connection.knowledgeWriteReason { OnlineOnlyNote(reason: reason) }
                Button(action: run) {
                    if running { Label { Text("Asking your computer's AI…") } icon: { ProgressView() } } else { Label("Run workflow", systemImage: "play.fill") }
                }
                .buttonStyle(.hearthPrimary)
                .disabled(!canRun)
                .accessibilityIdentifier("WorkflowRunConfirm")
            }
            .navigationTitle("Run workflow")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(running) } }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(running)
        .task { await load() }
    }

    private var canRun: Bool {
        !running && !loading && connection.knowledgeWriteReason == nil && status?.configured == true
            && !PreferenceSelection.tooLong(preferences, selected)
    }

    private func load() async {
        guard let client = connection.privateClient else { return }
        defer { loading = false }
        do {
            status = try await client.send(.aiStatus, as: AIStatus.self)
            if let rootId = recipe.scope.rootId {
                runProject = try await client.send(.item(rootId), as: ItemDetail.self).item.project?.id
            } else {
                runProject = recipe.scope.project
            }
            let all = try await client.send(.preferences(project: runProject), as: [OrganizationPreference].self)
            preferences = all.filter { $0.applies(inProject: runProject) }
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
    }

    private func run() {
        guard canRun, let client = connection.privateClient else { return }
        running = true
        error = nil
        emptyReply = nil
        let chosen = preferences.map(\.id).filter(selected.contains)
        Task {
            defer { running = false }
            do {
                let reply = try await client.send(.runRecipe(recipe.id, preferences: chosen), as: ChatResponse.self)
                guard case .actions(let proposal) = reply else {
                    error = "Your computer answered with something other than actions, so there's nothing to review here."
                    return
                }
                if proposal.operations.isEmpty {
                    emptyReply = proposal.summary.isEmpty ? "No actions were proposed this time. Nothing changed." : "\(proposal.summary) No actions were proposed; nothing changed."
                    return
                }
                dismiss()
                proposed(proposal)
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = (error as? APIError)?.allowsCachedFallback == true
                    ? "Couldn't reach your computer. Nothing was run or queued."
                    : error.localizedDescription
            }
        }
    }
}
