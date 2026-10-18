import Foundation

public struct AIStatus: Decodable, Hashable, Sendable {
    public let configured: Bool
    public let provider: String
    public let label: String
    public let model: String?
    public let cloud: Bool
}

public enum ChatMode: String, Codable, Hashable, Sendable {
    case ask, edit, organize, actions
}

public struct ChatMessage: Codable, Hashable, Sendable {
    public enum Role: String, Codable, Hashable, Sendable { case user, assistant }

    public let role: Role
    public let content: String

    public init(role: Role, content: String) {
        self.role = role
        self.content = content
    }
}

/// Cut to the server's limits; the conversation itself is never stored.
public struct ChatRequest: Encodable, Hashable, Sendable {
    public static let maxMessages = 12
    /// Measured in UTF-16 code units, as the server counts.
    public static let maxMessageLength = 4_000
    public static let maxTotalLength = 16_000

    public let mode: ChatMode
    public let messages: [ChatMessage]
    public let project: String?
    public let rootId: String?
    /// A keyword topic; the actions mode takes exactly one of `rootId` or `query`.
    public let query: String?
    /// Earlier messages left out to fit; not encoded.
    public let omitted: Int

    private enum CodingKeys: String, CodingKey { case mode, messages, project, rootId, query }

    /// Whole exchanges drop from the front so roles still alternate and the new message stays whole.
    public init(mode: ChatMode, history: [ChatMessage], message: String, project: String? = nil, rootId: String? = nil, query: String? = nil) {
        var earlier = history.map { ChatMessage(role: $0.role, content: Self.clipped($0.content)) }
        let original = earlier.count
        if earlier.first?.role == .assistant { earlier.removeFirst() }
        if earlier.last?.role == .user { earlier.removeLast() }
        let final = ChatMessage(role: .user, content: message)
        func length(_ list: [ChatMessage]) -> Int { list.reduce(Self.length(final.content)) { $0 + Self.length($1.content) } }
        while !earlier.isEmpty, earlier.count + 1 > Self.maxMessages || length(earlier) > Self.maxTotalLength {
            earlier.removeFirst(min(2, earlier.count))
        }
        self.mode = mode
        messages = earlier + [final]
        self.project = project
        self.rootId = rootId
        self.query = query
        omitted = original - earlier.count
    }

    public static func length(_ text: String) -> Int { text.utf16.count }

    static func clipped(_ text: String) -> String {
        guard length(text) > maxMessageLength else { return text }
        var result = ""
        var used = 1
        for character in text {
            used += character.utf16.count
            if used > maxMessageLength { break }
            result.append(character)
        }
        return result + "…"
    }
}

/// Each `[n]` in the text refers to the source numbered `n`.
public struct CitedAnswer: Decodable, Hashable, Sendable {
    public struct Source: Decodable, Hashable, Sendable {
        public let n: Int
        public let id: String
        public let title: String
        public let url: String?
        public let type: ItemType
    }

    public let answer: String
    public let sources: [Source]

    public init(answer: String, sources: [Source]) {
        self.answer = answer
        self.sources = sources
    }

    /// The answer as ordinary note text: each `[n]` becomes a stable reference to its source, and every source is listed below.
    public var noteBody: String {
        let byNumber = Dictionary(sources.map { ($0.n, $0) }, uniquingKeysWith: { first, _ in first })
        let text = answer.replacing(/\[(\d+)\]/) { match -> String in
            guard let n = Int(match.output.1), let source = byNumber[n] else { return String(match.output.0) }
            return InlineReference.token(id: source.id, label: source.label)
        }
        guard !sources.isEmpty else { return text }
        let list = sources.map { "- " + InlineReference.token(id: $0.id, label: $0.label) }
        return text + "\n\nSources\n" + list.joined(separator: "\n")
    }
}

extension CitedAnswer.Source {
    var label: String { title.isEmpty ? (url ?? "Source \(n)") : title }
}

/// Proposals change nothing until reviewed and applied.
public enum ChatResponse: Decodable, Hashable, Sendable {
    case answer(CitedAnswer)
    case proposal(EditProposal)
    case organization(OrganizationProposal)
    case actions(ActionProposal)

    private enum CodingKeys: String, CodingKey { case kind, answer, proposal }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "answer": self = .answer(try c.decode(CitedAnswer.self, forKey: .answer))
        case "proposal": self = .proposal(try c.decode(EditProposal.self, forKey: .proposal))
        case "organization": self = .organization(try c.decode(OrganizationProposal.self, forKey: .proposal))
        case "actions": self = .actions(try c.decode(ActionProposal.self, forKey: .proposal))
        case let kind: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Unknown chat reply “\(kind)”.")
        }
    }
}

extension Endpoint {
    public static let aiStatus = get("/ai/status")

    /// No idempotency key, so the server keeps no copy of a preview.
    public static func chat(_ request: ChatRequest) throws -> Endpoint {
        Endpoint(method: "POST", path: "/ai/chat", headers: ["Content-Type": "application/json"],
                 body: try JSONCoding.makeEncoder().encode(request))
    }
}

/// Each recognizer result replaces the previous partial text; results from an ended session are ignored.
public struct DictationDraft: Sendable {
    public private(set) var text = ""
    public private(set) var isActive = false
    private var base = ""
    private var session = 0

    public init() {}

    public mutating func begin(after typed: String) -> Int {
        base = typed
        text = typed
        session += 1
        isActive = true
        return session
    }

    public func isCurrent(_ session: Int) -> Bool { isActive && session == self.session }

    @discardableResult
    public mutating func apply(_ transcript: String, session: Int) -> Bool {
        guard isCurrent(session) else { return false }
        let spoken = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if spoken.isEmpty {
            text = base
        } else if let last = base.last, !last.isWhitespace {
            text = base + " " + spoken
        } else {
            text = base + spoken
        }
        return true
    }

    public mutating func end() {
        isActive = false
    }
}
