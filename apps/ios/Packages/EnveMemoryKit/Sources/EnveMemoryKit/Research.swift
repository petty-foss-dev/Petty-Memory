import Foundation

/// The server's limits for PDF and recording research (`RESEARCH_LIMITS` in core, caption and transcription limits in ingestion).
public enum ResearchLimits {
    public static let pdfPreviewBytes = 32 * 1024 * 1024
    public static let audioBytes = 25 * 1024 * 1024
    /// The caption parser takes 5 MB, but the whole request must fit the server's 2 MB JSON body.
    public static let captionBytes = 2 * 1024 * 1024 - 64 * 1024
    public static let quoteChars = 5_000
    public static let noteChars = 20_000
    public static let ocrChars = 100_000
    public static let pageBatch = 50
    public static let findChars = 500
    public static let findResults = 50
    public static let passageSegments = 50
    public static let tags = 20
}

/// Where a citation or research note points inside an original PDF or recording.
public struct ResearchLocation: Codable, Hashable, Sendable {
    public var sourceId: String
    public var page: Int?
    public var start: Double?
    public var quote: String?

    public init(sourceId: String, page: Int? = nil, start: Double? = nil, quote: String? = nil) {
        self.sourceId = sourceId
        self.page = page
        self.start = start
        self.quote = quote?.isEmpty == true ? nil : quote
    }
}

extension CitedAnswer.Locator {
    public var location: ResearchLocation {
        ResearchLocation(sourceId: sourceId, page: kind == "pdf" ? page : nil, start: kind == "audio" ? start : nil, quote: quote)
    }
}

public enum PdfTextSource: String, Codable, Hashable, Sendable {
    case pdf, ocr
}

public struct PdfSource: Decodable, Hashable, Identifiable, Sendable {
    public enum Status: String, Decodable, Hashable, Sendable {
        case ready, pending, unavailable
    }

    public struct OcrPage: Decodable, Hashable, Sendable {
        public let page: Int
        public let id: String
    }

    public let id: String
    public let title: String
    public let attachmentId: String
    public let sha256: String
    public let filename: String
    public let status: Status
    public let pageCount: Int
    /// Pages whose text the library keeps, from page 1.
    public let storedPages: Int
    public let truncated: Bool
    public let clipped: [Int]
    public let ocrPages: [OcrPage]
    public let annotations: Int
}

public struct PdfPage: Decodable, Hashable, Identifiable, Sendable {
    public struct ReviewedOCR: Decodable, Hashable, Sendable {
        public let id: String
        public let text: String
        public let updatedAt: Date
    }

    public let page: Int
    public let text: String
    /// False beyond the pages the library keeps; reviewed OCR can still supply their text.
    public let available: Bool
    public let clipped: Bool
    public let ocr: ReviewedOCR?

    public var id: Int { page }
}

public struct PdfPageRange: Decodable, Hashable, Sendable {
    public let sourceId: String
    public let sha256: String
    public let pageCount: Int
    public let storedPages: Int
    public let truncated: Bool
    public let pages: [PdfPage]
}

public struct PdfMatch: Decodable, Hashable, Sendable {
    public let page: Int
    public let textSource: PdfTextSource
    public let start: Int
    public let end: Int
    public let excerpt: String
}

public struct TextSpan: Codable, Hashable, Sendable {
    public let start: Int
    public let end: Int
}

/// UTF-16 offsets into the page text, plus the text around them.
public struct AnnotationLocator: Codable, Hashable, Sendable {
    public let page: Int
    public let start: Int
    public let end: Int
    public let prefix: String
    public let suffix: String
}

public struct PdfAnnotation: Decodable, Hashable, Identifiable, Sendable {
    public enum Status: String, Decodable, Hashable, Sendable {
        case current, moved, stale
        case sourceMissing = "source-missing"
        case sourceChanged = "source-changed"

        public var label: String {
            switch self {
            case .current: "Current"
            case .moved: "Moved on the page"
            case .stale: "Quote no longer on the page"
            case .sourceMissing: "PDF missing"
            case .sourceChanged: "PDF replaced"
            }
        }
    }

    public let id: String
    public let title: String
    public let body: String
    public let sourceId: String
    public let sha256: String
    public let page: Int
    public let quote: String
    public let textSource: PdfTextSource
    public let ocrId: String?
    public let locator: AnnotationLocator
    public let status: Status
    /// Where the quote is now, for `current` and `moved`.
    public let current: TextSpan?
    public let createdAt: Date
}

