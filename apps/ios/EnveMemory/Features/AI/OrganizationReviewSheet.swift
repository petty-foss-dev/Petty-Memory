import EnveMemoryKit
import SwiftUI

/// Reviews a library organization from chat: untick false matches, apply the rest as one undoable move.
struct OrganizationReviewSheet: View {
    let proposal: OrganizationProposal
    /// Held by the chat, so the undo receipt outlives this sheet.
    @Binding var result: OrganizationResult?

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var selected: Set<String>
    @State private var parentTitles: [String: String] = [:]
    @State private var stale = false
    @State private var working = false
    @State private var error: String?

    init(proposal: OrganizationProposal, result: Binding<OrganizationResult?>) {
        self.proposal = proposal
        _result = result
        _selected = State(initialValue: Set(proposal.candidateIDs))
    }

    static func overview(_ proposal: OrganizationProposal) -> String {
        let notes = proposal.matchedCount == 1 ? "1 note matches" : "\(proposal.matchedCount) notes match"
        let moves = proposal.items.count == 1 ? "1 note would move" : "\(proposal.items.count) notes would move"
        return "\(notes) “\(proposal.query)”. \(moves), \(proposal.affectedCount) items in all with what's inside them."
    }

    var body: some View {
        NavigationStack {
            HearthScreen {
                if let result {
                    AppliedCard(title: proposal.destination.title, moved: result.moved, working: working, open: { open(result) }, undo: revert)
                } else {
                    if !proposal.summary.isEmpty {
                        HearthCard(padding: HearthSpacing.md) {
                            Label { Text(verbatim: proposal.summary) } icon: { Image(systemName: "sparkles") }
                                .font(HearthFont.callout)
                        }
                    }
                    Text(Self.overview(proposal))
                        .font(HearthFont.subheadline)
                        .accessibilityIdentifier("OrganizationCounts")
                    Text("Moving a note brings everything inside it along. Text, tags, files and project filing stay as they are; only the outline changes. Untick anything that doesn't belong.")
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                    if proposal.suggestedCount > 0 {
                        Label {
                            Text(proposal.suggestedCount == 1
                                 ? "1 note is a suggestion: it doesn't contain “\(proposal.query)” but seems related in meaning. Related suggestions come from a limited search, so check it before moving."
                                 : "\(proposal.suggestedCount) notes are suggestions: they don't contain “\(proposal.query)” but seem related in meaning. Related suggestions come from a limited search, so check them before moving.")
                        } icon: {
                            Image(systemName: "sparkle.magnifyingglass")
                        }
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                        .accessibilityIdentifier("OrganizationSuggestedNote")
                    }
                }
                if let error { ErrorBanner(message: error) }
                if result == nil { outline }
            }
            .navigationTitle("Organize library")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                if result == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(working ? "Moving…" : "Move \(selected.count)", action: apply)
                            .disabled(working || stale || selected.isEmpty)
                            .accessibilityIdentifier("OrganizationApply")
                    }
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(working)
        .task { await loadParentTitles() }
    }

