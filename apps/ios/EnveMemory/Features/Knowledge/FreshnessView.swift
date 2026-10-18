import EnveMemoryKit
import SwiftUI

struct FreshnessView: View {
    enum Mode: String, CaseIterable { case stale, conflicts }

    @State private var mode: Mode = .stale

    var body: some View {
        HearthScreen(title: "Information review", overline: "Knowledge") {
            Picker("Review", selection: $mode) {
                Text("Not checked lately").tag(Mode.stale)
                Text("Possible conflicts").tag(Mode.conflicts)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("FreshnessMode")
            switch mode {
            case .stale: StaleQueue()
            case .conflicts: ConflictReview()
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ReviewScope: Equatable {
    enum Kind: String, CaseIterable { case project, topic, branch }

    var kind: Kind = .project
    var project: String?
    var topic = ""
    var branch: ItemPicker.Choice?
}

private struct ScopeControls: View {
    @Binding var scope: ReviewScope
    let allowsTopic: Bool

    @Environment(\.hearth) private var hearth
    @State private var choosingBranch = false

    var body: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Picker("Look at", selection: $scope.kind) {
                Text(allowsTopic ? "Project" : "Library or project").tag(ReviewScope.Kind.project)
                if allowsTopic { Text("Topic").tag(ReviewScope.Kind.topic) }
                Text("Branch").tag(ReviewScope.Kind.branch)
            }
            .pickerStyle(.segmented)
            switch scope.kind {
            case .project:
                HStack {
                    Text("Project").font(HearthFont.subheadline)
                    Spacer()
                    ProjectChoice(title: "Project", selection: $scope.project, noneLabel: allowsTopic ? "Choose…" : "Whole library")
                }
            case .topic:
                TextField("Topic, for example “router setup”", text: $scope.topic)
                    .textInputAutocapitalization(.never)
                    .hearthField()
                    .accessibilityIdentifier("FreshnessTopic")
                HStack {
                    Text("In").font(HearthFont.subheadline)
                    Spacer()
                    ProjectChoice(title: "Project", selection: $scope.project, noneLabel: "Any project")
                }
            case .branch:
                Button { choosingBranch = true } label: {
                    Label(scope.branch.map { "“\($0.title)” and what's inside it" } ?? "Choose a branch", systemImage: "list.bullet.indent")
                }
                .buttonStyle(.hearthSecondary)
                .accessibilityIdentifier("FreshnessBranch")
            }
        }
        .sheet(isPresented: $choosingBranch) {
            ItemPicker(title: "Branch to review") { scope.branch = $0 }.environment(\.hearth, hearth)
        }
    }
}

private struct StaleQueue: View {
    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var days = 90
    @State private var scope = ReviewScope()
    @State private var result: StaleItems?
    @State private var checked: Set<String> = []
    @State private var working: String?
    @State private var loading = false
    @State private var error: String?

    private static let presets = [30, 90, 180, 365]

    var body: some View {
        KnowledgeNote(text: "Notes, links and files not edited or marked checked for a while, oldest first. Worked out on your computer without AI. Marking one checked records the date only; its text doesn't change.")
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.md) {
                Stepper(value: $days, in: 1...SourceLimits.maxAgeDays, step: days < 30 ? 1 : 30) {
                    Text("Older than \(days) days").font(HearthFont.subheadline)
                }
                FlowLayout(spacing: HearthSpacing.sm) {
                    ForEach(Self.presets, id: \.self) { preset in
                        FilterChip(title: preset == 365 ? "1 year" : "\(preset) days", isSelected: days == preset) { days = preset }
                    }
                }
                ScopeControls(scope: $scope, allowsTopic: false)
                Button(action: { Task { await load() } }) {
                    if loading { ProgressView() } else { Label("Show stale items", systemImage: "clock.arrow.circlepath") }
                }
                .buttonStyle(.hearthPrimary)
                .disabled(loading || connection.knowledgeReadReason != nil || (scope.kind == .branch && scope.branch == nil))
                .accessibilityIdentifier("FreshnessStaleLoad")
            }
        }
        if let reason = connection.knowledgeReadReason { OnlineOnlyNote(reason: reason) }
        if let error { ErrorBanner(message: error) }
        if let result {
            Text(result.total > result.items.count
                 ? "\(result.total.formatted()) items qualify; the oldest \(result.items.count) are shown."
                 : "\(result.total.formatted()) items qualify.")
                .font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
                .accessibilityIdentifier("FreshnessStaleCount")
            let remaining = result.items.filter { !checked.contains($0.id) }
            if remaining.isEmpty {
                EmptyStateView(symbol: "checkmark.seal", title: "All caught up", message: "Nothing here is older than \(result.olderThanDays) days.")
            }
            ForEach(remaining) { item in
                StaleCard(item: item, working: working == item.id, canWrite: connection.knowledgeWriteReason == nil) { markChecked(item) }
            }
            if let reason = connection.knowledgeWriteReason, !remaining.isEmpty { OnlineOnlyNote(reason: reason) }
        }
    }

    private func load() async {
        guard let client = connection.privateClient else { return }
        loading = true
        defer { loading = false }
        do {
            let endpoint = Endpoint.staleItems(olderThanDays: days, rootId: scope.kind == .branch ? scope.branch?.id : nil,
                                               project: scope.kind == .project ? scope.project : nil)
            result = try await client.send(endpoint, as: StaleItems.self)
            checked = []
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
    }

    private func markChecked(_ item: StaleItem) {
        guard let client = connection.privateClient else { return }
        working = item.id
        Task {
            defer { working = nil }
            do {
                _ = try await client.send(.markChecked(item.ref), as: FreshnessReceipt.self)
                checked.insert(item.id)
                router.show("Marked “\(item.title.isEmpty ? item.type.label : item.title)” as checked")
            } catch {
                connection.note(error)
                router.show(error.isStaleConflict ? "It changed since this list loaded. Show the list again to review its current version." : error.onlineOnlyMessage)
            }
        }
    }
}

private struct StaleCard: View {
    let item: StaleItem
    let working: Bool
    let canWrite: Bool
    let markChecked: () -> Void

    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth
    @State private var expanded = false

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                HStack(alignment: .top, spacing: HearthSpacing.sm) {
                    TypeGlyph(symbol: item.type.symbol)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title.isEmpty ? item.type.label : item.title).font(HearthFont.cardTitle).lineLimit(2)
                        Text("\(item.ageDays) days since \(item.basis == .checked ? "last checked" : "last edited")")
                            .font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                FreshnessDatesLine(dates: item.dates)
                if !item.excerpt.isEmpty {
                    Text(verbatim: item.excerpt).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary).lineLimit(expanded ? nil : 3)
                    Button(expanded ? "Show less" : "Show more") { expanded.toggle() }.font(HearthFont.caption)
                }
                HStack {
                    Button("Open") { router.open(.item(item.id)) }.font(HearthFont.subheadline)
                    Spacer()
                    Button(action: markChecked) {
                        if working { ProgressView() } else { Label("Mark checked", systemImage: "checkmark.circle") }
                    }
                    .font(HearthFont.subheadline)
                    .disabled(working || !canWrite)
                    .accessibilityIdentifier("FreshnessMarkChecked")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("FreshnessStaleItem")
    }
}

private struct FreshnessDatesLine: View {
    let dates: FreshnessDates

