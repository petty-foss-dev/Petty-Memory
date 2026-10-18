import Foundation
import Testing
@testable import EnveMemoryKit

@Suite struct ResearchTests {
    let client = APIClient(baseURL: URL(string: "http://h:1")!, token: "em_t")
    static let sha = String(repeating: "a", count: 64)

    static let previewJSON = #"{"audio":{"itemId":"a1","title":"Standup","attachmentId":"att1","sha256":"\#(sha)","filename":"standup.m4a","mimeType":"audio/mp4","size":2048},"format":"vtt","engine":"","segments":[{"start":0,"end":2.5,"text":"Hello"},{"start":2.5,"end":4.25,"text":"Ship it","speaker":"Ada"}],"segmentCount":2,"duration":4.25,"characters":12,"overlaps":0,"fingerprint":"fp1","existingId":null,"skipped":1}"#

    @Test func savingAPreviewSendsOnlyItsAcceptedFields() throws {
        let preview = try JSONCoding.makeDecoder().decode(TranscriptPreview.self, from: Data(Self.previewJSON.utf8))
        #expect(preview.skipped == 1 && preview.segments[1].spoken == "Ada: Ship it")
        let save = try Endpoint.saveTranscript(SaveTranscriptInput(preview: preview, title: "Standup notes"))
        #expect(save.method == "POST" && save.path == "/knowledge/research/transcripts" && save.idempotencyKey != nil)
        let body = try bodyObject(save)
        #expect(body.keys.sorted() == ["audioId", "fingerprint", "format", "segments", "title"])
        #expect(body["audioId"] as? String == "a1" && body["fingerprint"] as? String == "fp1" && body["format"] as? String == "vtt")
        let segments = try #require(body["segments"] as? [[String: Any]])
        #expect(segments[0].keys.sorted() == ["end", "start", "text"])
        #expect(segments[1]["speaker"] as? String == "Ada" && segments[1]["end"] as? Double == 4.25)
    }

    @Test func previewsTranscriptionAndOcrAreTransient() throws {
        let preview = try Endpoint.previewTranscript(TranscriptPreviewRequest(audioId: "a1", data: "WEBVTT", format: .vtt))
        #expect(preview.idempotencyKey == nil && preview.path == "/knowledge/research/transcripts/preview")
        #expect(try bodyString(preview) == #"{"audioId":"a1","data":"WEBVTT","format":"vtt"}"#)
        let transcribe = try Endpoint.transcribe(audioId: "a1")
        #expect(transcribe.idempotencyKey == nil && transcribe.path == "/knowledge/research/transcribe")
        #expect(try bodyString(transcribe) == #"{"audioId":"a1","confirmed":true}"#)
        let ocr = try Endpoint.recognizePdfPage(sourceId: "p1", page: 2, sha256: Self.sha, png: Data([137, 80]))
        #expect(ocr.idempotencyKey == nil)
        #expect(try bodyObject(ocr)["png"] as? String == "iVA=")
        #expect(Endpoint.transcriptionStatus.path == "/knowledge/research/transcription")
    }

    @Test func pdfWritesCarryTheFileHash() throws {
        let annotate = try Endpoint.annotate(AnnotationInput(sourceId: "p1", page: 3, quote: "Plant after frost", sha256: Self.sha, note: ""))
        #expect(annotate.idempotencyKey != nil)
        #expect(try bodyString(annotate) == #"{"page":3,"quote":"Plant after frost","sha256":"\#(Self.sha)","sourceId":"p1"}"#)
        let ocr = try Endpoint.saveOcrPage(OcrPageInput(sourceId: "p1", page: 3, text: "Reviewed", sha256: Self.sha, engine: "Apple Vision on iPhone"))
        #expect(try bodyString(ocr) == #"{"engine":"Apple Vision on iPhone","page":3,"sha256":"\#(Self.sha)","sourceId":"p1","text":"Reviewed"}"#)
        #expect(client.urlRequest(for: .pdfPages("p1", from: 4, limit: 1)).url?.query() == "from=4&limit=1")
        #expect(client.urlRequest(for: .findInPdf("p1", text: "frost date")).url?.query(percentEncoded: true) == "q=frost%20date")
        #expect(Endpoint.indexPdf("p1").method == "POST" && Endpoint.indexPdf("p1").idempotencyKey != nil)
        let passage = try Endpoint.savePassage(PassageInput(transcriptId: "t1", fingerprint: "fp1", from: 0, to: 2, note: "Decision"))
        #expect(try bodyString(passage) == #"{"fingerprint":"fp1","from":0,"note":"Decision","to":2,"transcriptId":"t1"}"#)
    }

