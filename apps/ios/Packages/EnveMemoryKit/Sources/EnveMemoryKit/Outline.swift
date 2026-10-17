import Foundation

/// How an item shows and whether it's checked off. Stored sparsely on the server; `init(_:)` fills in the defaults.
public struct ItemPresentation: Hashable, Sendable {
    public enum Kind: String, Codable, Sendable, CaseIterable { case text, heading, section }
    public enum Attention: String, Codable, Sendable, CaseIterable { case low, normal, high }

    public var kind: Kind
    public var attention: Attention
    public var review: Bool
    public var checklist: Bool
    public var hideCompleted: Bool
    public var checked: Bool
    public var autoOrganize: Bool

    public init(_ patch: Patch? = nil) {
        kind = patch?.kind ?? .text
        attention = patch?.attention ?? .normal
        review = patch?.review ?? false
        checklist = patch?.checklist ?? false
        hideCompleted = patch?.hideCompleted ?? false
        checked = patch?.checked ?? false
        autoOrganize = patch?.autoOrganize ?? false
    }

    /// The wire shape for reads (sparse metadata) and `PATCH /items/:id/presentation` (only set fields are sent).
    public struct Patch: Codable, Hashable, Sendable {
        public var kind: Kind?
        public var attention: Attention?
        public var review: Bool?
        public var checklist: Bool?
        public var hideCompleted: Bool?
        public var checked: Bool?
        public var autoOrganize: Bool?

        public init(kind: Kind? = nil, attention: Attention? = nil, review: Bool? = nil, checklist: Bool? = nil,
                    hideCompleted: Bool? = nil, checked: Bool? = nil, autoOrganize: Bool? = nil) {
            self.kind = kind
            self.attention = attention
            self.review = review
            self.checklist = checklist
            self.hideCompleted = hideCompleted
            self.checked = checked
            self.autoOrganize = autoOrganize
        }

        private enum CodingKeys: String, CodingKey {
            case kind, attention, review, checklist, hideCompleted, checked, autoOrganize
        }

        /// Unknown kinds or levels from a newer server read as the default instead of failing the whole item.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = (try? c.decodeIfPresent(String.self, forKey: .kind)).flatMap { $0.flatMap(Kind.init(rawValue:)) }
            attention = (try? c.decodeIfPresent(String.self, forKey: .attention)).flatMap { $0.flatMap(Attention.init(rawValue:)) }
            review = try? c.decodeIfPresent(Bool.self, forKey: .review)
            checklist = try? c.decodeIfPresent(Bool.self, forKey: .checklist)
            hideCompleted = try? c.decodeIfPresent(Bool.self, forKey: .hideCompleted)
            checked = try? c.decodeIfPresent(Bool.self, forKey: .checked)
            autoOrganize = try? c.decodeIfPresent(Bool.self, forKey: .autoOrganize)
        }

        public var isEmpty: Bool { self == Patch() }

        /// This patch with `other`'s set fields on top.
        public func applying(_ other: Patch?) -> Patch {
            guard let other else { return self }
            return Patch(kind: other.kind ?? kind, attention: other.attention ?? attention, review: other.review ?? review,
                         checklist: other.checklist ?? checklist, hideCompleted: other.hideCompleted ?? hideCompleted,
                         checked: other.checked ?? checked, autoOrganize: other.autoOrganize ?? autoOrganize)
        }
    }
}

extension ItemMetadata {
    public var resolvedPresentation: ItemPresentation { ItemPresentation(presentation) }
}

extension Item {
    public var presentation: ItemPresentation { metadata.resolvedPresentation }
    /// A vault note: its ordinary fields hold only a generic label.
    public var isSecret: Bool { metadata.secret == true }

    /// Tasks are completed by status; other ordinary items by their presentation's checkmark.
    public var isChecked: Bool {
        if let task { return task.status == .done }
        return presentation.checked
    }
}

/// An item's place in the outline. `position` is an opaque sort key: never compute with it, place with `beforeId`.
public struct OutlineEntry: Codable, Hashable, Identifiable, Sendable {
    public let item: Item
    /// The stored parent, kept even while an archived parent makes the item show at the top level.
    public let parentId: String?
    public let position: Double
    public let childCount: Int

    public var id: String { item.id }

    init(item: Item, parentId: String?, position: Double, childCount: Int) {
        self.item = item
        self.parentId = parentId
        self.position = position
        self.childCount = childCount
    }

    private enum CodingKeys: String, CodingKey { case item, parentId, position, childCount }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(item, forKey: .item)
        if let parentId { try c.encode(parentId, forKey: .parentId) } else { try c.encodeNil(forKey: .parentId) }
        try c.encode(position, forKey: .position)
        try c.encode(childCount, forKey: .childCount)
    }

    func with(parentId: String?, childCount: Int) -> OutlineEntry {
        OutlineEntry(item: item, parentId: parentId, position: position, childCount: childCount)
    }
}

public struct OutlinePage: Codable, Hashable, Sendable {
    public let items: [OutlineEntry]
    public let total: Int
}

public struct ChecklistProgress: Codable, Hashable, Sendable {
    public let done: Int
    public let total: Int
}

public struct ReferenceList: Codable, Hashable, Sendable {
    public let outgoing: [RelatedItem]
    public let incoming: [RelatedItem]
}

/// `[[item:<uuid>]]` or `[[item:<uuid>|label]]`, the stable inline reference format.
public enum InlineReference {
    public struct Match: Hashable, Sendable {
        public let range: Range<String.Index>
        public let id: String
        public let label: String?
    }

