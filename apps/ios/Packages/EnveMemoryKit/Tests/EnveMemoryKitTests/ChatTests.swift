import Foundation
import Testing
@testable import EnveMemoryKit

@Suite struct ChatTests {
    static let rootID = "01930000-0000-7000-8000-0000000000a1"

    private func exchange(_ question: String, _ answer: String) -> [ChatMessage] {
        [ChatMessage(role: .user, content: question), ChatMessage(role: .assistant, content: answer)]
    }

    private func decode(_ json: String) throws -> ChatResponse {
        try JSONCoding.makeDecoder().decode(ChatResponse.self, from: Data(json.utf8))
    }

    @Test func statusAndChatRoutesMatchTheContract() throws {
        #expect(Endpoint.aiStatus.method == "GET" && Endpoint.aiStatus.path == "/ai/status" && Endpoint.aiStatus.body == nil)

        let ask = try Endpoint.chat(ChatRequest(mode: .ask, history: exchange("Which sensor?", "A reed switch [1]."),
                                                message: "Where is it?", project: "p1"))
        #expect(ask.method == "POST" && ask.path == "/ai/chat")
        #expect(ask.idempotencyKey == nil, "A preview must never be replayed from the server's idempotency store.")
        #expect(try bodyString(ask) == #"{"messages":[{"content":"Which sensor?","role":"user"},{"content":"A reed switch [1].","role":"assistant"},{"content":"Where is it?","role":"user"}],"mode":"ask","project":"p1"}"#)

        let edit = try Endpoint.chat(ChatRequest(mode: .edit, history: [], message: "Turn this into a checklist", rootId: Self.rootID))
        #expect(try bodyString(edit) == #"{"messages":[{"content":"Turn this into a checklist","role":"user"}],"mode":"edit","rootId":"\#(Self.rootID)"}"#)
    }

    @Test func longConversationsDropWholeExchangesAndKeepTheNewMessage() {
        let history = (1...8).flatMap { exchange("Question \($0)", "Answer \($0)") }
        let request = ChatRequest(mode: .ask, history: history, message: "Latest")
        #expect(request.messages.count == 11)
        #expect(request.omitted == 6)
        #expect(request.messages.first == ChatMessage(role: .user, content: "Question 4"))
        #expect(request.messages.last == ChatMessage(role: .user, content: "Latest"))
        for (index, message) in request.messages.enumerated() {
            #expect(message.role == (index.isMultiple(of: 2) ? .user : .assistant))
        }
        #expect(ChatRequest(mode: .ask, history: exchange("a", "b"), message: "c").omitted == 0)
    }

    @Test func requestsStayWithinTheServersCharacterLimits() {
        let long = String(repeating: "word ", count: 1_000)
        let history = (1...4).flatMap { exchange("Question \($0) \(long)".prefix(3_900).description, long) }
        let message = String(repeating: "é", count: ChatRequest.maxMessageLength)
        let request = ChatRequest(mode: .ask, history: history, message: message)
        let total = request.messages.reduce(0) { $0 + ChatRequest.length($1.content) }
        #expect(total <= ChatRequest.maxTotalLength)
        #expect(request.messages.allSatisfy { ChatRequest.length($0.content) <= ChatRequest.maxMessageLength })
        #expect(request.messages.last?.content == message)
        #expect(request.messages.first?.role == .user && request.omitted > 0 && request.omitted.isMultiple(of: 2))
        #expect(request.messages.dropLast().filter { $0.role == .assistant }.allSatisfy { $0.content.hasSuffix("…") })
    }

    @Test func clippingCountsUTF16AndNeverSplitsACharacter() {
        let emoji = String(repeating: "👍", count: 2_500)
        let clipped = ChatRequest.clipped(emoji)
        #expect(ChatRequest.length(emoji) == 5_000)
        #expect(ChatRequest.length(clipped) <= ChatRequest.maxMessageLength)
        #expect(clipped.hasSuffix("…") && clipped.dropLast().allSatisfy { $0 == "👍" })
        #expect(ChatRequest.clipped("short") == "short")
    }

    @Test func historyThatDoesNotAlternateIsTrimmedToStartAndEndCorrectly() {
        let history = [ChatMessage(role: .assistant, content: "stray")] + exchange("q", "a") + [ChatMessage(role: .user, content: "unanswered")]
        let request = ChatRequest(mode: .ask, history: history, message: "next")
        #expect(request.messages.map(\.content) == ["q", "a", "next"])
        #expect(request.omitted == 2)
    }

