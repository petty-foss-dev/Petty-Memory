import EnveMemoryKit
import SwiftUI

/// Ask your computer's AI to change this item and what's inside it, review each change, apply the ones you keep.
/// Online only: proposals are never queued or cached. Opened with a chat's proposal, it only reviews that one.
struct AIEditSheet: View {
    let rootID: String
    private let fromChat: Bool

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var instruction = ""
    @State private var proposal: EditProposal?
    @State private var selected: Set<Int> = []
    @State private var titles: [String: String] = [:]
    /// The server's receipt for the changes just applied; kept only while this sheet is open.
    @State private var undo: JSONValue?
    @State private var working = false
    @State private var error: String?

    init(rootID: String, initialProposal: EditProposal? = nil) {
        self.rootID = rootID
        fromChat = initialProposal != nil
        _proposal = State(initialValue: initialProposal)
        _selected = State(initialValue: Set(initialProposal?.operations.indices ?? 0..<0))
    }

    var body: some View {
        NavigationStack {
            HearthScreen {
                if fromChat {
                    Text("Review what the AI proposed in chat. Nothing changes until you apply it, and nothing is ever deleted.")
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                } else {
                    composer
                }
                if let error { ErrorBanner(message: error) }
                if undo != nil {
                    HearthCard(padding: HearthSpacing.md) {
                        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                            Label("Changes applied", systemImage: "checkmark.circle").font(HearthFont.headline)
                            Text("Undo puts everything back as it was and archives the notes the AI added, as long as nothing else changed since.")
                                .font(HearthFont.footnote)
                                .foregroundStyle(hearth.textSecondary)
                            Button(working ? "Undoing…" : "Undo AI changes", action: revert)
                                .buttonStyle(.hearthSecondary)
                                .disabled(working)
                                .accessibilityIdentifier("AIUndo")
                        }
                    }
                }
                if let proposal { review(proposal) }
            }
            .navigationTitle("Edit with AI")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                if proposal != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(working ? "Applying…" : "Apply \(selected.count)", action: apply)
                            .disabled(working || selected.isEmpty)
                            .accessibilityIdentifier("AIApply")
                    }
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(working)
        .task {
            if fromChat, let proposal { await loadTitles(for: proposal) }
        }
    }

    @ViewBuilder
    private var composer: some View {
        Text("Describe the change, for example “group these into sections” or “turn this into a checklist”. Nothing changes until you apply it, and nothing is ever deleted.")
            .font(HearthFont.footnote)
            .foregroundStyle(hearth.textSecondary)
        TextField("What should change?", text: $instruction, axis: .vertical)
            .lineLimit(2...6)
            .hearthField()
            .disabled(working)
            .accessibilityIdentifier("AIInstruction")
        Button(action: propose) {
            if working, proposal == nil { ProgressView() } else { Label(proposal == nil ? "Propose changes" : "Ask again", systemImage: "sparkles") }
        }
        .buttonStyle(.hearthSecondary)
        .disabled(working || instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    @ViewBuilder
    private func review(_ proposal: EditProposal) -> some View {
        if !proposal.summary.isEmpty {
            HearthCard(padding: HearthSpacing.md) {
                Label(proposal.summary, systemImage: "sparkles").font(HearthFont.callout)
            }
        }
        if proposal.operations.isEmpty {
            EmptyStateView(symbol: "checkmark.seal", title: "No changes proposed", message: "Try describing the change differently.")
        } else {
            Overline("\(proposal.operations.count) proposed \(proposal.operations.count == 1 ? "change" : "changes")")
            ForEach(Array(proposal.operations.enumerated()), id: \.offset) { index, operation in
                OperationCard(operation: operation, titles: titles, isSelected: Binding(
                    get: { selected.contains(index) },
                    set: { if $0 { selected.insert(index) } else { selected.remove(index) } }))
            }
        }
    }

    private func propose() {
        guard let client = connection.privateClient else { return }
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                let result = try await client.send(.proposeEdit(rootId: rootID, instruction: instruction), as: EditProposal.self)
                proposal = result
                selected = Set(result.operations.indices)
                await loadTitles(for: result)
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = message(for: error)
            }
        }
    }

    private func apply() {
        guard let client = connection.privateClient, let proposal else { return }
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                // Sent back with its original base hash; the server rejects it if anything changed meanwhile.
                let result = try await client.send(.applyEdit(proposal.keeping(selected)), as: ApplyResult.self)
                connection.didWrite()
                router.show(result.applied == 1 ? "Applied 1 change" : "Applied \(result.applied) changes")
                if let receipt = result.undo {
                    self.proposal = nil
                    undo = receipt
                } else {
                    dismiss()
                }
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                if (error as? APIError)?.code == .conflict { self.proposal = nil }
                self.error = message(for: error)
            }
        }
    }

    /// Restores the state before the AI's changes and archives the notes it created, if nothing changed since.
    private func revert() {
        guard let client = connection.privateClient, let undo else { return }
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                let result = try await client.send(.undoEdit(undo), as: RestoreResult.self)
                connection.didWrite()
                router.show(result.summary("AI changes undone"))
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = message(for: error)
            }
        }
    }

    private func message(for error: Error) -> String {
        if let error = error as? APIError, error.allowsCachedFallback {
            return "AI edits need a connection to your server. Try again when you're back on your network."
        }
        return error.localizedDescription
    }

    /// Names for the parents and anchors that moves and new notes refer to.
    private func loadTitles(for proposal: EditProposal) async {
        var ids = Set(proposal.operations.flatMap { [$0.parentId, $0.beforeId, $0.before?.parentId].compactMap(\.self) })
        ids.insert(rootID)
        titles.merge(proposal.titles ?? [:]) { current, _ in current }
        for operation in proposal.operations {
            if let id = operation.id, let before = operation.before { titles[id] = before.title }
        }
        for id in ids.subtracting(titles.keys).prefix(30) {
            if let entry = try? await connection.load(.outlineEntry(id), as: OutlineEntry.self).value {
                titles[id] = entry.item.displayTitle
            }
        }
    }
}

