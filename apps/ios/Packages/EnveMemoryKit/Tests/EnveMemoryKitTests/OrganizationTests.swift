import Foundation
import Testing
@testable import EnveMemoryKit

@Suite struct OrganizationTests {
    static let destination = "01930000-0000-7000-8000-0000000000d1"
    static let proposalJSON = #"""
    {"id":"01930000-0000-7000-8000-0000000000e1","query":"gardening","baseHash":"9f2c","summary":"Sort gardening notes into PARA",
     "matchedCount":4,"affectedCount":6,"createdAt":"2026-10-17T09:00:00.000Z",
     "destination":{"id":"\#(destination)","title":"Gardening","create":true},
     "items":[
       {"id":"a","title":"Raised beds","body":"Cedar, 4×8","parentId":"old1","position":3,"descendantCount":2},
       {"id":"b","title":"Seed suppliers","body":"","parentId":null,"position":1,"descendantCount":0},
       {"id":"c","title":"Compost","body":"Turn weekly","parentId":"old2","position":0,"descendantCount":1}],
     "groups":[
       {"id":"g1","title":"Projects","parentId":"\#(destination)"},
       {"id":"g2","title":"Beds","parentId":"g1"},
       {"id":"g3","title":"Resources","parentId":"\#(destination)"},
       {"id":"g4","title":"Archive","parentId":"\#(destination)"}],
     "assignments":[{"itemId":"a","parentId":"g2"},{"itemId":"b","parentId":"g3"},{"itemId":"c","parentId":"\#(destination)"}],
     "futureField":{"kept":[1,true,null]}}
    """#

    private func proposal() throws -> OrganizationProposal {
        try JSONCoding.makeDecoder().decode(OrganizationProposal.self, from: Data(Self.proposalJSON.utf8))
    }

    private func titles(_ entries: [OrganizationProposal.Entry]) -> [String] {
        entries.map {
            switch $0 {
            case .group(let group): "group \(group.title)"
            case .candidate(let candidate): "note \(candidate.title)"
            }
        }
    }

    @Test func proposalsDecodeIntoAHierarchy() throws {
        let proposal = try proposal()
        #expect(proposal.query == "gardening" && proposal.matchedCount == 4 && proposal.affectedCount == 6)
        #expect(proposal.destination == .init(id: Self.destination, title: "Gardening", create: true))
        #expect(proposal.candidateIDs == ["a", "b", "c"])
        #expect(proposal.candidate("a")?.descendantCount == 2 && proposal.candidate("b")?.parentId == nil)
        #expect(titles(proposal.entries(in: Self.destination)) == ["group Projects", "group Resources", "group Archive", "note Compost"])
        #expect(titles(proposal.entries(in: "g1")) == ["group Beds"])
        #expect(titles(proposal.entries(in: "g2")) == ["note Raised beds"])
    }

    @Test func excludingNotesDropsTheHeadingsOnlyTheyNeeded() throws {
        let proposal = try proposal()
        let all = Set(proposal.candidateIDs)
        #expect(proposal.createdGroups(selecting: all) == ["g1", "g2", "g3", "g4"])
        #expect(proposal.createdGroups(selecting: ["b", "c"]) == ["g3", "g4"])
        #expect(proposal.createdGroups(selecting: ["a"]) == ["g1", "g2", "g4"])
        #expect(proposal.movedCount(selecting: all) == 6)
        #expect(proposal.movedCount(selecting: ["a"]) == 3)
        #expect(proposal.movedCount(selecting: []) == 0)
    }

    @Test func chatAnswersWithAnOrganization() throws {
        let response = try JSONCoding.makeDecoder().decode(ChatResponse.self, from: Data(#"{"kind":"organization","proposal":\#(Self.proposalJSON)}"#.utf8))
        guard case .organization(let proposal) = response else { Issue.record("Expected an organization"); return }
        #expect(proposal.groups.count == 4)

        let request = try Endpoint.chat(ChatRequest(mode: .organize, history: [], message: "Organize all notes about gardening into a PARA system."))
        #expect(try bodyString(request) == #"{"messages":[{"content":"Organize all notes about gardening into a PARA system.","role":"user"}],"mode":"organize"}"#)
        #expect(request.idempotencyKey == nil)
    }

    @Test func intentionallyEmptyGroupsKeepTheirAncestors() throws {
        let json = Self.proposalJSON.replacingOccurrences(
            of: #"{"id":"g4","title":"Archive","parentId":"\#(Self.destination)"}"#,
            with: #"{"id":"g4","title":"Archive","parentId":"g2"}"#)
        let proposal = try JSONCoding.makeDecoder().decode(OrganizationProposal.self, from: Data(json.utf8))
        #expect(proposal.createdGroups(selecting: ["b"]) == ["g1", "g2", "g3", "g4"])
    }

    @Test func applySendsTheProposalVerbatimWithTheSelection() throws {
        let proposal = try proposal()
        let apply = try Endpoint.applyOrganization(proposal, including: ["c", "a"])
        #expect(apply.method == "POST" && apply.path == "/ai/organize/apply" && apply.idempotencyKey != nil)
        let body = try JSONCoding.makeDecoder().decode(JSONValue.self, from: #require(apply.body))
        let original = try JSONCoding.makeDecoder().decode(JSONValue.self, from: Data(Self.proposalJSON.utf8))
        guard case .object(let fields) = body else { Issue.record("Expected an object"); return }
        #expect(fields["proposal"] == original, "The proposal must go back exactly as the server sent it.")
        #expect(fields["includeIds"] == .array([.string("c"), .string("a")]))
        #expect(Set(fields.keys) == ["proposal", "includeIds"])
        #expect(try Endpoint.applyOrganization(proposal, including: ["a"]).idempotencyKey != apply.idempotencyKey)
    }

    @Test func resultsAndUndoReceiptsRoundTrip() throws {
        let json = #"{"rootId":"\#(Self.destination)","moved":2,"actionId":"01930000-0000-7000-8000-0000000000e1","undo":{"actionId":"01930000-0000-7000-8000-0000000000e1","rootId":"\#(Self.destination)","afterHash":"77ab"}}"#
        let result = try JSONCoding.makeDecoder().decode(OrganizationResult.self, from: Data(json.utf8))
        #expect(result.rootId == Self.destination && result.moved == 2 && result.undo.afterHash == "77ab")
        let undo = try Endpoint.undoOrganization(result.undo)
        #expect(undo.method == "POST" && undo.path == "/ai/organize/undo" && undo.idempotencyKey != nil)
        #expect(try bodyString(undo) == #"{"receipt":{"actionId":"01930000-0000-7000-8000-0000000000e1","afterHash":"77ab","rootId":"\#(Self.destination)"}}"#)
    }

    @Test func staleProposalsAreRefusedNotRetried() async throws {
        let server = StubServer { _ in (409, Data(#"{"error":{"code":"conflict","message":"Notes on this topic changed since the proposal was made. Ask for a new proposal."}}"#.utf8)) }
        let error = await #expect(throws: APIError.self) {
            try await server.client().send(.applyOrganization(try proposal(), including: ["a"]), as: OrganizationResult.self)
        }
        #expect(error?.code == .conflict && error?.isRetryable == false)
        #expect(error?.localizedDescription.contains("Ask for a new proposal") == true)
        #expect(server.requests.count == 1)
    }

    @Test func organizationRoutesAreNeverSavedForOfflineReads() throws {
        let proposal = try proposal()
        #expect(!ResponseCache.isCacheable(try .applyOrganization(proposal, including: ["a"])))
        #expect(!ResponseCache.isCacheable(try .undoOrganization(OrganizationReceipt(actionId: "x", rootId: "y", afterHash: "z"))))
    }
}
