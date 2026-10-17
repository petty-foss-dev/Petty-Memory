import Foundation

public struct OutboxEntry: Codable, Hashable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case note, link, task, file, edit
    }

    public let id: UUID
    public let createdAt: Date
    public let kind: Kind
    public let title: String
    public let endpoint: Endpoint
    /// Sent as `Idempotency-Key` on every attempt, so the server applies the write once however often it's retried.
    public let idempotencyKey: String
    /// File name of the upload body inside the outbox directory.
    public let attachment: String?
    public var attempts: Int
    public var nextAttemptAt: Date
    public var lastError: String?
    /// The server rejected it; only an explicit retry sends it again.
    public var needsAttention: Bool
}

/// A queued write that went through but needs saying: a restore whose files didn't all come back.
public struct OutboxNotice: Codable, Hashable, Identifiable, Sendable {
    public let id: UUID
    public let title: String
    public let at: Date
    public let result: RestoreResult

    public var message: String { "\(title): \(result.summary("restored"))" }
}

public enum OutboxError: Error, LocalizedError {
    case onlineOnly

    public var errorDescription: String? { "This needs a connection to your Petty Memory server. Try again when you're back on your network." }
}

public struct FlushReport: Hashable, Sendable {
    public var sent = 0
    public var failed = 0
    public var remaining = 0
}

