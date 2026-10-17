import Foundation

/// What the outbox is still waiting to send, read back from its endpoints in order so cached screens show local edits:
/// text, presentation, checks (with their descendants), new notes and every queued placement.
public struct PendingEdits: Hashable, Sendable {
    /// A note queued by an older version, without a client id; shown, but nothing can refer to it until it's sent.
    public struct NewNote: Hashable, Identifiable, Sendable {
        public let id: UUID
        public let title: String
    }

    /// A note queued with a client-made id: it can be opened, edited, moved and given children before it's sent.
    public struct Created: Hashable, Sendable {
        public let id: String
        public let parentId: String?
        /// For the second half of a split: the note it follows, whose parent it shares.
        public let follows: String?
        public let title: String
        public let body: String
        public let queuedAt: Date
    }

    private enum Placement: Hashable, Sendable {
        case create(String, parent: String?, before: String?)
        case move(String, parent: String?, before: String?)
        case remove(String, into: String?)
        case after(String, anchor: String)
    }

    private struct Check: Hashable, Sendable {
        let id: String
        let checked: Bool
    }

    public private(set) var titles: [String: String] = [:]
    public private(set) var bodies: [String: String] = [:]
    public private(set) var presentation: [String: ItemPresentation.Patch] = [:]
    public private(set) var created: [String: Created] = [:]
    /// Parent id ("" for the top level) to legacy notes waiting to be created there.
    public private(set) var newNotes: [String: [NewNote]] = [:]
    public private(set) var touched: Set<String> = []
    private var placements: [Placement] = []
    private var checks: [Check] = []

    public init(_ entries: [OutboxEntry] = []) {
        // Entries the server refused won't apply as they are, so they don't show as pending changes.
        let entries = entries.filter { !$0.needsAttention }
        var queuedActions: Set<String> = []
        var cancelled: Set<String> = []
        for entry in entries {
            if let action = entry.endpoint.editorAction {
                queuedActions.insert(action.id)
            } else if let reversal = Self.reversal(entry.endpoint), queuedActions.contains(reversal.id) {
                // An undo queued behind its own action cancels it out; a redo brings it back.
                if reversal.undo { cancelled.insert(reversal.id) } else { cancelled.remove(reversal.id) }
            }
        }
        let decoder = JSONCoding.makeDecoder()
        for entry in entries {
            let endpoint = entry.endpoint
            if let action = endpoint.editorAction {
                guard !cancelled.contains(action.id) else { continue }
                for command in action.commands { apply(command, at: entry.createdAt) }
                continue
            }
            let parts = endpoint.path.split(separator: "/").map { $0.removingPercentEncoding ?? String($0) }
            let body = endpoint.body ?? Data()
            switch (endpoint.method, parts.first, parts.count, parts.last) {
            case ("PATCH", "items", 2, _):
                guard let update = try? decoder.decode(ItemUpdate.self, from: body) else { continue }
                apply(.update(id: parts[1], title: update.title, body: update.body), at: entry.createdAt)
            case ("POST", "items", 3, "check"):
                guard let value = try? decoder.decode(CheckValue.self, from: body) else { continue }
                apply(.check(id: parts[1], checked: value.checked), at: entry.createdAt)
            case ("PATCH", "items", 3, "presentation"):
                guard let patch = try? decoder.decode(ItemPresentation.Patch.self, from: body) else { continue }
                apply(.presentation(id: parts[1], patch: patch), at: entry.createdAt)
            case ("POST", "tasks", 3, "complete"):
                apply(.check(id: parts[1], checked: true), at: entry.createdAt)
            case ("POST", "items", 3, "archive"):
                placements.append(.remove(parts[1], into: nil))
                touched.insert(parts[1])
            case ("PUT", "outline", 3, "parent"):
                guard let move = try? decoder.decode(MoveBody.self, from: body) else { continue }
                apply(.move(id: parts[1], parentId: move.parentId, beforeId: move.beforeId), at: entry.createdAt)
            case ("POST", "outline", 1, _):
                guard let note = try? decoder.decode(OutlineNoteRequest.self, from: body) else { continue }
                if note.id != nil {
                    apply(.create(id: note.id, parentId: note.parentId, title: note.title, body: note.body), at: entry.createdAt)
                } else {
                    newNotes[note.parentId ?? "", default: []].append(NewNote(id: entry.id, title: note.title ?? note.body ?? entry.title))
                }
            default:
                if parts.first == "items", parts.count >= 2 { touched.insert(parts[1]) }
            }
        }
    }

