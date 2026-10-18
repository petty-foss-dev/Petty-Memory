import Foundation
import Testing
@testable import EnveMemoryKit

func bodyObject(_ endpoint: Endpoint) throws -> [String: Any] {
    let data = try #require(endpoint.body)
    let value = try JSONSerialization.jsonObject(with: data)
    return try #require(value as? [String: Any])
}

@Suite struct KnowledgeTests {
    let client = APIClient(baseURL: URL(string: "http://h:1")!, token: "em_t")

    @Test func recipeRoutesSendOnlyAcceptedFields() throws {
        #expect(Endpoint.recipes.method == "GET" && Endpoint.recipes.path == "/knowledge/recipes")
        let branch = try Endpoint.saveRecipe(RecipeInput(name: "Follow-ups", instruction: "Suggest tasks.", scope: .branch("r1")))
        #expect(branch.method == "POST" && branch.path == "/knowledge/recipes" && branch.idempotencyKey != nil)
        #expect(try bodyString(branch) == #"{"instruction":"Suggest tasks.","name":"Follow-ups","scope":{"rootId":"r1"}}"#)
        let topic = try Endpoint.saveRecipe(RecipeInput(id: "x1", name: "Garden", instruction: "Brief.", scope: .topic("garden", project: "p1")))
        #expect(try bodyString(topic) == #"{"id":"x1","instruction":"Brief.","name":"Garden","scope":{"project":"p1","query":"garden"}}"#)

        let archive = Endpoint.archiveRecipe("x 1")
        #expect(archive.method == "DELETE" && archive.body == nil && archive.idempotencyKey != nil)
        #expect(client.urlRequest(for: archive).url?.path(percentEncoded: true) == "/api/v1/knowledge/recipes/x%201")
    }

    @Test func recipeRunsArePrivatePreviewsWithChosenPreferencesOnly() throws {
        let plain = try Endpoint.runRecipe("x1")
        #expect(plain.method == "POST" && plain.path == "/knowledge/recipes/x1/run" && plain.idempotencyKey == nil)
        #expect(try bodyString(plain) == "{}")
        #expect(try bodyString(.runRecipe("x1", preferences: ["p1", "p2"])) == #"{"preferences":["p1","p2"]}"#)
    }

