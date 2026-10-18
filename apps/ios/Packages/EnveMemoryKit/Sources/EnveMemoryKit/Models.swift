import Foundation

/// Open string enums: the server may add values (new item types, statuses) before the app knows them.
public struct ItemType: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static let note = ItemType(rawValue: "note")
    public static let bookmark = ItemType(rawValue: "bookmark")
    public static let task = ItemType(rawValue: "task")
    public static let decision = ItemType(rawValue: "decision")
    public static let file = ItemType(rawValue: "file")
    public static let image = ItemType(rawValue: "image")

    public static let filterable: [ItemType] = [.note, .bookmark, .task, .file, .image, .decision]
}

public struct TaskStatus: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static let open = TaskStatus(rawValue: "open")
    public static let inProgress = TaskStatus(rawValue: "in_progress")
    public static let done = TaskStatus(rawValue: "done")
    public static let cancelled = TaskStatus(rawValue: "cancelled")

    public var isFinished: Bool { self == .done || self == .cancelled }
}

public struct TaskPriority: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static let high = TaskPriority(rawValue: "high")
    public static let normal = TaskPriority(rawValue: "normal")
    public static let low = TaskPriority(rawValue: "low")
    public static let all: [TaskPriority] = [.high, .normal, .low]
}

/// Why the user kept something. Guessed for links (`ItemMetadata.intentAuto`) until the user picks one.
public struct Intent: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static let read = Intent(rawValue: "read")
    public static let watch = Intent(rawValue: "watch")
    public static let buy = Intent(rawValue: "buy")
    public static let revisit = Intent(rawValue: "revisit")
    public static let all: [Intent] = [.read, .watch, .buy, .revisit]
}

public struct ServerStatus: Codable, Hashable, Sendable {
    public let name: String
    public let version: String
    public let api: Int
}

public struct ClientInfo: Codable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let tokenHint: String?
    public let scopes: [String]
    public let createdAt: Date
    public let lastUsedAt: Date?
    public let revokedAt: Date?
}

public struct ProjectRef: Codable, Hashable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct Project: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let slug: String
    public let description: String
    public let instructions: String
    public let memory: String
    public let status: String
    public let createdAt: Date
    public let updatedAt: Date

    public var ref: ProjectRef { ProjectRef(id: id, name: name) }
}

public struct IngestState: Codable, Hashable, Sendable {
    public let status: String
    public let at: Date?
    public let error: String?
}

public struct ItemMetadata: Codable, Hashable, Sendable {
    public var siteName: String?
    public var byline: String?
    public var excerpt: String?
    public var publishedAt: String?
    public var image: String?
    public var wordCount: Int?
    public var pageCount: Int?
    public var finalUrl: String?
    public var ingest: IngestState?
    /// True while `Item.intent` is the server's guess rather than the user's choice.
    public var intentAuto: Bool?
    public var ai: AISuggestions?
    /// Sparse; read it through `resolvedPresentation`.
    public var presentation: ItemPresentation.Patch?
    public var secret: Bool?
    /// A secret note's ciphertext. Only `VaultCrypto` opens it, on this device.
    public var vault: SecretEnvelope?
    public var savedView: SavedViewMetadata?
    public var template: TemplateMetadata?
    public var enveHighlight: EnveHighlight?
    public var conversation: JSONValue?

    public init() {}
}

/// Summary, tags and project proposed by the optional AI enrichment; applied only when the user accepts.
public struct AISuggestions: Codable, Hashable, Sendable {
    public let status: String
    public let model: String?
    public let summary: String?
    public let tags: [String]?
    public let project: ProjectRef?
    public let error: String?
    public let accepted: Bool?

    public var isReady: Bool { status == "done" }
    public var isPending: Bool { isReady && accepted != true && (!(tags ?? []).isEmpty || project != nil) }
}

