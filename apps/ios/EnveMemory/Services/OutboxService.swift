import EnveMemoryKit
import Foundation
import Observation

/// Sends writes, parking them in the shared outbox when the server can't be reached.
@Observable
final class OutboxService {
    enum Outcome {
        case sent(Data)
        case queued(OutboxEntry)
        case failed(Error)
    }

    private(set) var entries: [OutboxEntry] = [] {
        didSet { pending = PendingEdits(entries) }
    }
    private(set) var isFlushing = false
    /// Sent writes worth reporting, such as a restore that couldn't bring every file back. Kept until dismissed.
    private(set) var notices: [OutboxNotice] = []
    /// Queued edits, so screens can show them on top of the last loaded or cached state.
    private(set) var pending = PendingEdits()

    private let outbox: Outbox
    private let connection: Connection

    init(connection: Connection, outbox: Outbox = Outbox()) {
        self.connection = connection
        self.outbox = outbox
    }

    var pendingCount: Int { entries.count }

    func reload() async {
        entries = await outbox.entries()
        notices = await outbox.notices()
    }

    func dismiss(_ notice: OutboxNotice) async {
        await outbox.dismissNotice(notice.id)
        await reload()
    }

    /// `refresh: false` for signals (like "opened") that shouldn't make screens reload. While earlier writes are still
    /// waiting, a new one queues behind them, since it may build on them (a move of a note created offline).
    func submit(_ endpoint: Endpoint, kind: OutboxEntry.Kind, title: String, file: URL? = nil, refresh: Bool = true) async -> Outcome {
        await reload()
        if let client = connection.client, endpoint.isOnlineOnly || !entries.contains(where: { !$0.needsAttention }) {
            do {
                let data = try await client.data(for: endpoint, uploadingFile: file)
                if refresh { connection.didWrite() }
                return .sent(data)
            } catch let error as APIError where error.isRetryable {
                connection.note(error)
            } catch {
                return .failed(error)
            }
        }
        do {
            let entry = try await outbox.enqueue(endpoint, kind: kind, title: title, attachment: file)
            await reload()
            if connection.isOnline { Task { await flush(ignoringBackoff: false) } }
            return .queued(entry)
        } catch {
            return .failed(error)
        }
    }

    /// Takes back an entry before it's sent; false once it's on its way.
    func withdraw(_ id: UUID) async -> Bool {
        let withdrawn = await outbox.withdraw(id)
        await reload()
        return withdrawn
    }

    @discardableResult
    func flush(ignoringBackoff: Bool) async -> FlushReport? {
        await reload()
        guard let client = connection.client, !entries.isEmpty else { return nil }
        isFlushing = true
        let report = await outbox.flush(using: client, ignoringBackoff: ignoringBackoff)
        isFlushing = false
        await reload()
        if report.sent > 0 {
            connection.didWrite()
            if !connection.isOnline { await connection.refresh() }
        }
        return report
    }

    func retry(_ entry: OutboxEntry) async {
        await outbox.retry(entry.id)
        await flush(ignoringBackoff: true)
    }

    func remove(_ entry: OutboxEntry) async {
        await outbox.remove(entry.id)
        await reload()
    }
}
