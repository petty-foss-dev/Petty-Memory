import Foundation
import Testing
@testable import EnveMemoryKit

@Suite struct WorkflowTests {
    let client = APIClient(baseURL: URL(string: "http://h:1")!, token: "em_t")
    static let rootID = "01930000-0000-7000-8000-0000000000a1"
    static let childID = "01930000-0000-7000-8000-0000000000a2"
    static let viewID = "01930000-0000-7000-8000-0000000000b1"
    static let project = "01a0d70c-2c99-7f67-9691-82c7ad19ebc8"

    static let viewMetadata = #"{"savedView":{"version":1,"query":"relay","filter":{"project":"\#(project)","taskStatus":"open","attention":"high"}}}"#
    static let templateMetadata = #"{"template":{"version":1,"rootId":"\#(rootID)"},"presentation":{"checklist":true}}"#

    @Test func viewRoutesMatchTheContract() throws {
        #expect(Endpoint.views.method == "GET" && Endpoint.views.path == "/views")
        #expect(client.urlRequest(for: .view("v 1")).url?.path(percentEncoded: true) == "/api/v1/views/v%201")
        #expect(client.urlRequest(for: .viewItems("v1")).url?.query() == nil)
        let page = client.urlRequest(for: .viewItems("v1", before: "2026-10-02T09:30:00.000Z,abc", limit: 50))
        #expect(page.url?.path() == "/api/v1/views/v1/items")
        #expect(page.url?.query(percentEncoded: true) == "before=2026-10-02T09%3A30%3A00.000Z%2Cabc&limit=50")

        let filter = SavedViewFilter(project: Self.project, type: .task, taskStatus: .inProgress, unopenedDays: 30, attention: .high)
        let create = try Endpoint.createView(SavedViewInput(name: "Open relay work", query: "relay", filter: filter))
        #expect(create.method == "POST" && create.path == "/views" && create.idempotencyKey != nil)
        #expect(try bodyString(create) == #"{"filter":{"attention":"high","project":"\#(Self.project)","taskStatus":"in_progress","type":"task","unopenedDays":30},"name":"Open relay work","query":"relay"}"#)

        let update = try Endpoint.updateView("v1", SavedViewInput(name: "Renamed", query: "", filter: SavedViewFilter()))
        #expect(update.method == "PATCH" && update.path == "/views/v1")
        #expect(try bodyString(update) == #"{"filter":{},"name":"Renamed","query":""}"#)
        #expect(update.idempotencyKey != create.idempotencyKey)

        let remove = Endpoint.removeView("v1")
        #expect(remove.method == "DELETE" && remove.path == "/views/v1" && remove.body == nil && remove.idempotencyKey != nil)
    }

    @Test func templateRoutesMatchTheContract() throws {
        #expect(Endpoint.templates.method == "GET" && Endpoint.templates.path == "/templates")
        let create = try Endpoint.createTemplate(sourceId: "n1", name: nil)
        #expect(create.method == "POST" && create.path == "/templates" && create.idempotencyKey != nil)
        #expect(try bodyString(create) == #"{"sourceId":"n1"}"#)
        #expect(try bodyString(.createTemplate(sourceId: "n1", name: "Weekly review")) == #"{"name":"Weekly review","sourceId":"n1"}"#)

        let use = try Endpoint.useTemplate("t 1", TemplateUseInput(title: "Review {{date}}", project: Self.project, date: "2026-10-17"))
        #expect(use.method == "POST" && client.urlRequest(for: use).url?.path(percentEncoded: true) == "/api/v1/templates/t%201/use")
        #expect(try bodyString(use) == #"{"date":"2026-10-17","project":"\#(Self.project)","title":"Review {{date}}"}"#)
        #expect(try bodyString(.useTemplate("t1", TemplateUseInput())) == "{}")
    }

