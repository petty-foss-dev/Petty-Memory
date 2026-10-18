import Foundation

/// A chat the user chose to keep. Proposals were saved as their summaries, so a resumed chat can't apply anything.
public struct SavedConversation: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let mode: ChatMode
    public let project: String?
    public let rootId: String?
    public let query: String?
    public let messages: [ChatMessage]
    public let createdAt: Date
    public let updatedAt: Date

    /// Each question with the answer that followed it; an unanswered question is left out.
    public var exchanges: [(question: String, answer: String)] {
        var pairs: [(question: String, answer: String)] = []
        var question: String?
        for message in messages {
            switch message.role {
            case .user: question = message.content
            case .assistant:
                if let asked = question { pairs.append((asked, message.content)) }
                question = nil
            }
        }
        return pairs
    }
}

/// What `POST /conversations` stores: a new conversation without `id`, or an update to the one with it.
public struct ConversationInput: Encodable, Hashable, Sendable {
    public static let maxMessages = 100
    /// UTF-16 code units across every message, as the server counts.
    public static let maxLength = 200_000
    public static let maxTitle = 120

    public let id: String?
    public let title: String
    public let mode: ChatMode
    public let project: String?
    public let rootId: String?
    public let query: String?
    public let messages: [ChatMessage]
    /// Earliest messages left out to fit; not encoded.
    public let omitted: Int

    private enum CodingKeys: String, CodingKey { case id, title, mode, project, rootId, query, messages }

    /// Whole exchanges drop from the front, so the saved messages still start with a question and alternate.
    public init(id: String?, title: String, mode: ChatMode, project: String? = nil, rootId: String? = nil, query: String? = nil,
                messages: [ChatMessage]) {
        var kept = messages
        if kept.first?.role == .assistant { kept.removeFirst() }
        if kept.last?.role == .user { kept.removeLast() }
        while !kept.isEmpty, kept.count > Self.maxMessages || kept.reduce(0, { $0 + ChatRequest.length($1.content) }) > Self.maxLength {
            kept.removeFirst(min(2, kept.count))
        }
        self.id = id
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        self.title = String((trimmed.isEmpty ? Self.suggestedTitle(for: kept) : trimmed).prefix(Self.maxTitle))
        self.mode = mode
        self.project = project
        self.rootId = rootId
        self.query = query
        self.messages = kept
        omitted = messages.count - kept.count
    }

    /// The first line of the first question.
    public static func suggestedTitle(for messages: [ChatMessage]) -> String {
        let first = messages.first { $0.role == .user }?.content ?? ""
        let line = first.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let title = line.trimmingCharacters(in: .whitespaces)
        return String((title.isEmpty ? "Conversation" : title).prefix(maxTitle))
    }
}

extension Endpoint {
    public static let conversations = get("/conversations")
    public static func searchConversations(_ query: String) -> Endpoint { get("/conversations", [("query", query)]) }
    public static func conversation(_ id: String) -> Endpoint { get("/conversations/\(segment(id))") }
    public static func saveConversation(_ input: ConversationInput) throws -> Endpoint { try json("POST", "/conversations", input) }
    /// Archives the conversation's item; it can be restored like any archived item, never hard-deleted.
    public static func archiveConversation(_ id: String) -> Endpoint {
        Endpoint(method: "DELETE", path: "/conversations/\(segment(id))", headers: [idempotencyHeader: newKey()])
    }
}
