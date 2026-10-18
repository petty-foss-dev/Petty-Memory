import Foundation

/// Something due for another look. Scheduling it again is journalled on the computer with its review history.
public struct ReviewCard: Codable, Hashable, Identifiable, Sendable {
    public let item: Item
    public let dueAt: Date?
    public let lastReviewedAt: Date?
    public let reviewCount: Int
    public let reason: String

    public var id: String { item.id }
}

public enum ReviewInterval {
    public static let tomorrow = 1
    public static let nextWeek = 7
    public static let nextMonth = 30
    /// Whole days the server accepts.
    public static let range = 1...3650

    public static func clamped(_ days: Int) -> Int { min(max(days, range.lowerBound), range.upperBound) }
}

private struct ReviewBody: Encodable { let days: Int }

extension Endpoint {
    public static func reviewQueue(limit: Int? = nil, project: String? = nil) -> Endpoint {
        get("/review", [("limit", limit.map(String.init)), ("project", project)])
    }

    /// Returns the updated item; `days` is clamped to what the server accepts.
    public static func scheduleReview(_ id: String, days: Int) throws -> Endpoint {
        try json("POST", "/review/\(segment(id))", ReviewBody(days: ReviewInterval.clamped(days)))
    }
}