    @Test func savedViewsAndPagesDecode() throws {
        let json = #"[{"id":"\#(Self.viewID)","name":"Open relay work","query":"relay","filter":{"project":"\#(Self.project)","inbox":false,"type":"task","tag":"hardware","taskStatus":"open","pinned":true,"intent":"read","unopenedDays":14,"reminders":true,"review":false,"attention":"low"},"createdAt":"2026-10-01T08:00:00.000Z","updatedAt":"2026-10-02T09:30:00.000Z"}]"#
        let views = try JSONCoding.makeDecoder().decode([SavedView].self, from: Data(json.utf8))
        let filter = try #require(views.first?.filter)
        #expect(views.first?.query == "relay")
        #expect(filter == SavedViewFilter(project: Self.project, inbox: false, type: .task, tag: "hardware", taskStatus: .open, pinned: true,
                                          intent: .read, unopenedDays: 14, reminders: true, review: false, attention: .low))

        let page = #"{"items":[\#(itemJSON(id: "a1", title: "Relay"))],"next":"2026-10-02T09:30:00.000Z,a1"}"#
        let decoded = try JSONCoding.makeDecoder().decode(ViewPage.self, from: Data(page.utf8))
        #expect(decoded.items.map(\.id) == ["a1"] && decoded.next == decoded.items.first?.pageCursor)
        #expect(try JSONCoding.makeDecoder().decode(ViewPage.self, from: Data(#"{"items":[],"next":null}"#.utf8)).next == nil)
    }

    @Test func templateUseAnswersWithTheNewOrdinaryRoot() async throws {
        let created = itemJSON(id: "c1", title: "Review 2026-10-17", extra: #""content":"","attachments":[],"relations":[]"#)
        let server = StubServer { _ in (201, Data(created.utf8)) }
        let detail = try await server.client().send(.useTemplate(Self.rootID, TemplateUseInput(date: "2026-10-17")), as: ItemDetail.self)
        #expect(detail.id == "c1" && !detail.item.isTemplateMember && !detail.item.isSavedView)
        let request = try #require(server.requests.first)
        #expect(request.request.httpMethod == "POST" && request.request.url?.path() == "/api/v1/templates/\(Self.rootID)/use")
        #expect(request.request.value(forHTTPHeaderField: "Idempotency-Key") != nil)
    }

    @Test func workflowMetadataSurvivesTheOfflineCopy() async throws {
        let root = libraryItem(Self.rootID, title: "Weekly review", metadata: Self.templateMetadata)
        let child = libraryItem(Self.childID, title: "Inbox zero", metadata: #"{"template":{"version":1,"rootId":"\#(Self.rootID)"}}"#)
        let view = libraryItem(Self.viewID, title: "Open relay work", metadata: Self.viewMetadata)
        let feed = FakeFeed()
        feed.put(Self.rootID, feedRow(root, parent: nil, position: 1))
        feed.put(Self.childID, feedRow(child, parent: Self.rootID, position: 1))
        feed.put(Self.viewID, feedRow(view, parent: nil, position: 2))
        let server = StubServer { try feed.respond($0) }
        let directory = TestDirectory.make("workflows-offline")
        let cache = ResponseCache(root: TestDirectory.make("workflows-cache"), baseURL: server.baseURL, token: "em_a")
        let library = OfflineLibrary(root: directory, baseURL: server.baseURL, token: "em_a")
        while try await library.refresh(using: server.client(), cache: cache).hasMore {}

        // A fresh instance reads only what reached disk.
        let reopened = OfflineLibrary(root: directory, baseURL: server.baseURL, token: "em_a")
        func detail(_ id: String) async throws -> Item {
            let answer = try #require(await reopened.answer(.item(id)))
            return try JSONCoding.makeDecoder().decode(ItemDetail.self, from: answer.data).item
        }
        let template = try await detail(Self.rootID)
        #expect(template.isTemplateRoot && template.metadata.template == TemplateMetadata(version: 1, rootId: Self.rootID))
        #expect(template.presentation.checklist)
        let member = try await detail(Self.childID)
        #expect(member.isTemplateMember && !member.isTemplateRoot)
        let definition = try await detail(Self.viewID)
        #expect(definition.isSavedView)
        #expect(definition.metadata.savedView?.filter == SavedViewFilter(project: Self.project, taskStatus: .open, attention: .high))

        let branch = try #require(await reopened.answer(.outline(parent: Self.rootID)))
        #expect(try JSONCoding.makeDecoder().decode(OutlinePage.self, from: branch.data).items.first?.item.metadata.template?.rootId == Self.rootID)

        // Results are never recomputed from the copy; only a saved server answer may stand in for them.
        #expect(await reopened.answer(.views) == nil)
        #expect(await reopened.answer(.viewItems(Self.viewID)) == nil)
        #expect(await reopened.answer(.templates) == nil)
    }

    @Test func savedAnswersAreKeptForOfflineReads() throws {
        let cache = ResponseCache(root: TestDirectory.make("workflows-answers"), baseURL: URL(string: "http://h:1")!, token: "em_a")
        let page = Data(#"{"items":[\#(itemJSON(id: "a1"))],"next":"x,a1"}"#.utf8)
        for endpoint in [Endpoint.views, .view("v1"), .viewItems("v1"), .templates] {
            #expect(ResponseCache.isCacheable(endpoint))
            cache.store(page, for: endpoint)
            let saved = try #require(cache.load(endpoint))
            #expect(try JSONCoding.makeDecoder().decode(ViewPage.self, from: saved.data).next == "x,a1")
        }
        #expect(cache.load(.viewItems("v1", before: "x,y")) == nil)
        #expect(!ResponseCache.isCacheable(.removeView("v1")))
        #expect(!ResponseCache.isCacheable(try .useTemplate("t1", TemplateUseInput())))
    }
}