    @Test func statusDecodesWithoutCredentials() throws {
        let local = try JSONCoding.makeDecoder().decode(AIStatus.self, from: Data(#"{"configured":true,"provider":"ollama","label":"Ollama (on this computer)","model":"qwen2.5:1.5b","cloud":false}"#.utf8))
        #expect(local.configured && local.label == "Ollama (on this computer)" && local.model == "qwen2.5:1.5b" && !local.cloud)
        let none = try JSONCoding.makeDecoder().decode(AIStatus.self, from: Data(#"{"configured":false,"provider":"none","label":"No AI configured","model":null,"cloud":false}"#.utf8))
        #expect(!none.configured && none.model == nil)
    }

    @Test func answersAndProposalsDecode() throws {
        let answer = try decode(#"{"kind":"answer","answer":{"answer":"It uses a reed switch [1].","sources":[{"n":1,"id":"a1","title":"Garage sensor","url":null,"type":"note"},{"n":2,"id":"b2","title":"Datasheet","url":"https://example.com/d","type":"bookmark"}]}}"#)
        guard case .answer(let cited) = answer else { Issue.record("Expected an answer"); return }
        #expect(cited.answer == "It uses a reed switch [1].")
        #expect(cited.sources.map(\.n) == [1, 2] && cited.sources[1].type == .bookmark && cited.sources[1].url == "https://example.com/d")

        let proposal = try decode(#"{"kind":"proposal","proposal":\#(EditProposalTests.proposalJSON)}"#)
        guard case .proposal(let edits) = proposal else { Issue.record("Expected a proposal"); return }
        #expect(edits.rootId == "r1" && edits.operations.count == 5 && edits.operations[0].before?.title == "wire relay")

        #expect(throws: DecodingError.self) { try decode(#"{"kind":"tool","tool":{"name":"delete"}}"#) }
    }

    @Test func chatIsSentOnceAndAnswersFromTheServer() async throws {
        let reply = #"{"kind":"answer","answer":{"answer":"Nothing in your library matches that question.","sources":[]}}"#
        let server = StubServer { _ in (200, Data(reply.utf8)) }
        let response = try await server.client().send(.chat(ChatRequest(mode: .ask, history: [], message: "Anything?")), as: ChatResponse.self)
        #expect(response == .answer(CitedAnswer(answer: "Nothing in your library matches that question.", sources: [])))
        let recorded = try #require(server.requests.first)
        #expect(server.requests.count == 1)
        #expect(recorded.request.url?.path() == "/api/v1/ai/chat" && recorded.request.value(forHTTPHeaderField: "Idempotency-Key") == nil)
    }

    @Test func aiOffAndScopeRefusalsAreReportedNotRetried() async throws {
        let server = StubServer { _ in (400, Data(#"{"error":{"code":"invalid","message":"Configure an AI provider on the host first with `petty-memory ai use`."}}"#.utf8)) }
        let error = await #expect(throws: APIError.self) {
            try await server.client().send(.chat(ChatRequest(mode: .ask, history: [], message: "Hi")), as: ChatResponse.self)
        }
        #expect(error?.isRetryable == false && error?.code == .invalid)
        #expect(error?.localizedDescription.contains("petty-memory ai use") == true)
        #expect(server.requests.count == 1)
    }

    @Test func chatIsNeverSavedOrAnsweredFromThePhonesCopies() throws {
        let chat = try Endpoint.chat(ChatRequest(mode: .ask, history: [], message: "Hi"))
        let cache = ResponseCache(root: TestDirectory.make("chat-cache"), baseURL: URL(string: "http://h:1")!, token: "em_a")
        for endpoint in [Endpoint.aiStatus, chat] {
            #expect(!ResponseCache.isCacheable(endpoint))
            cache.store(Data(#"{"configured":true}"#.utf8), for: endpoint)
            #expect(cache.load(endpoint) == nil)
        }
    }
}

@Suite struct DictationDraftTests {
    @Test func partialResultsReplaceRatherThanRepeat() {
        var draft = DictationDraft()
        let session = draft.begin(after: "Typed first.")
        draft.apply("Organize", session: session)
        draft.apply("Organize my garage", session: session)
        draft.apply("Organize my garage notes", session: session)
        #expect(draft.text == "Typed first. Organize my garage notes")
    }

    @Test func spacingFollowsWhatWasTyped() {
        var draft = DictationDraft()
        var session = draft.begin(after: "")
        draft.apply("  hello ", session: session)
        #expect(draft.text == "hello")
        session = draft.begin(after: "line\n")
        draft.apply("next", session: session)
        #expect(draft.text == "line\nnext")
        draft.apply("", session: session)
        #expect(draft.text == "line\n")
    }

    @Test func lateResultsAfterStopOrRestartAreIgnored() {
        var draft = DictationDraft()
        let first = draft.begin(after: "Note")
        draft.apply("one", session: first)
        draft.end()
        let afterStop = draft.apply("one two", session: first)
        #expect(!afterStop && draft.text == "Note one" && !draft.isCurrent(first))

        let second = draft.begin(after: draft.text)
        let stale = draft.apply("stale", session: first)
        let current = draft.apply("three", session: second)
        #expect(!stale && current && draft.text == "Note one three")
    }
}