private struct OperationCard: View {
    let operation: EditOperation
    let titles: [String: String]
    @Binding var isSelected: Bool

    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Toggle(isOn: $isSelected) {
                    Label(heading, systemImage: symbol).font(HearthFont.subheadline)
                }
                details
            }
        }
        .opacity(isSelected ? 1 : 0.6)
    }

    private func name(_ id: String?) -> String {
        guard let id else { return "the top level" }
        return "“\(titles[id] ?? "an item in this branch")”"
    }

    private var heading: String {
        switch operation.kind {
        case .update: "Edit \(name(operation.id))"
        case .create: "New note in \(name(operation.parentId))"
        case .move: "Move \(name(operation.id))"
        case .presentation: "Restyle \(name(operation.id))"
        case .unknown: "Change"
        }
    }

    private var symbol: String {
        switch operation.kind {
        case .update: "pencil"
        case .create: "plus"
        case .move: "arrow.up.and.down.and.arrow.left.and.right"
        case .presentation: "textformat"
        case .unknown: "questionmark"
        }
    }

    @ViewBuilder
    private var details: some View {
        switch operation.kind {
        case .update:
            if let title = operation.title { change("Title", from: operation.before?.title, to: title) }
            if let body = operation.body { change("Text", from: operation.before?.body, to: body) }
        case .create:
            change("Title", from: nil, to: operation.title ?? "")
            if let body = operation.body, !body.isEmpty { change("Text", from: nil, to: body) }
        case .move:
            line("From \(name(operation.before?.parentId)) to \(name(operation.parentId))"
                 + (operation.beforeId.map { ", before \(name($0))" } ?? ", at the end"))
        case .presentation:
            ForEach(presentationChanges, id: \.self) { line($0) }
        case .unknown:
            line("This version of the app can't show this change.")
        }
    }

    private var presentationChanges: [String] {
        guard let patch = operation.patch else { return [] }
        let before = operation.presentationBefore ?? ItemPresentation()
        var lines: [String] = []
        if let kind = patch.kind { lines.append("Style: \(before.kind.rawValue) → \(kind.rawValue)") }
        if let attention = patch.attention { lines.append("Attention: \(before.attention.rawValue) → \(attention.rawValue)") }
        if let review = patch.review { lines.append("Review mark: \(before.review ? "on" : "off") → \(review ? "on" : "off")") }
        if let checklist = patch.checklist { lines.append("Checklist: \(before.checklist ? "on" : "off") → \(checklist ? "on" : "off")") }
        if let hide = patch.hideCompleted { lines.append("Hide completed: \(before.hideCompleted ? "on" : "off") → \(hide ? "on" : "off")") }
        if let checked = patch.checked { lines.append("Done: \(before.checked ? "yes" : "no") → \(checked ? "yes" : "no")") }
        if let auto = patch.autoOrganize { lines.append("Auto-organize: \(before.autoOrganize ? "on" : "off") → \(auto ? "on" : "off")") }
        return lines
    }

    private func line(_ text: String) -> some View {
        Text(text).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
    }

    @ViewBuilder
    private func change(_ label: String, from before: String?, to after: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let before, before != after {
                Text("\(label) before").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                Text(before.isEmpty ? "(empty)" : before).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
                    .strikethrough(true, color: hearth.textTertiary)
                    .lineLimit(8)
            }
            Text(before == nil ? label : "\(label) after").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
            Text(after.isEmpty ? "(empty)" : after).font(HearthFont.footnote).lineLimit(12)
        }
    }
}