    @Test func researchNotesLinkBackToTheirOriginals() throws {
        let annotation = itemJSON(id: "n1", metadata: #"{"research":{"version":1,"kind":"pdfAnnotation","sourceId":"p1","sha256":"\#(Self.sha)","identity":"x","page":7,"quote":"Plant after frost","textSource":"pdf","ocrId":null,"locator":{"page":7,"start":3,"end":20,"prefix":"","suffix":""}}}"#)
        let link = try #require(ResearchLink.decode(fromItemJSON: Data(annotation.utf8)))
        #expect(link.kind == .pdfAnnotation && link.location == ResearchLocation(sourceId: "p1", page: 7, quote: "Plant after frost"))
        let detail = try JSONCoding.makeDecoder().decode(Item.self, from: Data(annotation.utf8))
        let restored = try JSONCoding.makeDecoder().decode(ItemMetadata.self, from: JSONCoding.makeEncoder().encode(detail.metadata))
        #expect(ResearchLink.decode(fromMetadata: restored.research) == link)

        let passage = itemJSON(id: "n2", metadata: #"{"research":{"version":1,"kind":"transcriptPassage","sourceId":"t1","audioId":"a1","attachmentId":"att1","sha256":"\#(Self.sha)","fingerprint":"fp","identity":"y","from":1,"to":2,"start":61.5,"end":70,"quote":"Ship it","locator":{"audioId":"a1","attachmentId":"att1","start":61.5,"end":70}}}"#)
        #expect(ResearchLink.decode(fromItemJSON: Data(passage.utf8))?.location == ResearchLocation(sourceId: "a1", start: 61.5, quote: "Ship it"))
        #expect(ResearchLink.decode(fromItemJSON: Data(itemJSON(id: "n3").utf8)) == nil)
        #expect(ResearchLink.decode(fromItemJSON: Data(itemJSON(id: "n4", metadata: #"{"research":{"version":2,"kind":"pdfAnnotation","sourceId":"p1"}}"#).utf8)) == nil)
    }

    @Test func citationLocatorsOpenAtTheirPlace() throws {
        let json = #"{"answer":"See [1] and [2].","sources":[{"n":1,"id":"n1","title":"Notes","url":null,"type":"note","locator":{"kind":"pdf","sourceId":"p1","sha256":"\#(Self.sha)","page":4,"quote":"frost"}},{"n":2,"id":"n2","title":"Standup","url":null,"type":"note","locator":{"kind":"audio","sourceId":"a1","sha256":"\#(Self.sha)","start":12.5,"end":15,"quote":"Ship it"}}]}"#
        let answer = try JSONCoding.makeDecoder().decode(CitedAnswer.self, from: Data(json.utf8))
        #expect(answer.sources[0].locator?.location == ResearchLocation(sourceId: "p1", page: 4, quote: "frost"))
        #expect(answer.sources[1].locator?.location == ResearchLocation(sourceId: "a1", start: 12.5, quote: "Ship it"))
    }

    @Test func transcriptFindsTheCuePlayingAtATime() throws {
        let json = #"{"id":"t1","title":"Standup transcript","audioId":"a1","audio":null,"audioStatus":"missing","fingerprint":"fp","format":"srt","engine":"","duration":9,"segments":[{"start":0,"end":3,"text":"One"},{"start":3,"end":5,"text":"Two"},{"start":7,"end":9,"text":"Three"}],"createdAt":"2026-10-01T08:00:00.000Z","updatedAt":"2026-10-01T08:00:00.000Z"}"#
        let transcript = try JSONCoding.makeDecoder().decode(Transcript.self, from: Data(json.utf8))
        #expect(transcript.audioStatus == .missing)
        #expect(transcript.segmentIndex(at: 0) == 0 && transcript.segmentIndex(at: 4) == 1 && transcript.segmentIndex(at: 6) == 1 && transcript.segmentIndex(at: 8) == 2)
    }
}
