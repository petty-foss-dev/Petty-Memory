import EnveMemoryKit
import SwiftUI

/// Reviews proposed tasks, tags, reminders and briefs: tick the ones to keep, apply them together, undo them together.
struct ActionReviewSheet: View {
    let proposal: ActionProposal
    /// Held by the chat, so the undo receipt outlives this sheet.
    @Binding var result: ActionResult?

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    /// Starts with every operation this app can show, and survives failed or stale applies.
    @State private var selected: Set<String>
    @State private var titles: [String: String] = [:]
    @State private var stale = false
    @State private var working = false
    @State private var error: String?

    init(proposal: ActionProposal, result: Binding<ActionResult?>) {
        self.proposal = proposal
        _result = result
        _selected = State(initialValue: Set(proposal.reviewableIDs))
        _titles = State(initialValue: proposal.titles)
    }

    var body: some View {
        NavigationStack {
            HearthScreen {
                if let result {
                    applied(result)
                } else {
                    intro
                }
                if let error { ErrorBanner(message: error) }
                if stale {
                    OnlineOnlyNote(reason: "Your notes changed after this proposal was made, so it can't be applied. Ask again in chat for a fresh one; your ticks here are kept until then.")
                }
                if result == nil {
                    if proposal.operations.isEmpty {
                        EmptyStateView(symbol: "checkmark.seal", title: "No actions proposed", message: "Try asking differently, or choose other notes.")
                    } else {
                        ForEach(proposal.operations) { operation in
                            ActionCard(operation: operation, titles: titles, isSelected: Binding(
                                get: { selected.contains(operation.id) },
                                set: { if $0 { selected.insert(operation.id) } else { selected.remove(operation.id) } }))
                            .disabled(working || stale)
                        }
                    }
                }
            }
            .navigationTitle("Review actions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(working) }
                if result == nil, !proposal.operations.isEmpty {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(working ? "Applying…" : "Apply \(selected.count)", action: apply)
                            .disabled(working || stale || selected.isEmpty || blocked != nil)
                            .accessibilityIdentifier("ActionsApply")
                    }
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(working)
        .task { await loadTitles() }
    }

    @ViewBuilder
    private var intro: some View {
        if !proposal.summary.isEmpty {
            HearthCard(padding: HearthSpacing.md) {
                Label { Text(verbatim: proposal.summary) } icon: { Image(systemName: "sparkles") }
                    .font(HearthFont.callout)
            }
        }
        Text(scopeLine + " Nothing changes until you tap Apply. Your computer files new tasks and briefs with the notes they came from; tags are only added, and nothing is deleted.")
            .font(HearthFont.footnote)
            .foregroundStyle(hearth.textSecondary)
            .accessibilityIdentifier("ActionsIntro")
        if let blocked { OnlineOnlyNote(reason: blocked) }
    }

    private var scopeLine: String {
        if let query = proposal.query { return "Proposed from notes about “\(query)”." }
        if let rootId = proposal.rootId { return "Proposed from “\(titles[rootId] ?? "the chosen notes")” and the notes inside it." }
        return "Proposed from your notes."
    }

    private var blocked: String? {
        guard connection.isOnline else { return "Applying needs a connection to your computer. Nothing is queued." }
        guard connection.scopes.contains("write") else { return "This pairing is read-only, so these actions can't be applied from this phone." }
        return nil
    }

    private func applied(_ result: ActionResult) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Label(appliedLine(result), systemImage: "checkmark.circle").font(HearthFont.headline)
                Text("Undo archives what was created and puts tags and reminders back as they were, as long as nothing they touched changed since.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                if let first = result.createdIds.first {
                    Button("Open what was created", systemImage: "arrow.up.right") {
                        dismiss()
                        router.open(.item(first))
                    }
                    .buttonStyle(.hearthSecondary)
                }
                Button(working ? "Undoing…" : "Undo actions", action: revert)
                    .buttonStyle(.hearthSecondary)
                    .disabled(working || blocked != nil)
                    .accessibilityIdentifier("ActionsUndo")
            }
        }
    }

    private func appliedLine(_ result: ActionResult) -> String {
        switch (result.createdIds.count, result.updatedIds.count) {
        case (0, 0): "Applied"
        case (let created, 0): "Created \(created)"
        case (0, let updated): "Updated \(updated)"
        case (let created, let updated): "Created \(created), updated \(updated)"
        }
    }

    private func apply() {
        guard blocked == nil, let client = connection.privateClient else { return }
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                let applied = try await client.send(.applyActions(proposal, including: selected), as: ActionResult.self)
                result = applied
                connection.didWrite()
                router.show(appliedLine(applied))
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                if (error as? APIError)?.code == .conflict { stale = true }
                self.error = message(for: error, nothing: "Nothing was changed")
            }
        }
    }

    private func revert() {
        guard blocked == nil, let client = connection.privateClient, let receipt = result?.undo else { return }
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                let undone = try await client.send(.undoActions(receipt), as: ActionUndoResult.self)
                result = nil
                connection.didWrite()
                router.show(undone.restored == 1 ? "Undid 1 change" : "Undid \(undone.restored) changes")
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = (error as? APIError)?.code == .conflict
                    ? "Something these actions touched changed since, so undo was refused rather than overwrite newer work. \(error.localizedDescription)"
                    : message(for: error, nothing: "Nothing was undone")
            }
        }
    }

    private func message(for error: Error, nothing: String) -> String {
        if case .unreachable = error as? APIError {
            return "Couldn't reach your computer. \(nothing); try again when you're back on your network."
        }
        return error.localizedDescription
    }

    private func loadTitles() async {
        let ids = Set(proposal.operations.flatMap(\.referencedIDs) + [proposal.rootId].compactMap(\.self))
        for id in ids where titles[id] == nil {
            if let entry = try? await connection.load(.outlineEntry(id), as: OutlineEntry.self).value {
                titles[id] = entry.item.displayTitle
            }
        }
    }
}

