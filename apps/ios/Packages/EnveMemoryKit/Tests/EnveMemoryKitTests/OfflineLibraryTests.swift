import CryptoKit
import Foundation
import Testing
@testable import EnveMemoryKit

/// A library served the way `petty-memory serve` does through `GET /library` and `GET /changes`: a change log, and the
/// current ordinary state of whatever changed. Secret or deleted items have no state, so they arrive as deletions.
final class FakeFeed: @unchecked Sendable {
    private let lock = NSLock()
    private var log: [(seq: Int, entity: String, id: String)] = []
    private var revision = 0
    private var items: [String: String] = [:]
    private var projects: [String: String] = [:]
    private var relations: [String: String] = [:]
    private var deviceId = "device-1"
    private var unreachable = false
    private var status: Int?

    func put(_ id: String, _ entry: String) { record("item", id) { items[id] = entry } }
    func remove(_ id: String) { record("item", id) { items[id] = nil } }
    func putProject(_ id: String, _ json: String) { record("project", id) { projects[id] = json } }
    func putRelation(_ id: String, _ json: String) { record("relation", id) { relations[id] = json } }
    func setUnreachable(_ value: Bool) { lock.withLock { unreachable = value } }
    func setStatus(_ value: Int?) { lock.withLock { status = value } }
    func replaceDevice(_ id: String) { lock.withLock { deviceId = id } }

    /// A backup restore: the log rewinds to an earlier point, so a client's cursor runs past it.
    func restore(keeping count: Int) {
        lock.withLock {
            log = Array(log.prefix(count))
            revision = log.last?.seq ?? 0
        }
    }

    private func record(_ entity: String, _ id: String, _ change: () -> Void) {
        lock.withLock {
            change()
            revision += 1
            log.append((revision, entity, id))
        }
    }

