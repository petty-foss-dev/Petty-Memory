import EnveMemoryKit
import SwiftUI

struct HomeView: View {
    @Environment(Connection.self) private var connection
    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var items: [Item] = []
    @State private var loadError: String?
    @State private var loaded = false
    @State private var hasMore = false
    @State private var loadingMore = false
    @State private var cachedAt: Date?

    private let pageSize = 30

    var body: some View {
        HearthScreen(title: "Home", overline: statusLine) {
            QuickCaptureBar()
            if outbox.pendingCount > 0 { OutboxBanner() }
            if let cachedAt { CachedBanner(savedAt: cachedAt) }
            if let loadError { ErrorBanner(message: loadError) { Task { await load() } } }
            LibraryShortcuts()
            SuggestionsSection()
            ShelvesSection()
            recent
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private var statusLine: String {
        switch connection.status {
        case .online(let server, _): "Connected · \(connection.pairing?.baseURL.host() ?? "") · v\(server.version)"
        case .offline: "Offline"
        case .unauthorized: "Pairing revoked"
        case .unknown, .checking: "Connecting…"
        }
    }

    @ViewBuilder
    private var recent: some View {
        Overline("Recent")
        if items.isEmpty {
            if loaded, loadError == nil {
                EmptyStateView(symbol: "tray", title: "Nothing saved yet",
                               message: "Capture a note above, or share a link from Safari to Petty Memory.")
            }
        } else {
            RowStack(data: items) { item in
                Button { router.open(.item(item.id)) } label: { ItemRow(item: item) }
                    .buttonStyle(.plain)
            }
            if hasMore {
                Button { Task { await loadMore() } } label: {
                    if loadingMore { ProgressView() } else { Text("Show older") }
                }
                .buttonStyle(.hearthSecondary)
                .disabled(loadingMore)
                .accessibilityIdentifier("ShowOlder")
            }
        }
    }

    private func load() async {
        guard connection.client != nil else { return }
        do {
            let loaded = try await connection.load(.items(ItemFilter(limit: pageSize)), as: [Item].self)
            let page = loaded.value
            items = page
            cachedAt = loaded.cachedAt
            hasMore = page.count == pageSize && loaded.cachedAt == nil
            loadError = nil
            if loaded.cachedAt == nil, !connection.isOnline { await connection.refresh() }
        } catch is CancellationError {
            return
        } catch {
            loadError = error.localizedDescription
            connection.note(error)
        }
        loaded = true
    }

    private func loadMore() async {
        guard let client = connection.client, let last = items.last, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await client.items(ItemFilter(limit: pageSize, before: last.pageCursor))
            let known = Set(items.map(\.id))
            items += page.filter { !known.contains($0.id) }
            hasMore = page.count == pageSize
        } catch {
            router.show(error.localizedDescription)
            connection.note(error)
        }
    }
}

/// The outline, saved views and templates, plus the vault and public links when this phone may use them.
private struct LibraryShortcuts: View {
    @Environment(Router.self) private var router
    @Environment(Connection.self) private var connection

    var body: some View {
        FlowLayout(spacing: HearthSpacing.sm) {
            FilterChip(title: "Outline", systemImage: "list.bullet.indent", isSelected: false) { router.open(.outline(nil)) }
                .accessibilityIdentifier("OpenOutline")
            FilterChip(title: "Saved views", systemImage: "line.3.horizontal.decrease.circle", isSelected: false) { router.open(.savedViews) }
                .accessibilityIdentifier("OpenSavedViews")
            FilterChip(title: "Templates", systemImage: "doc.on.doc", isSelected: false) { router.open(.templates) }
                .accessibilityIdentifier("OpenTemplates")
            if connection.canUseVault {
                FilterChip(title: "Vault", systemImage: "lock", isSelected: false) { router.open(.vault) }
                    .accessibilityIdentifier("OpenVault")
            }
            FilterChip(title: "Public links", systemImage: "link", isSelected: false) { router.open(.shares) }
        }
    }
}

/// Type and send. A bare URL is saved as a link, anything else as a note.
private struct QuickCaptureBar: View {
    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var text = ""
    @State private var sending = false
    @FocusState private var focused: Bool

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.md) {
                HStack(alignment: .bottom, spacing: HearthSpacing.sm) {
                    TextField("Jot something, or paste a link", text: $text, axis: .vertical)
                        .lineLimit(1...6)
                        .focused($focused)
                        .font(HearthFont.body)
                        .padding(.vertical, HearthSpacing.sm)
                        .accessibilityIdentifier("QuickCaptureField")
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(canSend ? hearth.accent : hearth.textTertiary)
                    }
                    .disabled(!canSend)
                    .accessibilityLabel("Save")
                    .accessibilityIdentifier("QuickCaptureSend")
                }
                HStack(spacing: HearthSpacing.sm) {
                    ForEach(CaptureKind.allCases) { kind in
                        FilterChip(title: kind.title, systemImage: kind.symbol, isSelected: false) {
                            router.capture = kind
                        }
                        .accessibilityLabel("New \(kind.title.lowercased())")
                    }
                }
            }
        }
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { !trimmed.isEmpty && !sending }

    private func send() {
        let value = trimmed
        sending = true
        Task {
            defer { sending = false }
            let isLink = URL.web(value) != nil
            let request = isLink ? CaptureRequest(url: value) : CaptureRequest(note: value)
            guard let endpoint = try? Endpoint.capture(request) else { return }
            let outcome = await outbox.submit(endpoint, kind: isLink ? .link : .note, title: String(value.prefix(60)))
            if router.report(outcome, sent: isLink ? "Link saved" : "Note saved") {
                text = ""
                focused = false
            }
        }
    }
}

private struct OutboxBanner: View {
    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            HStack(spacing: HearthSpacing.md) {
                TypeGlyph(symbol: "tray.and.arrow.up")
                VStack(alignment: .leading, spacing: 2) {
                    Text(outbox.pendingCount == 1 ? "1 change waiting to sync" : "\(outbox.pendingCount) changes waiting to sync")
                        .font(HearthFont.subheadline)
                    Text("They'll send when your server is reachable.")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if outbox.isFlushing {
                    ProgressView()
                } else {
                    Button("Sync") { Task { await outbox.flush(ignoringBackoff: true) } }
                        .font(HearthFont.subheadline)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { router.selectedTab = .settings }
        }
        .accessibilityIdentifier("OutboxBanner")
    }
}