    private mutating func apply(_ command: EditorCommand, at date: Date) {
        switch command {
        case .create(let id, let parentId, let beforeId, let title, let body):
            guard let id else { return }
            created[id] = Created(id: id, parentId: parentId, follows: nil, title: title ?? "", body: body ?? "", queuedAt: date)
            placements.append(.create(id, parent: parentId, before: beforeId))
            touched.insert(id)
        case .update(let id, let title, let body, _, _):
            if let title { titles[id] = title }
            if let body { bodies[id] = body }
            touched.insert(id)
        case .move(let id, let parentId, let beforeId):
            placements.append(.move(id, parent: parentId, before: beforeId))
            touched.insert(id)
        case .presentation(let id, let patch):
            presentation[id] = (presentation[id] ?? ItemPresentation.Patch()).applying(patch)
            touched.insert(id)
        case .check(let id, let checked):
            checks.append(Check(id: id, checked: checked))
            touched.insert(id)
        case .split(let id, let field, let offset, let baseText, let newId):
            // The server trims both halves, as it does any saved title or text.
            let cut = String.Index(utf16Offset: min(max(offset, 0), baseText.utf16.count), in: baseText)
            let head = baseText[..<cut].trimmingCharacters(in: .whitespacesAndNewlines)
            let tail = baseText[cut...].trimmingCharacters(in: .whitespacesAndNewlines)
            if field == .title { titles[id] = head } else { bodies[id] = head }
            touched.insert(id)
            guard let newId else { return }
            created[newId] = Created(id: newId, parentId: nil, follows: id, title: field == .title ? tail : "",
                                     body: field == .body ? tail : "", queuedAt: date)
            placements.append(.after(newId, anchor: id))
            touched.insert(newId)
        case .merge(let id, let previousId):
            placements.append(.remove(id, into: previousId))
            touched.formUnion([id, previousId])
        }
    }

    private static func reversal(_ endpoint: Endpoint) -> (id: String, undo: Bool)? {
        let parts = endpoint.path.split(separator: "/").map { $0.removingPercentEncoding ?? String($0) }
        guard endpoint.method == "POST", parts.count == 4, parts[0] == "editor", parts[1] == "actions",
              parts[3] == "undo" || parts[3] == "redo" else { return nil }
        return (parts[2], parts[3] == "undo")
    }

    public func isPending(_ id: String) -> Bool { touched.contains(id) }

    public func notes(under parentID: String?) -> [NewNote] { newNotes[parentID ?? ""] ?? [] }

    /// The item's presentation with any queued change on top.
    public func presentation(of item: Item) -> ItemPresentation {
        ItemPresentation((item.metadata.presentation ?? ItemPresentation.Patch()).applying(presentation[item.id]))
    }

    /// The last queued check of the item or of anything above it (`path`, in any order), since a check applies to everything below.
    public func checked(_ id: String, path: [String] = []) -> Bool? {
        checks.last { $0.id == id || path.contains($0.id) }?.checked
    }

    /// A queued note as an outline row, so it can be shown and opened before it's sent. `arrange` counts what's queued inside it.
    /// The second half of a split shares its original's parent, which `parent` supplies when the queue doesn't say.
    public func createdEntry(_ id: String, parent: (String) -> String?? = { _ in nil }) -> OutlineEntry? {
        guard let note = created[id] else { return nil }
        let item = Item(id: note.id, type: .note, title: note.title, body: note.body, source: "app", metadata: ItemMetadata(),
                        createdAt: note.queuedAt, updatedAtStamp: JSONCoding.formatTimestamp(note.queuedAt))
        let parentId = note.follows.map { original in queuedParent(of: original) ?? parent(original) ?? nil } ?? note.parentId
        return OutlineEntry(item: item, parentId: parentId, position: 0, childCount: 0)
    }