    @ViewBuilder
    private var outline: some View {
        Overline("Proposed outline")
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.md) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: proposal.destination.title).font(HearthFont.cardTitle)
                        Text(proposal.destination.create ? "New top-level note" : "Your existing top-level note; its text stays as it is")
                            .font(HearthFont.caption)
                            .foregroundStyle(hearth.textSecondary)
                    }
                } icon: {
                    Image(systemName: proposal.destination.create ? "plus.rectangle.on.folder" : "folder")
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("OrganizationDestination")
                let created = proposal.createdGroups(selecting: selected)
                ForEach(rows, id: \.self) { row in
                    switch row.entry {
                    case .group(let group):
                        GroupRow(title: group.title, isCreated: created.contains(group.id))
                            .padding(.leading, indent(row.depth))
                    case .candidate(let candidate):
                        CandidateRow(candidate: candidate, from: origin(of: candidate), isSelected: Binding(
                            get: { selected.contains(candidate.id) },
                            set: { if $0 { selected.insert(candidate.id) } else { selected.remove(candidate.id) } }))
                        .padding(.leading, indent(row.depth))
                        .disabled(working)
                    }
                }
            }
        }
        let count = proposal.movedCount(selecting: selected)
        Text("Moves \(count) \(count == 1 ? "item" : "items"). Nothing moves until you tap Move.")
            .font(HearthFont.caption)
            .foregroundStyle(hearth.textTertiary)
    }

    private struct Row: Hashable {
        let depth: Int
        let entry: OrganizationProposal.Entry
    }

    private var rows: [Row] {
        var rows: [Row] = []
        func visit(_ parentID: String, depth: Int) {
            for entry in proposal.entries(in: parentID) {
                rows.append(Row(depth: depth, entry: entry))
                if case .group(let group) = entry { visit(group.id, depth: depth + 1) }
            }
        }
        visit(proposal.destination.id, depth: 1)
        return rows
    }

    private func indent(_ depth: Int) -> CGFloat { CGFloat(min(depth, 6)) * HearthSpacing.lg }

    private func origin(of candidate: OrganizationProposal.Candidate) -> String {
        guard let parentID = candidate.parentId else { return "From the top level" }
        return "From “\(parentTitles[parentID] ?? "another note")”"
    }

    private func apply() {
        guard let client = connection.privateClient else { return }
        let ids = proposal.candidateIDs.filter(selected.contains)
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                let applied = try await client.send(.applyOrganization(proposal, including: ids), as: OrganizationResult.self)
                result = applied
                connection.didWrite()
                router.show(applied.moved == 1 ? "Moved 1 note" : "Moved \(applied.moved) notes")
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                if (error as? APIError)?.code == .conflict { stale = true }
                self.error = message(for: error, nothing: "Nothing moved")
            }
        }
    }

    private func revert() {
        guard let client = connection.privateClient, let receipt = result?.undo else { return }
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                _ = try await client.send(.undoOrganization(receipt), as: EditorActionResult.self)
                result = nil
                connection.didWrite()
                router.show("Organization undone")
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = message(for: error, nothing: "Nothing was undone")
            }
        }
    }

    private func open(_ result: OrganizationResult) {
        dismiss()
        router.open(.outline(result.rootId))
    }

    private func message(for error: Error, nothing: String) -> String {
        if case .unreachable = error as? APIError {
            return "Couldn't reach your computer. \(nothing); try again when you're back on your network."
        }
        return error.localizedDescription
    }

    private func loadParentTitles() async {
        let moving = Set(proposal.candidateIDs)
        let ids = Set(proposal.items.compactMap(\.parentId)).subtracting(moving)
        for id in ids {
            if let entry = try? await connection.load(.outlineEntry(id), as: OutlineEntry.self).value {
                parentTitles[id] = entry.item.displayTitle
            }
        }
    }
}

private struct GroupRow: View {
    let title: String
    let isCreated: Bool

    @Environment(\.hearth) private var hearth

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label { Text(verbatim: title) } icon: { Image(systemName: "number") }
                .font(HearthFont.subheadline)
            Text(isCreated ? "New heading" : "Not created: nothing selected goes here")
                .font(HearthFont.caption)
                .foregroundStyle(hearth.textTertiary)
        }
        .opacity(isCreated ? 1 : 0.5)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("OrganizationGroup")
    }
}

private struct CandidateRow: View {
    let candidate: OrganizationProposal.Candidate
    let from: String
    @Binding var isSelected: Bool

    @Environment(\.hearth) private var hearth

    var body: some View {
        Toggle(isOn: $isSelected) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: candidate.title.isEmpty ? "Untitled note" : candidate.title)
                    .font(HearthFont.subheadline)
                    .lineLimit(2)
                if candidate.isSuggested {
                    Label("Suggested · related in meaning", systemImage: "sparkle.magnifyingglass")
                        .font(HearthFont.caption.weight(.medium))
                        .foregroundStyle(hearth.accentText)
                }
                if !candidate.body.isEmpty {
                    Text(verbatim: candidate.body)
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textSecondary)
                        .lineLimit(2)
                }
                Text(details)
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textTertiary)
            }
        }
        .opacity(isSelected ? 1 : 0.6)
        .accessibilityIdentifier("OrganizationCandidate")
    }

    private var details: String {
        switch candidate.descendantCount {
        case 0: from
        case 1: "\(from) · carries 1 item inside it"
        case let count: "\(from) · carries \(count) items inside it"
        }
    }
}

private struct AppliedCard: View {
    let title: String
    let moved: Int
    let working: Bool
    let open: () -> Void
    let undo: () -> Void

    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Label {
                    Text(verbatim: moved == 1 ? "Moved 1 note under “\(title)”" : "Moved \(moved) notes under “\(title)”")
                } icon: {
                    Image(systemName: "checkmark.circle")
                }
                .font(HearthFont.headline)
                Button("Open “\(title)”", systemImage: "list.bullet.indent", action: open)
                    .buttonStyle(.hearthSecondary)
                    .accessibilityIdentifier("OrganizationOpen")
                Text("Undo puts every note back where it was and archives the new headings, as long as nothing under “\(title)” changed since.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                Button(working ? "Undoing…" : "Undo organization", action: undo)
                    .buttonStyle(.hearthSecondary)
                    .disabled(working)
                    .accessibilityIdentifier("OrganizationUndo")
            }
        }
    }
}
