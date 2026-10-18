import Foundation

/// The server's limits for watched sources and freshness review (`SOURCE_LIMITS` in core).
public enum SourceLimits {
    public static let watches = 100
    public static let name = 120
    public static let url = 2_048
    public static let applyBatch = 20
    public static let freshnessItems = 100
    public static let maxAgeDays = 36_500
    /// How often the host checks enabled watches while it runs, and how often it looks for due ones.
    public static let checkIntervalHours = 6
    public static let pollMinutes = 15
}

public enum WatchKind: String, Codable, CaseIterable, Hashable, Sendable {
    case url, rss, folder

    public var label: String {
        switch self {
        case .url: "Web page"
        case .rss: "RSS or Atom feed"
        case .folder: "Folder on your computer"
        }
    }
}

/// Whether the library's computer approved a folder for the watch and can read it now. Never the path.
public struct FolderStatus: Codable, Hashable, Sendable {
    public let approved: Bool
    public let available: Bool
}

public struct SourceCheck: Codable, Hashable, Sendable {
    public enum Status: String, Codable, Hashable, Sendable {
        case ok, failed, stale
    }

    public let at: Date
    public let status: Status
    public let found: Int
    public let queued: Int
    public let unchanged: Int
    /// Archived imports, oversized or unreadable files.
    public let skipped: Int
    /// More entries, files or text existed than one check takes.
    public let truncated: Bool
    public let error: String?
}

public struct WatchedSource: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let kind: WatchKind
    public let url: String?
    public let project: ProjectRef?
    public let enabled: Bool
    public let hash: String
    public let folder: FolderStatus?
    public let lastCheck: SourceCheck?
    public let pending: Int
    public let createdAt: Date
    public let updatedAt: Date

    /// A folder watch can be checked only once the library's computer has approved a folder it can read.
    public var canCheck: Bool { kind != .folder || folder?.available == true }
}

/// A folder watch has no URL; its folder is approved on the library's computer.
public struct WatchInput: Encodable, Hashable, Sendable {
    public var name: String
    public var kind: WatchKind
    public var url: String?
    public var project: String?
    public var enabled: Bool

    public init(name: String, kind: WatchKind, url: String? = nil, project: String? = nil, enabled: Bool = false) {
        self.name = name
        self.kind = kind
        self.url = kind == .folder ? nil : url
        self.project = project
        self.enabled = enabled
    }
}

/// Only the fields given change; `project: .some(nil)` files future imports nowhere.
public struct WatchPatch: Encodable, Hashable, Sendable {
    public var name: String?
    public var url: String?
    public var project: String??
    public var enabled: Bool?

    public init(name: String? = nil, url: String? = nil, project: String?? = nil, enabled: Bool? = nil) {
        self.name = name
        self.url = url
        self.project = project
        self.enabled = enabled
    }

    private enum CodingKeys: String, CodingKey { case name, url, project, enabled }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(url, forKey: .url)
        if let project { try c.encode(project, forKey: .project) }
        try c.encodeIfPresent(enabled, forKey: .enabled)
    }
}

public struct CandidateFile: Codable, Hashable, Sendable {
    public let name: String
    public let size: Int
    public let sha256: String
    public let mimeType: String
    public let modifiedAt: Date
}

/// A queued import or update. Nothing reaches the library until it's applied.
public struct SourceCandidate: Codable, Hashable, Identifiable, Sendable {
    public enum Change: String, Codable, Hashable, Sendable {
        case new, changed
    }

    public let id: String
    public let watchId: String
    public let key: String
    public let change: Change
    public let title: String
    public let url: String?
    /// What an import stores (URL/RSS), or a preview of a text file.
    public let text: String
    public let truncated: Bool
    public let publishedAt: String?
    public let file: CandidateFile?
    public let fingerprint: String
    public let sourceHash: String
    /// The library item a changed candidate updates or supersedes.
    public let targetId: String?
    public let targetHash: String?
    public let checkedAt: Date
}

public struct SourceQueue: Codable, Hashable, Sendable {
    public let watchId: String
    public let check: SourceCheck?
    public let candidates: [SourceCandidate]
}

public struct AppliedCandidate: Codable, Hashable, Sendable {
    public let candidateId: String
    public let itemId: String
    public let change: SourceCandidate.Change
    /// The earlier file snapshot a changed file supersedes; kept unchanged.
    public let previousId: String?
}

public struct SourceApplyResult: Codable, Hashable, Sendable {
    public let watchId: String
    public let applied: [AppliedCandidate]
}

/// Published comes from the source, captured is when it was saved, edited is the last change, checked is the last review.
public struct FreshnessDates: Codable, Hashable, Sendable {
    public let publishedAt: Date?
    public let capturedAt: Date
    public let editedAt: Date
    public let checkedAt: Date?
}

/// An item's identity at review time; a write with an outdated `stateHash` is refused.
public struct FreshnessRef: Codable, Hashable, Sendable {
    public let id: String
    public let stateHash: String

    public init(id: String, stateHash: String) {
        self.id = id
        self.stateHash = stateHash
    }
}

public struct StaleItem: Decodable, Hashable, Identifiable, Sendable {
    public enum Basis: String, Decodable, Hashable, Sendable {
        case checked, edited
    }