/// Captures that couldn't reach the server. One JSON file per entry (plus its upload body) in the
/// App Group container, so the share extension can enqueue while the app owns flushing.
public actor Outbox {
    public nonisolated let directory: URL
    private let now: @Sendable () -> Date
    private var isFlushing = false
    private var inFlight: UUID?

    public init(directory: URL = AppGroup.outboxDirectory, now: @escaping @Sendable () -> Date = { .now }) {
        self.directory = directory
        self.now = now
    }

    /// Moves `attachment` (if any) into the outbox, so the caller's copy may be temporary. Keeps the endpoint's
    /// idempotency key when it has one: a direct attempt whose response was lost must retry under the same key.
    @discardableResult
    public func enqueue(_ endpoint: Endpoint, kind: OutboxEntry.Kind, title: String, attachment: URL? = nil) throws -> OutboxEntry {
        guard !endpoint.isOnlineOnly else { throw OutboxError.onlineOnly }
        var endpoint = endpoint
        let key = endpoint.idempotencyKey ?? Endpoint.newKey()
        endpoint.headers[Endpoint.idempotencyHeader] = key
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let id = UUID()
        var attachmentName: String?
        if let attachment {
            let name = "\(id.uuidString).upload"
            try FileManager.default.moveItem(at: attachment, to: directory.appending(path: name))
            attachmentName = name
        }
        // Strictly increasing (at the millisecond precision we persist) so a multi-file share keeps its order.
        let currentMillisecond = (now().timeIntervalSince1970 * 1000).rounded(.down)
        let previousMillisecond = entries().last.map { ($0.createdAt.timeIntervalSince1970 * 1000).rounded() } ?? -.infinity
        let millisecond = max(currentMillisecond, previousMillisecond + 1)
        let createdAt = Date(timeIntervalSince1970: (millisecond + 0.25) / 1000)
        let entry = OutboxEntry(id: id, createdAt: createdAt, kind: kind, title: title, endpoint: endpoint, idempotencyKey: key, attachment: attachmentName,
                                attempts: 0, nextAttemptAt: now(), lastError: nil, needsAttention: false)
        try write(entry)
        return entry
    }

    public func entries() -> [OutboxEntry] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        let decoder = JSONCoding.makeDecoder()
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { try? decoder.decode(OutboxEntry.self, from: Data(contentsOf: $0)) }
            .sorted { $0.createdAt < $1.createdAt }
    }

    /// Sends entries strictly oldest first: later edits may build on earlier ones (a move of a note created offline, an undo
    /// of a queued action), so a retryable failure or a pending backoff holds everything behind it. Refused entries wait for
    /// the user without blocking the rest. Concurrent calls collapse into the one already running.
    public func flush(using client: APIClient, ignoringBackoff: Bool = false) async -> FlushReport {
        guard !isFlushing else { return FlushReport(remaining: entries().count) }
        isFlushing = true
        defer { isFlushing = false }

        var report = FlushReport()
        for var entry in entries() where !entry.needsAttention {
            guard ignoringBackoff || entry.nextAttemptAt <= now() else { break }
            guard exists(entry.id) else { continue }
            let upload = entry.attachment.map { directory.appending(path: $0) }
            if let upload, !FileManager.default.fileExists(atPath: upload.path) {
                entry.needsAttention = true
                entry.lastError = "The file to upload is missing."
                try? write(entry)
                report.failed += 1
                continue
            }
            inFlight = entry.id
            defer { inFlight = nil }
            do {
                let response = try await client.data(for: entry.endpoint, uploadingFile: upload)
                if let result = entry.endpoint.completionNotice(for: response) {
                    try? write(OutboxNotice(id: entry.id, title: entry.title, at: now(), result: result))
                }
                remove(entry.id)
                report.sent += 1
            } catch is CancellationError {
                break
            } catch {
                guard exists(entry.id) else { continue }
                let apiError = error as? APIError
                entry.attempts += 1
                entry.lastError = error.localizedDescription
                let retryable = apiError?.isRetryable ?? false
                if retryable {
                    entry.nextAttemptAt = now().addingTimeInterval(Self.backoff(afterAttempts: entry.attempts))
                } else {
                    entry.needsAttention = true
                    report.failed += 1
                }
                try? write(entry)
                if retryable { break }
            }
        }
        report.remaining = entries().count
        return report
    }

    public func retry(_ id: UUID) {
        guard var entry = entries().first(where: { $0.id == id }) else { return }
        entry.needsAttention = false
        entry.nextAttemptAt = now()
        try? write(entry)
    }

    /// Reports kept from sent entries, oldest first, until dismissed.
    public func notices() -> [OutboxNotice] {
        let files = (try? FileManager.default.contentsOfDirectory(at: noticesDirectory, includingPropertiesForKeys: nil)) ?? []
        let decoder = JSONCoding.makeDecoder()
        return files.compactMap { try? decoder.decode(OutboxNotice.self, from: Data(contentsOf: $0)) }.sorted { $0.at < $1.at }
    }

    public func dismissNotice(_ id: UUID) {
        try? FileManager.default.removeItem(at: noticesDirectory.appending(path: "\(id.uuidString).json"))
    }

    /// Takes back an entry that hasn't reached the server, as undoing an unsent action does. False once it's being sent.
    public func withdraw(_ id: UUID) -> Bool {
        guard inFlight != id, exists(id) else { return false }
        remove(id)
        return true
    }

    public func remove(_ id: UUID) {
        let fm = FileManager.default
        try? fm.removeItem(at: entryURL(id))
        try? fm.removeItem(at: directory.appending(path: "\(id.uuidString).upload"))
    }

    /// 30 s, 1 min, 2 min … capped at an hour.
    public static func backoff(afterAttempts attempts: Int) -> TimeInterval {
        min(30 * pow(2, Double(max(attempts, 1) - 1)), 3600)
    }

    private func exists(_ id: UUID) -> Bool {
        FileManager.default.fileExists(atPath: entryURL(id).path)
    }

    private func entryURL(_ id: UUID) -> URL {
        directory.appending(path: "\(id.uuidString).json")
    }

    private var noticesDirectory: URL { directory.appending(path: "Notices", directoryHint: .isDirectory) }

    private func write(_ notice: OutboxNotice) throws {
        try FileManager.default.createDirectory(at: noticesDirectory, withIntermediateDirectories: true)
        try JSONCoding.makeEncoder().encode(notice).write(to: noticesDirectory.appending(path: "\(notice.id.uuidString).json"), options: .atomic)
    }

    private func write(_ entry: OutboxEntry) throws {
        try JSONCoding.makeEncoder().encode(entry).write(to: entryURL(entry.id), options: .atomic)
    }
}