/// Only what the server accepts; the quote must exist on that page of the PDF text or its reviewed OCR.
public struct AnnotationInput: Encodable, Hashable, Sendable {
    public var sourceId: String
    public var page: Int
    public var quote: String
    public var sha256: String
    public var note: String?
    public var textSource: PdfTextSource?
    public var occurrence: Int?
    public var project: String?
    public var tags: [String]?

    public init(sourceId: String, page: Int, quote: String, sha256: String, note: String? = nil, textSource: PdfTextSource? = nil,
                occurrence: Int? = nil, project: String? = nil, tags: [String]? = nil) {
        self.sourceId = sourceId
        self.page = page
        self.quote = quote
        self.sha256 = sha256
        self.note = note?.isEmpty == true ? nil : note
        self.textSource = textSource
        self.occurrence = occurrence
        self.project = project
        self.tags = tags?.isEmpty == true ? nil : tags
    }
}

/// Reviewed text for one rendered page; `sha256` is the PDF the page was rendered from.
public struct OcrPageInput: Encodable, Hashable, Sendable {
    public var sourceId: String
    public var page: Int
    public var text: String
    public var sha256: String
    public var engine: String?

    public init(sourceId: String, page: Int, text: String, sha256: String, engine: String? = nil) {
        self.sourceId = sourceId
        self.page = page
        self.text = text
        self.sha256 = sha256
        self.engine = engine
    }
}

/// An ordinary note the server wrote (or had already written for the same input).
public struct CreatedNote: Decodable, Hashable, Sendable {
    public let item: ItemDetail
    public let created: Bool
}

/// Seconds from the start of the recording.
public struct TranscriptSegment: Codable, Hashable, Sendable {
    public let start: Double
    public let end: Double
    public let text: String
    public let speaker: String?

    public var spoken: String { speaker.map { "\($0): \(text)" } ?? text }
}

public struct AudioSource: Decodable, Hashable, Sendable {
    public let itemId: String
    public let title: String
    public let attachmentId: String
    public let sha256: String
    public let filename: String
    public let mimeType: String
    public let size: Int
}

public enum CaptionFormat: String, Codable, CaseIterable, Hashable, Sendable {
    case vtt, srt, json

    public static func guess(filename: String) -> CaptionFormat? {
        switch (filename as NSString).pathExtension.lowercased() {
        case "vtt": .vtt
        case "srt": .srt
        case "json": .json
        default: nil
        }
    }
}

public struct TranscriptFormat: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static let transcription = TranscriptFormat(rawValue: "transcription")

    public var label: String {
        switch rawValue {
        case "vtt": "WebVTT captions"
        case "srt": "SubRip captions"
        case "json": "Timed JSON"
        case "transcription": "Transcription server"
        default: rawValue
        }
    }
}

/// A reviewed import before it's saved. Nothing in it is stored until `SaveTranscriptInput` is sent.
public struct TranscriptPreview: Decodable, Hashable, Sendable {
    public let audio: AudioSource
    public let format: TranscriptFormat
    public let engine: String
    public let segments: [TranscriptSegment]
    public let segmentCount: Int
    public let duration: Double
    public let characters: Int
    public let overlaps: Int
    public let fingerprint: String
    public let existingId: String?
    /// Cues with no text once markup was removed.
    public let skipped: Int?
}

public struct TranscriptPreviewRequest: Encodable, Hashable, Sendable {
    public var audioId: String
    public var data: String
    public var format: CaptionFormat?

    public init(audioId: String, data: String, format: CaptionFormat? = nil) {
        self.audioId = audioId
        self.data = data
        self.format = format
    }
}

/// The accepted fields of a preview plus the person's title, project and tags; never the preview itself.
public struct SaveTranscriptInput: Encodable, Hashable, Sendable {
    public var audioId: String
    public var segments: [TranscriptSegment]
    public var format: TranscriptFormat
    public var engine: String?
    public var fingerprint: String
    public var title: String?
    public var project: String?
    public var tags: [String]?

    public init(preview: TranscriptPreview, title: String? = nil, project: String? = nil, tags: [String] = []) {
        audioId = preview.audio.itemId
        segments = preview.segments
        format = preview.format
        engine = preview.engine.isEmpty ? nil : preview.engine
        fingerprint = preview.fingerprint
        self.title = title?.isEmpty == true ? nil : title
        self.project = project
        self.tags = tags.isEmpty ? nil : tags
    }
}

