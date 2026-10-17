import EnveMemoryKit
import Foundation
import Observation

/// The paired server: credentials, reachability, and a revision screens watch to reload after writes.
@Observable
final class Connection {
    enum Status: Equatable {
        case unknown
        case checking
        case online(ServerStatus, ClientInfo)
        case offline(String)
        case unauthorized
    }

    private(set) var pairing: Pairing? {
        didSet { library = pairing.map { OfflineLibrary(baseURL: $0.baseURL, token: $0.token) } }
    }
    private(set) var status: Status = .unknown
    private(set) var revision = 0
    /// This pairing's offline copy of the ordinary library.
    @ObservationIgnored private(set) var library: OfflineLibrary?

    private let store: CredentialStore
    let session: URLSession
    /// For vault, share-creation and AI calls: no URL cache, cookies or credential storage at all.
    private let privateSession: URLSession

    init(store: CredentialStore = KeychainCredentialStore()) {
        self.store = store
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
        let ephemeral = URLSessionConfiguration.ephemeral
        ephemeral.urlCache = nil
        ephemeral.requestCachePolicy = .reloadIgnoringLocalCacheData
        ephemeral.timeoutIntervalForRequest = 60
        privateSession = URLSession(configuration: ephemeral)
        pairing = try? store.load()
        library = pairing.map { OfflineLibrary(baseURL: $0.baseURL, token: $0.token) }
    }

    var client: APIClient? {
        pairing.map { APIClient(pairing: $0, session: session) }
    }

    /// Online-only calls whose bodies or answers must never be cached or queued.
    var privateClient: APIClient? {
        pairing.map { APIClient(baseURL: $0.baseURL, token: $0.token, session: privateSession, timeout: 90) }
    }

    var isOnline: Bool {
        if case .online = status { true } else { false }
    }

    /// The token's scopes as last confirmed by the server; empty until then.
    var scopes: [String] {
        if case .online(_, let me) = status { me.scopes } else { [] }
    }

    /// The vault is offered only when the token was explicitly granted `secrets`.
    var canUseVault: Bool { scopes.contains("secrets") }

    var responseCache: ResponseCache? {
        pairing.map { ResponseCache(baseURL: $0.baseURL, token: $0.token) }
    }

    /// Fetches a regular read, falling back to this phone's copies when the server can't be reached: the saved answer
    /// or the offline library, whichever is newer (a saved item page wins, since only it has the archived text and files).
    /// A refused token or permission is reported, never papered over with saved data.
    func load<T: Decodable>(_ endpoint: Endpoint, as type: T.Type = T.self) async throws -> Loaded<T> {
        guard let pairing, let client, let cache = responseCache else { throw APIError.unreachable(.notConnectedToInternet) }
        let library = self.library
        do {
            let data = try await client.data(for: endpoint)
            guard pairing == self.pairing else { throw CancellationError() }
            let value = try Self.decode(T.self, from: data)
            cache.store(data, for: endpoint)
            return Loaded(value: value, cachedAt: nil)
        } catch let error as APIError where error.allowsCachedFallback {
            note(error)
            guard pairing == self.pairing else { throw CancellationError() }
            let saved = cache.load(endpoint)
            let snapshot = await library?.answer(endpoint)
            var candidates = [saved, snapshot].compactMap(\.self)
            if !(endpoint.path.hasPrefix("/items/") && endpoint.path.split(separator: "/").count == 2) {
                candidates.sort { $0.savedAt > $1.savedAt }
            }
            for candidate in candidates {
                if let value = try? Self.decode(T.self, from: candidate.data) { return Loaded(value: value, cachedAt: candidate.savedAt) }
            }
            throw error
        }
    }

    private static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONCoding.makeDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    func refresh() async {
        guard let client else { return }
        if case .unknown = status { status = .checking }
        do {
            async let server = client.status()
            async let me = client.whoami()
            status = .online(try await server, try await me)
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch is CancellationError {
            return
        } catch {
            status = .offline(error.localizedDescription)
        }
    }

    /// Checks the server and token before anything is stored.
    func verify(baseURL: URL, token: String) async throws -> Pairing {
        let client = APIClient(baseURL: baseURL, token: token, session: session)
        let server = try await client.status()
        guard server.name == "enve-memory" else { throw APIError.unexpectedResponse(status: 200) }
        let me = try await client.whoami()
        return Pairing(baseURL: baseURL, token: token, clientName: me.name, serverVersion: server.version)
    }

    func adopt(_ pairing: Pairing) throws {
        try store.save(pairing)
        forgetServerCaches()
        self.pairing = pairing
        status = .unknown
        revision += 1
    }

    func unpair() throws {
        try store.delete()
        forgetServerCaches()
        pairing = nil
        status = .unknown
    }

    /// Lets any failed call update the status line without waiting for the next check.
    func note(_ error: Error) {
        guard let error = error as? APIError else { return }
        if error.isUnauthorized {
            status = .unauthorized
        } else if case .unreachable = error {
            status = .offline(error.localizedDescription)
        }
    }

    /// Project ids, cached reads and the offline library belong to one library; after re-pairing, nothing of the old one may show.
    private func forgetServerCaches() {
        let settings = SharedSettings()
        settings.cachedProjects = []
        settings.lastProjectID = nil
        ResponseCache.removeAll()
        OfflineLibrary.removeAll()
        if let library { Task { await library.discard() } }
    }

    func didWrite() {
        revision += 1
    }
}

struct Loaded<Value> {
    let value: Value
    /// When this phone saved the copy being shown; nil for a fresh answer.
    let cachedAt: Date?
}

extension APIError {
    /// No answer, or a server failure: the saved copy is still the best thing to show. A revoked pairing isn't.
    var allowsCachedFallback: Bool {
        switch self {
        case .unreachable: true
        case .server(let status, _, _), .unexpectedResponse(let status): status >= 500
        case .decoding: false
        }
    }
}