    func respond(_ request: URLRequest) throws -> (Int, Data) {
        try lock.withLock {
            if unreachable { throw URLError(.cannotConnectToHost) }
            if let status { return (status, Data(#"{"error":{"code":"unauthorized","message":"Revoked."}}"#.utf8)) }
            let url = try #require(request.url)
            let query = Dictionary((URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") },
                                   uniquingKeysWith: { a, _ in a })
            switch url.path() {
            case "/api/v1/library":
                return (200, Data(page(cursor: Int(query["cursor"] ?? "0") ?? 0, limit: Int(query["limit"] ?? "200") ?? 200).utf8))
            case "/api/v1/changes":
                return (200, Data(#"{"revision":\#(revision),"deviceId":"\#(deviceId)"}"#.utf8))
            case let path where path.hasPrefix("/api/v1/projects/"):
                return (200, try Fixture.data("briefing"))
            default:
                return (404, Data(#"{"error":{"code":"not_found","message":"No route."}}"#.utf8))
            }
        }
    }

    private func page(cursor: Int, limit: Int) -> String {
        let reset = cursor > revision
        let consumed = log.filter { $0.seq > (reset ? 0 : cursor) }.prefix(limit)
        let end = consumed.last?.seq ?? revision
        var latest: [String: (entity: String, id: String)] = [:]
        var order: [String] = []
        for change in consumed {
            let key = "\(change.entity):\(change.id)"
            if latest.updateValue((change.entity, change.id), forKey: key) != nil { order.removeAll { $0 == key } }
            order.append(key)
        }
        var itemRows: [String] = [], deleted: [String] = [], projectRows: [String] = [], deletedProjects: [String] = []
        var relationRows: [String] = [], deletedRelations: [String] = []
        for key in order {
            let (entity, id) = latest[key]!
            switch entity {
            case "item": if let row = items[id] { itemRows.append(row) } else { deleted.append("\"\(id)\"") }
            case "project": if let row = projects[id] { projectRows.append(row) } else { deletedProjects.append("\"\(id)\"") }
            default: if let row = relations[id] { relationRows.append(row) } else { deletedRelations.append("\"\(id)\"") }
            }
        }
        return #"{"deviceId":"\#(deviceId)","cursor":\#(end),"hasMore":\#(end < revision),"reset":\#(reset),"items":[\#(itemRows.joined(separator: ","))],"deletedItemIds":[\#(deleted.joined(separator: ","))],"projects":[\#(projectRows.joined(separator: ","))],"deletedProjectIds":[\#(deletedProjects.joined(separator: ","))],"relations":[\#(relationRows.joined(separator: ","))],"deletedRelationIds":[\#(deletedRelations.joined(separator: ","))]}"#
    }
}

func libraryItem(_ id: String, title: String, body: String = "", type: String = "note", tags: [String] = [], project: String? = nil,
                 metadata: String = "{}", archived: Bool = false, extra: String = "") -> String {
    let projectJSON = project.map { #"{"id":"\#($0)","name":"Garage"}"# } ?? "null"
    let tagJSON = tags.map { "\"\($0)\"" }.joined(separator: ",")
    let archivedAt = archived ? #""2026-10-05T08:00:00.000Z""# : "null"
    let tail = extra.isEmpty ? "" : ",\(extra)"
    return #"{"id":"\#(id)","type":"\#(type)","title":"\#(title)","body":"\#(body)","url":null,"project":\#(projectJSON),"source":"app","metadata":\#(metadata),"createdAt":"2026-10-01T08:00:00.000Z","updatedAt":"2026-10-02T09:30:00.000Z","archivedAt":\#(archivedAt),"tags":[\#(tagJSON)]\#(tail)}"#
}

func outlineRow(_ item: String, parent: String?, position: Double = 1, children: Int = 0) -> String {
    #"{"item":\#(item),"parentId":\#(parent.map { "\"\($0)\"" } ?? "null"),"position":\#(position),"childCount":\#(children)}"#
}

/// A `LibraryPage` item: the full item page plus its placement.
func feedRow(_ item: String, parent: String?, position: Double, content: String = "") -> String {
    let detail = String(item.dropLast()) + #","content":"\#(content)","attachments":[],"relations":[]}"#
    return #"{"item":\#(detail),"parentId":\#(parent.map { "\"\($0)\"" } ?? "null"),"position":\#(position)}"#
}

func projectJSON(_ id: String, name: String, slug: String) -> String {
    #"{"id":"\#(id)","name":"\#(name)","slug":"\#(slug)","description":"","instructions":"","memory":"","status":"active","createdAt":"2026-10-01T08:00:00.000Z","updatedAt":"2026-10-01T08:00:00.000Z"}"#
}

@Suite struct OfflineLibraryTests {
    static let base = URL(string: "http://192.168.1.20:49231")!
    static let project = "01a0d70c-2c99-7f67-9691-82c7ad19ebc8"
    static let wiringID = "01920000-0000-7000-8000-00000000000c"
    let root = TestDirectory.make("offline")
    let cacheRoot = TestDirectory.make("cache")

    static let garage = libraryItem("A", title: "Garage door", body: "Uses the [[item:\(wiringID)|relay]] board", tags: ["hardware"], project: project)
    static let task = libraryItem("T", title: "Buy relay", type: "task", metadata: #"{"ai":{"status":"done","summary":"MODEL SUMMARY"}}"#,
                                  extra: #""task":{"status":"open","priority":"high","dueAt":"2026-10-20","completedAt":null}"#)
    static let wiring = libraryItem(wiringID, title: "Wiring", body: "Use 18 AWG wire")
    static let old = libraryItem("Z", title: "Old idea", archived: true)

    func library(token: String = "em_a") -> OfflineLibrary { OfflineLibrary(root: root, baseURL: Self.base, token: token) }
    func cache() -> ResponseCache { ResponseCache(root: cacheRoot, baseURL: Self.base, token: "em_a") }

    func standard() -> FakeFeed {
        let feed = FakeFeed()
        feed.putProject(Self.project, projectJSON(Self.project, name: "Garage", slug: "garage"))
        feed.put("A", feedRow(Self.garage, parent: nil, position: 1, content: "ARCHIVED PAGE TEXT"))
        feed.put("S", "unused")
        feed.remove("S")
        feed.put("T", feedRow(Self.task, parent: nil, position: 3))
        feed.put(Self.wiringID, feedRow(Self.wiring, parent: "A", position: 1))
        feed.put("Z", feedRow(Self.old, parent: nil, position: 2))
        feed.putRelation("r1", #"{"id":"r1","fromId":"A","toId":"T","kind":"depends_on"}"#)
        return feed
    }

    func complete(_ library: OfflineLibrary, _ server: StubServer, budget: Int = 20) async throws {
        while try await library.refresh(using: server.client(), cache: cache(), budget: budget).hasMore {}
    }

    func decode<T: Decodable>(_ type: T.Type, _ library: OfflineLibrary, _ endpoint: Endpoint) async throws -> T {
        let answer = try #require(await library.answer(endpoint))
        return try JSONCoding.makeDecoder().decode(T.self, from: answer.data)
    }

    func storedFiles() throws -> [String] {
        try FileManager.default.subpathsOfDirectory(atPath: root.path).compactMap {
            try? String(contentsOf: root.appending(path: $0), encoding: .utf8)
        }
    }

    @Test func feedCopyBrowsesUnopenedBranchesSearchesAndSurvivesRelaunch() async throws {
        let feed = standard()
        let server = StubServer { try feed.respond($0) }
        let library = library()
        try await complete(library, server)
        #expect(try await !library.waitForChange(using: server.client()))

        let paths = Set(server.requests.compactMap { $0.request.url?.path() })
        #expect(paths == ["/api/v1/library", "/api/v1/projects/\(Self.project)", "/api/v1/changes"])
        #expect(server.requests.allSatisfy { $0.request.httpMethod == "GET" })

        let top = try await decode(OutlinePage.self, library, .outline(parent: nil))
        #expect(top.items.map(\.id) == ["A", "T"] && top.total == 2)
        #expect(top.items[0].childCount == 1 && top.items[1].item.metadata.ai == nil && top.items[1].item.task?.status == .open)
        #expect(try await decode(OutlinePage.self, library, .outline(parent: "A")).items.map(\.id) == [Self.wiringID])
        #expect(try await decode(OutlineEntry.self, library, .outlineEntry(Self.wiringID)).parentId == "A")
        #expect(try await decode([Item].self, library, .ancestors(Self.wiringID)).map(\.id) == ["A"])
        let detail = try await decode(ItemDetail.self, library, .item("A"))
        #expect(detail.content == "ARCHIVED PAGE TEXT" && detail.tags == ["hardware"])
        #expect(detail.relations.map(\.id) == ["T"] && detail.relations[0].direction == "outgoing" && detail.relations[0].kind == "depends_on")
        let references = try await decode(ReferenceList.self, library, .references(Self.wiringID))
        #expect(references.incoming.map(\.id) == ["A"] && references.outgoing.isEmpty)
        #expect(try await decode(ChecklistProgress.self, library, .checklist("A")) == ChecklistProgress(done: 0, total: 1))
        #expect(try await decode([Item].self, library, .items(ItemFilter(tag: "hardware"))).map(\.id) == ["A"])
        #expect(try await !decode([Item].self, library, .items()).map(\.id).contains("Z"))
        #expect(try await decode([Item].self, library, .tasks()).map(\.id) == ["T"])
        #expect(try await decode([Project].self, library, .projects).map(\.slug) == ["garage"])
        #expect(cache().load(.briefing(Self.project)) != nil)

        let hits = try await decode([SearchHit].self, library, .search("relay"))
        #expect(hits.map(\.id) == ["T", "A"])
        #expect(hits[1].snippet.contains("[relay]") && !hits[1].snippet.contains("item:"))
        #expect(try await decode([SearchHit].self, library, .search("awg wire")).map(\.id) == [Self.wiringID])
        #expect(try await decode([SearchHit].self, library, .search("hardware garage")).map(\.id) == ["A"])
        #expect(try await decode([SearchHit].self, library, .search("relay", filter: ItemFilter(project: "garage"))).map(\.id) == ["A"])
        #expect(try await decode([SearchHit].self, library, .search("old idea")).isEmpty)

        let stored = try storedFiles().joined()
        #expect(stored.contains("Wiring") && stored.contains("ARCHIVED PAGE TEXT") && !stored.contains("MODEL SUMMARY"))

        let relaunched = self.library()
        let summary = await relaunched.summary()
        #expect(summary.items == 3 && summary.projects == 1 && summary.completedAt != nil && !summary.isBuilding)
        #expect(try await decode(OutlinePage.self, relaunched, .outline(parent: "A")).items.map(\.id) == [Self.wiringID])

        #expect(await self.library(token: "em_b").answer(.outline(parent: nil)) == nil)
        await relaunched.discard()
        #expect(await relaunched.answer(.outline(parent: nil)) == nil)
        #expect(await self.library().answer(.item("A")) == nil)
    }

    @Test func boundedPagesResumeFromTheirCursorAndStayReadableThroughFailures() async throws {
        let feed = FakeFeed()
        for index in 0..<450 { feed.put("n\(index)", feedRow(libraryItem("n\(index)", title: "Note \(index)"), parent: nil, position: Double(index))) }
        let server = StubServer { try feed.respond($0) }

        #expect(try await library().refresh(using: server.client(), cache: cache(), budget: 1) == .init(hasMore: true, changed: true))
        #expect(await library().summary().isBuilding)
        #expect(await library().answer(.outline(parent: nil)) == nil)
        #expect(try await decode(ItemDetail.self, library(), .item("n10")).item.title == "Note 10")

        feed.setUnreachable(true)
        await #expect(throws: APIError.self) { try await library().refresh(using: server.client(), cache: cache()) }
        feed.setUnreachable(false)
        #expect(await library().answer(.item("n10")) != nil)

        try await complete(library(), server)
        let queries = server.requests.compactMap { $0.request.url?.query() }
        #expect(queries.filter { $0.contains("cursor=200") }.count == 2)
        let tail = try await decode(OutlinePage.self, library(), .outline(parent: nil, offset: 400, limit: 100))
        #expect(tail.total == 450 && tail.items.count == 50 && tail.items.last?.id == "n449")
    }

    @Test func changesMoveDeleteAndEvictSecretsAfterALongPoll() async throws {
        let feed = standard()
        let server = StubServer { try feed.respond($0) }
        let library = library()
        try await complete(library, server)
        #expect(try await !library.waitForChange(using: server.client()))

        // Another device moved Wiring to the top level, deleted the task and made the garage note secret.
        feed.put(Self.wiringID, feedRow(Self.wiring, parent: nil, position: 4))
        feed.remove("T")
        feed.remove("A")
        #expect(try await library.waitForChange(using: server.client()))
        let before = server.requests.count
        try await complete(library, server)
        let pulled = server.requests.dropFirst(before).compactMap { $0.request.url?.path() }
        #expect(pulled.allSatisfy { $0 == "/api/v1/library" || $0.hasPrefix("/api/v1/projects/") })

        #expect(try await decode(OutlinePage.self, library, .outline(parent: nil)).items.map(\.id) == [Self.wiringID])
        #expect(await library.answer(.item("A")) == nil)
        #expect(await library.answer(.item("T")) == nil)
        #expect(try await decode([SearchHit].self, library, .search("relay")).isEmpty)
        #expect(try await decode(ReferenceList.self, library, .references(Self.wiringID)).incoming.isEmpty)
        #expect(try await decode(ItemDetail.self, library, .item(Self.wiringID)).relations.isEmpty)
        #expect(try !storedFiles().contains { $0.contains("ARCHIVED PAGE TEXT") })
    }

    @Test func aRestoredOrReplacedLibraryRebuildsTheCopy() async throws {
        let feed = standard()
        let server = StubServer { try feed.respond($0) }
        let library = library()
        try await complete(library, server)

        feed.restore(keeping: 4)
        #expect(try await library.waitForChange(using: server.client()))
        try await complete(library, server)
        #expect(try await decode(OutlinePage.self, library, .outline(parent: nil)).items.map(\.id) == ["A"])
        #expect(await library.answer(.item("T")) == nil)

        feed.replaceDevice("device-2")
        feed.put("N", feedRow(libraryItem("N", title: "New library"), parent: nil, position: 9))
        #expect(try await library.waitForChange(using: server.client()))
        try await complete(library, server)
        #expect(try await decode(OutlinePage.self, library, .outline(parent: nil)).items.map(\.id) == ["A", "N"])
    }

    @Test func revokedTokenThrowsAndLeavesTheCopyInPlace() async throws {
        let feed = standard()
        let server = StubServer { try feed.respond($0) }
        let library = library()
        try await complete(library, server)
        feed.setStatus(401)
        await #expect(throws: APIError.server(status: 401, code: .unauthorized, message: "Revoked.")) {
            _ = try await library.refresh(using: server.client(), cache: cache())
        }
        #expect(await library.answer(.outline(parent: "A")) != nil)
    }

    @Test func manySmallPullsCompactIntoOneSnapshot() async throws {
        let feed = standard()
        let server = StubServer { try feed.respond($0) }
        try await complete(library(), server)
        for index in 0..<40 {
            feed.put("m\(index)", feedRow(libraryItem("m\(index)", title: "More \(index)"), parent: "A", position: Double(index + 2)))
            try await complete(library(), server)
        }
        let pages = (try? FileManager.default.contentsOfDirectory(atPath: library().directory.appending(path: "pages").path)) ?? []
        #expect(pages.count < 32)
        #expect(FileManager.default.fileExists(atPath: library().directory.appending(path: "snapshot.json").path))
        #expect(try await decode(OutlinePage.self, library(), .outline(parent: "A", limit: 100)).total == 41)
    }

    @Test func aPageCountsOnlyOnceItIsOnDiskAndAFailedSaveRetriesTheSameCursor() async throws {
        let feed = FakeFeed()
        for index in 0..<300 { feed.put("n\(index)", feedRow(libraryItem("n\(index)", title: "Note \(index)"), parent: nil, position: Double(index))) }
        let server = StubServer { try feed.respond($0) }

        // A file where the copy's folder should be: nothing can be saved, and nothing counts as copied.
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let blocked = library().directory
        try Data("not a folder".utf8).write(to: blocked)
        await #expect(throws: OfflineLibraryError.self) { try await library().refresh(using: server.client(), cache: cache()) }
        let failed = library()
        #expect(await failed.summary().isBuilding)
        #expect(await failed.answer(.item("n1")) == nil)
        try FileManager.default.removeItem(at: blocked)

        // The first page saves; the second is written but its cursor can't be, so it doesn't count.
        let first = library()
        #expect(try await first.refresh(using: server.client(), cache: cache(), budget: 1).hasMore)
        let pages = library().directory.appending(path: "pages")
        #expect(try FileManager.default.contentsOfDirectory(atPath: pages.path) == ["200.json"])
        let saved = try blockState()
        await #expect(throws: OfflineLibraryError.self) { try await first.refresh(using: server.client(), cache: cache()) }
        #expect(try Set(FileManager.default.contentsOfDirectory(atPath: pages.path)) == ["200.json", "300.json"])
        #expect(await library().answer(.item("n1")) == nil)
        await #expect(throws: OfflineLibraryError.self) { try await library().refresh(using: server.client(), cache: cache()) }
        #expect(try Set(FileManager.default.contentsOfDirectory(atPath: pages.path)) == ["200.json", "300.json"])

        try restoreState(saved)
        let interrupted = library()
        #expect(await interrupted.summary().isBuilding)
        #expect(await interrupted.answer(.item("n250")) == nil)
        #expect(try await decode(ItemDetail.self, interrupted, .item("n10")).item.title == "Note 10")
        let before = server.requests.count
        try await complete(library(), server)
        #expect(server.requests.dropFirst(before).first?.request.url?.query()?.contains("cursor=200") == true)
        #expect(try await decode(OutlinePage.self, library(), .outline(parent: nil, offset: 250, limit: 100)).items.count == 50)
        #expect(try await decode(ItemDetail.self, library(), .item("n1")).item.title == "Note 1")
    }

    @Test func overlappingRefreshesRunOneAfterTheOther() async throws {
        let feed = standard()
        let server = StubServer { try feed.respond($0) }
        let library = library()
        async let first = library.refresh(using: server.client(), cache: cache())
        async let second = library.refresh(using: server.client(), cache: cache())
        let (a, b) = try await (first, second)
        #expect(!a.hasMore && !b.hasMore)
        #expect(a.changed != b.changed)
        let pulls = server.requests.filter { $0.request.url?.path() == "/api/v1/library" }.compactMap { $0.request.url?.query() }
        #expect(pulls.count == 2 && pulls[0] != pulls[1])
        #expect(try await library.refresh(using: server.client(), cache: cache()) == .init(hasMore: false, changed: false))
    }

    static let garageV2 = libraryItem("A", title: "Garage door v2", body: "Rewired", project: project)

    /// Puts a folder where state.json goes, so a page is written but its cursor can't be saved.
    func blockState() throws -> Data {
        let state = library().directory.appending(path: "state.json")
        let saved = try Data(contentsOf: state)
        try FileManager.default.removeItem(at: state)
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: false)
        return saved
    }

    func restoreState(_ saved: Data) throws {
        let state = library().directory.appending(path: "state.json")
        try FileManager.default.removeItem(at: state)
        try saved.write(to: state)
    }

    @Test func aPageWhoseCursorWasNeverSavedStaysInvisibleAcrossReopenAndRetry() async throws {
        let feed = standard()
        let server = StubServer { try feed.respond($0) }
        let library = library()
        try await complete(library, server)

        feed.put("A", feedRow(Self.garageV2, parent: nil, position: 1, content: "NEW ARCHIVED TEXT"))
        let saved = try blockState()
        await #expect(throws: OfflineLibraryError.self) { try await library.refresh(using: server.client(), cache: cache()) }
        let failedQuery = try #require(server.requests.last { $0.request.url?.path() == "/api/v1/library" }?.request.url?.query())

        // The open copy keeps the old row and the old archived text together.
        let unchanged = try await decode(ItemDetail.self, library, .item("A"))
        #expect(unchanged.item.title == "Garage door" && unchanged.content == "ARCHIVED PAGE TEXT")

        // Reopened with no readable state: nothing counts, not even the page written before the failure.
        #expect(await self.library().answer(.item("A")) == nil)
        #expect(await self.library().summary().isBuilding)

        // The saved state comes back: the earlier complete copy, without the uncommitted page.
        try restoreState(saved)
        let reopened = self.library()
        let before = try await decode(ItemDetail.self, reopened, .item("A"))
        #expect(before.item.title == "Garage door" && before.content == "ARCHIVED PAGE TEXT")
        #expect(try await decode(OutlinePage.self, reopened, .outline(parent: nil)).items.map(\.id) == ["A", "T"])

        let retried = server.requests.count
        try await complete(reopened, server)
        #expect(server.requests.dropFirst(retried).first?.request.url?.query() == failedQuery)
        let after = try await decode(ItemDetail.self, self.library(), .item("A"))
        #expect(after.item.title == "Garage door v2" && after.content == "NEW ARCHIVED TEXT")
        #expect(try !storedFiles().contains { $0.contains("ARCHIVED PAGE TEXT") })
    }

    @Test func aRetryThatEndsFurtherOnDropsTheFailedPageAndItsText() async throws {
        let feed = standard()
        let server = StubServer { try feed.respond($0) }
        let open = library()
        try await complete(open, server)
        let pages = library().directory.appending(path: "pages")
        let committed = Set(try FileManager.default.contentsOfDirectory(atPath: pages.path))

        feed.put("A", feedRow(Self.garageV2, parent: nil, position: 1, content: "NEW ARCHIVED TEXT"))
        let saved = try blockState()
        await #expect(throws: OfflineLibraryError.self) { try await open.refresh(using: server.client(), cache: cache()) }
        let failed = Set(try FileManager.default.contentsOfDirectory(atPath: pages.path)).subtracting(committed)
        #expect(failed.count == 1)
        #expect(try storedFiles().contains { $0.contains("NEW ARCHIVED TEXT") })
        try restoreState(saved)

        // More changed meanwhile, so the retried page ends at a later cursor than the failed one.
        feed.remove("A")
        try await complete(library(), server)
        #expect(Set(try FileManager.default.contentsOfDirectory(atPath: pages.path)).isDisjoint(with: failed))
        #expect(await library().answer(.item("A")) == nil)
        #expect(try !storedFiles().contains { $0.contains("NEW ARCHIVED TEXT") || $0.contains("ARCHIVED PAGE TEXT") })
        #expect(try await decode(OutlinePage.self, library(), .outline(parent: nil)).items.map(\.id) == ["T"])
    }

    @Test func compactionKeepsOnlyTheArchivedTextCurrentRecordsUse() async throws {
        let feed = standard()
        let server = StubServer { try feed.respond($0) }
        try await complete(library(), server)
        for version in 0..<35 {
            feed.put("A", feedRow(Self.garage, parent: nil, position: 1, content: "VERSION \(version) TEXT"))
            try await complete(library(), server)
        }
        let extras = try FileManager.default.contentsOfDirectory(atPath: library().directory.appending(path: "extras").path)
        #expect(extras.count == 1)
        #expect(try await decode(ItemDetail.self, library(), .item("A")).content == "VERSION 34 TEXT")
        #expect(try !storedFiles().contains { $0.contains("VERSION 33 TEXT") })
    }

    @Test func recordsSavedBeforeVersionedExtrasStillOpenTheirText() async throws {
        let feed = standard()
        let server = StubServer { try feed.respond($0) }
        try await complete(library(), server)
        let folder = library().directory
        // Rewrite the copy the way the previous version stored it: no extras key, text filed under the item id.
        let extras = folder.appending(path: "extras")
        for name in try FileManager.default.contentsOfDirectory(atPath: extras.path) {
            let legacy = SHA256.hash(data: Data("A".utf8)).map { String(format: "%02x", $0) }.joined() + ".json"
            try FileManager.default.moveItem(at: extras.appending(path: name), to: extras.appending(path: legacy))
        }
        for name in try FileManager.default.contentsOfDirectory(atPath: folder.appending(path: "pages").path) {
            let page = folder.appending(path: "pages").appending(path: name)
            var delta = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: page)) as? [String: Any])
            delta["records"] = (delta["records"] as? [[String: Any]])?.map { $0.filter { $0.key != "extras" } }
            try JSONSerialization.data(withJSONObject: delta).write(to: page)
        }
        #expect(try await decode(ItemDetail.self, library(), .item("A")).content == "ARCHIVED PAGE TEXT")
    }
}
