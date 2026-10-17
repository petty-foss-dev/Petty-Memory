import Foundation

public struct PublicShare: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let rootId: String
    public let createdAt: Date
    public let expiresAt: Date?
    public let revokedAt: Date?
    public let excludedIds: [String]

    public func isActive(now: Date = .now) -> Bool {
        revokedAt == nil && (expiresAt.map { $0 > now } ?? true)
    }
}

/// The capability token appears only in this response. Keep it in transient state; never persist it.
public struct CreatedShare: Decodable, Sendable {
    public let share: PublicShare
    public let token: String

    /// `<server>/s/<token>`: the read-only public page. It carries no private credential.
    public func link(on baseURL: URL) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        let basePath = components.percentEncodedPath.hasSuffix("/") ? String(components.percentEncodedPath.dropLast()) : components.percentEncodedPath
        components.percentEncodedPath = basePath + "/s/" + Endpoint.percentEncoded(token)
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        return components.url!
    }
}

private struct CreateShareBody: Encodable {
    let rootId: String
    let excludedIds: [String]
    let expiresAt: String?
}

extension Endpoint {
    public static let shares = get("/shares")

    public static func createShare(rootId: String, excludedIds: [String], expiresAt: Date?) throws -> Endpoint {
        try json("POST", "/shares", CreateShareBody(rootId: rootId, excludedIds: excludedIds, expiresAt: expiresAt.map(JSONCoding.formatTimestamp)))
    }

    public static func revokeShare(_ id: String) -> Endpoint { post("/shares/\(segment(id))/revoke") }
}