public struct TranscriptSummary: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let fingerprint: String
    public let format: TranscriptFormat
    public let segmentCount: Int
    public let duration: Double
    public let createdAt: Date
}

public struct Transcript: Decodable, Hashable, Identifiable, Sendable {
    public enum AudioStatus: String, Decodable, Hashable, Sendable {
        case ok, missing, changed
    }

    public let id: String
    public let title: String
    public let audioId: String
    public let audio: AudioSource?
    public let audioStatus: AudioStatus
    public let fingerprint: String
    public let format: TranscriptFormat
    public let engine: String
    public let duration: Double
    public let segments: [TranscriptSegment]
    public let createdAt: Date
    public let updatedAt: Date

    /// The cue playing at `time`, or the last one before it.
    public func segmentIndex(at time: Double) -> Int? {
        var found: Int?
        for (index, segment) in segments.enumerated() {
            if segment.start > time { break }
            found = index
        }
        guard let last = found else { return nil }
        for index in stride(from: last, through: max(0, last - 7), by: -1) where time < segments[index].end { return index }
        return last
    }
}

public struct PassageInput: Encodable, Hashable, Sendable {
    public var transcriptId: String
    public var fingerprint: String
    /// Inclusive segment indexes.
    public var from: Int
    public var to: Int
    public var note: String?
    public var tags: [String]?

    public init(transcriptId: String, fingerprint: String, from: Int, to: Int, note: String? = nil, tags: [String]? = nil) {
        self.transcriptId = transcriptId
        self.fingerprint = fingerprint
        self.from = from
        self.to = to
        self.note = note?.isEmpty == true ? nil : note
        self.tags = tags?.isEmpty == true ? nil : tags
    }
}

public struct TranscriptPassage: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let transcriptId: String
    public let from: Int
    public let to: Int
    public let start: Double
    public let end: Double
    public let quote: String
    public let createdAt: Date
}

public struct PlayLocator: Decodable, Hashable, Sendable {
    public let audioId: String
    public let attachmentId: String
    public let sha256: String
    public let filename: String
    public let mimeType: String
    public let start: Double
    public let end: Double
}

/// Whether the library host has a transcription server configured. Its key never leaves the host.
public struct TranscriptionStatus: Decodable, Hashable, Sendable {
    public let configured: Bool
    public let baseUrl: String
    public let model: String

    public var host: String { URL(string: baseUrl)?.host() ?? baseUrl }
}

public struct AudioTranscripts: Decodable, Hashable, Sendable {
    public let transcripts: [TranscriptSummary]
}

/// Saved PDFs and recordings, 100 files at a time; `next` is the `before` cursor.
public struct ResearchSourcesPage: Decodable, Hashable, Sendable {
    public let items: [ItemDetail]
    public let next: String?
}

/// What a research note says about its source, read from the item's `metadata.research`.
public struct ResearchLink: Hashable, Sendable {
    public enum Kind: String, Hashable, Sendable {
        case pdfAnnotation, pdfOcrPage, transcript, transcriptPassage
    }

    public let kind: Kind
    /// The PDF, or the transcript for a passage, or the recording for a transcript.
    public let sourceId: String
    public let audioId: String?
    public let page: Int?
    public let start: Double?
    public let quote: String?

    /// Where it opens: the PDF page, or the recording at the passage's start.
    public var location: ResearchLocation {
        switch kind {
        case .pdfAnnotation, .pdfOcrPage: ResearchLocation(sourceId: sourceId, page: page, quote: quote)
        case .transcript: ResearchLocation(sourceId: sourceId)
        case .transcriptPassage: ResearchLocation(sourceId: audioId ?? sourceId, start: start, quote: quote)
        }
    }

    /// Reads the link from an item or item-detail response; nil for anything that isn't a research note.
    public static func decode(fromItemJSON data: Data) -> ResearchLink? {
        (try? JSONCoding.makeDecoder().decode(Probe.self, from: data))?.metadata.research?.link
    }

    public static func decode(fromMetadata metadata: JSONValue?) -> ResearchLink? {
        guard let metadata, let data = try? JSONCoding.makeEncoder().encode(metadata) else { return nil }
        return (try? JSONCoding.makeDecoder().decode(Record.self, from: data))?.link
    }