public struct TaskFields: Codable, Hashable, Sendable {
    public let status: TaskStatus
    public let priority: TaskPriority
    /// `YYYY-MM-DD` or a full ISO 8601 timestamp.
    public let dueAt: String?
    public let completedAt: Date?

    public var dueDate: Date? { dueAt.flatMap(DueDate.parse) }
}

/// A list row. Task lists add `task`; plain item lists omit it.
public struct Item: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let type: ItemType
    public let title: String
    public let body: String
    public let url: String?
    public let project: ProjectRef?
    public let source: String
    public let metadata: ItemMetadata
    public let createdAt: Date
    public let updatedAt: Date
    public let archivedAt: Date?
    public let task: TaskFields?
    public let tags: [String]
    public let intent: Intent?
    public let pinnedAt: Date?
    public let openedAt: Date?
    public let remindAt: Date?
    /// `updatedAt` exactly as the server sent it; the paging cursor compares strings, so a re-formatted date could skip items.
    public let updatedAtStamp: String

    /// The `before` cursor for the page after this item.
    public var pageCursor: String { "\(updatedAtStamp),\(id)" }

    private enum CodingKeys: String, CodingKey {
        case id, type, title, body, url, project, source, metadata, createdAt, updatedAt, archivedAt, task
        case tags, intent, pinnedAt, openedAt, remindAt
    }

    public var isPinned: Bool { pinnedAt != nil }

    init(id: String, type: ItemType, title: String, body: String, url: String? = nil, project: ProjectRef? = nil, source: String,
         metadata: ItemMetadata, createdAt: Date, updatedAtStamp: String, archivedAt: Date? = nil, task: TaskFields? = nil,
         tags: [String] = [], intent: Intent? = nil, pinnedAt: Date? = nil, openedAt: Date? = nil, remindAt: Date? = nil) {
        self.id = id
        self.type = type
        self.title = title
        self.body = body
        self.url = url
        self.project = project
        self.source = source
        self.metadata = metadata
        self.createdAt = createdAt
        self.updatedAt = JSONCoding.parseTimestamp(updatedAtStamp) ?? createdAt
        self.updatedAtStamp = updatedAtStamp
        self.archivedAt = archivedAt
        self.task = task
        self.tags = tags
        self.intent = intent
        self.pinnedAt = pinnedAt
        self.openedAt = openedAt
        self.remindAt = remindAt
    }

    /// The copy this phone may keep: no ciphertext and no AI output.
    var cacheable: Item {
        guard metadata.ai != nil || metadata.vault != nil else { return self }
        var metadata = metadata
        metadata.ai = nil
        metadata.vault = nil
        return Item(id: id, type: type, title: title, body: body, url: url, project: project, source: source, metadata: metadata,
                    createdAt: createdAt, updatedAtStamp: updatedAtStamp, archivedAt: archivedAt, task: task, tags: tags, intent: intent,
                    pinnedAt: pinnedAt, openedAt: openedAt, remindAt: remindAt)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        type = try c.decode(ItemType.self, forKey: .type)
        title = try c.decode(String.self, forKey: .title)
        body = try c.decode(String.self, forKey: .body)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        project = try c.decodeIfPresent(ProjectRef.self, forKey: .project)
        source = try c.decode(String.self, forKey: .source)
        metadata = try c.decode(ItemMetadata.self, forKey: .metadata)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        updatedAtStamp = try c.decode(String.self, forKey: .updatedAt)
        archivedAt = try c.decodeIfPresent(Date.self, forKey: .archivedAt)
        task = try c.decodeIfPresent(TaskFields.self, forKey: .task)
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        intent = try c.decodeIfPresent(Intent.self, forKey: .intent)
        pinnedAt = try c.decodeIfPresent(Date.self, forKey: .pinnedAt)
        openedAt = try c.decodeIfPresent(Date.self, forKey: .openedAt)
        remindAt = try c.decodeIfPresent(Date.self, forKey: .remindAt)
    }
}