    public let id: String
    public let type: ItemType
    public let title: String
    public let url: String?
    public let excerpt: String
    public let truncated: Bool
    public let dates: FreshnessDates
    public let stateHash: String
    public let ageDays: Int
    public let basis: Basis

    public var ref: FreshnessRef { FreshnessRef(id: id, stateHash: stateHash) }
}

public struct StaleItems: Decodable, Hashable, Sendable {
    public let olderThanDays: Int
    public let cutoff: Date
    public let items: [StaleItem]
    /// Every matching item; `items` holds at most `SourceLimits.freshnessItems`, oldest first.
    public let total: Int
}

/// A branch, or a keyword topic with an optional project, or a whole project.
public struct FreshnessScopeInput: Encodable, Hashable, Sendable {
    public var rootId: String?
    public var query: String?
    public var project: String?

    public init(rootId: String? = nil, query: String? = nil, project: String? = nil) {
        self.rootId = rootId
        self.query = query
        self.project = rootId == nil ? project : nil
    }
}

public struct FreshnessEvidence: Decodable, Hashable, Sendable {
    public let id: String
    public let type: ItemType
    public let title: String
    /// Copied exactly from the item's text.
    public let quote: String
    public let stateHash: String
    public let dates: FreshnessDates

    public var ref: FreshnessRef { FreshnessRef(id: id, stateHash: stateHash) }
}

public struct FreshnessSuggestion: Decodable, Hashable, Sendable {
    public enum Kind: String, Decodable, Hashable, Sendable {
        case conflict, outdated
    }

    /// Which item is more recent by its dates, never by the model.
    public struct Newer: Decodable, Hashable, Sendable {
        public enum Basis: String, Decodable, Hashable, Sendable { case published, edited }
        public let id: String
        public let basis: Basis
    }

    public let kind: Kind
    public let reason: String
    public let items: [FreshnessEvidence]
    public let newer: Newer?

    public var pair: (FreshnessEvidence, FreshnessEvidence)? {
        items.count == 2 ? (items[0], items[1]) : nil
    }
}

public struct FreshnessProposal: Decodable, Hashable, Sendable {
    public enum State: String, Decodable, Hashable, Sendable {
        case suggestions
        case noEvidence = "no_evidence"
    }

    public let state: State
    public let baseHash: String
    public let scanned: Int
    public let suggestions: [FreshnessSuggestion]
    /// Model suggestions dropped for unknown items or quotes not in the text.
    public let rejected: Int
    /// Valid suggestions for pairs already dismissed.
    public let dismissed: Int
    public let message: String
}

public struct FreshnessReceipt: Decodable, Hashable, Sendable {
    public let action: String
    public let itemIds: [String]
    public let at: Date
}

private struct ApplyCandidatesBody: Encodable { let candidateIds: [String] }
private struct DismissBody: Encodable { let refs: [FreshnessRef] }
private struct SupersedeBody: Encodable {
    let newer: FreshnessRef
    let older: FreshnessRef
}

extension Endpoint {
    public static let sources = get("/knowledge/sources")
    public static func source(_ id: String) -> Endpoint { get("/knowledge/sources/\(segment(id))") }
    public static func createSource(_ input: WatchInput) throws -> Endpoint { try json("POST", "/knowledge/sources", input) }
    public static func updateSource(_ id: String, _ patch: WatchPatch) throws -> Endpoint { try json("PATCH", "/knowledge/sources/\(segment(id))", patch) }
    /// Archives the definition; items it imported stay.
    public static func removeSource(_ id: String) -> Endpoint { remove("/knowledge/sources/\(segment(id))") }
    public static func sourceQueue(_ id: String) -> Endpoint { get("/knowledge/sources/\(segment(id))/queue") }
    /// The host reads the source now and queues previews; it never imports.
    public static func checkSource(_ id: String) -> Endpoint { post("/knowledge/sources/\(segment(id))/check") }
    /// All or nothing; refused when the source, a target or a file changed since the preview.
    public static func applyCandidates(_ watchId: String, ids: [String]) throws -> Endpoint {
        try json("POST", "/knowledge/sources/\(segment(watchId))/apply", ApplyCandidatesBody(candidateIds: ids))
    }

    /// Branch or project, not both.
    public static func staleItems(olderThanDays days: Int, rootId: String? = nil, project: String? = nil) -> Endpoint {
        get("/knowledge/freshness/stale", [("days", String(days)), ("rootId", rootId), ("project", rootId == nil ? project : nil)])
    }
    public static func analyzeFreshness(_ scope: FreshnessScopeInput) throws -> Endpoint { try transient("/knowledge/freshness/analyze", scope) }
    public static func markChecked(_ ref: FreshnessRef) throws -> Endpoint { try json("POST", "/knowledge/freshness/check", ref) }
    public static func dismissPair(_ first: FreshnessRef, _ second: FreshnessRef) throws -> Endpoint {
        try json("POST", "/knowledge/freshness/dismiss", DismissBody(refs: [first, second]))
    }
    /// Marks `older` as superseded by `newer` with a permanent connection; both texts stay.
    public static func supersede(newer: FreshnessRef, older: FreshnessRef) throws -> Endpoint {
        try json("POST", "/knowledge/freshness/supersede", SupersedeBody(newer: newer, older: older))
    }
}