    @Test func preferencesSendExplicitNullsSoEditsCanClear() throws {
        #expect(client.urlRequest(for: .preferences(project: "p 1")).url?.query(percentEncoded: true) == "project=p%201")
        #expect(client.urlRequest(for: .preferences()).url?.query() == nil)
        let derived = try Endpoint.savePreference(PreferenceInput(instruction: "File receipts under Finance"))
        #expect(try bodyString(derived) == #"{"instruction":"File receipts under Finance","name":null,"project":null}"#)
        let scoped = try Endpoint.savePreference(PreferenceInput(id: "q1", name: "Receipts", instruction: "File receipts", project: "p1"))
        #expect(try bodyString(scoped) == #"{"id":"q1","instruction":"File receipts","name":"Receipts","project":"p1"}"#)
        let preference = try JSONCoding.makeDecoder().decode(OrganizationPreference.self, from: Data(
            #"{"id":"q1","name":"Receipts","instruction":"File receipts","project":null,"createdAt":"2026-10-01T08:00:00.000Z","updatedAt":"2026-10-01T08:00:00.000Z"}"#.utf8))
        #expect(preference.isGlobal && preference.applies(inProject: "p9"))
    }

    @Test func collectionInputKeepsIdsAndOmitsWhatTheServerRejects() throws {
        let input = CollectionInput(id: "c1", name: "Reading", fields: [
            PropertyFieldInput(id: "f1", key: "status", name: "Status", type: .select, options: [.init(id: "o1", name: "To read"), .init(name: "Done")]),
            PropertyFieldInput(name: "Pages", type: .number, options: [.init(name: "ignored")]),
        ], scope: CollectionScope(type: .bookmark), layout: .table, filters: [CollectionFilter(field: "status", op: .empty, value: .string("x"))])
        let body = try bodyObject(.saveCollection(input))
        #expect(body["groupBy"] is NSNull)
        #expect((body["scope"] as? [String: Any])?.keys.sorted() == ["type"])
        let fields = try #require(body["fields"] as? [[String: Any]])
        #expect(fields[0]["id"] as? String == "f1")
        #expect((fields[0]["options"] as? [[String: Any]])?.map { $0["id"] as? String } == ["o1", nil])
        #expect(fields[1]["options"] == nil && fields[1]["id"] == nil)
        let filters = try #require(body["filters"] as? [[String: Any]])
        #expect(filters[0]["value"] == nil && filters[0]["op"] as? String == "empty")
    }

    @Test func rowsAndValuesRoutes() throws {
        let rows = client.urlRequest(for: .collectionRows("c1", group: .unset))
        #expect(rows.url?.path() == "/api/v1/knowledge/collections/c1/rows")
        #expect(rows.url?.query() == "limit=50&group=__unset")
        #expect(client.urlRequest(for: .collectionRows("c1", offset: 50, group: .option("o1"))).url?.query() == "offset=50&limit=50&group=o1")

        let clear = try Endpoint.setFieldValues(collection: "c1", item: "i1", values: ["status": nil])
        #expect(clear.method == "POST" && clear.path == "/knowledge/collections/c1/values" && clear.idempotencyKey != nil)
        #expect(try bodyString(clear) == #"{"itemId":"i1","values":{"status":null}}"#)
        #expect(try bodyString(.setFieldValues(collection: "c1", item: "i1", values: ["done": .bool(true)])) == #"{"itemId":"i1","values":{"done":true}}"#)
    }

    @Test func rowsPagesDecodeTypedValues() throws {
        let collection = #"{"id":"c1","name":"Reading","fields":[{"id":"f1","key":"status","name":"Status","type":"select","options":[{"id":"o1","name":"To read"}]},{"id":"f2","key":"pages","name":"Pages","type":"number"},{"id":"f3","key":"done","name":"Done","type":"checkbox"}],"scope":{"project":null,"query":null,"type":null},"layout":"kanban","groupBy":"f1","sort":[{"field":"updatedAt","direction":"desc"}],"filters":[{"field":"f2","op":"gt","value":10}],"createdAt":"2026-10-01T08:00:00.000Z","updatedAt":"2026-10-01T08:00:00.000Z"}"#
        let row = #"{"item":\#(itemJSON(id: "i1", type: "bookmark", extra: #""task":null"#)),"values":{"f1":"o1","f2":320,"f3":false}}"#
        let json = #"{"collection":\#(collection),"rows":[\#(row)],"offset":0,"limit":50,"total":1,"next":null,"matched":1200,"evaluated":1000,"capped":true,"groups":[{"option":"o1","name":"To read","count":1},{"option":null,"name":"No Status","count":0}]}"#
        let page = try JSONCoding.makeDecoder().decode(CollectionRowsPage.self, from: Data(json.utf8))
        #expect(page.capped && page.matched == 1200 && page.groups?.last?.option == nil)
        let first = try #require(page.rows.first)
        let status = try #require(page.collection.field("f1"))
        #expect(first.values["f1"]?.display(for: status) == "To read")
        #expect(first.values["f2"] == .number(320) && first.values["f3"] == .bool(false))
        #expect(page.collection.groupField?.id == "f1" && page.collection.filters.first?.value == .number(10))
        #expect(first.replacingValues([:]).values.isEmpty && first.replacingValues([:]).id == "i1")
    }

    @Test func organizeRequestsCarryOnlyChosenPreferences() throws {
        let organize = try Endpoint.chat(ChatRequest(mode: .organize, history: [], message: "Organize garden notes.", preferences: ["p1"]))
        #expect(try bodyString(organize).contains(#""preferences":["p1"]"#))
        let none = try Endpoint.chat(ChatRequest(mode: .organize, history: [], message: "Organize garden notes."))
        #expect(try !bodyString(none).contains("preferences"))
        let ask = try Endpoint.chat(ChatRequest(mode: .ask, history: [], message: "What?", preferences: ["p1"]))
        #expect(try !bodyString(ask).contains("preferences"))
    }

    @Test func knowledgeRequestsNeverEnterTheOutboxOrResponseCache() throws {
        for endpoint in [Endpoint.recipes, .collections, .preferences(), .researchSources(), .sources,
                         try .runRecipe("r1"), try .markChecked(FreshnessRef(id: "i1", stateHash: "h1"))] {
            #expect(endpoint.isOnlineOnly)
            #expect(!ResponseCache.isCacheable(endpoint))
        }
    }
}