    @Environment(\.hearth) private var hearth

    var body: some View {
        let parts: [String] = [
            dates.publishedAt.map { "Published \($0.formatted(date: .abbreviated, time: .omitted))" },
            "Saved \(dates.capturedAt.formatted(date: .abbreviated, time: .omitted))",
            "Edited \(dates.editedAt.formatted(date: .abbreviated, time: .omitted))",
            dates.checkedAt.map { "Checked \($0.formatted(date: .abbreviated, time: .omitted))" },
        ].compactMap(\.self)
        Text(parts.joined(separator: " · ")).font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
    }
}

private struct ConflictReview: View {
    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var scope = ReviewScope(kind: .topic)
    @State private var status: AIStatus?
    @State private var proposal: FreshnessProposal?
    /// Suggestions already reviewed in this session, by index.
    @State private var handled: [Int: String] = [:]
    @State private var analyzing = false
    @State private var working: Int?
    @State private var superseding: Supersede?
    @State private var error: String?

    struct Supersede: Identifiable {
        let index: Int
        let newer: FreshnessEvidence
        let older: FreshnessEvidence
        var id: Int { index }
    }

    var body: some View {
        KnowledgeNote(text: "Your computer's AI compares up to \(SourceLimits.freshnessItems) items in the scope you choose and suggests statements that conflict or look outdated. Every suggestion quotes both items exactly and shows their dates. They are suggestions, not verdicts: check the sources, then dismiss, mark checked, or mark the older note as superseded. Neither text is ever rewritten, and decisions are never touched.")
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.md) {
                ScopeControls(scope: $scope, allowsTopic: true)
                if let status, !status.configured {
                    OnlineOnlyNote(reason: "No AI is set up on your computer. Choose a provider in Petty Memory's settings there; the stale list works without one.")
                }
                Button(action: analyze) {
                    if analyzing { Label { Text("Comparing on your computer…") } icon: { ProgressView() } } else { Label("Look for conflicts", systemImage: "sparkle.magnifyingglass") }
                }
                .buttonStyle(.hearthPrimary)
                .disabled(!canAnalyze)
                .accessibilityIdentifier("FreshnessAnalyze")
            }
        }
        .confirmationDialog("Mark the older note as superseded?", isPresented: Binding(get: { superseding != nil }, set: { if !$0 { superseding = nil } }),
                            titleVisibility: .visible, presenting: superseding) { choice in
            Button("“\(choice.older.title)” is superseded by “\(choice.newer.title)”") { supersede(choice) }
                .accessibilityIdentifier("FreshnessSupersedeConfirm")
            Button("“\(choice.newer.title)” is superseded by “\(choice.older.title)”") {
                supersede(Supersede(index: choice.index, newer: choice.older, older: choice.newer))
            }
        } message: { _ in
            Text("Choose which note is replaced. This adds a permanent “supersedes” connection and marks that note as superseded. Both texts stay exactly as they are. It records your judgement; it doesn't make either statement correct.")
        }
        if let reason = connection.knowledgeWriteReason { OnlineOnlyNote(reason: reason) }
        if let error { ErrorBanner(message: error) }
        if let proposal {
            Text(verbatim: proposal.message).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
            FlowLayout(spacing: HearthSpacing.sm) {
                StatPill(label: "items compared", value: proposal.scanned.formatted())
                StatPill(label: "suggestions", value: proposal.suggestions.count.formatted())
                StatPill(label: "unverified, left out", value: proposal.rejected.formatted())
                StatPill(label: "already dismissed", value: proposal.dismissed.formatted())
            }
            .accessibilityIdentifier("FreshnessCounts")
            if proposal.state == .noEvidence {
                EmptyStateView(symbol: "checkmark.seal", title: "No quoted conflicts found", message: "Nothing in this scope was flagged with exact quotes from two items.")
            }
            ForEach(Array(proposal.suggestions.enumerated()), id: \.offset) { index, suggestion in
                suggestionCard(index, suggestion)
            }
        }
    }

    private var canAnalyze: Bool {
        guard !analyzing, connection.knowledgeWriteReason == nil, status?.configured != false else { return false }
        switch scope.kind {
        case .project: return scope.project != nil
        case .topic: return !scope.topic.trimmed.isEmpty && scope.topic.trimmed.utf16.count <= KnowledgeLimits.query
        case .branch: return scope.branch != nil
        }
    }

    private func suggestionCard(_ index: Int, _ suggestion: FreshnessSuggestion) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Label(suggestion.kind == .conflict ? "Possible conflict" : "Possibly outdated",
                      systemImage: suggestion.kind == .conflict ? "arrow.left.arrow.right" : "clock.badge.exclamationmark")
                    .font(HearthFont.headline)
                Text(verbatim: "AI's reason: \(suggestion.reason)").font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
                ForEach(suggestion.items, id: \.id) { evidence in evidenceCard(evidence, newer: suggestion.newer) }
                if let newer = suggestion.newer, let item = suggestion.items.first(where: { $0.id == newer.id }) {
                    Text("By its \(newer.basis == .published ? "published" : "last edited") date, “\(item.title)” is more recent. Dates don't say which statement is right.")
                        .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                }
                if let done = handled[index] {
                    Label(done, systemImage: "checkmark.circle").font(HearthFont.subheadline).foregroundStyle(hearth.success)
                } else if let pair = suggestion.pair {
                    actionRow(index, suggestion: suggestion, first: pair.0, second: pair.1)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("FreshnessSuggestion")
    }

    private func evidenceCard(_ evidence: FreshnessEvidence, newer: FreshnessSuggestion.Newer?) -> some View {
        VStack(alignment: .leading, spacing: HearthSpacing.xs) {
            HStack {
                Text(evidence.title.isEmpty ? "Untitled" : evidence.title).font(HearthFont.subheadline).lineLimit(2)
                Spacer()
                Button("Open") { router.open(.item(evidence.id)) }.font(HearthFont.caption)
            }
            Text(verbatim: "“\(evidence.quote)”").font(HearthFont.callout).textSelection(.enabled)
            FreshnessDatesLine(dates: evidence.dates)
        }
        .padding(HearthSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: HearthRadius.inner, style: .continuous).fill(hearth.surfaceSunken))
    }

    private func actionRow(_ index: Int, suggestion: FreshnessSuggestion, first: FreshnessEvidence, second: FreshnessEvidence) -> some View {
        let canSupersede = first.type == .note && second.type == .note
        return VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            FlowLayout(spacing: HearthSpacing.sm) {
                Button("Dismiss") { act(index, "Dismissed; this pair won't be suggested again.") { [try .dismissPair(first.ref, second.ref)] } }
                    .buttonStyle(.hearthQuiet)
                    .accessibilityIdentifier("FreshnessDismiss")
                Button("Both still current") {
                    act(index, "Both marked checked.") { [try .markChecked(first.ref), try .markChecked(second.ref)] }
                }
                .buttonStyle(.hearthQuiet)
                .accessibilityIdentifier("FreshnessCheckBoth")
                Button("Supersede…") {
                    let newerID = suggestion.newer?.id ?? first.id
                    superseding = Supersede(index: index, newer: newerID == first.id ? first : second, older: newerID == first.id ? second : first)
                }
                .buttonStyle(.hearthQuiet)
                .disabled(!canSupersede)
                .accessibilityIdentifier("FreshnessSupersede")
            }
            .disabled(working != nil || connection.knowledgeWriteReason != nil)
            if !canSupersede {
                Text("Only two ordinary notes can be superseded. Links and files can be marked checked instead.")
                    .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
            }
        }
    }

    private func analyze() {
        guard let client = connection.privateClient else { return }
        analyzing = true
        error = nil
        let input: FreshnessScopeInput = switch scope.kind {
        case .project: FreshnessScopeInput(project: scope.project)
        case .topic: FreshnessScopeInput(query: scope.topic.trimmed, project: scope.project)
        case .branch: FreshnessScopeInput(rootId: scope.branch?.id)
        }
        Task {
            defer { analyzing = false }
            do {
                let current = try await client.send(.aiStatus, as: AIStatus.self)
                status = current
                guard current.configured else { return }
                let next = try await client.send(.analyzeFreshness(input), as: FreshnessProposal.self)
                proposal = next
                handled = [:]
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }

    /// Requests go one after another; a stale later one is reported without undoing the earlier ones.
    private func act(_ index: Int, _ done: String, _ endpoints: () throws -> [Endpoint]) {
        guard let client = connection.privateClient, let requests = try? endpoints() else { return }
        working = index
        Task {
            defer { working = nil }
            do {
                for request in requests { _ = try await client.send(request, as: FreshnessReceipt.self) }
                handled[index] = done
            } catch {
                connection.note(error)
                router.show(error.isStaleConflict ? "These items changed since the comparison. Look for conflicts again to review their current text." : error.onlineOnlyMessage)
            }
        }
    }

    private func supersede(_ choice: Supersede) {
        act(choice.index, "“\(choice.older.title)” marked as superseded by “\(choice.newer.title)”. Both texts are unchanged.") {
            [try .supersede(newer: choice.newer.ref, older: choice.older.ref)]
        }
    }
}
