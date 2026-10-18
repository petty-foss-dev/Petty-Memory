import EnveMemoryKit
import SwiftUI

enum KnowledgeArea: String, Hashable, CaseIterable, Identifiable {
    case workflows, collections, research, sources, freshness, preferences

    var id: String { rawValue }

    var title: String {
        switch self {
        case .workflows: "AI workflows"
        case .collections: "Collections"
        case .research: "PDFs and recordings"
        case .sources: "Watched sources"
        case .freshness: "Information review"
        case .preferences: "Organization preferences"
        }
    }

    var symbol: String {
        switch self {
        case .workflows: "wand.and.stars"
        case .collections: "tablecells"
        case .research: "doc.text.magnifyingglass"
        case .sources: "dot.radiowaves.left.and.right"
        case .freshness: "clock.badge.exclamationmark"
        case .preferences: "slider.horizontal.3"
        }
    }

    var summary: String {
        switch self {
        case .workflows: "Saved instructions for a branch or topic. Each run proposes actions you review, apply and undo."
        case .collections: "Typed fields on ordinary items, shown as a table, cards or Kanban board."
        case .research: "Read PDFs by page, quote and annotate them, record or import audio, and work from timed transcripts."
        case .sources: "Web pages, feeds and approved folders checked by your computer. New and changed material waits for you."
        case .freshness: "Notes nobody has checked in a while, and suggested conflicts backed by exact quotes."
        case .preferences: "Instructions you choose to include when the AI proposes organization."
        }
    }

    var identifier: String { "Knowledge-\(rawValue)" }
}

extension Connection {
    /// Knowledge screens are never answered from a saved copy or queued; nil while the server is reachable.
    var knowledgeReadReason: String? {
        switch status {
        case .online: nil
        case .unknown, .checking: "Connecting to your computer…"
        case .offline: "This needs a connection to the computer that holds your library. Nothing here is saved on the phone or queued for later."
        case .unauthorized: "This phone's pairing was revoked. Pair again to continue."
        }
    }

    var knowledgeWriteReason: String? {
        if let reason = knowledgeReadReason { return reason }
        return scopes.contains("write") ? nil : "This pairing is read-only. You can look around, but changes need a pairing with read and write access."
    }
}

extension ProjectStore {
    func label(for id: String?) -> String {
        guard let id else { return "No project" }
        return name(for: id) ?? "A project"
    }
}

struct KnowledgeNote: View {
    let text: String
    var symbol = "info.circle"

    @Environment(\.hearth) private var hearth

    var body: some View {
        Label {
            Text(text).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
        } icon: {
            Image(systemName: symbol).foregroundStyle(hearth.accent)
        }
        .accessibilityElement(children: .combine)
    }
}

struct StatPill: View {
    let label: String
    let value: String

    @Environment(\.hearth) private var hearth

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(value).font(HearthFont.headline).foregroundStyle(hearth.textPrimary)
            Text(label).font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
        }
        .padding(.horizontal, HearthSpacing.md)
        .padding(.vertical, HearthSpacing.sm)
        .background(RoundedRectangle(cornerRadius: HearthRadius.inner, style: .continuous).fill(hearth.surfaceSunken))
        .accessibilityElement(children: .combine)
    }
}

struct ProjectChoice: View {
    let title: String
    @Binding var selection: String?
    var noneLabel = "No project"

    @Environment(ProjectStore.self) private var projects

    var body: some View {
        Picker(title, selection: $selection) {
            Text(noneLabel).tag(String?.none)
            ForEach(projects.refs, id: \.id) { Text($0.name).tag(Optional($0.id)) }
            if let selection, projects.name(for: selection) == nil {
                Text("Current project").tag(Optional(selection))
            }
        }
    }
}

enum Timestamp {
    /// `m:ss`, or `h:mm:ss` from an hour, matching the server's transcript notes.
    static func label(_ seconds: Double) -> String {
        guard seconds.isFinite else { return "0:00" }
        let total = max(0, Int(seconds.rounded(.down)))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let rest = total % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

extension Error {
    /// A conflict means the library moved on since the preview or review; the person reviews again rather than overwriting.
    var isStaleConflict: Bool { (self as? APIError)?.code == .conflict }
}
