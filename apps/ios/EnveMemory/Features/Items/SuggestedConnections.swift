import EnveMemoryKit
import SwiftUI

/// Notes that mention this one without a link, cover the same ground, or may duplicate it. Found without AI, on request;
/// nothing is connected or merged until the person chooses to.
struct SuggestedConnections: View {
    let item: Item

    @Environment(Connection.self) private var connection
    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var insights: ItemInsights?
    @State private var loading = false
    @State private var error: String?
    @State private var handled: Set<String> = []
    @State private var merging: MergeChoice?

    var body: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            HStack {
                Overline("Suggested connections")
                Spacer()
                if insights != nil {
                    Button(loading ? "Looking…" : "Look again") { Task { await load() } }
                        .font(HearthFont.subheadline)
                        .disabled(loading || readReason != nil)
                }
            }
            if let insights = insights?.removing(handled) {
                found(insights)
            } else {
                Text("Find notes that mention this one, cover the same ground, or may be duplicates. No AI is used, and nothing changes until you choose.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                Button { Task { await load() } } label: {
                    if loading { ProgressView() } else { Label("Find connections", systemImage: "point.3.filled.connected.trianglepath.dotted") }
                }
                .buttonStyle(.hearthSecondary)
                .disabled(loading || readReason != nil)
                .accessibilityIdentifier("FindConnections")
            }
            if let reason = readReason ?? (insights == nil ? nil : writeReason) { OnlineOnlyNote(reason: reason) }
            if let error { ErrorBanner(message: error) }
        }
        .sheet(item: $merging) { choice in
            MergeReviewSheet(choice: choice).environment(\.hearth, hearth)
        }
        .task(id: connection.revision) {
            if insights != nil { await load() }
        }
    }

    @ViewBuilder
    private func found(_ insights: ItemInsights) -> some View {
        if insights.isEmpty {
            Text("Nothing else looks connected right now.")
                .font(HearthFont.footnote)
                .foregroundStyle(hearth.textSecondary)
                .accessibilityIdentifier("NoSuggestedConnections")
        }
        group(.mentions, insights.mentions)
        group(.related, insights.related)
        group(.duplicates, insights.duplicates)
        if insights.isBounded {
            Text("Looked through \(insights.scanned.formatted()) of \(insights.total.formatted()) items, so there may be more.")
                .font(HearthFont.caption)
                .foregroundStyle(hearth.textTertiary)
        }
    }

    private enum Kind {
        case mentions, related, duplicates

        var title: String {
            switch self {
            case .mentions: "Mentions without a link"
            case .related: "Related"
            case .duplicates: "Possible duplicates"
            }
        }

        var symbol: String {
            switch self {
            case .mentions: "text.quote"
            case .related: "point.3.connected.trianglepath.dotted"
            case .duplicates: "doc.on.doc"
            }
        }
    }

    @ViewBuilder
    private func group(_ kind: Kind, _ suggestions: [KnowledgeSuggestion]) -> some View {
        if !suggestions.isEmpty {
            Text(kind.title).font(HearthFont.subheadline).padding(.top, HearthSpacing.xs)
            RowStack(data: suggestions) { suggestion in
                SuggestionRow(suggestion: suggestion, symbol: kind.symbol, open: { router.open(.item(suggestion.id)) }) {
                    if kind == .duplicates {
                        Menu {
                            Button("Merge it into this note…") {
                                merging = MergeChoice(sourceId: suggestion.id, targetId: item.id, sourceTitle: suggestion.title, targetTitle: item.displayTitle)
                            }
                            Button("Merge this note into it…") {
                                merging = MergeChoice(sourceId: item.id, targetId: suggestion.id, sourceTitle: item.displayTitle, targetTitle: suggestion.title)
                            }
                        } label: {
                            Text("Merge…").font(HearthFont.subheadline)
                        }
                        .disabled(writeReason != nil)
                        .accessibilityIdentifier("SuggestionMerge")
                    } else {
                        Button("Connect") { connect(suggestion) }
                            .font(HearthFont.subheadline)
                            .disabled(writeReason != nil)
                            .accessibilityIdentifier("SuggestionConnect")
                    }
                }
            }
        }
    }

    private var readReason: String? {
        switch connection.status {
        case .online: nil
        case .unknown, .checking: "Connecting to your computer…"
        case .offline: "Finding connections needs a connection to your computer."
        case .unauthorized: "This phone's pairing was revoked. Pair again to find connections."
        }
    }

    private var writeReason: String? {
        connection.scopes.contains("write") ? nil : "This pairing is read-only, so suggestions can be opened but not connected or merged."
    }

    private func load() async {
        guard connection.isOnline, let client = connection.privateClient else { return }
        loading = true
        defer { loading = false }
        do {
            insights = try await client.send(.insights(item.id), as: ItemInsights.self)
            handled = []
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.localizedDescription
        }
    }

    /// The same "related to" connection as adding one by hand, so it's removable from Connections.
    private func connect(_ suggestion: KnowledgeSuggestion) {
        handled.insert(suggestion.id)
        Task {
            let done = await ItemActions(outbox: outbox, router: router)
                .edit(try? .relate(item.id, to: suggestion.id, kind: "related_to"), title: "Connect “\(suggestion.title)”", sent: "Connected")
            if !done { handled.remove(suggestion.id) }
        }
    }
}

