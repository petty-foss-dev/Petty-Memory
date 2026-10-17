import Foundation
import Testing
@testable import EnveMemoryKit

private func pending(_ endpoints: [Endpoint]) async throws -> PendingEdits {
    let clock = TestClock()
    let outbox = Outbox(directory: TestDirectory.make("outbox"), now: { clock.advance(1); return clock.now })
    for endpoint in endpoints { try await outbox.enqueue(endpoint, kind: .edit, title: endpoint.path) }
    return PendingEdits(await outbox.entries())
}

private func row(_ id: String, parent: String? = nil, children: Int = 0) throws -> OutlineEntry {
    try JSONCoding.makeDecoder().decode(OutlineEntry.self, from: Data(outlineRow(libraryItem(id, title: id.uppercased()), parent: parent, children: children).utf8))
}

@Suite struct PendingPlacementTests {
    @Test func queuedPlacementsReplayInOrderAndCreatedNotesAreActionable() async throws {
        let (a, b, c) = (try row("a"), try row("b"), try row("c"))
        let new = UUIDv7.make(), child = UUIDv7.make()
        let edits = try await pending([
            .editorAction([.create(id: new, parentId: nil, beforeId: "b", title: "New")]),
            .editorAction([.move(id: "c", parentId: nil, beforeId: "a")]),
            .moveOutlineItem("a", parentId: "b", beforeId: nil),
            .editorAction([.create(id: child, parentId: new, title: "Child")]),
            .editorAction([.update(id: child, body: "Filled in before sending", baseBody: "")]),
        ])

        let top = edits.arrange([a, b, c], total: 3, under: nil)
        #expect(top.items.map(\.id) == ["c", new, "b"] && top.total == 3)
        #expect(top.items.first { $0.id == "b" }?.childCount == 1)
        #expect(top.items.first { $0.id == new }?.childCount == 1)

        let insideB = edits.arrange([], total: 0, under: "b", known: ["a": a])
        #expect(insideB.items.map(\.id) == ["a"] && insideB.items[0].parentId == "b" && insideB.total == 1)
        #expect(edits.arrange([], total: 0, under: new).items.map(\.id) == [child])

        let created = try #require(edits.createdEntry(new))
        #expect(created.item.title == "New" && created.item.type == .note && edits.created[new]?.follows == nil)
        #expect(edits.createdEntry(child)?.parentId == new && edits.bodies[child] == "Filled in before sending")
        #expect(edits.isPending(new) && edits.isPending("c") && !edits.isPending("b"))
        #expect(edits.placedIDs == ["a", "b", "c", new, child])
    }

    @Test func partlyLoadedBranchesCountRowsQueuedPastTheLoadedPage() async throws {
        let (a, b) = (try row("a"), try row("b"))
        let x = try row("x", parent: "other"), y = try row("y")
        let new = UUIDv7.make()
        let edits = try await pending([
            .editorAction([.create(id: new, parentId: nil)]),
            .editorAction([.move(id: "x", parentId: nil, beforeId: "b")]),
            .editorAction([.move(id: "y", parentId: "other", beforeId: nil)]),
            .editorAction([.move(id: "a", parentId: "other", beforeId: nil)]),
        ])
        let page = edits.arrange([a, b], total: 5, under: nil, known: ["x": x, "y": y])
        #expect(page.items.map(\.id) == ["x", "b"])
        // 5 on the server, +1 new note held for the end, +1 x, −1 y (not loaded yet), −1 a.
        #expect(page.total == 5)
        #expect(edits.arrange([a, b], total: 2, under: nil, known: ["x": x, "y": y]).items.map(\.id) == ["x", "b", new])
    }

    @Test func checksReachEverythingBelowInQueueOrder() async throws {
        let edits = try await pending([
            .editorAction([.check(id: "p", checked: true)]),
            try .check("c", false),
            .completeTask("t"),
        ])
        #expect(edits.checked("t") == true && edits.isPending("t"))
        #expect(edits.checked("c", path: ["p"]) == false)
        #expect(edits.checked("d", path: ["c", "p"]) == false)
        #expect(edits.checked("e", path: ["p"]) == true)
        #expect(edits.checked("z", path: ["q"]) == nil)
    }

