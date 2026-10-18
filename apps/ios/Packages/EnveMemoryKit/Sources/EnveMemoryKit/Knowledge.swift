import Foundation

/// The server's limits for recipes, preferences and collections (`KNOWLEDGE_LIMITS` in core).
public enum KnowledgeLimits {
    public static let name = 120
    public static let recipeInstruction = 4_000
    public static let preferenceInstruction = 1_000
    public static let query = 500
    public static let fields = 20
    public static let fieldName = 80
    public static let options = 50
    public static let optionName = 80
    public static let textValue = 2_000
    public static let number = 1e15
    public static let sorts = 3
    public static let filters = 10
    public static let evaluatedRows = 1_000
    public static let selectedPreferences = 10
    public static let preferenceContext = 4_000
    public static let rowsPage = 50
}

/// Exactly one of `rootId` or `query`; `project` only with a query.
public struct RecipeScope: Codable, Hashable, Sendable {
    public var rootId: String?
    public var query: String?
    public var project: String?

    public init(rootId: String? = nil, query: String? = nil, project: String? = nil) {
        self.rootId = rootId
        self.query = query
        self.project = project
    }

    public static func branch(_ rootId: String) -> RecipeScope { RecipeScope(rootId: rootId) }
    public static func topic(_ query: String, project: String? = nil) -> RecipeScope { RecipeScope(query: query, project: project) }
}

/// A saved instruction and scope. Running it always rereads the library; nothing executable is stored.
public struct Recipe: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let instruction: String
    public let scope: RecipeScope
    public let createdAt: Date
    public let updatedAt: Date
}

/// Without an id this creates a recipe; with one, the given scope replaces the whole scope.
public struct RecipeInput: Encodable, Hashable, Sendable {
    public var id: String?
    public var name: String
    public var instruction: String
    public var scope: RecipeScope

    public init(id: String? = nil, name: String, instruction: String, scope: RecipeScope) {
        self.id = id
        self.name = name
        self.instruction = instruction
        self.scope = scope
    }
}

public struct OrganizationPreference: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let instruction: String
    /// The project id it applies to; nil applies everywhere.
    public let project: String?
    public let createdAt: Date
    public let updatedAt: Date

    public var isGlobal: Bool { project == nil }

    /// Whether a request in `project` (nil for none) may use it.
    public func applies(inProject project: String?) -> Bool { self.project == nil || self.project == project }
}

/// `name` nil asks the server to derive one from the instruction; `project` nil applies everywhere (sent as null, so an edit clears it).
public struct PreferenceInput: Encodable, Hashable, Sendable {
    public var id: String?
    public var name: String?
    public var instruction: String
    public var project: String?

    public init(id: String? = nil, name: String? = nil, instruction: String, project: String? = nil) {
        self.id = id
        self.name = name
        self.instruction = instruction
        self.project = project
    }

    private enum CodingKeys: String, CodingKey { case id, name, instruction, project }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(instruction, forKey: .instruction)
        try c.encode(project, forKey: .project)
    }
}

public enum PropertyType: String, Codable, CaseIterable, Hashable, Sendable {
    case text, number, date, checkbox, select

    /// The filter operations the server accepts for this type.
    public var filterOps: [FilterOp] {
        switch self {
        case .text: [.equals, .notEquals, .contains, .empty, .notEmpty]
        case .number, .date: [.equals, .notEquals, .lt, .lte, .gt, .gte, .empty, .notEmpty]
        case .checkbox: [.equals]
        case .select: [.equals, .notEquals, .empty, .notEmpty]
        }
    }
}

public struct SelectOption: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
}

public struct PropertyField: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let key: String
    public let name: String
    public let type: PropertyType
    public let options: [SelectOption]?

    public func option(_ id: String) -> SelectOption? { options?.first { $0.id == id } }
}

/// A stored field value as JSON has it; its field's type says how to read it.
/// Dates are calendar days written `YYYY-MM-DD`; select values are option ids.
public enum FieldValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let value = try? c.decode(Bool.self) { self = .bool(value) }
        else if let value = try? c.decode(Double.self) { self = .number(value) }
        else { self = .string(try c.decode(String.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let value): try c.encode(value)
        case .number(let value): try c.encode(value)
        case .bool(let value): try c.encode(value)
        }
    }

    public var string: String? { if case .string(let value) = self { value } else { nil } }
    public var number: Double? { if case .number(let value) = self { value } else { nil } }
    public var bool: Bool? { if case .bool(let value) = self { value } else { nil } }

    var json: JSONValue {
        switch self {
        case .string(let value): .string(value)
        case .number(let value): .number(value)
        case .bool(let value): .bool(value)
        }
    }

    /// How a row shows the value of `field`.
    public func display(for field: PropertyField) -> String {
        switch (field.type, self) {
        case (.select, .string(let id)): field.option(id)?.name ?? ""
        case (.checkbox, .bool(let value)): value ? "Yes" : "No"
        case (.number, .number(let value)): value.formatted(.number.grouping(.never))
        case (.date, .string(let day)): DueDate.parse(day)?.formatted(date: .abbreviated, time: .omitted) ?? day
        case (_, .string(let value)): value
        case (_, .number(let value)): value.formatted()
        case (_, .bool(let value)): value ? "Yes" : "No"
        }
    }
}

