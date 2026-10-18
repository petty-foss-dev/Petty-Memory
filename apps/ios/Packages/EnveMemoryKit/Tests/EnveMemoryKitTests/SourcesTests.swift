import Foundation
import Testing
@testable import EnveMemoryKit

@Suite struct SourcesTests {
    let client = APIClient(baseURL: URL(string: "http://h:1")!, token: "em_t")

    @Test func watchWritesSendOnlyWhatChanged() throws {
        let create = try Endpoint.createSource(WatchInput(name: "Club news", kind: .rss, url: "https://example.org/feed.xml", enabled: true))
        #expect(create.method == "POST" && create.path == "/knowledge/sources" && create.idempotencyKey != nil)
        #expect(try bodyString(create) == #"{"enabled":true,"kind":"rss","name":"Club news","url":"https:\/\/example.org\/feed.xml"}"#)
        #expect(try bodyString(.createSource(WatchInput(name: "Scans", kind: .folder, url: "/Users/someone/Scans"))) == #"{"enabled":false,"kind":"folder","name":"Scans"}"#)

        #expect(try bodyString(.updateSource("w1", WatchPatch(enabled: false))) == #"{"enabled":false}"#)
        #expect(try bodyString(.updateSource("w1", WatchPatch(project: .some(nil)))) == #"{"project":null}"#)
        #expect(try bodyString(.updateSource("w1", WatchPatch(name: "Renamed", project: "p1"))) == #"{"name":"Renamed","project":"p1"}"#)
        let remove = Endpoint.removeSource("w1")
        #expect(remove.method == "DELETE" && remove.idempotencyKey != nil && remove.body == nil)
    }

    @Test func checksAndAppliesAreExplicitWrites() throws {
        let check = Endpoint.checkSource("w1")
        #expect(check.method == "POST" && check.path == "/knowledge/sources/w1/check" && check.idempotencyKey != nil)
        let apply = try Endpoint.applyCandidates("w1", ids: ["c1", "c2"])
        #expect(apply.path == "/knowledge/sources/w1/apply" && apply.idempotencyKey != nil)
        #expect(try bodyString(apply) == #"{"candidateIds":["c1","c2"]}"#)
    }

    @Test func freshnessRoutesMatchTheContract() throws {
        #expect(client.urlRequest(for: .staleItems(olderThanDays: 90, project: "p1")).url?.query() == "days=90&project=p1")
        #expect(client.urlRequest(for: .staleItems(olderThanDays: 30, rootId: "r1", project: "p1")).url?.query() == "days=30&rootId=r1")
        let analyze = try Endpoint.analyzeFreshness(FreshnessScopeInput(query: "router", project: "p1"))
        #expect(analyze.idempotencyKey == nil && analyze.path == "/knowledge/freshness/analyze")
        #expect(try bodyString(analyze) == #"{"project":"p1","query":"router"}"#)
        #expect(try bodyString(.analyzeFreshness(FreshnessScopeInput(rootId: "r1", project: "p1"))) == #"{"rootId":"r1"}"#)

        let a = FreshnessRef(id: "a", stateHash: "ha")
        let b = FreshnessRef(id: "b", stateHash: "hb")
        #expect(try bodyString(.markChecked(a)) == #"{"id":"a","stateHash":"ha"}"#)
        #expect(try bodyString(.dismissPair(a, b)) == #"{"refs":[{"id":"a","stateHash":"ha"},{"id":"b","stateHash":"hb"}]}"#)
        let supersede = try Endpoint.supersede(newer: a, older: b)
        #expect(supersede.idempotencyKey != nil)
        #expect(try bodyString(supersede) == #"{"newer":{"id":"a","stateHash":"ha"},"older":{"id":"b","stateHash":"hb"}}"#)
    }

    @Test func watchesQueuesAndProposalsDecode() throws {
        let watch = #"{"id":"w1","name":"Scans","kind":"folder","url":null,"project":{"id":"p1","name":"Home"},"enabled":true,"hash":"h","folder":{"approved":true,"available":false},"lastCheck":{"at":"2026-10-17T08:00:00.000Z","status":"failed","found":0,"queued":0,"unchanged":0,"skipped":0,"truncated":false,"error":"The approved folder can't be read now."},"pending":2,"createdAt":"2026-10-01T08:00:00.000Z","updatedAt":"2026-10-01T08:00:00.000Z"}"#
        let source = try JSONCoding.makeDecoder().decode(WatchedSource.self, from: Data(watch.utf8))
        #expect(!source.canCheck && source.lastCheck?.status == .failed && source.project?.name == "Home")

        let queue = #"{"watchId":"w1","check":null,"candidates":[{"id":"c1","watchId":"w1","key":"notes.md","change":"changed","title":"notes.md","url":null,"text":"Hello","truncated":false,"publishedAt":null,"file":{"name":"notes.md","size":5,"sha256":"s","mimeType":"text/markdown","modifiedAt":"2026-10-16T08:00:00.000Z"},"fingerprint":"s","sourceHash":"h","targetId":"i1","targetHash":"t","checkedAt":"2026-10-17T08:00:00.000Z"}]}"#
        let decoded = try JSONCoding.makeDecoder().decode(SourceQueue.self, from: Data(queue.utf8))
        #expect(decoded.candidates.first?.change == .changed && decoded.candidates.first?.file?.size == 5)

        let proposal = #"{"state":"no_evidence","baseHash":"b","scanned":12,"suggestions":[],"rejected":2,"dismissed":0,"message":"No conflicting or outdated statements backed by exact quotes were found in these items."}"#
        let empty = try JSONCoding.makeDecoder().decode(FreshnessProposal.self, from: Data(proposal.utf8))
        #expect(empty.state == .noEvidence && empty.rejected == 2 && empty.scanned == 12)

        let stale = #"{"olderThanDays":90,"cutoff":"2026-07-19T08:00:00.000Z","total":140,"items":[{"id":"i1","type":"note","title":"Router setup","url":null,"excerpt":"Use channel 6","truncated":false,"dates":{"publishedAt":null,"capturedAt":"2025-01-01T08:00:00.000Z","editedAt":"2025-02-01T08:00:00.000Z","checkedAt":null},"stateHash":"h1","dismissed":[],"ageDays":620,"basis":"edited"}]}"#
        let items = try JSONCoding.makeDecoder().decode(StaleItems.self, from: Data(stale.utf8))
        #expect(items.total == 140 && items.items.first?.ref == FreshnessRef(id: "i1", stateHash: "h1"))
    }
}
