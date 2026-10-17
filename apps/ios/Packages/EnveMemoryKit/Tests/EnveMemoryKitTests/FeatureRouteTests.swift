import Foundation
import Testing
@testable import EnveMemoryKit

@Suite struct OutlineAndEditTests {
    let client = APIClient(baseURL: URL(string: "http://192.168.1.20:49231")!, token: "em_secret")

    @Test func outlinePageDecodesTaskStateParentsAndPresentation() throws {
        let task = itemJSON(id: "a1", type: "task", title: "Wire relay",
                            extra: #""task":{"status":"in_progress","priority":"high","dueAt":"2026-10-20","completedAt":null}"#)
        let done = itemJSON(id: "a2", type: "task", title: "Buy relay",
                            extra: #""task":{"status":"done","priority":"normal","dueAt":null,"completedAt":"2026-10-03T10:00:00.000Z"}"#)
        let heading = itemJSON(id: "a3", title: "Parts", metadata: #"{"presentation":{"kind":"heading","checked":true,"checklist":true}}"#)
        let json = #"{"items":[{"item":\#(task),"parentId":"p1","position":1.5,"childCount":0},{"item":\#(done),"parentId":"p1","position":2,"childCount":0},{"item":\#(heading),"parentId":null,"position":0.25,"childCount":3}],"total":7}"#

        let page = try JSONCoding.makeDecoder().decode(OutlinePage.self, from: Data(json.utf8))
        #expect(page.total == 7)
        #expect(page.items.map(\.id) == ["a1", "a2", "a3"])
        #expect(page.items[0].item.task?.status == .inProgress)
        #expect(page.items[0].item.isChecked == false)
        #expect(page.items[1].item.isChecked)
        #expect(page.items[0].parentId == "p1")
        #expect(page.items[2].parentId == nil && page.items[2].childCount == 3)
        let presentation = page.items[2].item.presentation
        #expect(presentation.kind == .heading && presentation.checklist && presentation.checked)
        #expect(presentation.attention == .normal && !presentation.review && !presentation.hideCompleted)
        #expect(page.items[2].item.isChecked)
    }

    @Test func outlineRoutesSendExplicitNullParents() throws {
        let topLevel = try Endpoint.moveOutlineItem("n 1", parentId: nil, beforeId: nil)
        #expect(topLevel.method == "PUT")
        #expect(client.urlRequest(for: topLevel).url?.path(percentEncoded: true) == "/api/v1/outline/n%201/parent")
        #expect(try bodyString(topLevel) == #"{"beforeId":null,"parentId":null}"#)
        #expect(topLevel.idempotencyKey != nil)

        let placed = try Endpoint.moveOutlineItem("n1", parentId: "p1", beforeId: "s2")
        #expect(try bodyString(placed) == #"{"beforeId":"s2","parentId":"p1"}"#)

        let id = UUIDv7.make()
        #expect(try bodyString(.createOutlineNote(OutlineNoteRequest(id: id, parentId: nil, title: "Idea"))) == #"{"id":"\#(id)","parentId":null,"title":"Idea"}"#)
        #expect(try bodyString(.createOutlineNote(OutlineNoteRequest(id: nil, parentId: "p1", body: "x"))) == #"{"body":"x","parentId":"p1"}"#)
        #expect(OutlineNoteRequest(parentId: nil).id?.wholeMatch(of: /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/) != nil)

        #expect(client.urlRequest(for: .outline(parent: nil)).url?.query() == "limit=50")
        #expect(client.urlRequest(for: .outline(parent: "p1", offset: 50)).url?.query() == "parent=p1&offset=50&limit=50")
        #expect(client.urlRequest(for: .ancestors("a3")).url?.path() == "/api/v1/outline/a3/ancestors")
    }

    @Test func updateItemSendsBasesOnlyForChangedFields() throws {
        let titleOnly = try Endpoint.updateItem("i1", ItemUpdate(title: "New", baseTitle: "Old", baseBody: "dropped"))
        #expect(titleOnly.method == "PATCH" && titleOnly.path == "/items/i1")
        #expect(try bodyString(titleOnly) == #"{"baseTitle":"Old","title":"New"}"#)

        let both = try Endpoint.updateItem("i1", ItemUpdate(title: "T", body: "B", baseTitle: "t", baseBody: ""))
        #expect(try bodyString(both) == #"{"baseBody":"","baseTitle":"t","body":"B","title":"T"}"#)
        #expect(titleOnly.idempotencyKey != nil && titleOnly.idempotencyKey != both.idempotencyKey)
    }

    @Test func staleQueuedEditStaysRecoverableAfterAConflict() async throws {
        let server = StubServer { _ in (409, Data(#"{"error":{"code":"conflict","message":"This item changed on another device."}}"#.utf8)) }
        let outbox = Outbox(directory: TestDirectory.make("outbox"))
        let update = ItemUpdate(body: "my offline draft", baseBody: "old text")
        let endpoint = try Endpoint.updateItem("i1", update)
        try await outbox.enqueue(endpoint, kind: .edit, title: "i1")

        let report = await outbox.flush(using: server.client())
        #expect(report == FlushReport(sent: 0, failed: 1, remaining: 1))
        let entry = try #require(await outbox.entries().first)
        #expect(entry.needsAttention)
        #expect(entry.recoverableDraft == update)
        #expect(entry.endpoint.body == endpoint.body)
        #expect(server.requests.first?.request.value(forHTTPHeaderField: "Idempotency-Key") == endpoint.idempotencyKey)
    }
}

@Suite struct ChecklistReferenceHistoryTests {
    let client = APIClient(baseURL: URL(string: "http://h:1")!, token: "em_t")

    @Test func presentationChecklistAndReferenceRoutes() throws {
        let patch = try Endpoint.updatePresentation("i1", ItemPresentation.Patch(kind: .heading, checked: true))
        #expect(patch.method == "PATCH" && patch.path == "/items/i1/presentation")
        #expect(try bodyString(patch) == #"{"checked":true,"kind":"heading"}"#)

        let check = try Endpoint.check("i1", false)
        #expect(check.method == "POST" && check.path == "/items/i1/check")
        #expect(try bodyString(check) == #"{"checked":false}"#)

        let reset = Endpoint.resetChecklist("i1")
        #expect(reset.method == "POST" && reset.path == "/items/i1/checklist/reset" && reset.idempotencyKey != nil)
        #expect(Endpoint.checklist("i1").path == "/items/i1/checklist" && Endpoint.checklist("i1").method == "GET")
        #expect(Endpoint.presentation("i1").method == "GET")

        #expect(try bodyString(.insertReference("i1", to: "i2", label: "Spec")) == #"{"label":"Spec","toId":"i2"}"#)
        #expect(try bodyString(.insertReference("i1", to: "i2", label: nil)) == #"{"toId":"i2"}"#)
        let relate = try Endpoint.relate("i1", to: "i2", kind: "depends_on")
        let unrelate = try Endpoint.unrelate("i1", from: "i2", kind: "depends_on")
        #expect(relate.method == "POST" && unrelate.method == "DELETE")
        #expect(relate.path == "/items/i1/relations" && unrelate.path == relate.path)
        #expect(try bodyString(unrelate) == #"{"kind":"depends_on","toId":"i2"}"#)
        #expect(!RelationKind.editable.contains("supersedes"))

        #expect(client.urlRequest(for: .items(ItemFilter(shelf: .review))).url?.query() == "review=true")
        #expect(client.urlRequest(for: .items(ItemFilter(shelf: .attention(.high)))).url?.query() == "attention=high")
    }

    @Test func decodesProgressReferencesAndForwardCompatiblePresentation() throws {
        let decoder = JSONCoding.makeDecoder()
        #expect(try decoder.decode(ChecklistProgress.self, from: Data(#"{"done":2,"total":5}"#.utf8)) == ChecklistProgress(done: 2, total: 5))
        #expect(try decoder.decode(ResetResult.self, from: Data(#"{"updated":4}"#.utf8)).updated == 4)

        let refs = try decoder.decode(ReferenceList.self, from: Data(#"{"outgoing":[{"kind":"references","direction":"out","id":"i2","type":"note","title":"Spec"}],"incoming":[]}"#.utf8))
        #expect(refs.outgoing.map(\.title) == ["Spec"] && refs.incoming.isEmpty)

        let newer = try decoder.decode(ItemPresentation.Patch.self, from: Data(#"{"kind":"kanban","attention":"urgent","review":true,"future":1}"#.utf8))
        let resolved = ItemPresentation(newer)
        #expect(resolved.kind == .text && resolved.attention == .normal && resolved.review)

        let id = "01920000-0000-7000-8000-00000000abcd"
        let token = InlineReference.token(id: id, label: "Spec|v2]")
        #expect(token == "[[item:\(id)|Spec v2]]")
        #expect(InlineReference.matches(in: "see \(token) and [[item:\(id)]]").map(\.label) == ["Spec v2", nil])
    }

    @Test func historyRoutesAndSnapshots() throws {
        #expect(client.urlRequest(for: .versions("i1")).url?.query() == "limit=30")
        #expect(client.urlRequest(for: .versions("i1", offset: 30, limit: 10)).url?.query() == "offset=30&limit=10")
        #expect(Endpoint.version("v 1").path == "/versions/v%201")
        let restore = Endpoint.restoreVersion("v1")
        #expect(restore.method == "POST" && restore.path == "/versions/v1/restore" && restore.idempotencyKey != nil)

        let decoder = JSONCoding.makeDecoder()
        let page = try decoder.decode(VersionPage.self, from: Data(#"{"items":[{"id":"v2","itemId":"i1","at":"2026-10-02T09:30:00.000Z","actor":"desktop","op":"update"},{"id":"v1","itemId":"i1","at":"2026-10-01T08:00:00Z","actor":"system","op":"baseline"}],"total":2}"#.utf8))
        #expect(page.items.map(\.isBaseline) == [false, true])

        let root = itemJSON(id: "i1", title: "Before", extra: #""content":"","attachments":[],"relations":[]"#)
        let child = itemJSON(id: "c1", title: "Child")
        let version = try decoder.decode(ItemVersion.self, from: Data(#"{"id":"v2","itemId":"i1","at":"2026-10-02T09:30:00.000Z","actor":"desktop","op":"update","snapshot":{"rootId":"i1","items":[{"item":\#(child),"parentId":"i1","position":1},{"item":\#(root),"parentId":null,"position":0}]}}"#.utf8))
        #expect(version.id == "v2" && version.summary.op == "update")
        #expect(version.snapshot.root?.item.item.title == "Before")
        #expect(version.snapshot.items.count == 2)

        let deletion = try decoder.decode(ItemVersion.self, from: Data(#"{"id":"v3","itemId":"i1","at":"2026-10-03T00:00:00Z","actor":"desktop","op":"delete","snapshot":{"rootId":"i1","items":[]}}"#.utf8))
        #expect(deletion.summary.isDeletion && deletion.snapshot.root == nil)
    }
}

@Suite struct EditProposalTests {
    static let proposalJSON = #"""
    {"rootId":"r1","baseHash":"sha256:9f2c","summary":"Tidy the plan","createdAt":"2026-10-05T12:00:00.123Z","operations":[
      {"op":"update","id":"i1","title":"Wire the relay","body":"New body","before":{"title":"wire relay","body":"old body","parentId":"r1"}},
      {"op":"create","parentId":"r1","beforeId":null,"title":"Test plan","body":""},
      {"op":"move","id":"i2","parentId":"i1","beforeId":"i3","before":{"title":"Fuse","body":"","parentId":"r1"}},
      {"op":"presentation","id":"i1","patch":{"kind":"section","attention":"high"},"before":{"kind":"text"}},
      {"op":"rename_everything","id":"i4","weight":0.5,"nested":{"keep":[true,null]}}
    ]}
    """#

    @Test func typedOperationsKeepTrustedBeforeState() throws {
        let proposal = try JSONCoding.makeDecoder().decode(EditProposal.self, from: Data(Self.proposalJSON.utf8))
        #expect(proposal.operations.map(\.kind) == [.update, .create, .move, .presentation, .unknown])
        #expect(proposal.operations[0].before?.title == "wire relay")
        #expect(proposal.operations[0].before?.body == "old body")
        #expect(proposal.operations[2].before?.parentId == "r1" && proposal.operations[2].beforeId == "i3")
        #expect(proposal.operations[3].patch == ItemPresentation.Patch(kind: .section, attention: .high))
        #expect(proposal.operations[3].presentationBefore?.kind == .text && proposal.operations[3].before == nil)
    }

    @Test func applyingASelectionSendsKeptOperationsVerbatim() async throws {
        let proposal = try JSONCoding.makeDecoder().decode(EditProposal.self, from: Data(Self.proposalJSON.utf8))
        let server = StubServer { _ in (200, Data(#"{"applied":2,"undo":{"v":1,"rootId":"r1","entries":[{"id":"i1","hash":"abc"}]}}"#.utf8)) }
        let endpoint = try Endpoint.applyEdit(proposal.keeping([0, 4]))
        #expect(endpoint.path == "/ai/apply" && endpoint.isOnlineOnly)
        let result = try await server.client().send(endpoint, as: ApplyResult.self)
        #expect(result.applied == 2)

        let sent = try JSONDecoder().decode([String: JSONValue].self, from: #require(server.requests.first?.body))
        let original = try JSONDecoder().decode([String: JSONValue].self, from: Data(Self.proposalJSON.utf8))
        guard case .object(var sentProposal) = sent["proposal"], case .array(let sentOps) = sentProposal.removeValue(forKey: "operations"),
              case .array(let originalOps) = original["operations"] else { Issue.record("unexpected apply body \(sent)"); return }
        #expect(sentOps == [originalOps[0], originalOps[4]])
        #expect(sentProposal == original.filter { $0.key != "operations" })

        let receipt = try #require(result.undo)
        let undo = try Endpoint.undoEdit(receipt)
        #expect(undo.method == "POST" && undo.path == "/ai/undo" && undo.isOnlineOnly && undo.idempotencyKey != nil)
        let undoBody = try JSONDecoder().decode([String: JSONValue].self, from: #require(undo.body))
        #expect(undoBody == ["receipt": receipt])
        #expect(try JSONDecoder().decode(ApplyResult.self, from: Data(#"{"applied":0}"#.utf8)).undo == nil)
        #expect(try Endpoint.proposeEdit(rootId: "r1", instruction: "tidy").isOnlineOnly)
    }
}

@Suite struct PublicShareTests {
    @Test func shareRoutesAndExpiry() throws {
        let at = try #require(JSONCoding.parseTimestamp("2026-11-01T00:00:00Z"))
        let create = try Endpoint.createShare(rootId: "r1", excludedIds: ["c2", "c3"], expiresAt: at)
        #expect(create.method == "POST" && create.path == "/shares" && create.isOnlineOnly)
        #expect(try bodyString(create) == #"{"excludedIds":["c2","c3"],"expiresAt":"2026-11-01T00:00:00.000Z","rootId":"r1"}"#)
        #expect(try bodyString(.createShare(rootId: "r1", excludedIds: [], expiresAt: nil)) == #"{"excludedIds":[],"rootId":"r1"}"#)
        #expect(Endpoint.shares.method == "GET" && Endpoint.shares.path == "/shares")
        let revoke = Endpoint.revokeShare("s 1")
        #expect(revoke.method == "POST" && revoke.path == "/shares/s%201/revoke" && revoke.idempotencyKey != nil)

        let shares = try JSONCoding.makeDecoder().decode([PublicShare].self, from: Data(#"""
        [{"id":"s1","rootId":"r1","createdAt":"2026-10-01T00:00:00Z","expiresAt":null,"revokedAt":null,"excludedIds":[]},
         {"id":"s2","rootId":"r1","createdAt":"2026-10-01T00:00:00Z","expiresAt":"2026-10-10T00:00:00Z","revokedAt":null,"excludedIds":["c2"]},
         {"id":"s3","rootId":"r1","createdAt":"2026-10-01T00:00:00Z","expiresAt":null,"revokedAt":"2026-10-02T00:00:00.000Z","excludedIds":[]}]
        """#.utf8))
        let now = try #require(JSONCoding.parseTimestamp("2026-10-05T00:00:00Z"))
        #expect(shares.map { $0.isActive(now: now) } == [true, true, false])
        #expect(shares[1].isActive(now: try #require(JSONCoding.parseTimestamp("2026-10-11T00:00:00Z"))) == false)
        #expect(shares[1].excludedIds == ["c2"])
    }

    @Test func publicLinkCarriesOnlyTheCapabilityToken() async throws {
        let server = StubServer { _ in
            (201, Data(#"{"share":{"id":"s1","rootId":"r1","createdAt":"2026-10-01T00:00:00Z","expiresAt":null,"revokedAt":null,"excludedIds":[]},"token":"pub_Ab-9/x+y"}"#.utf8))
        }
        let created = try await server.client(token: "em_private").send(.createShare(rootId: "r1", excludedIds: [], expiresAt: nil), as: CreatedShare.self)
        #expect(server.requests.first?.request.value(forHTTPHeaderField: "Authorization") == "Bearer em_private")

        let base = try #require(URL(string: "http://me:pw@192.168.1.20:49231/memory/?token=em_private#frag"))
        let link = created.link(on: base).absoluteString
        #expect(link == "http://192.168.1.20:49231/memory/s/pub_Ab-9%2Fx%2By")
        #expect(!link.contains("em_private") && !link.contains("api/v1") && !link.contains("pw"))
        #expect(created.link(on: server.baseURL).absoluteString == "http://\(server.host):49231/s/pub_Ab-9%2Fx%2By")
    }
}
