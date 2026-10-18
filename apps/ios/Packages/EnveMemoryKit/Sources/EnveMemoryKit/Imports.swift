import Foundation

/// A book highlight or annotation from an Enve export, as the computer read it.
public struct EnveHighlight: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let bookTitle: String
    public let author: String?
    public let text: String
    public let note: String?
    public let location: String?
    /// Already validated against the documented safe schemes by the computer.
    public let sourceUrl: String?

    public var sourceURL: URL? {
        guard let sourceUrl, let url = URL(string: sourceUrl),
              ["http", "https", "enve"].contains(url.scheme?.lowercased() ?? ""),
              url.user == nil, url.password == nil else { return nil }
        return url
    }
}

public struct EnveImportPreview: Codable, Hashable, Sendable {
    public let format: String
    public let entries: [EnveHighlight]
    public let skipped: Int

    public var books: Int { Set(entries.map(\.bookTitle)).count }
}

/// Repeated imports skip passages already in the library, so `skipped` includes them.
public struct EnveImportResult: Decodable, Hashable, Sendable {
    public struct Failure: Decodable, Hashable, Sendable {
        public let source: String
        public let error: String
    }

    public let created: Int
    public let skipped: Int
    public let failed: [Failure]
}

public enum EnveImport {
    /// The largest export the phone sends.
    public static let maxBytes = 2 * 1024 * 1024

    public enum Problem: LocalizedError, Equatable {
        case tooLarge(Int)
        case notText

        public var errorDescription: String? {
            switch self {
            case .tooLarge(let bytes):
                "This file is \(Int64(bytes).formatted(.byteCount(style: .file))). Export fewer passages at a time; files can be at most \(Int64(EnveImport.maxBytes).formatted(.byteCount(style: .file)))."
            case .notText:
                "This isn't a text file. Choose an Enve highlights export in JSON or Markdown."
            }
        }
    }

    /// The export's text, sent as is: the computer recognizes JSON and Enve's Markdown export.
    public static func text(from data: Data) throws -> String {
        guard data.count <= maxBytes else { throw Problem.tooLarge(data.count) }
        guard let text = String(data: data, encoding: .utf8), !text.contains("\0") else { throw Problem.notText }
        return text
    }
}

/// Text read from an image attachment; nothing is saved until the user captures it.
public struct ExtractedText: Codable, Hashable, Sendable {
    public let text: String
    public let engine: String
}

private struct ImportBody: Encodable {
    let data: String
    let project: String?
}

private struct OCRBody: Encodable { let attachmentId: String }

extension Endpoint {
    public static func previewEnveImport(_ text: String) throws -> Endpoint {
        try transient("/imports/enve-highlights/preview", ImportBody(data: text, project: nil))
    }

    public static func importEnveHighlights(_ text: String, project: String?) throws -> Endpoint {
        try json("POST", "/imports/enve-highlights", ImportBody(data: text, project: project))
    }

    public static func extractText(attachmentId: String) throws -> Endpoint {
        try transient("/capture/ocr", OCRBody(attachmentId: attachmentId))
    }
}
