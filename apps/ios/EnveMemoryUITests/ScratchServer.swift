import Foundation
import XCTest

/// Fixture values from the runner's environment. xcodebuild hands `TEST_RUNNER_<NAME>` to the runner as `<NAME>`;
/// the prefixed name is read too for runs started from a scheme's environment.
enum Fixture {
    static func value(_ name: String) -> String? {
        let environment = ProcessInfo.processInfo.environment
        guard let value = environment[name] ?? environment["TEST_RUNNER_\(name)"], !value.isEmpty else { return nil }
        return value
    }

    static func required(_ name: String, for purpose: String) throws -> String {
        guard let value = value(name) else {
            throw XCTSkip("Set TEST_RUNNER_\(name) to run \(purpose) against a scratch Petty Memory server.")
        }
        return value
    }

    static var timeout: TimeInterval { value("MEMORY_UI_TIMEOUT").flatMap(TimeInterval.init) ?? 20 }
}

struct FixtureError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

/// The scratch server named by the pairing link, read straight over its API to confirm what the UI did.
/// The token goes only into request headers; nothing here prints it or the link.
struct ScratchServer {
    let link: String
    /// As the app shows it in Settings: no trailing slash.
    let address: String
    private let baseURL: URL
    private let token: String

    init() throws {
        link = try Fixture.required("MEMORY_PAIRING_LINK", for: "the native UI tests")
        let query = URLComponents(string: link.trimmingCharacters(in: .whitespacesAndNewlines))
        guard let query, query.scheme?.lowercased() == "enve-memory", query.host?.lowercased() == "pair",
              var raw = query.queryItems?.first(where: { $0.name == "url" })?.value,
              let token = query.queryItems?.first(where: { $0.name == "token" })?.value, token.hasPrefix("em_")
        else { throw FixtureError("MEMORY_PAIRING_LINK isn't an enve-memory://pair link with a url and an em_ token.") }
        while raw.hasSuffix("/") { raw.removeLast() }
        guard let baseURL = URL(string: raw), baseURL.host() != nil else { throw FixtureError("The pairing link's url isn't a server address.") }
        self.baseURL = baseURL
        self.token = token
        address = baseURL.absoluteString
    }

    func whoami() async throws -> [String: Any] {
        try await object("/whoami")
    }

    func item(_ id: String) async throws -> [String: Any] {
        try await object("/items/\(id)")
    }

    /// Pages the top level, archived notes included, for the note with exactly this title.
    func topLevelNote(titled title: String) async throws -> [String: Any]? {
        var offset = 0
        while true {
            let page = try await object("/outline", [
                URLQueryItem(name: "archived", value: "true"),
                URLQueryItem(name: "offset", value: String(offset)),
                URLQueryItem(name: "limit", value: "100"),
            ])
            let entries = (page["items"] as? [[String: Any]] ?? []).compactMap { $0["item"] as? [String: Any] }
            if let match = entries.first(where: { $0["title"] as? String == title }) { return match }
            offset += entries.count
            guard !entries.isEmpty, offset < page["total"] as? Int ?? 0 else { return nil }
        }
    }

    private func object(_ path: String, _ query: [URLQueryItem] = []) async throws -> [String: Any] {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { throw FixtureError("Bad server address.") }
        components.path += "/api/v1" + path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw FixtureError("Bad API path \(path).") }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let data: Data, response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw FixtureError("The test runner couldn't reach the scratch server for GET \(path): \(error.localizedDescription)")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw FixtureError("GET \(path) answered HTTP \(status).") }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw FixtureError("GET \(path) didn't answer with a JSON object.")
        }
        return object
    }
}
