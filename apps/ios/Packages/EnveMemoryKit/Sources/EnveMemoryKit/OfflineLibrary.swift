import CryptoKit
import Foundation

/// Per-server/token read-only replica from `GET /library`, answering ordinary reads offline; never holds secrets or AI output.
public actor OfflineLibrary {
    /// What one refresh did.
    public struct Progress: Hashable, Sendable {
        /// More pages or briefings remain within this pull.
        public let hasMore: Bool
        /// Something new was saved, so screens showing the copy should reload.
        public let changed: Bool
    }

    public struct Summary: Hashable, Sendable {
        public let items: Int
        public let projects: Int
        /// When the first complete copy finished; nil while it's still being built.
        public let completedAt: Date?
        /// When the copy was last confirmed current with the server.
        public let refreshedAt: Date?
        public let isBuilding: Bool
    }

    struct Record: Codable {
        var item: Item
        var parentId: String?
        var position: Double
        /// Nil in records saved before extras were versioned; those read the item's old per-id file.
        var extras: ExtrasRef?
    }

    enum ExtrasRef: Codable, Hashable {
        case empty
        case file(String)
    }

    struct Relation: Codable, Hashable {
        let id: String
        let fromId: String
        let toId: String
        let kind: String
    }

    /// Archived text and file listings, kept out of memory and never rewritten once a record refers to them.
    struct Extras: Codable {
        let content: String
        let attachments: [Attachment]
    }

    /// One feed page; counts only while its number is at or below the saved cursor.
    struct Delta: Codable {
        var records: [Record] = []
        var deleted: [String] = []
        var relations: [Relation] = []
        var deletedRelations: [String] = []
    }

    struct State: Codable {
        var deviceId: String?
        var cursor = 0
        var completedAt: Date?
        var refreshedAt: Date?
        var projects: [Project] = []
        var briefingsDue: [String] = []
        var deltas = 0
    }

    static let pageSize = 200
    static let compactAfter = 32
    public static let changeWait = 25_000

    public nonisolated let directory: URL
    private let now: @Sendable () -> Date
    private var state: State
    private var records: [String: Record]?
    private var relations: [String: Relation] = [:]
    private var branches: [String: [String]]?
    private var isRefreshing = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var isDiscarded = false
    /// A state file that exists but can't be read yet; treating it as empty would sweep committed pages.
    private var stateUnreadable = false

    public init(root: URL = OfflineLibrary.defaultRoot, baseURL: URL, token: String, now: @escaping @Sendable () -> Date = { .now }) {
        directory = root.appending(path: Self.digest("\(baseURL.absoluteString)\n\(token)"), directoryHint: .isDirectory)
        self.now = now
        let file = directory.appending(path: "state.json")
        if let saved = try? JSONCoding.makeDecoder().decode(State.self, from: Data(contentsOf: file)) {
            state = saved
        } else {
            state = State()
            stateUnreadable = FileManager.default.fileExists(atPath: file.path)
        }
    }

    /// Retries an unreadable state file, e.g. one still protected before the first unlock.
    private func stateReadable() -> Bool {
        guard stateUnreadable else { return true }
        guard let saved = try? JSONCoding.makeDecoder().decode(State.self, from: Data(contentsOf: directory.appending(path: "state.json"))) else {
            return false
        }
        state = saved
        stateUnreadable = false
        records = nil
        return true
    }

    public static var defaultRoot: URL { URL.applicationSupportDirectory.appending(path: "OfflineLibrary", directoryHint: .isDirectory) }

    public static func removeAll(root: URL = defaultRoot) {
        try? FileManager.default.removeItem(at: root)
    }

    /// Deletes this copy; writes from a refresh still in flight are ignored.
    public func discard() {
        isDiscarded = true
        state = State()
        records = [:]
        relations = [:]
        branches = nil
        try? FileManager.default.removeItem(at: directory)
    }

    public func summary() -> Summary {
        let records = loaded()
        return Summary(items: records.values.count { $0.item.archivedAt == nil }, projects: state.projects.count,
                       completedAt: state.completedAt, refreshedAt: state.refreshedAt, isBuilding: state.completedAt == nil)
    }

    // MARK: Refreshing

    /// At most `budget` requests of pages and briefings; overlapping calls run in turn.
    public func refresh(using client: APIClient, cache: ResponseCache, budget: Int = 20) async throws -> Progress {
        while isRefreshing {
            await withCheckedContinuation { waiting.append($0) }
            try Task.checkCancellation()
        }
        isRefreshing = true
        defer {
            isRefreshing = false
            let resumed = waiting
            waiting = []
            for waiter in resumed { waiter.resume() }
        }
        guard stateReadable() else { throw OfflineLibraryError.storage("its saved state can't be read") }
        _ = loaded()
        var budget = budget
        var hasMore = true
        var changed = false

        while budget > 0, hasMore {
            budget -= 1
            let page = try await client.send(.library(cursor: state.cursor, limit: Self.pageSize), as: LibraryPage.self)
            guard !isDiscarded else { return Progress(hasMore: false, changed: false) }
            if page.reset || (state.deviceId != nil && page.deviceId != state.deviceId) {
                // A restored or replaced library: start over.
                try rebuild(for: page.deviceId)
                changed = true
                if !page.reset { continue }
            }
            changed = try apply(page) || changed
            hasMore = page.hasMore
        }

        while budget > 0, let project = state.briefingsDue.first {
            budget -= 1
            do {
                cache.store(try await client.data(for: .briefing(project)), for: .briefing(project))
                changed = true
            } catch let error as APIError where error.code == .notFound {}
            var next = state
            next.briefingsDue.removeFirst()
            try commit(next)
        }
        if state.deltas >= Self.compactAfter { try compact() }
        return Progress(hasMore: hasMore || !state.briefingsDue.isEmpty, changed: changed)
    }

    /// True when there's something to pull; `client` needs a timeout longer than `changeWait`.
    public func waitForChange(using client: APIClient) async throws -> Bool {
        guard stateReadable() else { throw OfflineLibraryError.storage("its saved state can't be read") }
        let notice = try await client.send(.changes(since: state.cursor, wait: Self.changeWait), as: ChangeNotice.self)
        guard notice.revision == state.cursor, notice.deviceId == state.deviceId, state.completedAt != nil else { return true }
        var next = state
        next.refreshedAt = now()
        try commit(next)
        return false
    }

    /// New extras, then the page, then the state that commits both; memory and old files change only after that.
    private func apply(_ page: LibraryPage) throws -> Bool {
        try removeUncommittedPages()
        var delta = Delta()
        var next = state
        var briefings = Set(page.projects.map(\.id))
        for feed in page.items {
            let extras = Extras(content: feed.item.content, attachments: feed.item.attachments)
            var ref = ExtrasRef.empty
            if !extras.content.isEmpty || !extras.attachments.isEmpty {
                let key = Self.digest("\(feed.item.id)\n\(page.cursor)")
                try write(extras, to: extrasFile(key))
                ref = .file(key)
            }
            let record = Record(item: feed.item.item.cacheable, parentId: feed.parentId, position: feed.position, extras: ref)
            delta.records.append(record)
            if let project = record.item.project?.id { briefings.insert(project) }
        }
        for id in page.deletedItemIds {
            if let project = records?[id]?.item.project?.id { briefings.insert(project) }
            delta.deleted.append(id)
        }
        delta.relations = page.relations
        delta.deletedRelations = page.deletedRelationIds
        let deletedProjects = Set(page.deletedProjectIds)
        for project in page.projects {
            if let index = next.projects.firstIndex(where: { $0.id == project.id }) { next.projects[index] = project } else { next.projects.append(project) }
        }
        next.projects.removeAll { deletedProjects.contains($0.id) }
        next.briefingsDue += briefings.subtracting(next.briefingsDue).subtracting(deletedProjects).sorted()
        next.briefingsDue.removeAll { deletedProjects.contains($0) }
        next.deviceId = page.deviceId
        next.cursor = page.cursor
        if !page.hasMore {
            next.completedAt = next.completedAt ?? now()
            next.refreshedAt = now()
        }
        let changed = !(delta.records.isEmpty && delta.deleted.isEmpty && delta.relations.isEmpty && delta.deletedRelations.isEmpty
            && page.projects.isEmpty && page.deletedProjectIds.isEmpty)
        if !(delta.records.isEmpty && delta.deleted.isEmpty && delta.relations.isEmpty && delta.deletedRelations.isEmpty) {
            try write(delta, to: directory.appending(path: "pages", directoryHint: .isDirectory).appending(path: "\(next.cursor).json"))
            next.deltas += 1
        }
        try commit(next)

        let superseded = delta.records.compactMap { records?[$0.item.id] } + delta.deleted.compactMap { records?[$0] }
        for record in delta.records { records?[record.item.id] = record }
        for id in delta.deleted { records?[id] = nil }
        for old in superseded {
            if let file = extrasFile(of: old), file != records?[old.item.id].flatMap(extrasFile(of:)) {
                try? FileManager.default.removeItem(at: file)
            }
        }
        for relation in delta.relations { relations[relation.id] = relation }
        for id in delta.deletedRelations { relations[id] = nil }
        branches = nil
        return changed
    }

    private func rebuild(for deviceId: String) throws {
        do {
            if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
        } catch {
            throw OfflineLibraryError.storage(error.localizedDescription)
        }
        state = State(deviceId: deviceId)
        records = [:]
        relations = [:]
        branches = nil
        try commit(state)
    }

    // MARK: Answering

    /// The answer the server would give, or nil; lists wait for a complete copy so a half-built one never looks whole.
    public func answer(_ endpoint: Endpoint) -> CachedResponse? {
        guard endpoint.method == "GET" else { return nil }
        let parts = endpoint.path.split(separator: "/").map { $0.removingPercentEncoding ?? String($0) }
        let query = Dictionary(endpoint.query.map { ($0.name, $0.value) }, uniquingKeysWith: { first, _ in first })
        guard query["secret"] == nil else { return nil }
        let records = loaded()
        let limit = min(query["limit"].flatMap(Int.init) ?? 50, Self.pageSize)
        let offset = query["offset"].flatMap(Int.init) ?? 0
        let savedAt = state.refreshedAt ?? state.completedAt ?? now()
        let isComplete = state.completedAt != nil

        switch (parts.first, parts.count) {
        case ("outline", 1) where isComplete && query["archived"] == nil:
            let parent = query["parent"]
            if let parent, records[parent] == nil || records[parent]?.item.archivedAt != nil {
                guard records[parent] != nil else { return nil }
                return encoded(OutlinePage(items: [], total: 0), savedAt: savedAt)
            }
            let children = children(of: parent)
            return encoded(OutlinePage(items: children.dropFirst(offset).prefix(limit).compactMap(entry), total: children.count), savedAt: savedAt)
        case ("outline", 2):
            return entry(parts[1]).flatMap { encoded($0, savedAt: savedAt) }
        case ("outline", 3) where parts[2] == "ancestors":
            guard let record = records[parts[1]] else { return nil }
            return encoded(ancestors(of: record).map(\.item), savedAt: savedAt)
        case ("items", 1) where isComplete:
            return encoded(Array(items(matching: query).prefix(limit)), savedAt: savedAt)
        case ("items", 2):
            return detail(parts[1]).flatMap { encoded($0, savedAt: savedAt) }
        case ("items", 3) where parts[2] == "checklist" && isComplete:
            guard let record = records[parts[1]] else { return nil }
            return encoded(progress(of: record), savedAt: savedAt)
        case ("items", 3) where parts[2] == "references" && isComplete:
            guard let record = records[parts[1]] else { return nil }
            return encoded(references(of: record), savedAt: savedAt)
        case ("search", 1) where isComplete:
            guard let text = query["q"] else { return nil }
            return encoded(search(text, project: query["project"], type: query["type"], limit: limit), savedAt: savedAt)
        case ("tasks", 1) where isComplete:
            return encoded(Array(tasks(query).dropFirst(offset).prefix(limit)), savedAt: savedAt)
        case ("reminders", 1) where isComplete && query["due"] == nil:
            let due = active.filter { $0.remindAt != nil }.sorted { $0.remindAt! < $1.remindAt! }
            return encoded(Array(due.prefix(limit)), savedAt: savedAt)
        case ("projects", 1) where isComplete && query.isEmpty:
            return encoded(state.projects.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }, savedAt: savedAt)
        default:
            return nil
        }
    }

    /// Cached rows by id, for showing items that queued moves bring into a branch.
    public func entries(_ ids: some Sequence<String>) -> [String: OutlineEntry] {
        _ = loaded()
        var found: [String: OutlineEntry] = [:]
        for id in ids { if let entry = entry(id) { found[id] = entry } }
        return found
    }

    private var active: [Item] {
        loaded().values.compactMap { $0.item.archivedAt == nil ? $0.item : nil }
    }

    /// Active children in the server's order. The top level also holds active items whose parent is archived.
    private func children(of parentId: String?) -> [String] {
        if let branches { return branches[parentId ?? ""] ?? [] }
        let records = loaded()
        var built: [String: [Record]] = [:]
        for record in records.values where record.item.archivedAt == nil {
            let parentArchived = record.parentId.flatMap { records[$0] }.map { $0.item.archivedAt != nil } ?? false
            built[parentArchived ? "" : record.parentId ?? "", default: []].append(record)
        }
        let sorted = built.mapValues { $0.sorted { ($0.position, $0.item.id) < ($1.position, $1.item.id) }.map(\.item.id) }
        branches = sorted
        return sorted[parentId ?? ""] ?? []
    }

    private func childCount(of id: String) -> Int {
        loaded().values.count { $0.parentId == id && $0.item.archivedAt == nil }
    }

    private func entry(_ id: String) -> OutlineEntry? {
        guard let record = loaded()[id] else { return nil }
        let count = record.item.archivedAt == nil ? children(of: id).count : childCount(of: id)
        return OutlineEntry(item: record.item, parentId: record.parentId, position: record.position, childCount: count)
    }

    private func detail(_ id: String) -> ItemDetail? {
        guard let record = loaded()[id] else { return nil }
        let extras = extrasFile(of: record).flatMap { try? JSONCoding.makeDecoder().decode(Extras.self, from: Data(contentsOf: $0)) }
        let related = relations.values.compactMap { relation -> RelatedItem? in
            let outgoing = relation.fromId == id
            guard outgoing || relation.toId == id, let other = loaded()[outgoing ? relation.toId : relation.fromId]?.item else { return nil }
            return RelatedItem(kind: relation.kind, direction: outgoing ? "outgoing" : "incoming", id: other.id, type: other.type, title: other.title)
        }
        return ItemDetail(item: record.item, content: extras?.content ?? "", attachments: extras?.attachments ?? [],
                          relations: related.sorted { ($0.direction, $0.kind, $0.title) < ($1.direction, $1.kind, $1.title) })
    }

    private func ancestors(of record: Record) -> [Record] {
        var path: [Record] = []
        var next = record.parentId
        while let id = next, let parent = loaded()[id], !path.contains(where: { $0.item.id == id }) {
            path.insert(parent, at: 0)
            next = parent.parentId
        }
        return path
    }

    /// Inline `[[item:…]]` references, as the server lists them.
    private func references(of record: Record) -> ReferenceList {
        let records = loaded()
        var seen: Set<String> = []
        let outgoing = InlineReference.matches(in: record.item.body).compactMap { match -> RelatedItem? in
            guard seen.insert(match.id).inserted, let target = records[match.id]?.item else { return nil }
            return RelatedItem(kind: "references", direction: "outgoing", id: target.id, type: target.type, title: target.title)
        }
        let token = "[[item:\(record.item.id)"
        let incoming = records.values
            .map(\.item)
            .filter { $0.id != record.item.id && $0.body.contains(token) && InlineReference.matches(in: $0.body).contains { $0.id == record.item.id } }
            .sorted { ($0.updatedAtStamp, $0.id) > ($1.updatedAtStamp, $1.id) }
            .map { RelatedItem(kind: "references", direction: "incoming", id: $0.id, type: $0.type, title: $0.title) }
        return ReferenceList(outgoing: outgoing, incoming: incoming)
    }

    private func projectID(_ ref: String?) -> String?? {
        guard let ref else { return .some(nil) }
        let match = state.projects.first { $0.id == ref || $0.slug == ref || $0.name.lowercased() == ref.lowercased() }
        return match.map { .some($0.id) }
    }

    private func items(matching query: [String: String]) -> [Item] {
        guard case .some(let project) = projectID(query["project"]) else { return [] }
        let tag = query["tag"]?.trimmingCharacters(in: .whitespaces).lowercased()
        let unopenedBefore = query["unopened"].flatMap(Double.init).map { now().addingTimeInterval(-$0 * 86_400) }
        let pool = query["archived"] == "true" ? loaded().values.map(\.item) : active
        var items = pool.filter { item in
            (project == nil || item.project?.id == project)
                && (query["type"].map { item.type.rawValue == $0 } ?? true)
                && (tag.map { item.tags.contains($0) } ?? true)
                && (query["inbox"] != "true" || item.project == nil)
                && (query["pinned"] != "true" || item.isPinned)
                && (query["reminders"] != "true" || item.remindAt != nil)
                && (query["intent"].map { item.intent?.rawValue == $0 } ?? true)
                && (query["review"].map { item.presentation.review == ($0 == "true") } ?? true)
                && (query["attention"].map { item.presentation.attention.rawValue == $0 } ?? true)
                && (unopenedBefore.map { item.type == .bookmark && item.openedAt == nil && item.createdAt <= $0 } ?? true)
        }
        if let before = query["before"] {
            let cursor = before.split(separator: ",", maxSplits: 1).map(String.init)
            if cursor.count == 2 { items = items.filter { ($0.updatedAtStamp, $0.id) < (cursor[0], cursor[1]) } }
        }
        return items.sorted { a, b in
            if query["reminders"] == "true", a.remindAt != b.remindAt { return (a.remindAt ?? .distantFuture) < (b.remindAt ?? .distantFuture) }
            if query["pinned"] == "true", a.pinnedAt != b.pinnedAt { return (a.pinnedAt ?? .distantPast) > (b.pinnedAt ?? .distantPast) }
            return (a.updatedAtStamp, a.id) > (b.updatedAtStamp, b.id)
        }
    }

    private func tasks(_ query: [String: String]) -> [Item] {
        guard case .some(let project) = projectID(query["project"]) else { return [] }
        let status = query["status"] ?? "active"
        let tag = query["tag"]?.lowercased()
        return active
            .filter { item in
                guard let task = item.task, project == nil || item.project?.id == project, tag.map({ item.tags.contains($0) }) ?? true else { return false }
                switch status {
                case "all": return true
                case "active": return task.status == .open || task.status == .inProgress
                default: return task.status.rawValue == status
                }
            }
            .sorted { a, b in
                let (x, y) = (a.task!, b.task!)
                if (x.dueAt == nil) != (y.dueAt == nil) { return x.dueAt != nil }
                if x.dueAt != y.dueAt { return (x.dueAt ?? "") < (y.dueAt ?? "") }
                if x.priority != y.priority { return x.priority.rawValue < y.priority.rawValue }
                return a.createdAt < b.createdAt
            }
    }

    /// Leaves below the item (or the item itself) that can be checked, as the server counts them.
    private func progress(of root: Record) -> ChecklistProgress {
        let records = loaded()
        var done = 0, total = 0
        var queue = [root.item.id]
        while let id = queue.popLast(), let item = records[id]?.item {
            guard item.type != .decision, item.archivedAt == nil else { continue }
            let below = children(of: id).filter { records[$0]?.item.type != .decision }
            if below.isEmpty {
                total += 1
                if item.isChecked { done += 1 }
            }
            queue += below
        }
        return ChecklistProgress(done: done, total: total)
    }

    // MARK: Search

    /// Every word must appear in the title, text, tags, project, address or site. Titles and tags rank first.
    func search(_ text: String, project: String?, type: String?, limit: Int) -> [SearchHit] {
        let terms = text.split(whereSeparator: { $0.isWhitespace || $0 == "\"" }).map(String.init)
        guard !terms.isEmpty, case .some(let projectID) = projectID(project) else { return [] }
        let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
        let scored: [(Item, Int)] = active.compactMap { item in
            guard !item.isSecret, projectID == nil || item.project?.id == projectID, type.map({ item.type.rawValue == $0 }) ?? true else { return nil }
            let others = [item.body, item.project?.name ?? "", item.url ?? "", item.metadata.siteName ?? "", item.metadata.excerpt ?? ""]
            var score = 0
            for term in terms {
                if item.title.range(of: term, options: options) != nil { score += 3 }
                else if item.tags.contains(where: { $0.range(of: term, options: options) != nil }) { score += 2 }
                else if others.contains(where: { $0.range(of: term, options: options) != nil }) { score += 1 }
                else { return nil }
            }
            return (item, score)
        }
        return scored
            .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : ($0.0.updatedAtStamp, $0.0.id) > ($1.0.updatedAtStamp, $1.0.id) }
            .prefix(limit)
            .map { item, _ in
                let body = Self.plain(item.body)
                let source = terms.contains { body.range(of: $0, options: options) != nil } ? body : Self.plain(item.title)
                return SearchHit(id: item.id, type: item.type, title: item.title, url: item.url, project: item.project,
                                 snippet: Self.snippet(source, terms: terms), match: .keyword, taskStatus: item.task?.status,
                                 updatedAt: item.updatedAt, preview: item.title.isEmpty ? String(body.prefix(120)) : nil)
            }
    }

    /// Inline references read as their labels, and stray brackets go, since snippets mark matches with `[` `]`.
    private static func plain(_ text: String) -> String {
        var result = text
        for match in InlineReference.matches(in: text).reversed() {
            result.replaceSubrange(match.range, with: match.label ?? "item")
        }
        return result.replacing(/[\[\]]/, with: "").replacing(/\s+/, with: " ")
    }

    private static func snippet(_ text: String, terms: [String]) -> String {
        let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
        let first = terms.compactMap { text.range(of: $0, options: options) }.min { $0.lowerBound < $1.lowerBound }
        let start = first.map { text.index($0.lowerBound, offsetBy: -60, limitedBy: text.startIndex) ?? text.startIndex } ?? text.startIndex
        let end = text.index(start, offsetBy: 160, limitedBy: text.endIndex) ?? text.endIndex
        let window = text[start..<end]
        var matches: [Range<String.Index>] = []
        for term in terms {
            var from = window.startIndex
            while let range = window.range(of: term, options: options, range: from..<window.endIndex), !range.isEmpty {
                matches.append(range)
                from = range.upperBound
            }
        }
        var marked = ""
        var cursor = window.startIndex
        for range in matches.sorted(by: { $0.lowerBound < $1.lowerBound }) where range.lowerBound >= cursor {
            marked += window[cursor..<range.lowerBound] + "[" + window[range] + "]"
            cursor = range.upperBound
        }
        marked += window[cursor...]
        return (start > text.startIndex ? "…" : "") + marked + (end < text.endIndex ? "…" : "")
    }

    // MARK: Storage

    /// The snapshot plus committed pages, in order.
    private func loaded() -> [String: Record] {
        guard stateReadable() else { return [:] }
        if let records { return records }
        let decoder = JSONCoding.makeDecoder()
        var loaded: [String: Record] = [:]
        relations = [:]
        var deltas: [Delta] = []
        if let snapshot = try? decoder.decode(Delta.self, from: Data(contentsOf: directory.appending(path: "snapshot.json"))) {
            deltas.append(snapshot)
        }
        let folder = directory.appending(path: "pages", directoryHint: .isDirectory)
        let pages = ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [])
            .compactMap { file in Int(file.deletingPathExtension().lastPathComponent).map { ($0, file) } }
            .filter { $0.0 <= state.cursor }
            .sorted { $0.0 < $1.0 }
        deltas += pages.compactMap { try? decoder.decode(Delta.self, from: Data(contentsOf: $0.1)) }
        for delta in deltas {
            for record in delta.records { loaded[record.item.id] = record }
            for id in delta.deleted { loaded[id] = nil }
            for relation in delta.relations { relations[relation.id] = relation }
            for id in delta.deletedRelations { relations[id] = nil }
        }
        records = loaded
        branches = nil
        return loaded
    }

    /// Pages and extras nothing refers to go only after the snapshot and its state are saved.
    private func compact() throws {
        let records = loaded()
        try write(Delta(records: Array(records.values), relations: Array(relations.values)), to: directory.appending(path: "snapshot.json"))
        try? FileManager.default.removeItem(at: directory.appending(path: "pages", directoryHint: .isDirectory))
        var next = state
        next.deltas = 0
        try commit(next)
        let kept = Set(records.values.compactMap { extrasFile(of: $0)?.lastPathComponent })
        let folder = directory.appending(path: "extras", directoryHint: .isDirectory)
        for file in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] where !kept.contains(file.lastPathComponent) {
            try? FileManager.default.removeItem(at: file)
        }
    }

    /// Leftovers of a page that failed before its state was saved, with the extras only it refers to.
    private func removeUncommittedPages() throws {
        let folder = directory.appending(path: "pages", directoryHint: .isDirectory)
        for file in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] {
            guard let number = Int(file.deletingPathExtension().lastPathComponent), number > state.cursor else { continue }
            let leftover = try? JSONCoding.makeDecoder().decode(Delta.self, from: Data(contentsOf: file))
            do {
                try FileManager.default.removeItem(at: file)
            } catch {
                throw OfflineLibraryError.storage(error.localizedDescription)
            }
            for case .file(let key)? in leftover?.records.map(\.extras) ?? [] { try? FileManager.default.removeItem(at: extrasFile(key)) }
        }
    }

    private func extrasFile(_ key: String) -> URL {
        directory.appending(path: "extras", directoryHint: .isDirectory).appending(path: key + ".json")
    }

    private func extrasFile(of record: Record) -> URL? {
        switch record.extras {
        case .file(let key): extrasFile(key)
        case .empty: nil
        case nil: extrasFile(Self.digest(record.item.id))
        }
    }

    /// On failure the state in memory stays what's on disk.
    private func commit(_ next: State) throws {
        try write(next, to: directory.appending(path: "state.json"))
        state = next
    }

    private func write(_ value: some Encodable, to file: URL) throws {
        guard !isDiscarded else { return }
        do {
            try prepare(file.deletingLastPathComponent())
            try JSONCoding.makeEncoder().encode(value).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            throw OfflineLibraryError.storage(error.localizedDescription)
        }
    }

    private func prepare(_ folder: URL) throws {
        guard !FileManager.default.fileExists(atPath: folder.path) else { return }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var folder = folder
        try folder.setResourceValues(values)
    }

    private func encoded(_ value: some Encodable, savedAt: Date) -> CachedResponse? {
        (try? JSONCoding.makeEncoder().encode(value)).map { CachedResponse(data: $0, savedAt: savedAt) }
    }

    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