struct MergeChoice: Identifiable {
    let sourceId: String
    let targetId: String
    let sourceTitle: String
    let targetTitle: String

    var id: String { "\(sourceId)>\(targetId)" }
}

private struct SuggestionRow<Action: View>: View {
    let suggestion: KnowledgeSuggestion
    let symbol: String
    let open: () -> Void
    @ViewBuilder let action: Action

    @Environment(\.hearth) private var hearth

    var body: some View {
        HStack(alignment: .top, spacing: HearthSpacing.md) {
            Button(action: open) {
                HStack(alignment: .top, spacing: HearthSpacing.md) {
                    TypeGlyph(symbol: symbol)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: suggestion.title.isEmpty ? "Untitled" : suggestion.title).font(HearthFont.subheadline).lineLimit(2)
                        if !suggestion.snippet.isEmpty {
                            Text(Snippet.attributed(suggestion.snippet, highlight: hearth.accent, title: suggestion.title))
                                .font(HearthFont.caption)
                                .foregroundStyle(hearth.textSecondary)
                                .lineLimit(3)
                        }
                        Text(verbatim: suggestion.reason).font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            action
        }
        .padding(.vertical, HearthSpacing.xs)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("SuggestedConnection")
    }
}

/// Shows exactly what a merge does before it happens, then offers undo while nothing has changed since.
struct MergeReviewSheet: View {
    let choice: MergeChoice

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var proposal: MergeProposal?
    @State private var result: EditorActionResult?
    @State private var stale = false
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            HearthScreen {
                if let result {
                    merged(result)
                } else {
                    explanation
                    if let preview = proposal?.previewText {
                        Overline("“\(choice.targetTitle)” after merging")
                        Text(verbatim: preview)
                            .font(HearthFont.footnote)
                            .textSelection(.enabled)
                            .padding(HearthSpacing.md)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: HearthRadius.inner, style: .continuous).fill(hearth.surfaceSunken))
                            .accessibilityIdentifier("MergePreview")
                    } else if proposal == nil, error == nil {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                    if stale {
                        OnlineOnlyNote(reason: "One of the notes changed after this preview, so nothing was merged.")
                        Button("Preview again") { Task { await preview() } }
                            .buttonStyle(.hearthSecondary)
                    }
                }
                if let error { ErrorBanner(message: error) }
            }
            .navigationTitle("Merge notes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(working) }
                if result == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(working ? "Merging…" : "Merge", action: merge)
                            .disabled(working || stale || proposal == nil || !connection.isOnline || !connection.scopes.contains("write"))
                            .accessibilityIdentifier("MergeConfirm")
                    }
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(working)
        .task { await preview() }
    }

    private var explanation: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Text("Merge “\(proposal?.sourceTitle ?? choice.sourceTitle)” into “\(proposal?.targetTitle ?? choice.targetTitle)”")
                    .font(HearthFont.headline)
                bullet("Its text is added to “\(choice.targetTitle)”, as previewed below.")
                bullet("Notes inside it move under “\(choice.targetTitle)”, with everything inside them.")
                bullet("“\(choice.sourceTitle)” is then archived, not deleted. Its files stay attached to that archived original, which you can restore from its history.")
                bullet("Undo reverses the merge as long as neither note has changed since.")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("MergeExplanation")
    }

    private func bullet(_ text: String) -> some View {
        Label { Text(text) } icon: { Image(systemName: "circle.fill").font(.system(size: 5)) }
            .font(HearthFont.footnote)
            .foregroundStyle(hearth.textSecondary)
    }

    private func merged(_ result: EditorActionResult) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Label("Merged into “\(choice.targetTitle)”", systemImage: "checkmark.circle").font(HearthFont.headline)
                Text("“\(choice.sourceTitle)” is archived with its files. Undo puts both notes back as they were while neither has changed since.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                Button("Open “\(choice.targetTitle)”", systemImage: "arrow.up.right") {
                    dismiss()
                    router.open(.item(choice.targetId))
                }
                .buttonStyle(.hearthSecondary)
                Button(working ? "Undoing…" : "Undo merge", action: undo)
                    .buttonStyle(.hearthSecondary)
                    .disabled(working)
                    .accessibilityIdentifier("MergeUndo")
            }
        }
    }

    private func preview() async {
        guard let client = connection.privateClient else { return }
        stale = false
        error = nil
        do {
            proposal = try await client.send(.previewMerge(sourceId: choice.sourceId, targetId: choice.targetId), as: MergeProposal.self)
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = message(for: error, nothing: "Nothing was merged")
        }
    }

    private func merge() {
        guard let client = connection.privateClient, let proposal else { return }
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                result = try await client.send(.merge(proposal), as: EditorActionResult.self)
                connection.didWrite()
                router.show("Merged into “\(choice.targetTitle)”")
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                if (error as? APIError)?.code == .conflict {
                    stale = true
                    self.proposal = nil
                } else {
                    self.error = message(for: error, nothing: "Nothing was merged")
                }
            }
        }
    }

    private func undo() {
        guard let client = connection.privateClient, let result else { return }
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                _ = try await client.data(for: .undoEditorAction(result.actionId))
                self.result = nil
                connection.didWrite()
                router.show("Merge undone")
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = (error as? APIError)?.code == .conflict
                    ? "One of the notes changed after the merge, so undo was refused rather than overwrite newer work. You can still restore “\(choice.sourceTitle)” from its history."
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
}
