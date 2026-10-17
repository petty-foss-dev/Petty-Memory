import Foundation
import Testing
@testable import EnveMemoryKit

final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_790_000_000)
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
}

@Suite struct OutboxTests {
    let directory = FileManager.default.temporaryDirectory.appending(path: "outbox-\(UUID().uuidString)")
    let clock = TestClock()
    var outbox: Outbox { Outbox(directory: directory, now: { [clock] in clock.now }) }

    func note(_ text: String) throws -> Endpoint {
        try .capture(CaptureRequest(note: text))
    }

    @Test func enqueuePersistsAcrossInstances() async throws {
        try await outbox.enqueue(note("one"), kind: .note, title: "one")
        try await outbox.enqueue(note("two"), kind: .note, title: "two")
        let entries = await Outbox(directory: directory).entries()
        #expect(entries.map(\.title) == ["one", "two"])
        #expect(entries.allSatisfy { $0.attempts == 0 && !$0.needsAttention })
    }

    @Test func flushSendsInOrderAndEmptiesTheQueue() async throws {
        let server = StubServer { _ in (201, try Fixture.data("capture-note")) }
        let outbox = self.outbox
        try await outbox.enqueue(note("first"), kind: .note, title: "first")
        clock.advance(1)
        try await outbox.enqueue(note("second"), kind: .note, title: "second")

        let report = await outbox.flush(using: server.client())
        #expect(report == FlushReport(sent: 2, failed: 0, remaining: 0))
        let notes = try server.requests.map { try JSONDecoder().decode(CaptureRequest.self, from: #require($0.body)).note }
        #expect(notes == ["first", "second"])
        #expect(server.requests.allSatisfy { $0.request.url?.path() == "/api/v1/capture" })
    }

    @Test func flushIsIdempotent() async throws {
        let server = StubServer { _ in (201, try Fixture.data("capture-note")) }
        let outbox = self.outbox
        try await outbox.enqueue(note("once"), kind: .note, title: "once")

        async let a = outbox.flush(using: server.client())
        async let b = outbox.flush(using: server.client())
        _ = await (a, b)
        _ = await outbox.flush(using: server.client())
        #expect(server.requests.count == 1)
        #expect(await outbox.entries().isEmpty)
    }

    @Test func unreachableServerBacksOffAndStopsTheRun() async throws {
        let server = StubServer { _ in throw URLError(.cannotConnectToHost) }
        let outbox = self.outbox
        try await outbox.enqueue(note("a"), kind: .note, title: "a")
        try await outbox.enqueue(note("b"), kind: .note, title: "b")

        let first = await outbox.flush(using: server.client())
        #expect(first == FlushReport(sent: 0, failed: 0, remaining: 2))
        #expect(server.requests.count == 1)
        let entry = try #require(await outbox.entries().first { $0.attempts == 1 })
        #expect(entry.nextAttemptAt == clock.now.addingTimeInterval(30))
        #expect(entry.lastError != nil)
        #expect(!entry.needsAttention)
    }

    @Test func backoffIsRespectedUntilDueOrForced() async throws {
        let server = StubServer { _ in throw URLError(.timedOut) }
        let outbox = self.outbox
        try await outbox.enqueue(note("a"), kind: .note, title: "a")

        _ = await outbox.flush(using: server.client())
        _ = await outbox.flush(using: server.client())
        #expect(server.requests.count == 1)

        clock.advance(31)
        _ = await outbox.flush(using: server.client())
        #expect(server.requests.count == 2)
        #expect(await outbox.entries().first?.nextAttemptAt == clock.now.addingTimeInterval(60))

        _ = await outbox.flush(using: server.client(), ignoringBackoff: true)
        #expect(server.requests.count == 3)

        server.setResponse { _ in (201, try Fixture.data("capture-note")) }
        clock.advance(3600)
        let report = await outbox.flush(using: server.client())
        #expect(report.sent == 1)
        #expect(await outbox.entries().isEmpty)
    }

    /// A multi-file share or a burst of offline edits enqueues within the same millisecond.
    @Test func enqueuesWithinOneMillisecondKeepTheirOrder() async throws {
        let outbox = self.outbox
        let titles = (1...6).map { "edit \($0)" }
        for title in titles { try await outbox.enqueue(note(title), kind: .note, title: title) }
        let entries = await Outbox(directory: directory).entries()
        #expect(entries.map(\.title) == titles)
        #expect(Set(entries.map(\.createdAt)).count == titles.count)
    }

    @Test func enqueueKeepsTheKeyOfADirectAttempt() async throws {
        let endpoint = try note("lost response")
        let entry = try await outbox.enqueue(endpoint, kind: .note, title: "x")
        #expect(entry.idempotencyKey == endpoint.idempotencyKey)
        #expect(entry.endpoint.idempotencyKey == entry.idempotencyKey)
        let reloaded = try #require(await Outbox(directory: directory).entries().first)
        #expect(reloaded.idempotencyKey == endpoint.idempotencyKey)
    }

    @Test func enqueueAddsAKeyWhenTheEndpointHasNone() async throws {
        let bare = Endpoint(method: "POST", path: "/capture", body: Data("{}".utf8))
        let entry = try await outbox.enqueue(bare, kind: .note, title: "x")
        #expect(!entry.idempotencyKey.isEmpty)
        #expect(entry.endpoint.idempotencyKey == entry.idempotencyKey)
    }

    /// The double-send case: the server applied the write but the response never arrived.
    @Test func retriesAfterALostResponseReuseTheKey() async throws {
        let server = StubServer { _ in throw URLError(.networkConnectionLost) }
        let outbox = self.outbox
        let endpoint = try note("once only")
        _ = try? await server.client().data(for: endpoint)
        try await outbox.enqueue(endpoint, kind: .note, title: "once only")

        server.setResponse { _ in (201, try Fixture.data("capture-note")) }
        let report = await outbox.flush(using: server.client(), ignoringBackoff: true)
        #expect(report.sent == 1)
        let keys = server.requests.map { $0.request.value(forHTTPHeaderField: "Idempotency-Key") }
        #expect(keys.count == 2)
        #expect(keys[0] != nil && keys[0] == keys[1])
    }

    @Test func backoffDoublesAndCaps() {
        #expect(Outbox.backoff(afterAttempts: 1) == 30)
        #expect(Outbox.backoff(afterAttempts: 2) == 60)
        #expect(Outbox.backoff(afterAttempts: 5) == 480)
        #expect(Outbox.backoff(afterAttempts: 20) == 3600)
    }

    @Test func rejectedEntriesWaitForTheUserButDontBlockOthers() async throws {
        let server = StubServer { request in
            let body = try JSONDecoder().decode(CaptureRequest.self, from: #require(request.httpBody))
            return body.note == "bad"
                ? (400, Data(#"{"error":{"code":"invalid","message":"Nope."}}"#.utf8))
                : (201, try Fixture.data("capture-note"))
        }
        let outbox = self.outbox
        try await outbox.enqueue(note("bad"), kind: .note, title: "bad")
        clock.advance(1)
        try await outbox.enqueue(note("good"), kind: .note, title: "good")

        let report = await outbox.flush(using: server.client())
        #expect(report == FlushReport(sent: 1, failed: 1, remaining: 1))
        let stuck = try #require(await outbox.entries().first)
        #expect(stuck.needsAttention)
        #expect(stuck.lastError == "Nope.")

        clock.advance(7200)
        _ = await outbox.flush(using: server.client())
        #expect(server.requests.count == 2)

        await outbox.retry(stuck.id)
        _ = await outbox.flush(using: server.client())
        #expect(server.requests.count == 3)
    }

    @Test func fileUploadsStreamFromTheOutboxAndAreCleanedUp() async throws {
        let server = StubServer { _ in (201, try Fixture.data("capture-note")) }
        let outbox = self.outbox
        let source = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).txt")
        try Data("hello file".utf8).write(to: source)

        let entry = try await outbox.enqueue(.upload(FileUpload(filename: "hello.txt", mimeType: "text/plain")), kind: .file,
                                             title: "hello.txt", attachment: source)
        #expect(!FileManager.default.fileExists(atPath: source.path))
        #expect(entry.attachment != nil)

        let report = await outbox.flush(using: server.client())
        #expect(report.sent == 1)
        #expect(server.requests.first?.body == Data("hello file".utf8))
        #expect(server.requests.first?.request.value(forHTTPHeaderField: "X-Filename") == "hello.txt")
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        #expect(leftovers.isEmpty)
    }

    @Test func removeDropsEntryAndItsFile() async throws {
        let outbox = self.outbox
        let source = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).bin")
        try Data([1, 2, 3]).write(to: source)
        let entry = try await outbox.enqueue(.upload(FileUpload(filename: "x.bin", mimeType: "application/octet-stream")), kind: .file,
                                             title: "x", attachment: source)
        await outbox.remove(entry.id)
        #expect(await outbox.entries().isEmpty)
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
    }
}