public enum CollectionLayout: String, Codable, CaseIterable, Hashable, Sendable {
    case table, cards, kanban
}

public enum FilterOp: String, Codable, CaseIterable, Hashable, Sendable {
    case equals, notEquals, contains, lt, lte, gt, gte, empty, notEmpty

    public var takesValue: Bool { self != .empty && self != .notEmpty }
}

public enum SortDirection: String, Codable, CaseIterable, Hashable, Sendable {
    case asc, desc
}

/// `field` is a property field id or one of `builtIn`.
public struct CollectionSort: Codable, Hashable, Sendable {
    public static let builtIn = ["title", "createdAt", "updatedAt"]

    public var field: String
    public var direction: SortDirection

    public init(field: String, direction: SortDirection = .asc) {
        self.field = field
        self.direction = direction
    }
}

/// `value` is omitted for `empty` and `notEmpty`.
public struct CollectionFilter: Codable, Hashable, Sendable {
    public var field: String
    public var op: FilterOp
    public var value: FieldValue?

    public init(field: String, op: FilterOp, value: FieldValue? = nil) {
        self.field = field
        self.op = op
        self.value = op.takesValue ? value : nil
    }
}

/// Every condition must hold. `project` is an id; `type` is never a decision.
public struct CollectionScope: Codable, Hashable, Sendable {
    public var project: String?
    public var query: String?
    public var type: ItemType?

    public init(project: String? = nil, query: String? = nil, type: ItemType? = nil) {
        self.project = project
        self.query = query
        self.type = type
    }

    public static let rowTypes: [ItemType] = [.note, .bookmark, .task, .file, .image]
}

public struct KnowledgeCollection: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let fields: [PropertyField]
    public let scope: CollectionScope
    public let layout: CollectionLayout
    /// A select field's id; required for Kanban.
    public let groupBy: String?
    public let sort: [CollectionSort]
    public let filters: [CollectionFilter]
    public let createdAt: Date
    public let updatedAt: Date

    public func field(_ id: String) -> PropertyField? { fields.first { $0.id == id } }
    public var groupField: PropertyField? { groupBy.flatMap(field) }
}

/// Omit `id` for a new field or option; an existing one keeps its id, so its stored values stay attached.
public struct PropertyFieldInput: Encodable, Hashable, Sendable {
    public struct Option: Encodable, Hashable, Sendable {
        public var id: String?
        public var name: String

        public init(id: String? = nil, name: String) {
            self.id = id
            self.name = name
        }
    }

    public var id: String?
    public var key: String?
    public var name: String
    public var type: PropertyType
    /// Select fields only; other types never send options.
    public var options: [Option]?

    public init(id: String? = nil, key: String? = nil, name: String, type: PropertyType, options: [Option]? = nil) {
        self.id = id
        self.key = key
        self.name = name
        self.type = type
        self.options = type == .select ? options : nil
    }

    public init(_ field: PropertyField) {
        self.init(id: field.id, key: field.key, name: field.name, type: field.type,
                  options: field.options?.map { Option(id: $0.id, name: $0.name) })
    }
}

/// A whole definition: `groupBy` nil is sent as null, so an edit can ungroup.
public struct CollectionInput: Encodable, Hashable, Sendable {
    public var id: String?
    public var name: String
    public var fields: [PropertyFieldInput]
    public var scope: CollectionScope
    public var layout: CollectionLayout
    public var groupBy: String?
    public var sort: [CollectionSort]
    public var filters: [CollectionFilter]

    public init(id: String? = nil, name: String, fields: [PropertyFieldInput], scope: CollectionScope = .init(), layout: CollectionLayout = .table,
                groupBy: String? = nil, sort: [CollectionSort] = [], filters: [CollectionFilter] = []) {
        self.id = id
        self.name = name
        self.fields = fields
        self.scope = scope
        self.layout = layout
        self.groupBy = groupBy
        self.sort = sort
        self.filters = filters
    }

    public init(_ collection: KnowledgeCollection) {
        self.init(id: collection.id, name: collection.name, fields: collection.fields.map(PropertyFieldInput.init), scope: collection.scope,
                  layout: collection.layout, groupBy: collection.groupBy, sort: collection.sort, filters: collection.filters)
    }

