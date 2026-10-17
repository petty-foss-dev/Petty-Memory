import EnveMemoryKit
import SwiftUI

/// One version's snapshot next to another (the newest, or the one before it), with restore as a new change.
struct VersionDetailView: View {
    let summary: ItemVersionSummary
    let newest: ItemVersionSummary?
    let previous: ItemVersionSummary?

    @Environment(Connection.self) private var connection
    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    enum Baseline: Hashable { case newest, previous }

    @State private var version: ItemVersion?
    @State private var other: ItemVersion?
    @State private var baseline: Baseline = .newest
    @State private var error: String?
    @State private var confirmRestore = false
    @State private var restoring = false

    private var baselineSummary: ItemVersionSummary? { baseline == .newest ? newest : previous }

    var body: some View {
        NavigationStack {
            HearthScreen {
                Text(summary.label).font(HearthFont.itemTitle)
                Text("\(summary.at.formatted(date: .complete, time: .shortened)) by \(summary.actor)")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                if summary.isBaseline {
                    Label("The state when history began. Nothing before this was recorded.", systemImage: "flag")
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                }
                if let error { ErrorBanner(message: error) { Task { await load() } } }
                comparePicker
                if let version {
                    if version.snapshot.items.isEmpty {
                        Text("This version records a deletion. Restore an earlier version instead.")
                            .font(HearthFont.callout)
                            .foregroundStyle(hearth.textSecondary)
                    } else {
                        SnapshotComparison(version: version, other: baselineSummary?.id == summary.id ? nil : other,
                                           otherLabel: baseline == .newest ? "Newest" : "Version before")
                    }
                } else if error == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, HearthSpacing.xl)
                }
            }
            .navigationTitle("Version")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(restoring ? "Restoring…" : "Restore") { confirmRestore = true }
                        .disabled(restoring || version == nil || version?.snapshot.items.isEmpty == true || summary.id == newest?.id)
                }
            }
            .confirmationDialog("Restore this version?", isPresented: $confirmRestore, titleVisibility: .visible) {
                Button("Restore") { restore() }
            } message: {
                Text("The item and what was inside it go back to this state as a new change. Items added since stay, and the current state stays in history.")
            }
            .task { await load() }
            .task(id: baseline) { await loadOther() }
        }
        .tint(hearth.accent)
    }

    @ViewBuilder
    private var comparePicker: some View {
        if summary.id != newest?.id || previous != nil {
            Picker("Compare with", selection: $baseline) {
                if summary.id != newest?.id { Text("Newest").tag(Baseline.newest) }
                if previous != nil { Text("Version before").tag(Baseline.previous) }
            }
            .pickerStyle(.segmented)
            .onAppear { if summary.id == newest?.id { baseline = .previous } }
        }
    }

    private func load() async {
        guard let client = connection.client else { return }
        do {
            version = try await client.send(.version(summary.id), as: ItemVersion.self)
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func loadOther() async {
        guard let client = connection.client, let target = baselineSummary, target.id != summary.id else {
            other = nil
            return
        }
        other = try? await client.send(.version(target.id), as: ItemVersion.self)
    }

    /// A secret note's version goes through the vault route (ciphertext only, needs a connection and `secrets`);
    /// anything else through the outbox. Either way, files that didn't come back are named, now or once it's sent.
    private func restore() {
        restoring = true
        Task {
            defer { restoring = false }
            if version?.snapshot.root?.item.item.isSecret == true {
                await restoreSecret()
                return
            }
            let outcome = await outbox.submit(.restoreVersion(summary.id), kind: .edit, title: "Restore a version")
            if case .sent(let data) = outcome, let result = try? JSONCoding.makeDecoder().decode(RestoreResult.self, from: data) {
                router.show(result.summary("Restored as a new change"))
                dismiss()
            } else if router.report(outcome, sent: "Restored as a new change") {
                dismiss()
            }
        }
    }
}

extension VersionDetailView {
    private func restoreSecret() async {
        guard connection.canUseVault, let client = connection.privateClient else {
            router.show("Restoring a secret note's history needs this phone's “secrets” permission and a connection.")
            return
        }
        do {
            let result = try await client.send(.restoreSecretVersion(summary.id), as: RestoreResult.self)
            connection.didWrite()
            router.show(result.summary("Secret note restored as a new change"))
            dismiss()
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.localizedDescription
        }
    }
}

/// Plain before/after: the root's title and text, and which items inside were added, removed or changed.
private struct SnapshotComparison: View {
    let version: ItemVersion
    let other: ItemVersion?
    let otherLabel: String

    @Environment(\.hearth) private var hearth

    var body: some View {
        let root = version.snapshot.root?.item.item
        let otherRoot = other?.snapshot.root?.item.item
        field("Title", root?.title ?? "", otherRoot?.title)
        field("Text", root?.body ?? "", otherRoot?.body)
        let inside = Array(version.snapshot.items.filter { $0.id != version.snapshot.rootId })
        Overline(inside.count == 1 ? "1 item inside" : "\(inside.count) items inside")
        if let other {
            changes(against: other)
        }
        if !inside.isEmpty {
            HearthCard(padding: HearthSpacing.md) {
                VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                    ForEach(inside) { node in
                        Text("• \(node.item.item.displayTitle)")
                            .font(HearthFont.footnote)
                            .padding(.leading, CGFloat(depth(of: node)) * HearthSpacing.md)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func field(_ label: String, _ value: String, _ otherValue: String?) -> some View {
        VStack(alignment: .leading, spacing: HearthSpacing.xs) {
            HStack {
                Overline(label)
                Spacer()
                if let otherValue {
                    Text(otherValue == value ? "Same as \(otherLabel.lowercased())" : "Changed")
                        .font(HearthFont.caption)
                        .foregroundStyle(otherValue == value ? hearth.textTertiary : hearth.accent)
                }
            }
            HearthCard(padding: HearthSpacing.md) {
                VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                    Text("This version").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                    Text(value.isEmpty ? "(empty)" : value).font(HearthFont.callout).textSelection(.enabled)
                    if let otherValue, otherValue != value {
                        HearthDivider()
                        Text(otherLabel).font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                        Text(otherValue.isEmpty ? "(empty)" : otherValue).font(HearthFont.callout).foregroundStyle(hearth.textSecondary)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func changes(against other: ItemVersion) -> some View {
        let mine = Dictionary(version.snapshot.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let theirs = Dictionary(other.snapshot.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let onlyHere = version.snapshot.items.filter { theirs[$0.id] == nil }
        let onlyThere = other.snapshot.items.filter { mine[$0.id] == nil }
        let changed = version.snapshot.items.filter { node in
            guard node.id != version.snapshot.rootId, let match = theirs[node.id] else { return false }
            return match.item.item.title != node.item.item.title || match.item.item.body != node.item.item.body || match.parentId != node.parentId
        }
        if onlyHere.isEmpty, onlyThere.isEmpty, changed.isEmpty {
            Text("Same items inside as the \(otherLabel.lowercased()).").font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(onlyHere) { Text("Only in this version: \($0.item.item.displayTitle)") }
                ForEach(onlyThere) { Text("Only in \(otherLabel.lowercased()): \($0.item.item.displayTitle)") }
                ForEach(changed) { Text("Different: \($0.item.item.displayTitle)") }
            }
            .font(HearthFont.footnote)
            .foregroundStyle(hearth.textSecondary)
        }
    }

    private func depth(of node: VersionNode) -> Int {
        let parents = Dictionary(version.snapshot.items.map { ($0.id, $0.parentId) }, uniquingKeysWith: { first, _ in first })
        var depth = 0
        var current = node.parentId
        while let id = current, id != version.snapshot.rootId, depth < 8 {
            depth += 1
            current = parents[id] ?? nil
        }
        return depth
    }
}
