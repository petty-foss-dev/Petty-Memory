import Foundation

/// One step of a journalled structural edit (`POST /editor/actions`). The server validates and records the whole batch,
/// so it can be undone and redone as one action.
public enum EditorCommand: Codable, Hashable, Sendable {
    public enum Field: String, Codable, Hashable, Sendable { case title, body }

    case create(id: String?, parentId: String?, beforeId: String? = nil, title: String? = nil, body: String? = nil)
    /// The bases are what the edit started from; the server refuses the action if that field changed since.
    case update(id: String, title: String? = nil, body: String? = nil, baseTitle: String? = nil, baseBody: String? = nil)
    case move(id: String, parentId: String?, beforeId: String?)
    case presentation(id: String, patch: ItemPresentation.Patch)
    case check(id: String, checked: Bool)
    /// `offset` counts UTF-16 code units into `baseText`, the field's current text, matching DOM selections.
    /// `newId` is the client-made id of the note that receives the rest, so it can be used before the split is sent.
    case split(id: String, field: Field, offset: Int, baseText: String, newId: String?)
    case merge(id: String, previousId: String)

    /// A split at `index`, with the offset in the UTF-16 units the server expects and a new id for the following note.
    public static func split(_ id: String, field: Field, text: String, at index: String.Index, newId: String = UUIDv7.make()) -> EditorCommand {
        .split(id: id, field: field, offset: text.utf16.distance(from: text.startIndex, to: index), baseText: text, newId: newId)
    }

    /// An update carrying only the fields that changed, each with the text it started from.
    public static func update(_ id: String, title: String, body: String, baseTitle: String, baseBody: String) -> EditorCommand? {
        guard title != baseTitle || body != baseBody else { return nil }
        return .update(id: id, title: title != baseTitle ? title : nil, body: body != baseBody ? body : nil,
                       baseTitle: title != baseTitle ? baseTitle : nil, baseBody: body != baseBody ? baseBody : nil)
    }

    private enum CodingKeys: String, CodingKey {
        case op, id, parentId, beforeId, title, body, baseTitle, baseBody, patch, checked, field, offset, baseText, newId, previousId
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .create(let id, let parentId, let beforeId, let title, let body):
            try c.encode("create", forKey: .op)
            try c.encodeIfPresent(id, forKey: .id)
            try c.encode(parentId, forKey: .parentId)
            try c.encodeIfPresent(beforeId, forKey: .beforeId)
            try c.encodeIfPresent(title, forKey: .title)
            try c.encodeIfPresent(body, forKey: .body)
        case .update(let id, let title, let body, let baseTitle, let baseBody):
            try c.encode("update", forKey: .op)
            try c.encode(id, forKey: .id)
            try c.encodeIfPresent(title, forKey: .title)
            try c.encodeIfPresent(body, forKey: .body)
            try c.encodeIfPresent(baseTitle, forKey: .baseTitle)
            try c.encodeIfPresent(baseBody, forKey: .baseBody)
        case .move(let id, let parentId, let beforeId):
            try c.encode("move", forKey: .op)
            try c.encode(id, forKey: .id)
            try c.encode(parentId, forKey: .parentId)
            try c.encode(beforeId, forKey: .beforeId)
        case .presentation(let id, let patch):
            try c.encode("presentation", forKey: .op)
            try c.encode(id, forKey: .id)
            try c.encode(patch, forKey: .patch)
        case .check(let id, let checked):
            try c.encode("check", forKey: .op)
            try c.encode(id, forKey: .id)
            try c.encode(checked, forKey: .checked)
        case .split(let id, let field, let offset, let baseText, let newId):
            try c.encode("split", forKey: .op)
            try c.encode(id, forKey: .id)
            try c.encode(field, forKey: .field)
            try c.encode(offset, forKey: .offset)
            try c.encode(baseText, forKey: .baseText)
            try c.encodeIfPresent(newId, forKey: .newId)
        case .merge(let id, let previousId):
            try c.encode("merge", forKey: .op)
            try c.encode(id, forKey: .id)
            try c.encode(previousId, forKey: .previousId)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let op = try c.decode(String.self, forKey: .op)
        switch op {
        case "create":
            self = .create(id: try c.decodeIfPresent(String.self, forKey: .id), parentId: try c.decodeIfPresent(String.self, forKey: .parentId),
                           beforeId: try c.decodeIfPresent(String.self, forKey: .beforeId), title: try c.decodeIfPresent(String.self, forKey: .title),
                           body: try c.decodeIfPresent(String.self, forKey: .body))
        case "update":
            self = .update(id: try c.decode(String.self, forKey: .id), title: try c.decodeIfPresent(String.self, forKey: .title),
                           body: try c.decodeIfPresent(String.self, forKey: .body), baseTitle: try c.decodeIfPresent(String.self, forKey: .baseTitle),
                           baseBody: try c.decodeIfPresent(String.self, forKey: .baseBody))
        case "move":
            self = .move(id: try c.decode(String.self, forKey: .id), parentId: try c.decodeIfPresent(String.self, forKey: .parentId),
                         beforeId: try c.decodeIfPresent(String.self, forKey: .beforeId))
        case "presentation":
            self = .presentation(id: try c.decode(String.self, forKey: .id), patch: try c.decode(ItemPresentation.Patch.self, forKey: .patch))
        case "check":
            self = .check(id: try c.decode(String.self, forKey: .id), checked: try c.decode(Bool.self, forKey: .checked))
        case "split":
            self = .split(id: try c.decode(String.self, forKey: .id), field: try c.decode(Field.self, forKey: .field),
                          offset: try c.decode(Int.self, forKey: .offset), baseText: try c.decode(String.self, forKey: .baseText),
                          newId: try c.decodeIfPresent(String.self, forKey: .newId))
        case "merge":
            self = .merge(id: try c.decode(String.self, forKey: .id), previousId: try c.decode(String.self, forKey: .previousId))
        default:
            throw DecodingError.dataCorruptedError(forKey: .op, in: c, debugDescription: "Unknown editor command \(op)")
        }
    }
}