    private enum CodingKeys: String, CodingKey { case id, name, fields, scope, layout, groupBy, sort, filters }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(fields, forKey: .fields)
        try c.encode(scope, forKey: .scope)
        try c.encode(layout, forKey: .layout)
        try c.encode(groupBy, forKey: .groupBy)
        try c.encode(sort, forKey: .sort)
        try c.encode(filters, forKey: .filters)
    }
}

public struct CollectionRow: Decodable, Hashable, Identifiable, Sendable {
    public let item: Item
    /// Valid values by field id; unset fields are absent.
    public let values: [String: FieldValue]

    public var id: String { item.id }

    /// The same row with the values the server answered after an edit.
    public func replacingValues(_ values: [String: FieldValue]) -> CollectionRow {
        CollectionRow(item: item, values: values)
    }

    init(item: Item, values: [String: FieldValue]) {
        self.item = item
        self.values = values
    }
}

public struct CollectionGroup: Decodable, Hashable, Sendable {
    /// The option id, or nil for rows without a value.
    public let option: String?
    public let name: String
    public let count: Int
}

/// Rows after filters, among at most `KnowledgeLimits.evaluatedRows` of the newest matching items; `capped` says the scope held more.
public struct CollectionRowsPage: Decodable, Hashable, Sendable {
    public let collection: KnowledgeCollection
    public let rows: [CollectionRow]
    public let offset: Int
    public let limit: Int
    public let total: Int
    public let next: Int?
    public let matched: Int
    public let evaluated: Int
    public let capped: Bool
    public let groups: [CollectionGroup]?
}

/// One Kanban column's rows: an option id, or the rows without a value.
public enum CollectionGroupSelection: Hashable, Sendable {
    case option(String)
    case unset

    var queryValue: String {
        switch self {
        case .option(let id): id
        case .unset: "__unset"
        }
    }

    public init(_ option: String?) { self = option.map(Self.option) ?? .unset }
}

public struct ArchiveResult: Decodable, Hashable, Sendable {
    public let archived: Bool
}

private struct RecipeRunBody: Encodable { let preferences: [String]? }

private struct SetValuesBody: Encodable {
    let itemId: String
    let values: [String: JSONValue]
}

extension Endpoint {
    public static let recipes = get("/knowledge/recipes")
    public static func recipe(_ id: String) -> Endpoint { get("/knowledge/recipes/\(segment(id))") }
    public static func saveRecipe(_ input: RecipeInput) throws -> Endpoint { try json("POST", "/knowledge/recipes", input) }
    public static func archiveRecipe(_ id: String) -> Endpoint { remove("/knowledge/recipes/\(segment(id))") }
    /// A fresh proposal for review; `preferences` is omitted unless some were chosen.
    public static func runRecipe(_ id: String, preferences: [String] = []) throws -> Endpoint {
        try transient("/knowledge/recipes/\(segment(id))/run", RecipeRunBody(preferences: preferences.isEmpty ? nil : preferences))
    }

    /// With a project, only the preferences that apply there: global ones and that project's own.
    public static func preferences(project: String? = nil) -> Endpoint { get("/knowledge/preferences", [("project", project)]) }
    public static func savePreference(_ input: PreferenceInput) throws -> Endpoint { try json("POST", "/knowledge/preferences", input) }
    public static func archivePreference(_ id: String) -> Endpoint { remove("/knowledge/preferences/\(segment(id))") }

    public static let collections = get("/knowledge/collections")
    public static func collection(_ id: String) -> Endpoint { get("/knowledge/collections/\(segment(id))") }
    public static func saveCollection(_ input: CollectionInput) throws -> Endpoint { try json("POST", "/knowledge/collections", input) }
    public static func archiveCollection(_ id: String) -> Endpoint { remove("/knowledge/collections/\(segment(id))") }
    public static func collectionRows(_ id: String, offset: Int = 0, limit: Int = KnowledgeLimits.rowsPage, group: CollectionGroupSelection? = nil) -> Endpoint {
        get("/knowledge/collections/\(segment(id))/rows",
            [("offset", offset > 0 ? String(offset) : nil), ("limit", String(limit)), ("group", group?.queryValue)])
    }
    /// A nil value clears that field; fields not named keep their values.
    public static func setFieldValues(collection: String, item: String, values: [String: FieldValue?]) throws -> Endpoint {
        try json("POST", "/knowledge/collections/\(segment(collection))/values",
                 SetValuesBody(itemId: item, values: values.mapValues { $0?.json ?? .null }))
    }

    static func remove(_ path: String) -> Endpoint {
        Endpoint(method: "DELETE", path: path, headers: [idempotencyHeader: newKey()])
    }
}
