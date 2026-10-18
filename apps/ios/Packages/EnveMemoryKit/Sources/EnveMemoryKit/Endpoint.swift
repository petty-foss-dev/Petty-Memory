import Foundation

/// One API call, relative to `<base>/api/v1`. Codable so the outbox can persist it verbatim.
public struct Endpoint: Codable, Hashable, Sendable {
    public struct QueryItem: Codable, Hashable, Sendable {
        public let name: String
        public let value: String
    }

    public var method: String
    public var path: String
    public var query: [QueryItem]
    public var headers: [String: String]
    public var body: Data?

    public init(method: String = "GET", path: String, query: [QueryItem] = [], headers: [String: String] = [:], body: Data? = nil) {
        self.method = method
        self.path = path
        self.query = query
        self.headers = headers
        self.body = body
    }

    static func get(_ path: String, _ query: [(String, String?)] = []) -> Endpoint {
        Endpoint(path: path, query: query.compactMap { name, value in
            guard let value, !value.isEmpty else { return nil }
            return QueryItem(name: name, value: value)
        })
    }

    /// Every write is born with its own key, so a retry of the same value (direct attempt, then outbox) never writes twice.
    static func json(_ method: String, _ path: String, _ body: some Encodable) throws -> Endpoint {
        Endpoint(method: method, path: path, headers: ["Content-Type": "application/json", idempotencyHeader: newKey()],
                 body: try JSONCoding.makeEncoder().encode(body))
    }

    /// Previews and extractions save nothing, so they carry no idempotency key and the server keeps no copy of the answer.
    static func transient(_ path: String, _ body: some Encodable) throws -> Endpoint {
        Endpoint(method: "POST", path: path, headers: ["Content-Type": "application/json"], body: try JSONCoding.makeEncoder().encode(body))
    }

    static func post(_ path: String) -> Endpoint {
        Endpoint(method: "POST", path: path, headers: [idempotencyHeader: newKey()])
    }

    public static let idempotencyHeader = "Idempotency-Key"

    static func newKey() -> String { UUID().uuidString.lowercased() }

    public var idempotencyKey: String? { headers[Self.idempotencyHeader] }
}

public struct CaptureRequest: Codable, Hashable, Sendable {
    public var url: String?
    public var title: String?
    public var selection: String?
    public var note: String?
    public var project: String?
    public var tags: [String]?
    public var intent: Intent?
    /// An ISO timestamp. The phone resolves "tomorrow" itself, so a capture that waits in the outbox keeps its meaning.
    public var remind: String?
    public var pinned: Bool?

    public init(url: String? = nil, title: String? = nil, selection: String? = nil, note: String? = nil, project: String? = nil,
                tags: [String]? = nil, intent: Intent? = nil, remind: Date? = nil, pinned: Bool? = nil) {
        self.url = url
        self.title = title
        self.selection = selection
        self.note = note
        self.project = project
        self.tags = tags
        self.intent = intent
        self.remind = remind.map(JSONCoding.formatTimestamp)
        self.pinned = pinned
    }
}

private struct PinBody: Encodable { let pinned: Bool }
private struct ReminderBody: Encodable { let at: String? }
private struct IntentBody: Encodable { let intent: Intent? }

public struct NewItemRequest: Codable, Hashable, Sendable {
    public var type: ItemType
    public var title: String?
    public var body: String?
    public var url: String?
    public var project: String?
    public var tags: [String]?
    public var due: String?
    public var priority: TaskPriority?

    public init(type: ItemType, title: String? = nil, body: String? = nil, url: String? = nil, project: String? = nil,
                tags: [String]? = nil, due: String? = nil, priority: TaskPriority? = nil) {
        self.type = type
        self.title = title
        self.body = body
        self.url = url
        self.project = project
        self.tags = tags
        self.due = due
        self.priority = priority
    }
}

/// Metadata for `POST /files`; the bytes stream from a file on disk.
public struct FileUpload: Codable, Hashable, Sendable {
    public var filename: String
    public var mimeType: String
    public var title: String?
    public var note: String?
    public var project: String?
    public var tags: [String]
    public var intent: Intent?
    /// Sent as an exact ISO time, for the same reason as `CaptureRequest.remind`.
    public var remind: Date?
    public var pinned: Bool

    public init(filename: String, mimeType: String, title: String? = nil, note: String? = nil, project: String? = nil, tags: [String] = [],
                intent: Intent? = nil, remind: Date? = nil, pinned: Bool = false) {
        self.filename = filename
        self.mimeType = mimeType
        self.title = title
        self.note = note
        self.project = project
        self.tags = tags
        self.intent = intent
        self.remind = remind
        self.pinned = pinned
    }
}

public struct ItemFilter: Hashable, Sendable {
    public var project: String?
    public var type: ItemType?
    public var tag: String?
    public var limit: Int?
    /// `Item.pageCursor` of the last item on the previous page (`/items` only).
    public var before: String?
    public var shelf: Shelf?

    public init(project: String? = nil, type: ItemType? = nil, tag: String? = nil, limit: Int? = nil, before: String? = nil, shelf: Shelf? = nil) {
        self.project = project
        self.type = type
        self.tag = tag
        self.limit = limit
        self.before = before
        self.shelf = shelf
    }

