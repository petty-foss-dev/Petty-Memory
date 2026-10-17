import Foundation

public enum JSONCoding {
    public static func parseTimestamp(_ value: String) -> Date? {
        if let date = try? Date(value, strategy: fractional) { return date }
        return try? Date(value, strategy: .iso8601)
    }

    // Truncate milliseconds without shifting parsed timestamps or delaying a just-queued write.
    public static func formatTimestamp(_ date: Date) -> String {
        let millisecond = (date.timeIntervalSince1970 * 1000 + 0.001).rounded(.down)
        return Date(timeIntervalSince1970: (millisecond + 0.1) / 1000).formatted(fractional)
    }

    public static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            guard let date = parseTimestamp(raw) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not an ISO 8601 timestamp: \(raw)")
            }
            return date
        }
        return decoder
    }

    public static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(formatTimestamp(date))
        }
        return encoder
    }

    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
}
