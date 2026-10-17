import Foundation

/// Every condition ANDs together. `project` is the project's id; the server stores it resolved.
public struct SavedViewFilter: Codable, Hashable, Sendable {
    public var project: String?
    public var inbox: Bool?
    public var type: ItemType?
    public var tag: String?
    public var taskStatus: TaskStatus?
    public var pinned: Bool?
    public var intent: Intent?
    public var unopenedDays: Int?
    public var reminders: Bool?
    public var review: Bool?
    public var attention: ItemPresentation.Attention?

    public init(project: String? = nil, inbox: Bool? = nil, type: ItemType? = nil, tag: String? = nil, taskStatus: TaskStatus? = nil,
                pinned: Bool? = nil, intent: Intent? = nil, unopenedDays: Int? = nil, reminders: Bool? = nil, review: Bool? = nil,
                attention: ItemPresentation.Attention? = nil) {
        self.project = project
        self.inbox = inbox
        self.type = type
        self.tag = tag
        self.taskStatus = taskStatus
        self.pinned = pinned
        self.intent = intent
        self.unopenedDays = unopenedDays
        self.reminders = reminders
        self.review = review
        self.attention = attention
    }
}

public struct SavedViewInput: Codable, Hashable, Sendable {
    public static let maxName = 120
    public static let maxQuery = 500

    public var name: String
    public var query: String?
    public var filter: SavedViewFilter?

    public init(name: String, query: String? = nil, filter: SavedViewFilter? = nil) {
        self.name = name
        self.query = query
        self.filter = filter
    }
}

public struct SavedView: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let query: String
    public let filter: SavedViewFilter
    public let createdAt: Date
    public let updatedAt: Date
}

/// One page of a saved view's results; `next` is the `before` cursor of the page after it.
public struct ViewPage: Codable, Hashable, Sendable {
    public let items: [Item]
    public let next: String?
}

/// `date` is the caller's local calendar day, `YYYY-MM-DD`. Omitting `project` puts the copy in the Inbox.
public struct TemplateUseInput: Codable, Hashable, Sendable {
    public var title: String?
    public var project: String?
    public var date: String?

    public init(title: String? = nil, project: String? = nil, date: String? = nil) {
        self.title = title
        self.project = project
        self.date = date
    }
}

/// The definition behind a saved view: an ordinary note titled with the view's name.
public struct SavedViewMetadata: Codable, Hashable, Sendable {
    public let version: Int
    public let query: String
    public let filter: SavedViewFilter
}

/// Shared by a template's root and every note inside it.
public struct TemplateMetadata: Codable, Hashable, Sendable {
    public let version: Int
    public let rootId: String
}

extension Item {
    public var isSavedView: Bool { metadata.savedView?.version == 1 }
    public var isTemplateRoot: Bool { metadata.template?.version == 1 && metadata.template?.rootId == id }
    public var isTemplateMember: Bool { metadata.template?.version == 1 }
}

private struct TemplateCreateBody: Encodable {
    let sourceId: String
    let name: String?
}

extension Endpoint {
    public static let views = get("/views")
    public static func view(_ id: String) -> Endpoint { get("/views/\(segment(id))") }
    public static func viewItems(_ id: String, before: String? = nil, limit: Int? = nil) -> Endpoint {
        get("/views/\(segment(id))/items", [("before", before), ("limit", limit.map(String.init))])
    }
    public static func createView(_ input: SavedViewInput) throws -> Endpoint { try json("POST", "/views", input) }
    public static func updateView(_ id: String, _ input: SavedViewInput) throws -> Endpoint { try json("PATCH", "/views/\(segment(id))", input) }
    /// Archives the definition only; the items it showed are untouched.
    public static func removeView(_ id: String) -> Endpoint {
        Endpoint(method: "DELETE", path: "/views/\(segment(id))", headers: [idempotencyHeader: newKey()])
    }

    public static let templates = get("/templates")
    public static func createTemplate(sourceId: String, name: String?) throws -> Endpoint {
        try json("POST", "/templates", TemplateCreateBody(sourceId: sourceId, name: name))
    }
    public static func useTemplate(_ id: String, _ input: TemplateUseInput) throws -> Endpoint {
        try json("POST", "/templates/\(segment(id))/use", input)
    }
}