    public static func token(id: String, label: String?) -> String {
        let clean = (label ?? "").replacing(/[\]|\n\r]+/, with: " ").trimmingCharacters(in: .whitespaces)
        return clean.isEmpty ? "[[item:\(id)]]" : "[[item:\(id)|\(clean)]]"
    }

    public static func matches(in text: String) -> [Match] {
        let pattern = /\[\[item:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\|([^\]\n]*))?\]\]/
        return text.matches(of: pattern).map { match in
            Match(range: match.range, id: String(match.output.1), label: match.output.2.map(String.init))
        }
    }
}

public struct OutlineNoteRequest: Codable, Hashable, Sendable {
    /// A client-made UUIDv7, so a queued note can be opened, edited and given children before the server has it.
    /// Absent in entries queued by older versions.
    public var id: String?
    public var parentId: String?
    public var title: String?
    public var body: String?

    public init(id: String? = UUIDv7.make(), parentId: String?, title: String? = nil, body: String? = nil) {
        self.id = id
        self.parentId = parentId
        self.title = title
        self.body = body
    }

    private enum CodingKeys: String, CodingKey { case id, parentId, title, body }

    /// A top-level note sends `"parentId": null` explicitly.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(id, forKey: .id)
        if let parentId { try c.encode(parentId, forKey: .parentId) } else { try c.encodeNil(forKey: .parentId) }
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(body, forKey: .body)
    }
}

/// The server requires `parentId` to be present: an id, or null for the top level.
struct MoveBody: Codable {
    let parentId: String?
    let beforeId: String?

    private enum CodingKeys: String, CodingKey { case parentId, beforeId }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let parentId { try c.encode(parentId, forKey: .parentId) } else { try c.encodeNil(forKey: .parentId) }
        if let beforeId { try c.encode(beforeId, forKey: .beforeId) } else { try c.encodeNil(forKey: .beforeId) }
    }
}

/// The bases are what the edit started from; the server refuses (409) if another device changed that field since,
/// so a queued offline edit can't silently overwrite newer text.
public struct ItemUpdate: Codable, Hashable, Sendable {
    public var title: String?
    public var body: String?
    public var baseTitle: String?
    public var baseBody: String?

    public init(title: String? = nil, body: String? = nil, baseTitle: String? = nil, baseBody: String? = nil) {
        self.title = title
        self.body = body
        self.baseTitle = title == nil ? nil : baseTitle
        self.baseBody = body == nil ? nil : baseBody
    }
}


public struct ResetResult: Decodable, Hashable, Sendable { public let updated: Int }

private struct CheckBody: Encodable { let checked: Bool }
private struct ReferenceBody: Encodable { let toId: String; let label: String? }
struct RelationBody: Codable, Hashable { let toId: String; let kind: String }

/// Connection kinds a person can add or remove; `supersedes` belongs to the decision log.
public enum RelationKind {
    public static let editable = ["related_to", "references", "derived_from", "depends_on"]
}

extension Endpoint {
    public static func outline(parent: String?, offset: Int = 0, limit: Int = 50) -> Endpoint {
        get("/outline", [("parent", parent), ("offset", offset > 0 ? String(offset) : nil), ("limit", String(limit))])
    }
    public static func outlineEntry(_ id: String) -> Endpoint { get("/outline/\(segment(id))") }
    public static func ancestors(_ id: String) -> Endpoint { get("/outline/\(segment(id))/ancestors") }
    public static func createOutlineNote(_ request: OutlineNoteRequest) throws -> Endpoint { try json("POST", "/outline", request) }
    public static func moveOutlineItem(_ id: String, parentId: String?, beforeId: String?) throws -> Endpoint {
        try json("PUT", "/outline/\(segment(id))/parent", MoveBody(parentId: parentId, beforeId: beforeId))
    }

    public static func updateItem(_ id: String, _ update: ItemUpdate) throws -> Endpoint { try json("PATCH", "/items/\(segment(id))", update) }

    public static func presentation(_ id: String) -> Endpoint { get("/items/\(segment(id))/presentation") }
    public static func updatePresentation(_ id: String, _ patch: ItemPresentation.Patch) throws -> Endpoint {
        try json("PATCH", "/items/\(segment(id))/presentation", patch)
    }
    public static func check(_ id: String, _ checked: Bool) throws -> Endpoint { try json("POST", "/items/\(segment(id))/check", CheckBody(checked: checked)) }
    public static func resetChecklist(_ id: String) -> Endpoint { post("/items/\(segment(id))/checklist/reset") }
    public static func checklist(_ id: String) -> Endpoint { get("/items/\(segment(id))/checklist") }

    public static func references(_ id: String) -> Endpoint { get("/items/\(segment(id))/references") }
    public static func insertReference(_ id: String, to target: String, label: String?) throws -> Endpoint {
        try json("POST", "/items/\(segment(id))/references", ReferenceBody(toId: target, label: label))
    }
    public static func relate(_ id: String, to target: String, kind: String) throws -> Endpoint {
        try json("POST", "/items/\(segment(id))/relations", RelationBody(toId: target, kind: kind))
    }
    public static func unrelate(_ id: String, from target: String, kind: String) throws -> Endpoint {
        try json("DELETE", "/items/\(segment(id))/relations", RelationBody(toId: target, kind: kind))
    }
}

extension APIClient {
    public func outline(parent: String?, offset: Int = 0, limit: Int = 50) async throws -> OutlinePage {
        try await send(.outline(parent: parent, offset: offset, limit: limit))
    }
    public func outlineEntry(_ id: String) async throws -> OutlineEntry { try await send(.outlineEntry(id)) }
    public func ancestors(_ id: String) async throws -> [Item] { try await send(.ancestors(id)) }
}
