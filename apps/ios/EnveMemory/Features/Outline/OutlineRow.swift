import EnveMemoryKit
import SwiftUI

struct OutlineRow: View {
    struct Actions {
        let toggle: () -> Void
        let open: () -> Void
        let details: () -> Void
        let edit: () -> Void
        let shift: (OutlineMover.Direction) -> Void
        let indent: () -> Void
        let outdent: () -> Void
        let moveTo: () -> Void
        let merge: () -> Void
    }

    let entry: OutlineEntry
    let title: String
    let presentation: ItemPresentation
    let isChecked: Bool
    let showsCheckbox: Bool
    let isQueued: Bool
    let isBusy: Bool
    let canOutdent: Bool
    /// The title of the note above, when this one can be merged into it.
    let mergeTarget: String?
    let actions: Actions

    @Environment(\.hearth) private var hearth

    private var item: Item { entry.item }
    private var isMovable: Bool { item.type != .decision }
    private var isEditable: Bool { item.type != .decision && !item.isSecret }

    var body: some View {
        HStack(alignment: .center, spacing: HearthSpacing.sm) {
            leading
            Button(action: actions.open) {
                VStack(alignment: .leading, spacing: 2) {
                    titleText
                    if let meta { Text(meta).font(HearthFont.caption).foregroundStyle(hearth.textTertiary) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(item.isSecret ? "Opens the vault" : "Shows what's inside")
            .accessibilityActions {
                if showsCheckbox { Button(isChecked ? "Uncheck" : "Check", action: actions.toggle) }
                Button("Details", action: actions.details)
                if isMovable {
                    Button("Move up") { actions.shift(.up) }
                    Button("Move down") { actions.shift(.down) }
                    Button("Indent", action: actions.indent)
                    if canOutdent { Button("Outdent", action: actions.outdent) }
                    Button("Move to…", action: actions.moveTo)
                }
                if let mergeTarget { Button("Merge into “\(mergeTarget)”", action: actions.merge) }
            }
            if isQueued { QueuedBadge() }
            if isBusy { ProgressView() }
            menu
        }
        .padding(.vertical, presentation.kind == .section ? HearthSpacing.md : HearthSpacing.sm)
        .opacity(presentation.attention == .low ? 0.65 : 1)
    }

    @ViewBuilder
    private var leading: some View {
        if showsCheckbox {
            Button(action: actions.toggle) {
                Image(systemName: isChecked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22))
                    .foregroundStyle(isChecked ? hearth.accent : hearth.textTertiary)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isBusy)
            .accessibilityLabel(isChecked ? "Uncheck \(title)" : "Check \(title)")
        } else {
            Image(systemName: glyph)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(presentation.attention == .high ? hearth.accent : hearth.textTertiary)
                .frame(width: 28, height: 28)
                .accessibilityHidden(true)
        }
    }

    private var glyph: String {
        if item.isSecret { return "lock.fill" }
        if presentation.attention == .high { return "exclamationmark.circle.fill" }
        return entry.childCount > 0 ? "chevron.right.circle" : "circle.fill"
    }

    private var titleText: some View {
        Text(title)
            .font(font)
            .foregroundStyle(isChecked ? hearth.textTertiary : hearth.textPrimary)
            .strikethrough(isChecked, color: hearth.textTertiary)
            .textCase(presentation.kind == .section ? .uppercase : nil)
            .lineLimit(3)
    }

    private var font: Font {
        switch presentation.kind {
        case .heading: HearthFont.heading3
        case .section: HearthFont.overline
        case .text: presentation.attention == .high ? HearthFont.body.weight(.semibold) : HearthFont.body
        }
    }

    private var meta: String? {
        var parts: [String] = []
        if entry.childCount > 0 { parts.append(entry.childCount == 1 ? "1 inside" : "\(entry.childCount) inside") }
        if presentation.review { parts.append("Review") }
        if item.type != .note { parts.append(item.type.label) }
        if entry.item.archivedAt != nil { parts.append("Archived") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var menu: some View {
        Menu {
            Button("Details", systemImage: "info.circle", action: actions.details)
            if isEditable { Button("Edit", systemImage: "pencil", action: actions.edit) }
            if isMovable {
                Section("Move") {
                    Button("Move up", systemImage: "arrow.up") { actions.shift(.up) }
                    Button("Move down", systemImage: "arrow.down") { actions.shift(.down) }
                    Button("Indent", systemImage: "increase.indent", action: actions.indent)
                    if canOutdent { Button("Outdent", systemImage: "decrease.indent", action: actions.outdent) }
                    Button("Move to…", systemImage: "arrow.up.and.down.and.arrow.left.and.right", action: actions.moveTo)
                }
            }
            if let mergeTarget {
                Button("Merge into “\(mergeTarget)”", systemImage: "arrow.merge", action: actions.merge)
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(hearth.textSecondary)
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .disabled(isBusy)
        .accessibilityLabel("Actions for \(title)")
    }
}