    /// Where queued placements leave `id`: `.some(parent)` once one has moved or created it, nil when none has.
    public func queuedParent(of id: String) -> String?? {
        for placement in placements.reversed() {
            switch placement {
            case .create(let moved, let parent, _), .move(let moved, let parent, _):
                if moved == id { return .some(parent) }
            default:
                continue
            }
        }
        return nil
    }

    /// Every item a queued placement refers to, for looking up rows a branch doesn't hold yet.
    public var placedIDs: Set<String> {
        Set(placements.flatMap { placement -> [String] in
            switch placement {
            case .create(let id, _, let before), .move(let id, _, let before): [id] + (before.map { [$0] } ?? [])
            case .remove(let id, _): [id]
            case .after(let id, let anchor): [id, anchor]
            }
        })
    }

    /// One branch's loaded page with every queued placement replayed in order. Rows queued past the end of a partly
    /// loaded branch are counted in `total` but held back until the rows before them are loaded.
    /// `known` supplies rows that queued moves bring in from other branches.
    public func arrange(_ entries: [OutlineEntry], total: Int, under parent: String?, known: [String: OutlineEntry] = [:]) -> OutlinePage {
        guard !placements.isEmpty else { return OutlinePage(items: entries, total: total) }
        var list = entries
        var total = total
        let complete = entries.count >= total
        var location: [String: String?] = [:]
        var hidden: Set<String> = []
        var childDelta: [String: Int] = [:]

        func lookup(_ id: String) -> OutlineEntry? {
            list.first { $0.id == id } ?? known[id] ?? createdEntry(id)
        }
        func source(_ id: String) -> String?? {
            if let moved = location[id] { return .some(moved) }
            if list.contains(where: { $0.id == id }) { return .some(parent) }
            if let entry = known[id] { return .some(entry.parentId) }
            if let note = created[id], note.follows == nil { return .some(note.parentId) }
            return nil
        }
        func leave(_ id: String) {
            let from = source(id)
            if let index = list.firstIndex(where: { $0.id == id }) {
                list.remove(at: index)
                total -= 1
            } else if hidden.remove(id) != nil || (!complete && location[id] == nil && from == .some(parent)) {
                total -= 1
            }
            if case .some(let from?) = from { childDelta[from, default: 0] -= 1 }
            location[id] = .some(nil)
        }
        func enter(_ id: String, _ entry: OutlineEntry?, into destination: String?, before: String?) {
            location[id] = .some(destination)
            if let destination { childDelta[destination, default: 0] += 1 }
            guard destination == parent else { return }
            guard let entry else {
                if !complete {
                    total += 1
                    hidden.insert(id)
                }
                return
            }
            total += 1
            let placed = entry.with(parentId: destination, childCount: entry.childCount)
            if let before, let index = list.firstIndex(where: { $0.id == before }) {
                list.insert(placed, at: index)
            } else if complete {
                list.append(placed)
            } else {
                hidden.insert(id)
            }
        }

        for placement in placements {
            switch placement {
            case .create(let id, let destination, let before):
                enter(id, createdEntry(id), into: destination, before: before)
            case .move(let id, let destination, let before):
                let entry = lookup(id)
                leave(id)
                enter(id, entry, into: destination, before: before)
            case .remove(let id, let target):
                let children = lookup(id)?.childCount ?? 0
                leave(id)
                if let target { childDelta[target, default: 0] += children }
            case .after(let id, let anchor):
                guard let index = list.firstIndex(where: { $0.id == anchor }), let entry = createdEntry(id) else { continue }
                location[id] = .some(list[index].parentId)
                list.insert(entry.with(parentId: list[index].parentId, childCount: 0), at: index + 1)
                total += 1
            }
        }
        return OutlinePage(items: list.map { entry in
            guard let delta = childDelta[entry.id], delta != 0 else { return entry }
            return entry.with(parentId: entry.parentId, childCount: max(0, entry.childCount + delta))
        }, total: max(total, list.count))
    }

    private struct CheckValue: Decodable { let checked: Bool }
}
