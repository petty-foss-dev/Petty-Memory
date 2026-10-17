import Foundation

public struct ItemVersionSummary: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let itemId: String
    public let at: Date
    public let actor: String
    public let op: String

    /// The state an older library had when history began; nothing earlier was recorded.
    public var isBaseline: Bool { op == "baseline" }
    public var isDeletion: Bool { op == "delete" }
}

public struct VersionPage: Decodable, Hashable, Sendable {
    public let items: [ItemVersionSummary]
    public let total: Int
}

public struct VersionNode: Decodable, Hashable, Identifiable, Sendable {
    public let item: ItemDetail
    public let parentId: String?
    public let position: Double

    public var id: String { item.id }
}

/// The item and every descendant as they were at that version. Empty when the version records a deletion.
public struct VersionSnapshot: Decodable, Hashable, Sendable {
    public let rootId: String
    public let items: [VersionNode]

    public var root: VersionNode? { items.first { $0.item.id == rootId } }
}

public struct ItemVersion: Decodable, Hashable, Identifiable, Sendable {
    public let summary: ItemVersionSummary
    public let snapshot: VersionSnapshot

    public var id: String { summary.id }

    private enum CodingKeys: String, CodingKey { case snapshot }

    public init(from decoder: Decoder) throws {
        summary = try ItemVersionSummary(from: decoder)
        snapshot = try decoder.container(keyedBy: CodingKeys.self).decode(VersionSnapshot.self, forKey: .snapshot)
    }
}

/// A file a restored version refers to whose bytes aren't on the computer, so it came back without them.
public struct MissingFile: Codable, Hashable, Sendable {
    public let itemId: String
    public let attachmentId: String
    public let sha256: String
    public let filename: String
}

/// What `POST /versions/:id/restore`, `POST /vault/versions/:id/restore` and `POST /ai/undo` brought back.
public struct RestoreResult: Codable, Hashable, Sendable {
    public let restored: Int
    public let missingFiles: [MissingFile]?

    /// "Restored", or which files couldn't come back with it.
    public func summary(_ done: String) -> String {
        guard let missing = missingFiles, !missing.isEmpty else { return done }
        let names = missing.prefix(3).map(\.filename).joined(separator: ", ") + (missing.count > 3 ? " and \(missing.count - 3) more" : "")
        return "\(done), but \(missing.count == 1 ? "1 file isn't" : "\(missing.count) files aren't") on your computer any more: \(names)."
    }
}

extension Endpoint {
    public static func versions(_ itemID: String, offset: Int = 0, limit: Int = 30) -> Endpoint {
        get("/items/\(segment(itemID))/versions", [("offset", offset > 0 ? String(offset) : nil), ("limit", String(limit))])
    }
    public static func version(_ id: String) -> Endpoint { get("/versions/\(segment(id))") }
    public static func restoreVersion(_ id: String) -> Endpoint { post("/versions/\(segment(id))/restore") }

    /// A secret note's ciphertext-only history; needs `secrets` and a connection, like every vault call.
    public static func restoreSecretVersion(_ id: String) -> Endpoint {
        Endpoint(method: "POST", path: "/vault/versions/\(segment(id))/restore")
    }

    /// The response of a queued write worth reporting after the outbox sends it: a restore that couldn't bring files back.
    func completionNotice(for response: Data) -> RestoreResult? {
        let parts = path.split(separator: "/")
        guard method == "POST", parts.count == 3, parts[0] == "versions", parts[2] == "restore",
              let result = try? JSONCoding.makeDecoder().decode(RestoreResult.self, from: response),
              result.missingFiles?.isEmpty == false else { return nil }
        return result
    }
}
