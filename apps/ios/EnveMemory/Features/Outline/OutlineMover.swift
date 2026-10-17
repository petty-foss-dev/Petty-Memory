import EnveMemoryKit
import Foundation

/// Plans outline moves against a branch as it's shown, queued placements included, so a run of offline moves composes.
/// Places only with `beforeId`; positions are opaque. The server validates every placement when the action arrives.
enum OutlineMover {
    enum Direction { case up, down }

    static func shift(_ entry: OutlineEntry, among siblings: [OutlineEntry], in parentID: String?, _ direction: Direction) -> EditorCommand? {
        let anchors = siblings.filter { canAnchor($0, in: parentID) || $0.id == entry.id }
        guard let index = anchors.firstIndex(where: { $0.id == entry.id }) else { return nil }
        switch direction {
        case .up:
            guard index > 0 else { return nil }
            return .move(id: entry.id, parentId: parentID, beforeId: anchors[index - 1].id)
        case .down:
            guard index + 1 < anchors.count else { return nil }
            return .move(id: entry.id, parentId: parentID, beforeId: index + 2 < anchors.count ? anchors[index + 2].id : nil)
        }
    }

    /// Makes the item the last child of the sibling above it.
    static func indent(_ entry: OutlineEntry, among siblings: [OutlineEntry]) -> EditorCommand? {
        guard let index = siblings.firstIndex(where: { $0.id == entry.id }), index > 0 else { return nil }
        let target = siblings[index - 1]
        guard canHold(target, child: entry.item) else { return nil }
        return .move(id: entry.id, parentId: target.id, beforeId: nil)
    }

    /// Lifts the item out of `parent`, to just after it among `parent`'s own siblings.
    static func outdent(_ entry: OutlineEntry, from parent: OutlineEntry, among parentSiblings: [OutlineEntry]) -> EditorCommand {
        let grandparent = parent.parentId
        let anchors = parentSiblings.filter { canAnchor($0, in: grandparent) || $0.id == parent.id }
        let next = anchors.firstIndex(where: { $0.id == parent.id }).flatMap { anchors.indices.contains($0 + 1) ? anchors[$0 + 1].id : nil }
        return .move(id: entry.id, parentId: grandparent, beforeId: next)
    }

    /// The note directly above, when both are ordinary active notes that can be merged.
    static func mergeTarget(for entry: OutlineEntry, among siblings: [OutlineEntry], in parentID: String?) -> OutlineEntry? {
        guard isMergeable(entry, in: parentID), let index = siblings.firstIndex(where: { $0.id == entry.id }), index > 0 else { return nil }
        let previous = siblings[index - 1]
        return isMergeable(previous, in: parentID) ? previous : nil
    }

    /// Only a child whose stored parent is this branch can anchor a placement in it; an archived parent's children show at
    /// the top level but can't.
    static func canAnchor(_ entry: OutlineEntry, in parentID: String?) -> Bool {
        entry.parentId == parentID
    }

    /// Decisions and archived items hold nothing; a secret note holds only other secret notes.
    static func canHold(_ entry: OutlineEntry, child: Item? = nil) -> Bool {
        guard entry.item.type != .decision, entry.item.archivedAt == nil else { return false }
        return !entry.item.isSecret || child?.isSecret == true
    }

    private static func isMergeable(_ entry: OutlineEntry, in parentID: String?) -> Bool {
        entry.item.type == .note && canHold(entry) && canAnchor(entry, in: parentID)
    }
}