    var query: [(String, String?)] {
        [("project", project), ("type", type?.rawValue), ("tag", tag), ("limit", limit.map(String.init)), ("before", before)]
            + (shelf?.query ?? [])
    }
}

/// Curated slices of `/items`. Shelves sort by their own key (pin time, reminder time), so they aren't paged by `before`.
public enum Shelf: Hashable, Sendable, Identifiable {
    case pinned
    case intent(Intent)
    case unopened(days: Int)
    case reminders
    case review
    case attention(ItemPresentation.Attention)

    public static let all: [Shelf] = [.pinned, .intent(.read), .intent(.watch), .intent(.buy), .intent(.revisit), .unopened(days: 30), .reminders]
    /// What deserves a look: marked for review, high attention, and the existing revisit and unopened signals.
    public static let suggestions: [Shelf] = [.review, .attention(.high), .intent(.revisit), .unopened(days: 30)]

    public var id: String {
        switch self {
        case .pinned: "pinned"
        case .intent(let intent): "intent-\(intent.rawValue)"
        case .unopened(let days): "unopened-\(days)"
        case .reminders: "reminders"
        case .review: "review"
        case .attention(let level): "attention-\(level.rawValue)"
        }
    }

    var query: [(String, String?)] {
        switch self {
        case .pinned: [("pinned", "true")]
        case .intent(let intent): [("intent", intent.rawValue)]
        case .unopened(let days): [("unopened", String(days))]
        case .reminders: [("reminders", "true")]
        case .review: [("review", "true")]
        case .attention(let level): [("attention", level.rawValue)]
        }
    }
}

public enum TaskListStatus: String, Sendable, CaseIterable {
    case active, open, inProgress = "in_progress", done, all
}

extension Endpoint {
    public static let status = get("/status")
    public static let whoami = get("/whoami")

    public static func search(_ text: String, filter: ItemFilter = .init()) -> Endpoint {
        get("/search", [("q", text)] + filter.query)
    }

    public static func items(_ filter: ItemFilter = .init()) -> Endpoint { get("/items", filter.query) }
    public static func item(_ id: String) -> Endpoint { get("/items/\(segment(id))") }
    public static func itemFile(_ id: String) -> Endpoint { get("/items/\(segment(id))/file") }
    public static let projects = get("/projects")
    public static func reminders(dueOnly: Bool = false, limit: Int? = nil) -> Endpoint {
        get("/reminders", [("due", dueOnly ? "true" : nil), ("limit", limit.map(String.init))])
    }
    public static func briefing(_ ref: String) -> Endpoint { get("/projects/\(segment(ref))") }

    public static func tasks(project: String? = nil, status: TaskListStatus = .active, limit: Int? = nil, offset: Int = 0) -> Endpoint {
        get("/tasks", [("project", project), ("status", status.rawValue), ("limit", limit.map(String.init)),
                       ("offset", offset > 0 ? String(offset) : nil)])
    }

    public static func capture(_ request: CaptureRequest) throws -> Endpoint { try json("POST", "/capture", request) }
    public static func createItem(_ request: NewItemRequest) throws -> Endpoint { try json("POST", "/items", request) }
    public static func completeTask(_ id: String) -> Endpoint { post("/tasks/\(segment(id))/complete") }
    public static func pin(_ id: String, _ pinned: Bool) throws -> Endpoint { try json("POST", "/items/\(segment(id))/pin", PinBody(pinned: pinned)) }
    /// `nil` clears the reminder (the key is omitted, which the server reads as null).
    public static func setReminder(_ id: String, at date: Date?) throws -> Endpoint {
        try json("PUT", "/items/\(segment(id))/reminder", ReminderBody(at: date.map(JSONCoding.formatTimestamp)))
    }
    public static func setIntent(_ id: String, _ intent: Intent?) throws -> Endpoint { try json("PUT", "/items/\(segment(id))/intent", IntentBody(intent: intent)) }
    public static func acceptSuggestions(_ id: String) -> Endpoint { post("/items/\(segment(id))/accept") }
    public static func opened(_ id: String) -> Endpoint { post("/items/\(segment(id))/opened") }

    public static func upload(_ file: FileUpload) -> Endpoint {
        var headers = ["Content-Type": file.mimeType, "X-Filename": percentEncoded(file.filename), idempotencyHeader: newKey()]
        if let title = file.title, !title.isEmpty { headers["X-Title"] = percentEncoded(title) }
        if let note = file.note, !note.isEmpty { headers["X-Note"] = percentEncoded(note) }
        if let project = file.project, !project.isEmpty { headers["X-Project"] = percentEncoded(project) }
        if !file.tags.isEmpty { headers["X-Tags"] = percentEncoded(file.tags.joined(separator: ",")) }
        if let intent = file.intent { headers["X-Intent"] = percentEncoded(intent.rawValue) }
        if let remind = file.remind { headers["X-Remind"] = percentEncoded(JSONCoding.formatTimestamp(remind)) }
        if file.pinned { headers["X-Pinned"] = "true" }
        return Endpoint(method: "POST", path: "/files", headers: headers)
    }

    static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    /// Strict RFC 3986 encoding; the server decodes with `decodeURIComponent`, and `+` must not become a space.
    static func percentEncoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    static func segment(_ value: String) -> String { percentEncoded(value) }
}