private struct ActionCard: View {
    let operation: ActionOperation
    let titles: [String: String]
    @Binding var isSelected: Bool

    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                if case .unknown = operation.kind {
                    Label("This version of the app can't show this action, so it won't be applied from here.", systemImage: "questionmark")
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                } else {
                    Toggle(isOn: $isSelected) {
                        Label(heading, systemImage: symbol).font(HearthFont.subheadline)
                    }
                    .accessibilityIdentifier("ActionOperation")
                    details
                }
            }
        }
        .opacity(isSelected ? 1 : 0.6)
    }

    private func name(_ id: String) -> String { "“\(titles[id] ?? "a note")”" }

    private var heading: String {
        switch operation.kind {
        case .task(let title, _, _, _): "New task: \(title)"
        case .tag(let itemId, _): "Tag \(name(itemId))"
        case .reminder(let itemId, _): "Remind me about \(name(itemId))"
        case .note(let title, _, _): "New note: \(title)"
        case .unknown: ""
        }
    }

    private var symbol: String {
        switch operation.kind {
        case .task: "checkmark.circle"
        case .tag: "number"
        case .reminder: "bell"
        case .note: "note.text"
        case .unknown: "questionmark"
        }
    }

    @ViewBuilder
    private var details: some View {
        switch operation.kind {
        case .task(_, let body, let sourceId, let dueAt):
            if !body.isEmpty { line(body) }
            if let due = dueAt.flatMap(DueDate.parse) { line("Due \(due.formatted(date: .abbreviated, time: .omitted))") }
            if let sourceId { line("From \(name(sourceId))") }
        case .tag(_, let tags):
            FlowLayout { ForEach(tags, id: \.self) { TagChip(tag: $0) } }
        case .reminder(_, let remindAt):
            line(remindAt.flatMap(JSONCoding.parseTimestamp).map { "At \($0.formatted(date: .abbreviated, time: .shortened))" } ?? "Clears the reminder")
        case .note(_, let body, let sourceIds):
            Text(verbatim: body).font(HearthFont.footnote).textSelection(.enabled)
            if !sourceIds.isEmpty { line("From " + sourceIds.prefix(5).map(name).joined(separator: ", ")) }
        case .unknown:
            EmptyView()
        }
    }

    private func line(_ text: String) -> some View {
        Text(verbatim: text).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
    }
}
