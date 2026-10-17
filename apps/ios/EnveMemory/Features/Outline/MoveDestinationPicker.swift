import EnveMemoryKit
import SwiftUI

/// Browse to a branch, then put the item at its end or just before one of its children. Branches load a page at a
/// time and show queued notes and moves, so a note created offline can be a destination.
struct MoveDestinationPicker: View {
    let item: Item
    let onPick: (_ parentID: String?, _ beforeID: String?) -> Void

    @Environment(Connection.self) private var connection
    @Environment(OutboxService.self) private var outbox
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var trail: [Item] = []
    @State private var entries: [OutlineEntry] = []
    @State private var total = 0
    @State private var error: String?
    @State private var loading = false

    private let pageSize = 100

    private var branchID: String? { trail.last?.id }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { pick(before: nil) } label: {
                        Label(branchID == nil ? "At the end of the top level" : "At the end of “\(trail.last!.displayTitle)”",
                              systemImage: "text.append")
                    }
                    .disabled(branchID == item.id)
                } header: {
                    breadcrumbs
                }
                if let error {
                    Section { Text(error).foregroundStyle(hearth.danger) }
                }
                let page = outbox.pending.arrange(entries, total: total, under: branchID)
                Section(page.total > page.items.count ? "\(page.items.count) of \(page.total)" : "Inside") {
                    ForEach(page.items) { entry in row(entry) }
                    if loading {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if page.items.count < page.total {
                        Button("Show more (\(page.total - page.items.count))") { Task { await load(more: true) } }
                            .accessibilityIdentifier("MovePickerMore")
                    }
                }
            }
            .navigationTitle("Move “\(item.displayTitle)”")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task(id: branchID) { await load() }
        }
        .tint(hearth.accent)
    }

    private var breadcrumbs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: HearthSpacing.xs) {
                Button("Top level") { trail = [] }
                ForEach(Array(trail.enumerated()), id: \.element.id) { index, crumb in
                    Image(systemName: "chevron.right").font(.caption2).accessibilityHidden(true)
                    Button(crumb.displayTitle) { trail = Array(trail.prefix(index + 1)) }.lineLimit(1)
                }
            }
            .textCase(nil)
        }
    }

    private func row(_ entry: OutlineEntry) -> some View {
        let isSelf = entry.id == item.id
        let canEnter = !isSelf && OutlineMover.canHold(entry, child: item)
        let canAnchor = !isSelf && OutlineMover.canAnchor(entry, in: branchID)
        return HStack(spacing: HearthSpacing.md) {
            Button {
                if canEnter { trail.append(entry.item) }
            } label: {
                HStack {
                    Text(entry.item.displayTitle).lineLimit(2).foregroundStyle(isSelf ? hearth.textTertiary : hearth.textPrimary)
                    Spacer()
                    if isSelf {
                        Text("This item").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                    } else if canEnter {
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(hearth.textTertiary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!canEnter)
            .accessibilityHint(canEnter ? "Opens this branch" : "")
            Button { pick(before: entry.id) } label: {
                Image(systemName: "arrow.turn.left.up")
            }
            .buttonStyle(.borderless)
            .disabled(!canAnchor)
            .accessibilityLabel("Place before \(entry.item.displayTitle)")
        }
    }

    private func pick(before beforeID: String?) {
        onPick(branchID, beforeID)
        dismiss()
    }

    private func load(more: Bool = false) async {
        if !more {
            entries = []
            total = 0
        }
        if let branchID, outbox.pending.created[branchID] != nil { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await connection.load(.outline(parent: branchID, offset: entries.count, limit: pageSize), as: OutlinePage.self).value
            let seen = Set(entries.map(\.id))
            entries += page.items.filter { !seen.contains($0.id) }
            total = page.items.isEmpty ? entries.count : page.total
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }
}