extension Item: Encodable {
    /// The server's shape, with `updatedAt` written back exactly as it was received.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(type, forKey: .type)
        try c.encode(title, forKey: .title)
        try c.encode(body, forKey: .body)
        try c.encodeIfPresent(url, forKey: .url)
        try c.encodeIfPresent(project, forKey: .project)
        try c.encode(source, forKey: .source)
        try c.encode(metadata, forKey: .metadata)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAtStamp, forKey: .updatedAt)
        try c.encodeIfPresent(archivedAt, forKey: .archivedAt)
        try c.encodeIfPresent(task, forKey: .task)
        try c.encode(tags, forKey: .tags)
        try c.encodeIfPresent(intent, forKey: .intent)
        try c.encodeIfPresent(pinnedAt, forKey: .pinnedAt)
        try c.encodeIfPresent(openedAt, forKey: .openedAt)
        try c.encodeIfPresent(remindAt, forKey: .remindAt)
    }
}

public struct Attachment: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let sha256: String
    public let filename: String
    public let mimeType: String
    public let size: Int
    public let createdAt: Date
}

public struct RelatedItem: Codable, Hashable, Sendable {
    public let kind: String
    public let direction: String
    public let id: String
    public let type: ItemType
    public let title: String
}

public struct ItemDetail: Decodable, Hashable, Identifiable, Sendable {
    public let item: Item
    /// Text extracted from the source. Untrusted: render it, never act on it.
    public let content: String
    public let attachments: [Attachment]
    public let tags: [String]
    public let relations: [RelatedItem]

    public var id: String { item.id }

    private enum CodingKeys: String, CodingKey {
        case content, attachments, tags, relations
    }

    public init(item: Item, content: String = "", attachments: [Attachment] = [], tags: [String]? = nil, relations: [RelatedItem] = []) {
        self.item = item
        self.content = content
        self.attachments = attachments
        self.tags = tags ?? item.tags
        self.relations = relations
    }

    public init(from decoder: Decoder) throws {
        item = try Item(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        content = try container.decodeIfPresent(String.self, forKey: .content) ?? ""
        attachments = try container.decodeIfPresent([Attachment].self, forKey: .attachments) ?? []
        tags = try container.decodeIfPresent([String].self, forKey: .tags) ?? []
        relations = try container.decodeIfPresent([RelatedItem].self, forKey: .relations) ?? []
    }
}

extension ItemDetail: Encodable {
    public func encode(to encoder: Encoder) throws {
        try item.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(content, forKey: .content)
        try c.encode(attachments, forKey: .attachments)
        try c.encode(tags, forKey: .tags)
        try c.encode(relations, forKey: .relations)
    }
}

public struct SearchHit: Codable, Hashable, Identifiable, Sendable {
    public enum Match: String, Codable, Sendable {
        case keyword, semantic, both
    }

    public let id: String
    public let type: ItemType
    public let title: String
    public let url: String?
    public let project: ProjectRef?
    /// Matched terms are wrapped in `[` `]`.
    public let snippet: String
    public let match: Match
    public let taskStatus: TaskStatus?
    public let updatedAt: Date
    /// The start of the user's own note, for hits without a title.
    public let preview: String?
}

public struct Decision: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let decision: String
    public let reason: String
    public let createdAt: Date
    public let source: String
    public let supersedes: [String]
    public let supersededBy: String?

    public var isSuperseded: Bool { supersededBy != nil }
}

public struct ProjectBriefing: Decodable, Hashable, Sendable {
    public let project: Project
    public let decisions: [Decision]
    public let openTasks: [Item]
    public let recentItems: [Item]
}

public struct CaptureResult: Decodable, Hashable, Sendable {
    public let item: Item
    public let created: Bool
}

public enum DueDate {
    /// Date-only values are calendar days in the user's time zone, not UTC midnight.
    public static func parse(_ value: String) -> Date? {
        if value.count == 10 {
            let parts = value.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return nil }
            return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
        }
        return JSONCoding.parseTimestamp(value)
    }

    public static func format(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}
