import Foundation

/// One proposed task, tag set, reminder or brief. Typed fields are for review; `raw` goes back to apply.
public struct ActionOperation: Codable, Hashable, Identifiable, Sendable {
    public enum Kind: Hashable, Sendable {
        case task(title: String, body: String, sourceId: String?, dueAt: String?)
        case tag(itemId: String, tags: [String])
        case reminder(itemId: String, remindAt: String?)
        case note(title: String, body: String, sourceIds: [String])
        case unknown(String)
    }

    public let id: String
    public let kind: Kind
    public let raw: JSONValue

    private enum CodingKeys: String, CodingKey { case id, kind, title, body, sourceId, dueAt, itemId, tags, remindAt, sourceIds }

    public init(from decoder: Decoder) throws {
        raw = try JSONValue(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        switch try c.decode(String.self, forKey: .kind) {
        case "task":
            kind = .task(title: try c.decode(String.self, forKey: .title), body: try c.decodeIfPresent(String.self, forKey: .body) ?? "",
                         sourceId: try c.decodeIfPresent(String.self, forKey: .sourceId), dueAt: try c.decodeIfPresent(String.self, forKey: .dueAt))
        case "tag":
            kind = .tag(itemId: try c.decode(String.self, forKey: .itemId), tags: try c.decode([String].self, forKey: .tags))
        case "reminder":
            kind = .reminder(itemId: try c.decode(String.self, forKey: .itemId), remindAt: try c.decodeIfPresent(String.self, forKey: .remindAt))
        case "note":
            kind = .note(title: try c.decode(String.self, forKey: .title), body: try c.decodeIfPresent(String.self, forKey: .body) ?? "",
                         sourceIds: try c.decodeIfPresent([String].self, forKey: .sourceIds) ?? [])
        case let other:
            kind = .unknown(other)
        }
    }

    public func encode(to encoder: Encoder) throws {
        try raw.encode(to: encoder)
    }

    /// Existing items the operation names, for loading their titles.
    public var referencedIDs: [String] {
        switch kind {
        case .task(_, _, let sourceId, _): sourceId.map { [$0] } ?? []
        case .tag(let itemId, _), .reminder(let itemId, _): [itemId]
        case .note(_, _, let sourceIds): sourceIds
        case .unknown: []
        }
    }
}

/// Tasks, tags, reminders and a brief proposed from one branch or keyword topic, tied to the state (`baseHash`) it read.
public struct ActionProposal: Codable, Hashable, Sendable {
    public let id: String
    public let rootId: String?
    public let query: String?
    public let project: String?
    public let baseHash: String
    public let summary: String
    public let operations: [ActionOperation]
    public let createdAt: String
    public let titles: [String: String]
    public let raw: JSONValue

    private enum CodingKeys: String, CodingKey { case id, rootId, query, project, baseHash, summary, operations, createdAt, titles }

    public init(from decoder: Decoder) throws {
        raw = try JSONValue(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        rootId = try c.decodeIfPresent(String.self, forKey: .rootId)
        query = try c.decodeIfPresent(String.self, forKey: .query)
        project = try c.decodeIfPresent(String.self, forKey: .project)
        baseHash = try c.decode(String.self, forKey: .baseHash)
        summary = try c.decode(String.self, forKey: .summary)
        operations = try c.decode([ActionOperation].self, forKey: .operations)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        titles = try c.decodeIfPresent([String: String].self, forKey: .titles) ?? [:]
    }

    public func encode(to encoder: Encoder) throws {
        try raw.encode(to: encoder)
    }

    /// Operations this app can show; anything it doesn't understand is never applied from here.
    public var reviewableIDs: [String] {
        operations.filter { if case .unknown = $0.kind { false } else { true } }.map(\.id)
    }
}

/// `undo` is the receipt for `/ai/actions/undo`, which refuses once anything it touched changed again.
public struct ActionResult: Decodable, Hashable, Sendable {
    public let actionId: String
    public let createdIds: [String]
    public let updatedIds: [String]
    public let undo: JSONValue
}

public struct ActionUndoResult: Decodable, Hashable, Sendable {
    public let restored: Int
}

private struct ActionApplyBody: Encodable {
    let proposal: ActionProposal
    let includeIds: [String]
}

private struct ActionUndoBody: Encodable { let receipt: JSONValue }

extension Endpoint {
    /// The proposal goes back verbatim with the chosen operations, in proposal order.
    public static func applyActions(_ proposal: ActionProposal, including ids: Set<String>) throws -> Endpoint {
        try json("POST", "/ai/actions/apply", ActionApplyBody(proposal: proposal, includeIds: proposal.operations.map(\.id).filter(ids.contains)))
    }

    public static func undoActions(_ receipt: JSONValue) throws -> Endpoint {
        try json("POST", "/ai/actions/undo", ActionUndoBody(receipt: receipt))
    }
}
