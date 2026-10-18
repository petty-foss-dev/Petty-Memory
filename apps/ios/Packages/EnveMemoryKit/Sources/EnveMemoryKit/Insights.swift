import Foundation

/// A note that mentions, resembles or may duplicate another. Found without AI.
public struct KnowledgeSuggestion: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let snippet: String
    public let reason: String
    public let score: Double
}

/// Discovery is bounded: it looked at `scanned` of `total` ordinary items.
public struct ItemInsights: Codable, Hashable, Sendable {
    public let itemId: String
    public let mentions: [KnowledgeSuggestion]
    public let related: [KnowledgeSuggestion]
    public let duplicates: [KnowledgeSuggestion]
    public let scanned: Int
    public let total: Int

    public var isBounded: Bool { scanned < total }
    public var isEmpty: Bool { mentions.isEmpty && related.isEmpty && duplicates.isEmpty }

    /// Leaves out what the user already connected or merged on this screen.
    public func removing(_ ids: Set<String>) -> ItemInsights {
        ItemInsights(itemId: itemId, mentions: mentions.filter { !ids.contains($0.id) }, related: related.filter { !ids.contains($0.id) },
                     duplicates: duplicates.filter { !ids.contains($0.id) }, scanned: scanned, total: total)
    }
}

/// A merge of `sourceId` into `targetId`, bound to both notes' current state. Sent back verbatim to merge.
public struct MergeProposal: Codable, Hashable, Sendable {
    public struct Preview: Codable, Hashable, Sendable {
        public let title: String
        public let body: String
        public let movedChildren: Int
        public let retainedAttachments: Int
    }

    public let sourceId: String
    public let targetId: String
    public let baseHash: String
    public let sourceTitle: String
    public let targetTitle: String
    public let preview: Preview
    public let raw: JSONValue

    private enum CodingKeys: String, CodingKey { case sourceId, targetId, baseHash, sourceTitle, targetTitle, preview }

    public init(from decoder: Decoder) throws {
        raw = try JSONValue(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sourceId = try c.decode(String.self, forKey: .sourceId)
        targetId = try c.decode(String.self, forKey: .targetId)
        baseHash = try c.decode(String.self, forKey: .baseHash)
        sourceTitle = try c.decode(String.self, forKey: .sourceTitle)
        targetTitle = try c.decode(String.self, forKey: .targetTitle)
        preview = try c.decode(Preview.self, forKey: .preview)
    }

    public func encode(to encoder: Encoder) throws {
        try raw.encode(to: encoder)
    }

    public var previewText: String { preview.body }
}

private struct MergePreviewBody: Encodable { let sourceId: String; let targetId: String }
private struct MergeBody: Encodable { let proposal: MergeProposal }

extension Endpoint {
    public static func insights(_ id: String) -> Endpoint { get("/items/\(segment(id))/insights") }

    public static func previewMerge(sourceId: String, targetId: String) throws -> Endpoint {
        try transient("/insights/merge/preview", MergePreviewBody(sourceId: sourceId, targetId: targetId))
    }

    /// Returns an `EditorActionResult`; `undoEditorAction` reverses it while nothing changed since.
    public static func merge(_ proposal: MergeProposal) throws -> Endpoint {
        try json("POST", "/insights/merge", MergeBody(proposal: proposal))
    }
}
