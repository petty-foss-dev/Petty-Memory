import Foundation
import Testing
@testable import EnveMemoryKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONCoding.makeDecoder().decode(T.self, from: Data(json.utf8))
}

private func exchange(_ question: String, _ answer: String) -> [ChatMessage] {
    [ChatMessage(role: .user, content: question), ChatMessage(role: .assistant, content: answer)]
}

@Suite struct SavedConversationTests {
    @Test func routesAndBodiesMatchTheContract() throws {
        #expect(Endpoint.conversations.method == "GET" && Endpoint.conversations.path == "/conversations")
        #expect(Endpoint.conversation("c 1").path == "/conversations/c%201")

        let input = ConversationInput(id: nil, title: "  Garage  ", mode: .ask, project: "p1", messages: exchange("Which sensor?", "A reed switch."))
        let save = try Endpoint.saveConversation(input)
        #expect(save.method == "POST" && save.path == "/conversations" && save.idempotencyKey != nil && save.isOnlineOnly)
        #expect(try bodyString(save) == #"{"messages":[{"content":"Which sensor?","role":"user"},{"content":"A reed switch.","role":"assistant"}],"mode":"ask","project":"p1","title":"Garage"}"#)

        let update = ConversationInput(id: "c1", title: "", mode: .actions, query: "garden", messages: exchange("Plan the beds\nsoon", "Proposed 2 actions."))
        #expect(update.title == "Plan the beds")
        #expect(try bodyString(.saveConversation(update)).contains(#""id":"c1""#))
        #expect(try bodyString(.saveConversation(update)).contains(#""query":"garden""#))

        let archive = Endpoint.archiveConversation("c1")
        #expect(archive.method == "DELETE" && archive.path == "/conversations/c1" && archive.idempotencyKey != nil && archive.isOnlineOnly)
    }

    @Test func savedMessagesAlternateWithinTheServersLimits() {
        let many = (1...60).flatMap { exchange("Question \($0)", "Answer \($0)") }
        let input = ConversationInput(id: nil, title: "t", mode: .ask, messages: many)
        #expect(input.messages.count == ConversationInput.maxMessages && input.omitted == 20)
        #expect(input.messages.first == ChatMessage(role: .user, content: "Question 11"))

        let long = String(repeating: "x", count: 60_000)
        let heavy = ConversationInput(id: nil, title: "t", mode: .ask, messages: (1...4).flatMap { exchange("q\($0)", long) })
        #expect(heavy.messages.reduce(0) { $0 + ChatRequest.length($1.content) } <= ConversationInput.maxLength)
        #expect(heavy.messages.map(\.content).first == "q2" && heavy.omitted == 2)

        let stray = [ChatMessage(role: .assistant, content: "hi")] + exchange("q", "a") + [ChatMessage(role: .user, content: "unanswered")]
        let trimmed = ConversationInput(id: nil, title: "", mode: .ask, messages: stray)
        #expect(trimmed.messages.map(\.content) == ["q", "a"] && trimmed.omitted == 2)
        #expect(ConversationInput(id: nil, title: String(repeating: "t", count: 300), mode: .ask, messages: []).title.count == ConversationInput.maxTitle)
    }

