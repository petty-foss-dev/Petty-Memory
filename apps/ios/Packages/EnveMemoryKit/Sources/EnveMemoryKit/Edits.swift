import Foundation

/// Arbitrary JSON, kept verbatim so a proposal goes back to the server exactly as it came.
public enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let value = try? c.decode(Bool.self) { self = .bool(value) }
        else if let value = try? c.decode(Double.self) { self = .number(value) }
        else if let value = try? c.decode(String.self) { self = .string(value) }
        else if let value = try? c.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let value): try c.encode(value)
        case .number(let value): try c.encode(value)
        case .string(let value): try c.encode(value)
        case .array(let value): try c.encode(value)
        case .object(let value): try c.encode(value)
        }
    }
}

/// An item's state before an operation, read from the library rather than the model.
public struct EditPreview: Decodable, Hashable, Sendable {
    public let title: String
    public let body: String
    public let parentId: String?
}

/// One proposed change. The typed fields are for review; `raw` is what goes back to `/ai/apply`.
public struct EditOperation: Codable, Hashable, Sendable {
    public enum Kind: String, Sendable { case update, create, move, presentation, unknown }

    public let kind: Kind
    public let id: String?
    public let parentId: String?
    public let beforeId: String?
    public let title: String?
    public let body: String?
    public let before: EditPreview?
    public let patch: ItemPresentation.Patch?
    public let presentationBefore: ItemPresentation?
    public let raw: JSONValue

    private enum CodingKeys: String, CodingKey { case op, id, parentId, beforeId, title, body, before, patch }

    public init(from decoder: Decoder) throws {
        raw = try JSONValue(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = Kind(rawValue: try c.decode(String.self, forKey: .op)) ?? .unknown
        id = try c.decodeIfPresent(String.self, forKey: .id)
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        beforeId = try c.decodeIfPresent(String.self, forKey: .beforeId)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        body = try c.decodeIfPresent(String.self, forKey: .body)
        patch = try c.decodeIfPresent(ItemPresentation.Patch.self, forKey: .patch)
        if kind == .presentation {
            before = nil
            presentationBefore = try c.decodeIfPresent(ItemPresentation.Patch.self, forKey: .before).map(ItemPresentation.init)
        } else {
            before = try c.decodeIfPresent(EditPreview.self, forKey: .before)
            presentationBefore = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        try raw.encode(to: encoder)
    }
}

/// A reviewed change set for one subtree, tied to the exact state (`baseHash`) it was made from.
public struct EditProposal: Codable, Hashable, Sendable {
    public let rootId: String
    public let baseHash: String
    public let summary: String
    /// Kept as sent; the proposal is returned unchanged apart from the operations the user left out.
    public let createdAt: String
    public let operations: [EditOperation]
    /// Titles of notes the proposal creates, by their temporary `new:<n>` ids, which later operations may refer to.
    public let titles: [String: String]?

    public func keeping(_ indices: Set<Int>) -> EditProposal {
        EditProposal(rootId: rootId, baseHash: baseHash, summary: summary, createdAt: createdAt,
                     operations: operations.enumerated().filter { indices.contains($0.offset) }.map(\.element), titles: titles)
    }
}

public struct ApplyResult: Decodable, Hashable, Sendable {
    public let applied: Int
    /// Opaque receipt for `/ai/undo`, which restores the prior state and archives what the AI created.
    public let undo: JSONValue?
}

private struct EditRequest: Encodable { let rootId: String; let instruction: String }
private struct ApplyRequest: Encodable { let proposal: EditProposal }
private struct UndoRequest: Encodable { let receipt: JSONValue }

extension Endpoint {
    public static func proposeEdit(rootId: String, instruction: String) throws -> Endpoint {
        try json("POST", "/ai/edit", EditRequest(rootId: rootId, instruction: instruction))
    }
    public static func applyEdit(_ proposal: EditProposal) throws -> Endpoint { try json("POST", "/ai/apply", ApplyRequest(proposal: proposal)) }
    public static func undoEdit(_ receipt: JSONValue) throws -> Endpoint { try json("POST", "/ai/undo", UndoRequest(receipt: receipt)) }
}
