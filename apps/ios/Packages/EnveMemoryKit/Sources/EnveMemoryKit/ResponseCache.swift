import CryptoKit
import Foundation

public struct CachedResponse: Sendable {
    public let data: Data
    public let savedAt: Date
}

/// Bodies of allowlisted regular reads, so the app can still browse while the server is unreachable.
/// One folder per paired server and token; nothing from the vault, history, shares or AI is ever stored,
/// and item metadata loses its ciphertext and AI suggestions on the way in.
public struct ResponseCache: Sendable {
    public let directory: URL

    public init(root: URL = ResponseCache.defaultRoot, baseURL: URL, token: String) {
        directory = root.appending(path: Self.digest("\(baseURL.absoluteString)\n\(token)"), directoryHint: .isDirectory)
    }

    public static var defaultRoot: URL { URL.applicationSupportDirectory.appending(path: "ResponseCache", directoryHint: .isDirectory) }

    public static func removeAll(root: URL = defaultRoot) {
        try? FileManager.default.removeItem(at: root)
    }

    public static func isCacheable(_ endpoint: Endpoint) -> Bool {
        guard endpoint.method == "GET", !endpoint.query.contains(where: { $0.name == "secret" }) else { return false }
        let parts = endpoint.path.split(separator: "/").map(String.init)
        switch (parts.first, parts.count) {
        case ("items", 1), ("items", 2), ("outline", 1), ("outline", 2), ("projects", 1), ("projects", 2),
             ("tasks", 1), ("search", 1), ("reminders", 1), ("views", 1), ("views", 2), ("templates", 1):
            return true
        case ("views", 3):
            return parts[2] == "items"
        case ("items", 3):
            return ["references", "checklist", "presentation"].contains(parts[2])
        case ("outline", 3):
            return parts[2] == "ancestors"
        default:
            return false
        }
    }

    public func store(_ data: Data, for endpoint: Endpoint) {
        guard Self.isCacheable(endpoint), let data = Self.sanitized(data) else { return }
        do {
            var folder = directory
            if !FileManager.default.fileExists(atPath: folder.path) {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try folder.setResourceValues(values)
            }
            try data.write(to: file(for: endpoint), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            return
        }
    }

    public func load(_ endpoint: Endpoint) -> CachedResponse? {
        guard Self.isCacheable(endpoint) else { return nil }
        let url = file(for: endpoint)
        guard let data = try? Data(contentsOf: url) else { return nil }
        let savedAt = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        return CachedResponse(data: data, savedAt: savedAt)
    }

    /// The body without any item's `metadata.vault` or `metadata.ai`; nil when it isn't JSON.
    static func sanitized(_ data: Data) -> Data? {
        func clean(_ value: Any, isMetadata: Bool = false) -> Any {
            if var object = value as? [String: Any] {
                if isMetadata {
                    object["vault"] = nil
                    object["ai"] = nil
                }
                for (key, child) in object { object[key] = clean(child, isMetadata: key == "metadata") }
                return object
            }
            if let array = value as? [Any] { return array.map { clean($0) } }
            return value
        }
        guard let value = try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) else { return nil }
        return try? JSONSerialization.data(withJSONObject: clean(value), options: .fragmentsAllowed)
    }

    private func file(for endpoint: Endpoint) -> URL {
        let key = endpoint.path + "?" + endpoint.query.map { "\($0.name)=\($0.value)" }.joined(separator: "&")
        return directory.appending(path: Self.digest(key) + ".json")
    }

    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
