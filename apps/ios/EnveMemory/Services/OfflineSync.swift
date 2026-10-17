import EnveMemoryKit
import Foundation
import Observation

/// Keeps the offline library current while the app is in the foreground: pulls the feed, then long-polls for the next
/// change and pulls again. Screens reload once a pull has saved something new, never just because a change was announced.
/// Backs off when the server or the disk fails.
@Observable
final class OfflineSync {
    private(set) var summary: OfflineLibrary.Summary?
    private(set) var isRefreshing = false
    private(set) var lastError: String?

    private let connection: Connection
    /// A long-poll is quiet for up to 25 s, longer than ordinary requests may idle.
    private let pollSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 40
        config.waitsForConnectivity = false
        config.urlCache = nil
        return URLSession(configuration: config)
    }()

    init(connection: Connection) {
        self.connection = connection
    }

    /// Runs until cancelled (backgrounding, unpairing, going offline) or the pairing is refused.
    func run() async {
        guard let library = connection.library, let pairing = connection.pairing, let client = connection.client,
              let cache = connection.responseCache else { return }
        summary = await library.summary()
        guard connection.isOnline else { return }
        let poll = APIClient(baseURL: pairing.baseURL, token: pairing.token, session: pollSession, timeout: 40)
        var failures = 0
        var changed = true
        while !Task.isCancelled {
            do {
                if changed {
                    isRefreshing = true
                    defer { isRefreshing = false }
                    var saved = false
                    var progress: OfflineLibrary.Progress
                    repeat {
                        progress = try await library.refresh(using: client, cache: cache)
                        saved = saved || progress.changed
                        summary = await library.summary()
                    } while progress.hasMore && !Task.isCancelled
                    lastError = nil
                    if saved { connection.didWrite() }
                }
                changed = try await library.waitForChange(using: poll)
                summary = await library.summary()
                failures = 0
            } catch is CancellationError {
                return
            } catch {
                lastError = error.localizedDescription
                connection.note(error)
                if let error = error as? APIError, !error.allowsCachedFallback { return }
                failures += 1
                changed = true
                try? await Task.sleep(for: .seconds(min(5 * pow(2, Double(failures - 1)), 300)))
            }
        }
    }

    func reset() {
        summary = nil
        lastError = nil
    }
}