public struct EditorActionRequest: Codable, Hashable, Sendable {
    public let commands: [EditorCommand]
    /// A client-made UUIDv7: the action can be queued, undone and redone before the server has answered.
    public let id: String
}

public struct EditorActionResult: Decodable, Hashable, Sendable {
    public let actionId: String
    public let focusId: String?
    public let createdIds: [String]
    public let label: String
}

extension Endpoint {
    public static func editorAction(_ commands: [EditorCommand], id: String = UUIDv7.make()) throws -> Endpoint {
        try json("POST", "/editor/actions", EditorActionRequest(commands: commands, id: id))
    }
    public static func undoEditorAction(_ id: String) -> Endpoint { post("/editor/actions/\(segment(id))/undo") }
    public static func redoEditorAction(_ id: String) -> Endpoint { post("/editor/actions/\(segment(id))/redo") }

    /// The batch inside a queued `POST /editor/actions`.
    public var editorAction: EditorActionRequest? {
        guard method == "POST", path == "/editor/actions", let body else { return nil }
        return try? JSONCoding.makeDecoder().decode(EditorActionRequest.self, from: body)
    }
}

extension OutboxEntry {
    /// Text from a write the server refused (a stale edit, or a new note whose place is gone), so it can be kept as a new note.
    public var recoverableDraft: ItemUpdate? {
        guard needsAttention, let body = endpoint.body else { return nil }
        let decoder = JSONCoding.makeDecoder()
        let parts = endpoint.path.split(separator: "/")
        switch (endpoint.method, parts.first, parts.count) {
        case ("PATCH", "items", 2):
            return try? decoder.decode(ItemUpdate.self, from: body)
        case ("POST", "outline", 1):
            return (try? decoder.decode(OutlineNoteRequest.self, from: body)).map { ItemUpdate(title: $0.title, body: $0.body) }
        default:
            for command in endpoint.editorAction?.commands ?? [] {
                switch command {
                case .update(_, let title, let body, let baseTitle, let baseBody):
                    return ItemUpdate(title: title, body: body, baseTitle: baseTitle, baseBody: baseBody)
                case .create(_, _, _, let title, let body) where title?.isEmpty == false || body?.isEmpty == false:
                    return ItemUpdate(title: title, body: body)
                default:
                    continue
                }
            }
            return nil
        }
    }
}