    @Test func savedConversationsDecodeIntoExchanges() throws {
        let saved = try decode([SavedConversation].self, #"[{"id":"c1","title":"Garage","mode":"edit","rootId":"r1","messages":[{"role":"user","content":"Tidy"},{"role":"assistant","content":"Proposed 3 changes."},{"role":"user","content":"Again"}],"createdAt":"2026-10-17T08:00:00.000Z","updatedAt":"2026-10-17T09:00:00.000Z"}]"#)
        let conversation = try #require(saved.first)
        #expect(conversation.mode == .edit && conversation.rootId == "r1" && conversation.project == nil && conversation.query == nil)
        #expect(conversation.exchanges.map(\.question) == ["Tidy"] && conversation.exchanges.map(\.answer) == ["Proposed 3 changes."])
    }

    @Test func answersBecomeNotesWithStableReferences() {
        let a = "01930000-0000-7000-8000-0000000000a1", b = "01930000-0000-7000-8000-0000000000b2"
        let answer = CitedAnswer(answer: "Use a reed switch [1] wired to the relay [2]. See [9].", sources: [
            CitedAnswer.Source(n: 1, id: a, title: "Garage sensor", url: nil, type: .note, locator: nil),
            CitedAnswer.Source(n: 2, id: b, title: "", url: "https://example.com/relay", type: .bookmark, locator: nil),
        ])
        let body = answer.noteBody
        #expect(body.hasPrefix("Use a reed switch [[item:\(a)|Garage sensor]] wired to the relay [[item:\(b)|https://example.com/relay]]. See [9]."))
        #expect(body.hasSuffix("Sources\n- [[item:\(a)|Garage sensor]]\n- [[item:\(b)|https://example.com/relay]]"))
        #expect(Set(InlineReference.matches(in: body).map(\.id)) == [a, b])
        #expect(CitedAnswer(answer: "Nothing [1].", sources: []).noteBody == "Nothing [1].")
    }
}

@Suite struct ActionProposalTests {
    static let proposalJSON = #"{"id":"ap1","rootId":null,"query":"garden","project":"p1","baseHash":"h1","summary":"Plan the beds","createdAt":"2026-10-17T08:00:00.000Z","extra":{"kept":true},"operations":[{"id":"o1","kind":"task","title":"Order seeds","body":"","sourceId":"n1","dueAt":"2026-10-20"},{"id":"o2","kind":"tag","itemId":"n1","tags":["garden","spring"]},{"id":"o3","kind":"reminder","itemId":"n2","remindAt":"2026-10-18T16:00:00.000Z"},{"id":"o4","kind":"note","title":"Garden brief","body":"Beds and seeds.","sourceIds":["n1","n2"]},{"id":"o5","kind":"delete","itemId":"n3"}]}"#

