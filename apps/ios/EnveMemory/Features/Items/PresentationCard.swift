import EnveMemoryKit
import SwiftUI

/// Heading/section style, attention, review mark and checklist controls. Each change is an undoable action, queued when offline.
struct PresentationCard: View {
    let item: Item
    let progress: ChecklistProgress?

    @Environment(OutboxService.self) private var outbox
    @Environment(EditorHistory.self) private var history
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var confirmReset = false

    private var presentation: ItemPresentation { outbox.pending.presentation(of: item) }
    private var checked: Bool { outbox.pending.checked(item.id) ?? item.isChecked }
    private var actions: ItemActions { ItemActions(outbox: outbox, router: router) }

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.md) {
                HStack {
                    Overline("Shows as")
                    Spacer()
                    if outbox.pending.presentation[item.id] != nil { QueuedBadge() }
                }
                Picker("Style", selection: binding(\.kind) { ItemPresentation.Patch(kind: $0) }) {
                    Text("Text").tag(ItemPresentation.Kind.text)
                    Text("Heading").tag(ItemPresentation.Kind.heading)
                    Text("Section").tag(ItemPresentation.Kind.section)
                }
                .pickerStyle(.segmented)
                Picker("Attention", selection: binding(\.attention) { ItemPresentation.Patch(attention: $0) }) {
                    Text("Low").tag(ItemPresentation.Attention.low)
                    Text("Normal").tag(ItemPresentation.Attention.normal)
                    Text("High").tag(ItemPresentation.Attention.high)
                }
                .pickerStyle(.segmented)
                .accessibilityLabel("Attention")
                Toggle("Marked for review", isOn: binding(\.review) { ItemPresentation.Patch(review: $0) })
                HearthDivider()
                Toggle("Checklist", isOn: binding(\.checklist) { ItemPresentation.Patch(checklist: $0) })
                if presentation.checklist {
                    Toggle("Hide completed", isOn: binding(\.hideCompleted) { ItemPresentation.Patch(hideCompleted: $0) })
                    checklistProgress
                }
                if item.task == nil {
                    Toggle("Done", isOn: Binding(get: { checked }, set: setChecked))
                }
                HearthDivider()
                Toggle(isOn: binding(\.autoOrganize) { ItemPresentation.Patch(autoOrganize: $0) }) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Auto-organize with AI")
                        Text("Your computer's AI may tidy what's inside. Off unless you turn it on.")
                            .font(HearthFont.caption)
                            .foregroundStyle(hearth.textSecondary)
                    }
                }
            }
            .font(HearthFont.callout)
        }
        .confirmationDialog("Uncheck everything in this checklist?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset checklist") {
                Task { await actions.edit(.resetChecklist(item.id), title: "Reset “\(item.displayTitle)”", sent: "Checklist reset") }
            }
        }
    }

    @ViewBuilder
    private var checklistProgress: some View {
        HStack {
            if let progress, progress.total > 0 {
                ProgressView(value: Double(progress.done), total: Double(progress.total))
                    .tint(hearth.accent)
                Text("\(progress.done) of \(progress.total)")
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textSecondary)
                    .monospacedDigit()
            } else {
                Text("Nothing to check off yet").font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
                Spacer()
            }
            Button("Reset") { confirmReset = true }
                .font(HearthFont.subheadline)
                .disabled((progress?.done ?? 0) == 0)
        }
    }

    private func binding<Value: Equatable>(_ keyPath: KeyPath<ItemPresentation, Value>,
                                           patch: @escaping (Value) -> ItemPresentation.Patch) -> Binding<Value> {
        Binding(get: { presentation[keyPath: keyPath] }, set: { value in
            guard value != presentation[keyPath: keyPath] else { return }
            Task { await history.perform([.presentation(id: item.id, patch: patch(value))], label: "Restyle “\(item.displayTitle)”", sent: "Updated") }
        })
    }

    private func setChecked(_ value: Bool) {
        Task {
            await history.perform([.check(id: item.id, checked: value)], label: "\(value ? "Check" : "Uncheck") “\(item.displayTitle)”",
                                  sent: value ? "Checked" : "Unchecked")
        }
    }
}
