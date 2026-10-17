import EnveMemoryKit
import SwiftUI

extension ItemType {
    var symbol: String {
        switch self {
        case .note: "note.text"
        case .bookmark: "link"
        case .task: "checkmark.circle"
        case .decision: "signpost.right"
        case .file: "doc"
        case .image: "photo"
        default: "square.dashed"
        }
    }

    var label: String {
        switch self {
        case .note: "Note"
        case .bookmark: "Link"
        case .task: "Task"
        case .decision: "Decision"
        case .file: "File"
        case .image: "Image"
        default: rawValue.capitalized
        }
    }

    var pluralLabel: String {
        switch self {
        case .note: "Notes"
        case .bookmark: "Links"
        case .task: "Tasks"
        case .decision: "Decisions"
        case .file: "Files"
        case .image: "Images"
        default: rawValue.capitalized
        }
    }
}

extension Item {
    /// One line of plain text under the title; nil when the title already is the body.
    var preview: String? {
        guard !title.isEmpty || url != nil else { return nil }
        let text = (metadata.excerpt ?? body)
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces).trimmingPrefix(/[>#\-*+]+\s*/) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return text.isEmpty || text == title ? nil : text
    }
}

/// Icon tile shared by item, hit and outbox rows.
struct TypeGlyph: View {
    let symbol: String
    var tint: Color?

    @Environment(\.hearth) private var hearth

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(tint ?? hearth.accentText)
            .frame(width: 34, height: 34)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(hearth.accentMuted))
            .accessibilityHidden(true)
    }
}

struct ItemRow: View {
    let item: Item
    var showsProject = true

    @Environment(\.hearth) private var hearth

    var body: some View {
        HStack(alignment: .top, spacing: HearthSpacing.md) {
            TypeGlyph(symbol: item.task?.status == .done ? "checkmark.circle.fill" : item.type.symbol)
            VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                HStack(alignment: .firstTextBaseline, spacing: HearthSpacing.xs) {
                    Text(item.displayTitle)
                        .font(HearthFont.cardTitle)
                        .foregroundStyle(hearth.textPrimary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if item.isPinned {
                        Image(systemName: "pin.fill").accessibilityLabel("Pinned")
                    }
                    if let remindAt = item.remindAt, remindAt > .now {
                        Image(systemName: "bell.fill").accessibilityLabel("Reminder set")
                    }
                }
                .font(HearthFont.caption)
                .foregroundStyle(hearth.accent)
                if let preview = item.preview {
                    Text(preview)
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                        .lineLimit(2)
                }
                Text(meta)
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textTertiary)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, HearthSpacing.sm)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var meta: String {
        var parts = [item.intent.map(\.label) ?? item.type.label]
        if showsProject, let project = item.project { parts.append(project.name) }
        if let site = item.metadata.siteName ?? item.url.flatMap({ URL(string: $0)?.host() }) { parts.append(site) }
        if let remindAt = item.remindAt, remindAt > .now {
            parts.append("Remind \(remindAt.formatted(.relative(presentation: .named)))")
        } else {
            parts.append(item.updatedAt.formatted(.relative(presentation: .named)))
        }
        return parts.joined(separator: " · ")
    }
}

/// A list of rows on one card, separated by hairlines.
struct RowStack<Data: RandomAccessCollection, Row: View>: View where Data.Element: Identifiable {
    let data: Data
    @ViewBuilder var row: (Data.Element) -> Row

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(spacing: 0) {
                ForEach(Array(data.enumerated()), id: \.element.id) { index, element in
                    if index > 0 { HearthDivider().padding(.leading, 46) }
                    row(element)
                }
            }
        }
    }
}

struct EmptyStateView: View {
    let symbol: String
    let title: String
    let message: String

    @Environment(\.hearth) private var hearth

    var body: some View {
        VStack(spacing: HearthSpacing.sm) {
            Image(systemName: symbol)
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(hearth.accent)
            Text(title)
                .font(HearthFont.cardTitle)
            Text(message)
                .font(HearthFont.footnote)
                .foregroundStyle(hearth.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, HearthSpacing.xxxl)
        .accessibilityElement(children: .combine)
    }
}

struct ErrorBanner: View {
    let message: String
    var retry: (() -> Void)?

    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            HStack(alignment: .top, spacing: HearthSpacing.md) {
                Image(systemName: "wifi.exclamationmark")
                    .foregroundStyle(hearth.danger)
                Text(message)
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let retry {
                    Button("Retry", action: retry)
                        .font(HearthFont.subheadline)
                }
            }
        }
    }
}

/// Shown above content that came from this phone's saved copy instead of the server.
struct CachedBanner: View {
    let savedAt: Date

    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Offline · saved copy").font(HearthFont.subheadline)
                    Text("From \(savedAt.formatted(.relative(presentation: .named))). Edits you make are queued and sync when the server is back.")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textSecondary)
                }
            } icon: {
                Image(systemName: "icloud.slash").foregroundStyle(hearth.textSecondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("CachedBanner")
    }
}

/// Marks a row or field whose change is still waiting in the outbox.
struct QueuedBadge: View {
    @Environment(\.hearth) private var hearth

    var body: some View {
        Label("Queued", systemImage: "clock.arrow.circlepath")
            .labelStyle(.titleAndIcon)
            .font(HearthFont.caption)
            .foregroundStyle(hearth.textTertiary)
            .accessibilityLabel("Change waiting to sync")
    }
}

/// Search snippets mark matched terms with `[` `]`.
enum Snippet {
    /// `title` is dropped where the snippet merely repeats it (meaning matches start with the item's title).
    static func attributed(_ snippet: String, highlight: Color, title: String = "") -> AttributedString {
        // Snippets are cut from Markdown; drop heading, fence and table marks so they read as prose.
        var flat = snippet
            .replacing(/#{1,6} |```|\|/, with: " ")
            .replacing(/\s+/, with: " ")
            .trimmingCharacters(in: .whitespaces)
        while !title.isEmpty, flat.count > title.count, flat.hasPrefix(title) {
            flat = String(flat.dropFirst(title.count)).trimmingCharacters(in: .whitespaces)
        }
        var result = AttributedString()
        var buffer = ""
        var inMatch = false
        func emit() {
            guard !buffer.isEmpty else { return }
            var part = AttributedString(buffer)
            if inMatch {
                part.foregroundColor = highlight
                part.inlinePresentationIntent = .stronglyEmphasized
            }
            result += part
            buffer = ""
        }
        for character in flat {
            if character == "[", !inMatch {
                emit()
                inMatch = true
            } else if character == "]", inMatch {
                emit()
                inMatch = false
            } else {
                buffer.append(character)
            }
        }
        emit()
        return result
    }
}