    @Test func chatRepliesWithAnActionProposal() throws {
        let response = try decode(ChatResponse.self, #"{"kind":"actions","proposal":\#(Self.proposalJSON)}"#)
        guard case .actions(let proposal) = response else { Issue.record("Expected actions"); return }
        #expect(proposal.query == "garden" && proposal.rootId == nil && proposal.project == "p1" && proposal.operations.count == 5)
        #expect(proposal.operations[0].kind == .task(title: "Order seeds", body: "", sourceId: "n1", dueAt: "2026-10-20"))
        #expect(proposal.operations[1].kind == .tag(itemId: "n1", tags: ["garden", "spring"]))
        #expect(proposal.operations[2].kind == .reminder(itemId: "n2", remindAt: "2026-10-18T16:00:00.000Z"))
        #expect(proposal.operations[3].kind == .note(title: "Garden brief", body: "Beds and seeds.", sourceIds: ["n1", "n2"]))
        #expect(proposal.operations[4].kind == .unknown("delete"))
        #expect(proposal.reviewableIDs == ["o1", "o2", "o3", "o4"])
        #expect(proposal.operations[3].referencedIDs == ["n1", "n2"])
    }

    @Test func actionsModeSendsATopicOrABranch() throws {
        let topic = try Endpoint.chat(ChatRequest(mode: .actions, history: [], message: "Make tasks", project: "p1", query: "garden"))
        #expect(try bodyString(topic) == #"{"messages":[{"content":"Make tasks","role":"user"}],"mode":"actions","project":"p1","query":"garden"}"#)
        let branch = try Endpoint.chat(ChatRequest(mode: .actions, history: [], message: "Tag these", rootId: "r1"))
        #expect(try bodyString(branch) == #"{"messages":[{"content":"Tag these","role":"user"}],"mode":"actions","rootId":"r1"}"#)
    }

    @Test func applyReturnsTheProposalVerbatimWithTheSelection() throws {
        let proposal = try decode(ActionProposal.self, Self.proposalJSON)
        let apply = try Endpoint.applyActions(proposal, including: ["o4", "o1"])
        #expect(apply.method == "POST" && apply.path == "/ai/actions/apply" && apply.isOnlineOnly && apply.idempotencyKey != nil)
        let body = try JSONSerialization.jsonObject(with: try #require(apply.body)) as? [String: Any]
        #expect(body?["includeIds"] as? [String] == ["o1", "o4"])
        let sent = try #require(body?["proposal"] as? [String: Any])
        #expect((sent["extra"] as? [String: Any])?["kept"] as? Bool == true)
        #expect((sent["operations"] as? [[String: Any]])?.count == 5)

        let result = try decode(ActionResult.self, #"{"actionId":"a1","createdIds":["t1"],"updatedIds":["n1"],"undo":{"actionId":"a1","afterHash":"h2"}}"#)
        let undo = try Endpoint.undoActions(result.undo)
        #expect(undo.path == "/ai/actions/undo" && undo.isOnlineOnly)
        #expect(try bodyString(undo) == #"{"receipt":{"actionId":"a1","afterHash":"h2"}}"#)
        #expect(try decode(ActionUndoResult.self, #"{"restored":2}"#).restored == 2)
    }
}

@Suite struct ReviewQueueTests {
    @Test func queueAndScheduleRoutes() throws {
        let queue = Endpoint.reviewQueue(limit: 20, project: "p 1")
        #expect(queue.method == "GET" && queue.path == "/review")
        #expect(queue.query == [.init(name: "limit", value: "20"), .init(name: "project", value: "p 1")])
        #expect(Endpoint.reviewQueue().query.isEmpty)
        #expect(!ResponseCache.isCacheable(queue))

        let schedule = try Endpoint.scheduleReview("i1", days: ReviewInterval.nextWeek)
        #expect(schedule.method == "POST" && schedule.path == "/review/i1" && schedule.isOnlineOnly && schedule.idempotencyKey != nil)
        #expect(try bodyString(schedule) == #"{"days":7}"#)
        #expect(try bodyString(.scheduleReview("i1", days: 0)) == #"{"days":1}"#)
        #expect(try bodyString(.scheduleReview("i1", days: 9_999)) == #"{"days":3650}"#)
    }

    @Test func cardsDecode() throws {
        let cards = try decode([ReviewCard].self, "[{\"item\":\(itemJSON(id: "i1", title: "Relay")),\"dueAt\":\"2026-10-17T00:00:00.000Z\",\"lastReviewedAt\":null,\"reviewCount\":0,\"reason\":\"Marked for review\"}]")
        let card = try #require(cards.first)
        #expect(card.id == "i1" && card.item.title == "Relay" && card.dueAt != nil && card.lastReviewedAt == nil && card.reviewCount == 0)
    }
}

@Suite struct InsightTests {
    @Test func insightsDecodeAndStayBounded() throws {
        let insights = try decode(ItemInsights.self, #"{"itemId":"i1","mentions":[{"id":"m1","title":"Log","snippet":"…the [relay]…","reason":"Mentions “Relay” without a link","score":1}],"related":[{"id":"r1","title":"Wiring","snippet":"","reason":"Shares tags","score":0.6}],"duplicates":[{"id":"d1","title":"Relay","snippet":"","reason":"Same title","score":0.95}],"scanned":500,"total":1200}"#)
        #expect(insights.isBounded && !insights.isEmpty && insights.duplicates.first?.score == 0.95)
        let left = insights.removing(["m1", "d1"])
        #expect(left.mentions.isEmpty && left.duplicates.isEmpty && left.related.map(\.id) == ["r1"] && left.total == 1200)
        #expect(Endpoint.insights("i1").path == "/items/i1/insights" && !ResponseCache.isCacheable(.insights("i1")))
    }

    @Test func mergePreviewAndMergeKeepTheProposalVerbatim() throws {
        let preview = try Endpoint.previewMerge(sourceId: "d1", targetId: "i1")
        #expect(preview.path == "/insights/merge/preview" && preview.idempotencyKey == nil && preview.isOnlineOnly)
        #expect(try bodyString(preview) == #"{"sourceId":"d1","targetId":"i1"}"#)

        let proposal = try decode(MergeProposal.self, #"{"sourceId":"d1","targetId":"i1","baseHash":"h","sourceTitle":"Relay (copy)","targetTitle":"Relay","preview":{"title":"Relay","body":"Merged text","movedChildren":2,"retainedAttachments":1}}"#)
        #expect(proposal.previewText == "Merged text")
        let merge = try Endpoint.merge(proposal)
        #expect(merge.path == "/insights/merge" && merge.idempotencyKey != nil && merge.isOnlineOnly)
        #expect(try bodyString(merge) == #"{"proposal":{"baseHash":"h","preview":{"body":"Merged text","movedChildren":2,"retainedAttachments":1,"title":"Relay"},"sourceId":"d1","sourceTitle":"Relay (copy)","targetId":"i1","targetTitle":"Relay"}}"#)
        #expect(proposal.preview.movedChildren == 2 && proposal.preview.retainedAttachments == 1)
    }
}

@Suite struct ImportAndOCRTests {
    @Test func previewAndImportBodies() throws {
        let preview = try Endpoint.previewEnveImport("# Book\n> passage")
        #expect(preview.path == "/imports/enve-highlights/preview" && preview.idempotencyKey == nil && preview.isOnlineOnly)
        #expect(try bodyString(preview) == ##"{"data":"# Book\n> passage"}"##)
        let run = try Endpoint.importEnveHighlights("{}", project: "p1")
        #expect(run.path == "/imports/enve-highlights" && run.idempotencyKey != nil)
        #expect(try bodyString(run) == #"{"data":"{}","project":"p1"}"#)
        #expect(try bodyString(.importEnveHighlights("{}", project: nil)) == #"{"data":"{}"}"#)
    }

    @Test func previewAndResultDecode() throws {
        let preview = try decode(EnveImportPreview.self, #"{"format":"enve-markdown","entries":[{"id":"h1","bookTitle":"Dune","author":"Frank Herbert","text":"Fear is the mind-killer.","note":"","location":"Chapter 1","sourceUrl":null},{"id":"h2","bookTitle":"Dune","author":null,"text":"Second","note":null,"location":null,"sourceUrl":"https://example.com/b"}],"skipped":1}"#)
        #expect(preview.entries.count == 2 && preview.books == 1 && preview.skipped == 1 && preview.entries[1].author == nil)
        let result = try decode(EnveImportResult.self, #"{"created":1,"skipped":1,"failed":[{"source":"h3","error":"Empty passage"}]}"#)
        #expect(result.created == 1 && result.failed.first?.error == "Empty passage")
    }

    @Test func exportsAreTextWithinTheSizeLimit() throws {
        #expect(try EnveImport.text(from: Data("# Dune".utf8)) == "# Dune")
        #expect(throws: EnveImport.Problem.notText) { try EnveImport.text(from: Data([0xFF, 0xFE, 0x00])) }
        #expect(throws: EnveImport.Problem.tooLarge(EnveImport.maxBytes + 1)) { try EnveImport.text(from: Data(count: EnveImport.maxBytes + 1)) }
    }

    @Test func ocrExtractsWithoutSaving() throws {
        let ocr = try Endpoint.extractText(attachmentId: "a1")
        #expect(ocr.method == "POST" && ocr.path == "/capture/ocr" && ocr.idempotencyKey == nil && ocr.isOnlineOnly)
        #expect(try bodyString(ocr) == #"{"attachmentId":"a1"}"#)
        let capture = try Endpoint.capture(CaptureRequest(note: "n"))
        #expect(!capture.isOnlineOnly)
    }
}

@Suite struct SemanticOrganizationTests {
    @Test func candidatesCarryHowTheyWereFound() throws {
        let json = #"{"id":"o1","query":"garden","summary":"","matchedCount":2,"affectedCount":2,"destination":{"id":"d","title":"Garden","create":true},"items":[{"id":"a","title":"Beds","body":"","parentId":null,"descendantCount":0,"match":"keyword"},{"id":"b","title":"Compost","body":"","parentId":null,"descendantCount":0,"match":"semantic"},{"id":"c","title":"Old","body":"","parentId":null,"descendantCount":0}],"groups":[],"assignments":[{"itemId":"a","parentId":"d"},{"itemId":"b","parentId":"d"},{"itemId":"c","parentId":"d"}]}"#
        let proposal = try decode(OrganizationProposal.self, json)
        #expect(proposal.items.map(\.isSuggested) == [false, true, false] && proposal.suggestedCount == 1)
        #expect(proposal.items[2].match == nil)
    }
}
