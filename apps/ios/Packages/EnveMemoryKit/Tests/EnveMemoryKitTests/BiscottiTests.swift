import Foundation
import Testing
@testable import EnveMemoryKit

@Suite struct BiscottiTests {
    @Test func exportReadingIsBoundedAndRequiresUTF8() throws {
        let csv = "id,title,created\nmeeting,Planning,2026-10-20\n"
        #expect(try BiscottiImport.text(from: Data(csv.utf8)) == csv)
        #expect(throws: BiscottiImport.Problem.notText) { try BiscottiImport.text(from: Data([0xFF, 0xFE])) }
        #expect(throws: BiscottiImport.Problem.notText) { try BiscottiImport.text(from: Data([0])) }
        let oversized = Data(repeating: 65, count: BiscottiImport.maxBytes + 1)
        #expect(throws: BiscottiImport.Problem.tooLarge(oversized.count)) { try BiscottiImport.text(from: oversized) }
    }

    @Test func previewIsTransientAndApplyKeepsTheReviewedSelection() throws {
        let preview = try Endpoint.previewBiscottiImport("csv text")
        #expect(preview.path == "/imports/biscotti/preview" && preview.idempotencyKey == nil)
        let applied = try Endpoint.importBiscotti("csv text", fingerprint: "reviewed-fingerprint", includeIds: ["meeting-two"], project: "garden")
        #expect(applied.path == "/imports/biscotti" && applied.idempotencyKey != nil)
        let data = try #require(applied.body)
        let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(body["data"] as? String == "csv text" && body["source"] as? String == "csv")
        #expect(body["fingerprint"] as? String == "reviewed-fingerprint")
        #expect(body["includeIds"] as? [String] == ["meeting-two"] && body["project"] as? String == "garden")
        let list = Endpoint.biscottiMeetings(project: "garden & tools", before: "time,id", limit: 50)
        let client = APIClient(baseURL: URL(string: "http://h:1")!, token: "em_fixture")
        #expect(client.urlRequest(for: list).url?.query(percentEncoded: true)?.contains("project=garden%20%26%20tools") == true)
    }

    @Test func previewKeepsSpeakerTextAndExistingIdentity() throws {
        let json = #"{"entries":[{"id":"meeting-one","title":"Planning","date":"2026-10-20T15:00:00.000Z","summary":"Buy cedar.","notes":"Keep receipts.","transcript":"[0:23] Alex\nBuy cedar.","participants":[],"tags":[],"speakers":["Alex"],"turns":[{"start":23,"speaker":"Alex","text":"Buy cedar."}],"existingId":"saved-note"}],"skipped":1,"warnings":[{"row":3,"message":"Repeated ID"}],"fingerprint":"fp","source":"csv"}"#
        let preview = try JSONCoding.makeDecoder().decode(BiscottiPreview.self, from: Data(json.utf8))
        #expect(preview.importable.isEmpty && preview.entries[0].existingId == "saved-note")
        #expect(preview.entries[0].transcript == "[0:23] Alex\nBuy cedar.")
        #expect(preview.entries[0].turns[0].start == 23 && preview.warnings[0].row == 3)
        #expect(try JSONCoding.makeDecoder().decode(BiscottiPreview.self, from: JSONCoding.makeEncoder().encode(preview)) == preview)
    }

    @Test func directoryAndResultDecodeTheSharedAPIContract() throws {
        let page = #"{"items":[{"id":"note","meetingId":"meeting","title":"Planning","date":"2026-10-20T15:00:00.000Z","summary":"Buy cedar.","speakers":["Alex"],"participants":[],"project":{"id":"project","name":"Garden"},"source":"mcp","moments":[{"start":23,"speaker":"Alex"}]}],"next":"time,note"}"#
        let decoded = try JSONCoding.makeDecoder().decode(BiscottiMeetingPage.self, from: Data(page.utf8))
        #expect(decoded.items[0].id == "note" && decoded.items[0].project?.name == "Garden")
        #expect(decoded.items[0].moments[0].start == 23 && decoded.next == "time,note")
        let result = #"{"created":0,"skipped":1,"failed":[],"items":[{"id":"note","sourceId":"meeting","title":"Planning","created":false}]}"#
        let saved = try JSONCoding.makeDecoder().decode(BiscottiImportResult.self, from: Data(result.utf8))
        #expect(saved.created == 0 && saved.items[0].created == false && saved.items[0].id == "note")
    }
}
