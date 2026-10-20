import Foundation

/// One `[M:SS] Speaker: words` turn the computer found in a transcript.
public struct BiscottiTurn: Codable, Hashable, Sendable {
    public let start: Double
    public let speaker: String
    public let text: String
}

/// A meeting from a Biscotti export as the computer read it; nothing is saved until it's imported.
public struct BiscottiPreviewEntry: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String
    /// An ISO timestamp; calendar-only dates arrive as midnight UTC.
    public let date: String
    public let summary: String
    public let notes: String
    public let transcript: String
    public let participants: [String]
    public let tags: [String]
    public let speakers: [String]
    /// At most `BiscottiImport.maxTurnsShown`, and never the text before the first time marker; `transcript` is what's imported.
    public let turns: [BiscottiTurn]
    /// The note an earlier import made. Importing again never overwrites it.
    public let existingId: String?
}

public struct BiscottiPreview: Codable, Hashable, Sendable {
    public struct Warning: Codable, Hashable, Sendable {
        public let row: Int
        public let message: String
    }

    public let entries: [BiscottiPreviewEntry]
    public let skipped: Int
    public let warnings: [Warning]
    /// Sent back with the import, which is refused if the export changed since this preview.
    public let fingerprint: String
    public let source: String

    public var importable: [BiscottiPreviewEntry] { entries.filter { $0.existingId == nil } }
}

public struct BiscottiImportResult: Codable, Hashable, Sendable {
    public struct Failure: Codable, Hashable, Sendable {
        public let source: String
        public let error: String
    }

    /// `created` is false when the meeting was already in the library; `id` is then the existing note.
    public struct Saved: Codable, Hashable, Identifiable, Sendable {
        public let id: String
        public let sourceId: String
        public let title: String
        public let created: Bool
    }

    public let created: Int
    public let skipped: Int
    public let failed: [Failure]
    public let items: [Saved]
}

/// An imported meeting: an ordinary note, described by the metadata the import gave it.
public struct BiscottiSavedMeeting: Codable, Hashable, Identifiable, Sendable {
    public struct Moment: Codable, Hashable, Sendable {
        public let start: Double
        public let speaker: String
    }

    public let id: String
    public let meetingId: String
    public let title: String
    public let date: String
    /// The start of the summary only; the note holds all of it.
    public let summary: String
    public let speakers: [String]
    public let participants: [String]
    public let project: ProjectRef?
    public let source: String
    public let moments: [Moment]
}

/// `next` is the `before` cursor of the page after this one.
public struct BiscottiMeetingPage: Codable, Hashable, Sendable {
    public let items: [BiscottiSavedMeeting]
    public let next: String?
}

public enum BiscottiImport {
    public static let maxBytes = 8 * 1024 * 1024
    /// The computer lists at most this many turns per meeting in a preview.
    public static let maxTurnsShown = 2000

    public enum Problem: LocalizedError, Equatable {
        case tooLarge(Int)
        case notText

        public var errorDescription: String? {
            switch self {
            case .tooLarge(let bytes):
                "This file is \(Int64(bytes).formatted(.byteCount(style: .file))). Export fewer meetings from Biscotti; files can be at most \(Int64(BiscottiImport.maxBytes).formatted(.byteCount(style: .file)))."
            case .notText:
                "This isn't a UTF-8 text file. Choose a CSV export from Biscotti."
            }
        }
    }

    /// The export's text, sent as is: the computer parses and validates the CSV.
    public static func text(from data: Data) throws -> String {
        guard data.count <= maxBytes else { throw Problem.tooLarge(data.count) }
        guard let text = String(data: data, encoding: .utf8), !text.contains("\0") else { throw Problem.notText }
        return text
    }
}

private struct BiscottiPreviewBody: Encodable {
    let data: String
    let source = "csv"
}

private struct BiscottiImportBody: Encodable {
    let data: String
    let source = "csv"
    let fingerprint: String
    let includeIds: [String]
    let project: String?
}

extension Endpoint {
    public static func biscottiMeetings(project: String? = nil, before: String? = nil, limit: Int? = nil) -> Endpoint {
        get("/meetings/biscotti", [("project", project), ("before", before), ("limit", limit.map(String.init))])
    }

    public static func previewBiscottiImport(_ csv: String) throws -> Endpoint {
        try transient("/imports/biscotti/preview", BiscottiPreviewBody(data: csv))
    }

    /// `includeIds` are preview entry ids; the import is refused if `csv` no longer matches `fingerprint`.
    public static func importBiscotti(_ csv: String, fingerprint: String, includeIds: [String], project: String?) throws -> Endpoint {
        try json("POST", "/imports/biscotti", BiscottiImportBody(data: csv, fingerprint: fingerprint, includeIds: includeIds, project: project))
    }
}
