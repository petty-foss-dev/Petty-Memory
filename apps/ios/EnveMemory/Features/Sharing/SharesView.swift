import EnveMemoryKit
import SwiftUI

/// Every public link this library has handed out. Links themselves can't be shown again; only revoked.
struct SharesView: View {
    @Environment(Connection.self) private var connection
    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var shares: [PublicShare] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var revoking: PublicShare?

    var body: some View {
        HearthScreen(title: "Public links", overline: "Sharing") {
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            if loaded, shares.isEmpty, error == nil {
                EmptyStateView(symbol: "link", title: "No public links",
                               message: "Create one from an item's menu. Anyone with the link can read that item and what's inside it.")
            } else if !shares.isEmpty {
                RowStack(data: shares) { share in
                    ShareRow(share: share, open: { router.open(.item(share.rootId)) }, revoke: { revoking = share })
                }
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Revoke this link?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
                            titleVisibility: .visible, presenting: revoking) { share in
            Button("Revoke", role: .destructive) { revoke(share) }
        } message: { _ in
            Text("Anyone who has it can no longer open it. The items themselves aren't changed.")
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private func load() async {
        guard let client = connection.privateClient else { return }
        do {
            shares = try await client.send(.shares, as: [PublicShare].self)
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func revoke(_ share: PublicShare) {
        revoking = nil
        Task { await ItemActions(outbox: outbox, router: router).run(.revokeShare(share.id), kind: .edit, title: "Revoke a public link", sent: "Link revoked") }
    }
}

private struct ShareRow: View {
    let share: PublicShare
    let open: () -> Void
    let revoke: () -> Void

    @Environment(\.hearth) private var hearth

    var body: some View {
        HStack(spacing: HearthSpacing.md) {
            Button(action: open) {
                HStack(spacing: HearthSpacing.md) {
                    TypeGlyph(symbol: share.isActive() ? "link" : "link.badge.plus", tint: share.isActive() ? nil : hearth.textTertiary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(status).font(HearthFont.subheadline)
                        Text(detail).font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if share.isActive() {
                Button("Revoke", role: .destructive, action: revoke).font(HearthFont.subheadline)
            }
        }
        .padding(.vertical, HearthSpacing.xs)
    }

    private var status: String {
        if let revoked = share.revokedAt { return "Revoked \(revoked.formatted(.relative(presentation: .named)))" }
        if let expires = share.expiresAt {
            return expires > .now ? "Expires \(expires.formatted(.relative(presentation: .named)))" : "Expired"
        }
        return "Active, no expiry"
    }

    private var detail: String {
        var parts = ["Created \(share.createdAt.formatted(date: .abbreviated, time: .shortened))"]
        if !share.excludedIds.isEmpty { parts.append("\(share.excludedIds.count) left out") }
        return parts.joined(separator: " · ")
    }
}
