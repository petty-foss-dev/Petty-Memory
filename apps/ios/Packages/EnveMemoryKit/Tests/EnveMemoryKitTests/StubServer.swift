import Foundation
import Testing
@testable import EnveMemoryKit

/// Routes requests by host, so parallel tests each get their own fake server.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest, Data?) throws -> (Int, Data)

    private static let lock = NSLock()
    nonisolated(unsafe) private static var handlers: [String: Handler] = [:]

    static func register(host: String, handler: @escaping Handler) {
        lock.withLock { handlers[host] = handler }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let handler = Self.lock.withLock { Self.handlers[request.url?.host() ?? ""] }
        do {
            guard let handler else { throw URLError(.cannotConnectToHost) }
            let (status, data) = try handler(request, Self.body(of: request))
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

/// A fake server with its own host, recording every request it sees.
final class StubServer: @unchecked Sendable {
    struct Recorded: Sendable {
        let request: URLRequest
        let body: Data?
    }

    let host = "stub-\(UUID().uuidString.lowercased()).test"
    private let lock = NSLock()
    private var recorded: [Recorded] = []
    private var respond: @Sendable (URLRequest) throws -> (Int, Data)

    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }()

    init(_ respond: @escaping @Sendable (URLRequest) throws -> (Int, Data) = { _ in (200, Data("{}".utf8)) }) {
        self.respond = respond
        StubURLProtocol.register(host: host) { [weak self] request, body in
            guard let self else { throw URLError(.cannotConnectToHost) }
            return try self.handle(request, body)
        }
    }

    var baseURL: URL { URL(string: "http://\(host):49231")! }
    var requests: [Recorded] { lock.withLock { recorded } }

    func client(token: String? = "em_test") -> APIClient {
        APIClient(baseURL: baseURL, token: token, session: Self.session, timeout: 5)
    }

    func setResponse(_ respond: @escaping @Sendable (URLRequest) throws -> (Int, Data)) {
        lock.withLock { self.respond = respond }
    }

    private func handle(_ request: URLRequest, _ body: Data?) throws -> (Int, Data) {
        let respond = lock.withLock {
            recorded.append(Recorded(request: request, body: body))
            return self.respond
        }
        var withBody = request
        withBody.httpBody = body
        return try respond(withBody)
    }
}

enum Fixture {
    static func data(_ name: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }
}

/// A fresh, not-yet-created folder under the temporary directory.
enum TestDirectory {
    static func make(_ prefix: String) -> URL {
        FileManager.default.temporaryDirectory.appending(path: "\(prefix)-\(UUID().uuidString)", directoryHint: .isDirectory)
    }
}

/// A minimal server-shaped item; `extra` is spliced into the object verbatim.
func itemJSON(id: String, type: String = "note", title: String = "t", body: String = "", metadata: String = "{}", extra: String = "") -> String {
    let tail = extra.isEmpty ? "" : ",\(extra)"
    return #"{"id":"\#(id)","type":"\#(type)","title":"\#(title)","body":"\#(body)","url":null,"project":null,"source":"app","metadata":\#(metadata),"createdAt":"2026-10-01T08:00:00.000Z","updatedAt":"2026-10-02T09:30:00.000Z","archivedAt":null,"tags":[]\#(tail)}"#
}

func bodyString(_ endpoint: Endpoint) throws -> String {
    String(decoding: try #require(endpoint.body), as: UTF8.self)
}

