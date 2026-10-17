import EnveMemoryKit
import SwiftUI

/// The same briefing an AI gets from `get_project`: memory, decisions, open tasks, recent items.
struct ProjectBriefingView: View {
    let projectID: String

    @Environment(Connection.self) private var connection
    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var briefing: ProjectBriefing?
    @State private var memory = MarkdownDocument("")
    @State private var error: String?
    @State private var completing: Set<String> = []
    @State private var cachedAt: Date?

    var body: some View {
        HearthScreen(title: briefing?.project.name, overline: "Project") {
            if let cachedAt { CachedBanner(savedAt: cachedAt) }
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            if let briefing {
                content(briefing)
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity).padding(.top, HearthSpacing.xxxl)
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    @ViewBuilder
    private func content(_ briefing: ProjectBriefing) -> some View {
        let project = briefing.project
        if !project.description.isEmpty {
            Text(project.description)
                .font(HearthFont.callout)
                .foregroundStyle(hearth.textSecondary)
        }
        if !project.instructions.isEmpty {
            HearthCard(padding: HearthSpacing.md) {
                VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                    Overline("Standing instructions")
                    Text(project.instructions).font(HearthFont.callout)
                }
            }
        }

        Overline("Memory")
        HearthCard(padding: HearthSpacing.xl) {
            if memory.isEmpty {
                Text("No memory document yet. Agents write one with `set_project_memory`.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
            } else {
                MarkdownView(document: memory)
            }
        }

        if !briefing.decisions.isEmpty {
            Overline("Decisions")
            HearthCard(padding: HearthSpacing.md) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(briefing.decisions.reversed().enumerated()), id: \.element.id) { index, decision in
                        if index > 0 { HearthDivider() }
                        DecisionRow(decision: decision)
                    }
                }
            }
        }

        Overline("Open tasks")
        if briefing.openTasks.isEmpty {
            Text("Nothing open.").font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
        } else {
            RowStack(data: briefing.openTasks) { task in
                TaskRow(task: task, isCompleting: completing.contains(task.id),
                        onComplete: { complete(task) }, onOpen: { router.open(.item(task.id)) })
            }
        }

        if !briefing.recentItems.isEmpty {
            Overline("Recent")
            RowStack(data: briefing.recentItems) { item in
                Button { router.open(.item(item.id)) } label: { ItemRow(item: item, showsProject: false) }
                    .buttonStyle(.plain)
            }
        }
    }

    private func load() async {
        guard connection.client != nil else { return }
        do {
            let loaded = try await connection.load(.briefing(projectID), as: ProjectBriefing.self)
            briefing = loaded.value
            cachedAt = loaded.cachedAt
            memory = MarkdownDocument(loaded.value.project.memory)
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func complete(_ task: Item) {
        completing.insert(task.id)
        Task {
            if await !TaskCompleter(outbox: outbox, router: router).complete(task) {
                completing.remove(task.id)
            }
        }
    }
}

private struct DecisionRow: View {
    let decision: Decision
    @Environment(\.hearth) private var hearth

    var body: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.xs) {
            Text(decision.decision)
                .font(HearthFont.body.weight(decision.isSuperseded ? .regular : .medium))
                .foregroundStyle(decision.isSuperseded ? hearth.textTertiary : hearth.textPrimary)
                .strikethrough(decision.isSuperseded, color: hearth.textTertiary)
            if !decision.reason.isEmpty {
                Text(decision.reason)
                    .font(HearthFont.footnote)
                    .foregroundStyle(decision.isSuperseded ? hearth.textTertiary : hearth.textSecondary)
            }
            HStack(spacing: HearthSpacing.xs) {
                if decision.isSuperseded {
                    Text("Superseded")
                        .font(HearthFont.caption.weight(.semibold))
                        .padding(.horizontal, HearthSpacing.sm)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(hearth.surfaceSunken))
                }
                Text(decision.createdAt.formatted(date: .abbreviated, time: .omitted))
                Text("·")
                Text(decision.source)
            }
            .font(HearthFont.caption)
            .foregroundStyle(hearth.textTertiary)
        }
        .padding(.vertical, HearthSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(decision.isSuperseded ? 0.8 : 1)
        .accessibilityElement(children: .combine)
    }
}