    @Test func splitsAndMergesShowBeforeTheyreSentAndTheNewHalfCanBeUsed() async throws {
        let text = "Fix 👍 relay"
        let half = UUIDv7.make()
        let split = EditorCommand.split("a", field: .body, text: text, at: try #require(text.firstIndex(of: "r")), newId: half)
        #expect(split == .split(id: "a", field: .body, offset: 7, baseText: text, newId: half))
        let edits = try await pending([
            .editorAction([split]),
            .editorAction([.merge(id: "c", previousId: "b")]),
            .editorAction([.update(id: half, title: "Relay", baseTitle: "")]),
            .editorAction([.create(id: UUIDv7.make(), parentId: half, title: "Inside the new half")]),
        ])
        #expect(edits.bodies["a"] == "Fix 👍" && edits.created[half]?.body == "relay" && edits.created[half]?.follows == "a")
        #expect(edits.titles[half] == "Relay")

        let page = edits.arrange([try row("a", parent: "p"), try row("b", parent: "p", children: 2), try row("c", parent: "p", children: 1)],
                                 total: 3, under: "p")
        #expect(page.items.map(\.id) == ["a", half, "b"] && page.total == 3)
        #expect(page.items[1].parentId == "p" && page.items[1].childCount == 1)
        #expect(page.items[2].childCount == 3)
        #expect(edits.createdEntry(half) { original in original == "a" ? .some("p") : nil }?.parentId == "p")
    }

    @Test func undoingAQueuedActionCancelsItAndRedoRestoresIt() async throws {
        let rows = [try row("a"), try row("b"), try row("c")]
        let action = UUIDv7.make()
        let move = try Endpoint.editorAction([.move(id: "c", parentId: nil, beforeId: "a")], id: action)
        let undone = try await pending([move, .undoEditorAction(action)])
        #expect(undone.arrange(rows, total: 3, under: nil).items.map(\.id) == ["a", "b", "c"])
        #expect(!undone.isPending("c"))

        let redone = try await pending([move, .undoEditorAction(action), .redoEditorAction(action)])
        #expect(redone.arrange(rows, total: 3, under: nil).items.map(\.id) == ["c", "a", "b"])

        let sentEarlier = try await pending([.undoEditorAction("sent-earlier")])
        #expect(sentEarlier.touched.isEmpty && sentEarlier.arrange(rows, total: 3, under: nil).items.map(\.id) == ["a", "b", "c"])
    }
}

@Suite struct EditorActionRouteTests {
    @Test func actionsCarryClientIdsAndTheContractShapes() throws {
        let id = "01920000-0000-7000-8000-0000000000a1"
        let text = "a👍b"
        let commands: [EditorCommand] = [
            .create(id: "n1", parentId: nil, title: "T"),
            .move(id: "m", parentId: "p", beforeId: nil),
            .check(id: "c", checked: true),
            .presentation(id: "p", patch: .init(kind: .heading)),
            .merge(id: "b", previousId: "a"),
            .split("a", field: .title, text: text, at: text.index(before: text.endIndex), newId: "n2"),
            .update(id: "u", title: "New", baseTitle: "Old"),
        ]
        let endpoint = try Endpoint.editorAction(commands, id: id)
        #expect(endpoint.method == "POST" && endpoint.path == "/editor/actions" && endpoint.idempotencyKey != nil)
        #expect(try bodyString(endpoint) == #"{"commands":[{"id":"n1","op":"create","parentId":null,"title":"T"},{"beforeId":null,"id":"m","op":"move","parentId":"p"},{"checked":true,"id":"c","op":"check"},{"id":"p","op":"presentation","patch":{"kind":"heading"}},{"id":"b","op":"merge","previousId":"a"},{"baseText":"a👍b","field":"title","id":"a","newId":"n2","offset":3,"op":"split"},{"baseTitle":"Old","id":"u","op":"update","title":"New"}],"id":"\#(id)"}"#)
        #expect(endpoint.editorAction == EditorActionRequest(commands: commands, id: id))
        #expect(!endpoint.isOnlineOnly)

        let undo = Endpoint.undoEditorAction("a/b"), redo = Endpoint.redoEditorAction(id)
        #expect(undo.method == "POST" && undo.path == "/editor/actions/a%2Fb/undo" && undo.body == nil)
        #expect(redo.path == "/editor/actions/\(id)/redo")
        #expect(undo.idempotencyKey != nil && undo.idempotencyKey != Endpoint.undoEditorAction("a/b").idempotencyKey)
        #expect(try Endpoint.editorAction(commands).editorAction?.id.wholeMatch(of: /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/) != nil)

        let result = try JSONCoding.makeDecoder().decode(EditorActionResult.self, from: Data(#"{"actionId":"\#(id)","focusId":null,"createdIds":["n1"],"label":"Split note"}"#.utf8))
        #expect(result.actionId == id && result.focusId == nil && result.createdIds == ["n1"])
    }

    @Test func updatesSendOnlyChangedFieldsWithTheirBases() {
        #expect(EditorCommand.update("i", title: "T", body: "B", baseTitle: "T", baseBody: "B") == nil)
        #expect(EditorCommand.update("i", title: "T", body: "B2", baseTitle: "T", baseBody: "B")
            == .update(id: "i", body: "B2", baseBody: "B"))
    }

    @Test func refusedActionsKeepTheirTextAsADraft() async throws {
        let server = StubServer { _ in (409, Data(#"{"error":{"code":"conflict","message":"It changed on another device."}}"#.utf8)) }
        let outbox = Outbox(directory: TestDirectory.make("outbox"))
        try await outbox.enqueue(.editorAction([.update(id: "i", body: "my offline draft", baseBody: "old")]), kind: .edit, title: "edit")
        try await outbox.enqueue(.editorAction([.create(id: UUIDv7.make(), parentId: "gone", title: "Idea")]), kind: .edit, title: "add")
        try await outbox.enqueue(.editorAction([.move(id: "m", parentId: nil, beforeId: nil)]), kind: .edit, title: "move")
        let report = await outbox.flush(using: server.client())
        #expect(report.failed == 3)
        let entries = await outbox.entries()
        #expect(entries.map(\.title) == ["edit", "add", "move"])
        #expect(entries.map(\.recoverableDraft) == [ItemUpdate(body: "my offline draft", baseBody: "old"), ItemUpdate(title: "Idea"), nil])
        #expect(PendingEdits(await outbox.entries()).touched.isEmpty)
    }
}

@Suite struct OrderedOutboxTests {
    @Test func rewrittenEntriesKeepTheirMillisecond() throws {
        for millisecond in [1_792_265_311_059.0, 1_792_265_311_060, 1_790_000_000_001] {
            let date = Date(timeIntervalSince1970: (millisecond + 0.25) / 1000)
            let once = JSONCoding.formatTimestamp(date)
            let parsed = try #require(JSONCoding.parseTimestamp(once))
            #expect(JSONCoding.formatTimestamp(parsed) == once)
            #expect((parsed.timeIntervalSince1970 * 1000).rounded() == millisecond)
        }
        let late = Date(timeIntervalSince1970: 1_792_265_311.0599)
        #expect(JSONCoding.formatTimestamp(late).hasSuffix(".059Z"))
    }

    @Test func aRetryableFailureHoldsEverythingQueuedBehindIt() async throws {
        let clock = TestClock()
        let server = StubServer { _ in (503, Data(#"{"error":{"code":"internal","message":"Busy."}}"#.utf8)) }
        let outbox = Outbox(directory: TestDirectory.make("outbox"), now: { clock.now })
        let action = UUIDv7.make()
        try await outbox.enqueue(.editorAction([.create(id: UUIDv7.make(), parentId: nil, title: "n")], id: action), kind: .edit, title: "add")
        clock.advance(1)
        try await outbox.enqueue(.undoEditorAction(action), kind: .edit, title: "undo")

        #expect(await outbox.flush(using: server.client()) == FlushReport(sent: 0, failed: 0, remaining: 2))
        _ = await outbox.flush(using: server.client())
        #expect(server.requests.count == 1)

        server.setResponse { _ in (200, Data("{}".utf8)) }
        clock.advance(31)
        #expect(await outbox.flush(using: server.client()).sent == 2)
        #expect(server.requests.map { $0.request.url?.path() } == ["/api/v1/editor/actions", "/api/v1/editor/actions", "/api/v1/editor/actions/\(action)/undo"])
    }

    @Test func withdrawTakesBackOnlyWhatIsStillWaiting() async throws {
        let outbox = Outbox(directory: TestDirectory.make("outbox"))
        let entry = try await outbox.enqueue(.editorAction([.check(id: "c", checked: true)]), kind: .edit, title: "check")
        #expect(await outbox.withdraw(entry.id))
        #expect(await outbox.entries().isEmpty)
        #expect(await !outbox.withdraw(entry.id))
    }
}

@Suite struct RecoveryAndGroupingTests {
    @Test func restoresNameTheFilesThatDidntComeBack() throws {
        let decoder = JSONCoding.makeDecoder()
        let file = { (name: String) in #"{"itemId":"i1","attachmentId":"a-\#(name)","sha256":"00","filename":"\#(name)"}"# }
        let partial = try decoder.decode(RestoreResult.self, from: Data(#"{"restored":3,"missingFiles":[\#(["a.pdf", "b.png", "c.txt", "d.md"].map(file).joined(separator: ","))]}"#.utf8))
        #expect(partial.missingFiles?.map(\.filename) == ["a.pdf", "b.png", "c.txt", "d.md"])
        #expect(partial.summary("Restored") == "Restored, but 4 files aren't on your computer any more: a.pdf, b.png, c.txt and 1 more.")
        let one = try decoder.decode(RestoreResult.self, from: Data(#"{"restored":1,"missingFiles":[\#(file("scan.pdf"))]}"#.utf8))
        #expect(one.summary("AI changes undone") == "AI changes undone, but 1 file isn't on your computer any more: scan.pdf.")
        #expect(try decoder.decode(RestoreResult.self, from: Data(#"{"restored":2}"#.utf8)).summary("Restored") == "Restored")
    }

    @Test func aQueuedRestoreReportsMissingFilesOnceItIsSent() async throws {
        let server = StubServer { request in
            request.url?.path() == "/api/v1/versions/v1/restore"
                ? (200, Data(#"{"restored":2,"missingFiles":[{"itemId":"i1","attachmentId":"a1","sha256":"00","filename":"scan.pdf"}]}"#.utf8))
                : (200, Data(#"{"restored":1}"#.utf8))
        }
        let outbox = Outbox(directory: TestDirectory.make("outbox"))
        try await outbox.enqueue(.restoreVersion("v1"), kind: .edit, title: "Restore a version")
        try await outbox.enqueue(.restoreVersion("v2"), kind: .edit, title: "Restore another")
        #expect(await outbox.flush(using: server.client()).sent == 2)
        #expect(await outbox.entries().isEmpty)
        let notices = await outbox.notices()
        #expect(notices.map(\.message) == ["Restore a version: restored, but 1 file isn't on your computer any more: scan.pdf."])
        #expect(await Outbox(directory: outbox.directory).notices() == notices)
        await outbox.dismissNotice(try #require(notices.first).id)
        #expect(await outbox.notices().isEmpty)
        #expect(Endpoint.restoreSecretVersion("v1").path == "/vault/versions/v1/restore" && Endpoint.restoreSecretVersion("v1").isOnlineOnly)
    }

    @Test func groupingProposalsKeepTemporaryIdsAndTheirTitles() throws {
        let json = #"{"rootId":"r","baseHash":"h","summary":"Group","createdAt":"2026-10-17T10:00:00.000Z","titles":{"new:1":"Parts"},"operations":[{"op":"create","tempId":"new:1","parentId":"r","beforeId":null,"title":"Parts","body":"","before":null},{"op":"move","id":"m","parentId":"new:1","beforeId":null,"before":{"title":"Relay","body":"","parentId":"r"}},{"op":"update","id":"u","title":"x","before":{"title":"y","body":"","parentId":"r"}}]}"#
        let proposal = try JSONCoding.makeDecoder().decode(EditProposal.self, from: Data(json.utf8))
        #expect(proposal.titles == ["new:1": "Parts"])
        #expect(proposal.operations[1].parentId == "new:1")
        let sent = String(decoding: try JSONCoding.makeEncoder().encode(proposal.keeping([0, 1])), as: UTF8.self)
        #expect(sent.contains(#""tempId":"new:1""#) && sent.contains(#""parentId":"new:1""#) && sent.contains(#""titles":{"new:1":"Parts"}"#))
        #expect(!sent.contains(#""id":"u""#))
    }
}