    private struct Probe: Decodable {
        struct Metadata: Decodable { let research: Record? }
        let metadata: Metadata
    }

    private struct Record: Decodable {
        let version: Int
        let kind: String
        let sourceId: String
        let audioId: String?
        let page: Int?
        let start: Double?
        let quote: String?

        var link: ResearchLink? {
            guard version == 1, let kind = Kind(rawValue: kind), !sourceId.isEmpty else { return nil }
            return ResearchLink(kind: kind, sourceId: sourceId, audioId: audioId, page: page, start: start, quote: quote)
        }
    }
}

extension Attachment {
    public var isPDF: Bool { mimeType == "application/pdf" }
    public var isAudio: Bool { mimeType.hasPrefix("audio/") }
}

private struct OcrRecognizeBody: Encodable {
    let sourceId: String
    let page: Int
    let sha256: String
    let png: String
}

private struct TranscribeBody: Encodable {
    let audioId: String
    let confirmed: Bool
}

extension Endpoint {
    public static func researchSources(before: String? = nil) -> Endpoint { get("/knowledge/research/sources", [("before", before)]) }
    public static func pdfSource(_ id: String) -> Endpoint { get("/knowledge/research/pdf/\(segment(id))") }
    public static func pdfPages(_ id: String, from: Int = 1, limit: Int = 20) -> Endpoint {
        get("/knowledge/research/pdf/\(segment(id))/pages", [("from", String(from)), ("limit", String(limit))])
    }
    public static func findInPdf(_ id: String, text: String, limit: Int? = nil) -> Endpoint {
        get("/knowledge/research/pdf/\(segment(id))/find", [("q", text), ("limit", limit.map(String.init))])
    }
    public static func pdfAnnotations(_ id: String, limit: Int? = nil) -> Endpoint {
        get("/knowledge/research/pdf/\(segment(id))/annotations", [("limit", limit.map(String.init))])
    }
    /// Asks the host to extract page text again for a PDF saved before it was kept. The file itself is unchanged.
    public static func indexPdf(_ id: String) -> Endpoint { post("/knowledge/research/pdf/\(segment(id))/index") }
    public static func annotate(_ input: AnnotationInput) throws -> Endpoint { try json("POST", "/knowledge/research/annotations", input) }
    public static func annotation(_ id: String) -> Endpoint { get("/knowledge/research/annotations/\(segment(id))") }
    public static func saveOcrPage(_ input: OcrPageInput) throws -> Endpoint { try json("POST", "/knowledge/research/ocr-pages", input) }
    /// Host OCR of one rendered page as PNG; answers a draft and saves nothing.
    public static func recognizePdfPage(sourceId: String, page: Int, sha256: String, png: Data) throws -> Endpoint {
        try transient("/knowledge/research/ocr", OcrRecognizeBody(sourceId: sourceId, page: page, sha256: sha256, png: png.base64EncodedString()))
    }

    public static func audioTranscripts(_ audioId: String) -> Endpoint { get("/knowledge/research/audio/\(segment(audioId))") }
    public static func previewTranscript(_ request: TranscriptPreviewRequest) throws -> Endpoint {
        try transient("/knowledge/research/transcripts/preview", request)
    }
    public static func saveTranscript(_ input: SaveTranscriptInput) throws -> Endpoint { try json("POST", "/knowledge/research/transcripts", input) }
    public static let transcriptionStatus = get("/knowledge/research/transcription")
    /// Sends the saved recording to the host's configured transcription server; answers a preview and saves nothing.
    public static func transcribe(audioId: String) throws -> Endpoint {
        try transient("/knowledge/research/transcribe", TranscribeBody(audioId: audioId, confirmed: true))
    }
    public static func transcript(_ id: String) -> Endpoint { get("/knowledge/research/transcripts/\(segment(id))") }
    public static func transcriptPassages(_ id: String, limit: Int? = nil) -> Endpoint {
        get("/knowledge/research/transcripts/\(segment(id))/passages", [("limit", limit.map(String.init))])
    }
    public static func audioLocator(_ id: String, segment index: Int? = nil) -> Endpoint {
        get("/knowledge/research/audio-locator/\(segment(id))", [("segment", index.map(String.init))])
    }
    public static func savePassage(_ input: PassageInput) throws -> Endpoint { try json("POST", "/knowledge/research/passages", input) }
}
