import EnveMemoryKit
import Foundation
import Observation

/// Journalled structural edits (`/editor/actions`): sent or queued like any write, and undone or redone as whole actions.
/// Text typed into a field keeps its own local undo; this stack is only for actions.
@Observable
final class EditorHistory {
    struct Action {
        enum State: Equatable {
            /// In the outbox as this entry.
            case queued(UUID)
            /// The server has it, or will before anything queued after it.
            case sent
            /// Taken back before it was sent; redo queues it again.
            case withdrawn
        }

        let id: String
        let label: String
        let endpoint: Endpoint
        var state: State
    }

    private(set) var undoStack: [Action] = []
    private(set) var redoStack: [Action] = []
    private(set) var isBusy = false

    private let outbox: OutboxService
    private let router: Router

    init(outbox: OutboxService, router: Router) {
        self.outbox = outbox
        self.router = router
    }

    var undoLabel: String? { undoStack.last?.label }
    var redoLabel: String? { redoStack.last?.label }

    /// Sends or queues one action. On failure nothing is recorded and the caller keeps its draft.
    @discardableResult
    func perform(_ commands: [EditorCommand], label: String, sent: String) async -> Bool {
        guard !commands.isEmpty, let endpoint = try? Endpoint.editorAction(commands), let id = endpoint.editorAction?.id else { return false }
        let outcome = await outbox.submit(endpoint, kind: .edit, title: label)
        guard router.report(outcome, sent: sent) else { return false }
        undoStack.append(Action(id: id, label: label, endpoint: endpoint, state: state(after: outcome, isAction: true)))
        redoStack = []
        return true
    }

    func undo() async {
        guard !isBusy, var action = undoStack.popLast() else { return }
        isBusy = true
        defer { isBusy = false }
        await outbox.reload()
        if case .queued(let entryID) = action.state, let entry = outbox.entries.first(where: { $0.id == entryID }) {
            if entry.needsAttention {
                router.show("“\(action.label)” was refused by the server, so there's nothing to undo. It's kept in Settings › Outbox.")
                return
            }
            // Only the newest waiting entry can be taken back: anything queued after it may refer to what it creates.
            if outbox.entries.last(where: { !$0.needsAttention })?.id == entryID, await outbox.withdraw(entryID) {
                action.state = .withdrawn
                redoStack.append(action)
                router.show("Undid \(action.label)")
                return
            }
        }
        let outcome = await outbox.submit(.undoEditorAction(action.id), kind: .edit, title: "Undo \(action.label)")
        if case .failed(let error) = outcome {
            router.show(Self.refusal("undo", action, error))
            return
        }
        router.report(outcome, sent: "Undid \(action.label)")
        action.state = .sent
        redoStack.append(action)
    }

    func redo() async {
        guard !isBusy, var action = redoStack.popLast() else { return }
        isBusy = true
        defer { isBusy = false }
        let outcome = await outbox.submit(action.state == .withdrawn ? action.endpoint : .redoEditorAction(action.id),
                                          kind: .edit, title: "Redo \(action.label)")
        if case .failed(let error) = outcome {
            router.show(Self.refusal("redo", action, error))
            return
        }
        router.report(outcome, sent: "Redid \(action.label)")
        action.state = state(after: outcome, isAction: action.state == .withdrawn)
        undoStack.append(action)
    }

    /// Unpairing or re-pairing: these actions belong to the old library.
    func reset() {
        undoStack = []
        redoStack = []
    }

    /// Only an entry carrying the action itself can be withdrawn later; a queued undo or redo refers to one the server has.
    private func state(after outcome: OutboxService.Outcome, isAction: Bool) -> Action.State {
        if isAction, case .queued(let entry) = outcome { return .queued(entry.id) }
        return .sent
    }

    private static func refusal(_ verb: String, _ action: Action, _ error: Error) -> String {
        if (error as? APIError)?.code == .conflict {
            return "Can't \(verb) “\(action.label)”: something it touched has changed since. \(error.localizedDescription)"
        }
        return error.localizedDescription
    }
}