public enum OfflineLibraryError: Error, Hashable, LocalizedError {
    case storage(String)

    public var errorDescription: String? {
        switch self {
        case .storage(let reason): "This phone couldn't save its offline copy (\(reason)). It keeps what it already saved and tries again later."
        }
    }
}

/// `GET /library`: current ordinary state for everything changed after `cursor`.
struct LibraryPage: Decodable, Sendable {
    struct Entry: Decodable, Sendable {
        let item: ItemDetail
        let parentId: String?
        let position: Double
    }

    let deviceId: String
    let cursor: Int
    let hasMore: Bool
    let reset: Bool
    let items: [Entry]
    let deletedItemIds: [String]
    let projects: [Project]
    let deletedProjectIds: [String]
    let relations: [OfflineLibrary.Relation]
    let deletedRelationIds: [String]
}

/// `GET /changes`: a notification that the library moved past `since`, not a data feed.
struct ChangeNotice: Decodable, Sendable {
    let revision: Int
    let deviceId: String
}

extension Endpoint {
    static func library(cursor: Int, limit: Int) -> Endpoint {
        get("/library", [("cursor", cursor > 0 ? String(cursor) : nil), ("limit", String(limit))])
    }
    static func changes(since revision: Int, wait: Int) -> Endpoint {
        get("/changes", [("since", String(revision)), ("wait", String(wait))])
    }
}
