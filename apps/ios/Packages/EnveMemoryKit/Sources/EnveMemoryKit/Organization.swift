import Foundation

/// A proposed reorganization of every note matching a topic. Typed fields are for review; `raw` goes back to apply.
public struct OrganizationProposal: Codable, Hashable, Sendable {
    /// A matching note that would move, with everything nested under it. `body` is a review excerpt.
    public struct Candidate: Codable, Hashable, Sendable {
        public let id: String
        public let title: String
        public let body: String
        public let parentId: String?
        public let descendantCount: Int
    }

    public struct Destination: Codable, Hashable, Sendable {
        public let id: String
        public let title: String
        public let create: Bool
    }

    public struct Group: Codable, Hashable, Sendable {
        public let id: String
        public let title: String
        public let parentId: String
    }

    public struct Assignment: Codable, Hashable, Sendable {
        public let itemId: String
        public let parentId: String
    }

    public enum Entry: Hashable, Sendable {
        case group(Group)
        case candidate(Candidate)
    }

    public let id: String
    public let query: String
    public let summary: String
    public let matchedCount: Int
    public let affectedCount: Int
    public let destination: Destination
    public let items: [Candidate]
    public let groups: [Group]
    public let assignments: [Assignment]
    public let raw: JSONValue

    private enum CodingKeys: String, CodingKey { case id, query, summary, matchedCount, affectedCount, destination, items, groups, assignments }

    public init(from decoder: Decoder) throws {
        raw = try JSONValue(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        query = try c.decode(String.self, forKey: .query)
        summary = try c.decode(String.self, forKey: .summary)
        matchedCount = try c.decode(Int.self, forKey: .matchedCount)
        affectedCount = try c.decode(Int.self, forKey: .affectedCount)
        destination = try c.decode(Destination.self, forKey: .destination)
        items = try c.decode([Candidate].self, forKey: .items)
        groups = try c.decode([Group].self, forKey: .groups)
        assignments = try c.decode([Assignment].self, forKey: .assignments)
    }

    public func encode(to encoder: Encoder) throws {
        try raw.encode(to: encoder)
    }

    /// Candidates in the order they're placed; the default selection.
    public var candidateIDs: [String] { assignments.map(\.itemId) }

    public func candidate(_ id: String) -> Candidate? { items.first { $0.id == id } }

    /// Groups first in plan order, then the notes placed there, as apply creates them.
    public func entries(in parentID: String) -> [Entry] {
        groups.filter { $0.parentId == parentID }.map(Entry.group)
            + assignments.filter { $0.parentId == parentID }.compactMap { candidate($0.itemId).map(Entry.candidate) }
    }

    /// A group meant to hold notes is created only while one of its selected notes sits somewhere inside it.
    public func createdGroups(selecting selected: Set<String>) -> Set<String> {
        let parentOf = Dictionary(uniqueKeysWithValues: groups.map { ($0.id, $0.parentId) })
        var planned = Set<String>(), chosen = Set<String>()
        for assignment in assignments {
            var current: String? = assignment.parentId
            while let id = current, id != destination.id {
                planned.insert(id)
                if selected.contains(assignment.itemId) { chosen.insert(id) }
                current = parentOf[id]
            }
        }
        for group in groups where !planned.contains(group.id) {
            var current: String? = group.id
            while let id = current, id != destination.id {
                chosen.insert(id)
                current = parentOf[id]
            }
        }
        return Set(groups.map(\.id).filter { !planned.contains($0) || chosen.contains($0) })
    }

    /// Selected notes plus everything nested under them.
    public func movedCount(selecting selected: Set<String>) -> Int {
        items.filter { selected.contains($0.id) }.reduce(0) { $0 + 1 + $1.descendantCount }
    }
}

/// Undo is refused once anything in the organized tree changed after `afterHash`.
public struct OrganizationReceipt: Codable, Hashable, Sendable {
    public let actionId: String
    public let rootId: String
    public let afterHash: String
}

public struct OrganizationResult: Decodable, Hashable, Sendable {
    public let rootId: String
    public let moved: Int
    public let actionId: String
    public let undo: OrganizationReceipt
}

private struct OrganizeApplyBody: Encodable {
    let proposal: OrganizationProposal
    let includeIds: [String]
}

private struct OrganizeUndoBody: Encodable { let receipt: OrganizationReceipt }

extension Endpoint {
    /// Retrying the same proposal and selection returns the first result rather than moving anything twice.
    public static func applyOrganization(_ proposal: OrganizationProposal, including ids: [String]) throws -> Endpoint {
        try json("POST", "/ai/organize/apply", OrganizeApplyBody(proposal: proposal, includeIds: ids))
    }

    public static func undoOrganization(_ receipt: OrganizationReceipt) throws -> Endpoint {
        try json("POST", "/ai/organize/undo", OrganizeUndoBody(receipt: receipt))
    }
}
