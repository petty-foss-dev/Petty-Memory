import EnveMemoryKit
import SwiftUI

struct HomeView: View {
    @Environment(Connection.self) private var connection
    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router

    @State private var items: [Item] = []
    @State private var loadError: String?
    @State private var loaded = false
    @State private var hasMore = false
    @State private var loadingMore = false
    @State private var cachedAt: Date?

    private let pageSize = 30

    var body: some View {
        HearthScreen(title: "Home", overline: statusLine) {
            if isUnauthorized { PairingNotice() }
            QuickCaptureBar()
            if outbox.pendingCount > 0 { OutboxBanner() }
            HomeActions()
            if let cachedAt { CachedBanner(savedAt: cachedAt) }
            if let loadError, !isUnauthorized { ErrorBanner(message: loadError) { Task { await load() } } }
            recent
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private var statusLine: String? {
        if case .offline = connection.status { "Offline" } else { nil }
    }

    private var isUnauthorized: Bool { connection.status == .unauthorized }

    @ViewBuilder
    private var recent: some View {
        Overline("Recent")
        if items.isEmpty {
            if loaded, loadError == nil {
                EmptyStateView(symbol: "tray", title: "Nothing saved yet",
                               message: "Type above to save a note or paste a link. Tap + for a task or photo, or share from any app.")
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

/// Type and send. A bare URL is saved as a link, anything else as a note.
private struct QuickCaptureBar: View {
    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth
    @Environment(\.dynamicTypeSize) private var typeSize

    @State private var text = ""
    @State private var sending = false
    @FocusState private var focused: Bool

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            HStack(alignment: .bottom, spacing: HearthSpacing.sm) {
                Menu {
                    ForEach(CaptureKind.allCases) { kind in
                        Button { router.capture = kind } label: {
                            Label("New \(kind.title.lowercased())", systemImage: kind.symbol)
                        }
                    }
                } label: {
                    Image(systemName: "plus.circle")
                        .font(.system(size: 30))
                        .foregroundStyle(hearth.accent)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("New item")
                .accessibilityHint("Choose a note, link, task or image")
                .accessibilityIdentifier("QuickCaptureMenu")
                TextField("Quick note", text: $text,
                          prompt: Text(typeSize.isAccessibilitySize ? "Note" : "Write a note or paste a link")
                            .foregroundStyle(hearth.textTertiary), axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .font(HearthFont.body)
                    .padding(.vertical, HearthSpacing.sm)
                    .accessibilityIdentifier("QuickCaptureField")
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 30))
                        .foregroundStyle(canSend ? hearth.accent : hearth.textTertiary)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .disabled(!canSend)
                .accessibilityLabel("Save")
                .accessibilityIdentifier("QuickCaptureSend")
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

private struct HomeActions: View {
    @Environment(Router.self) private var router
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: HearthSpacing.sm))
            : AnyLayout(HStackLayout(spacing: HearthSpacing.sm))
        layout {
            Button { router.open(.aiChat) } label: {
                Label("Ask AI", systemImage: "bubble.left.and.text.bubble.right")
            }
            .accessibilityIdentifier("OpenAIChat")
            Button { router.open(.library) } label: {
                Label("Library", systemImage: "rectangle.stack")
            }
            .accessibilityHint("Outline, review, shelves, saved views and more")
            .accessibilityIdentifier("OpenLibrary")
        }
        .buttonStyle(.hearthSecondary)
    }
}

private struct PairingNotice: View {
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            HStack(alignment: .top, spacing: HearthSpacing.md) {
                Image(systemName: "exclamationmark.lock")
                    .foregroundStyle(hearth.danger)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Pairing revoked").font(HearthFont.subheadline)
                    Text("Pair this phone again to see and sync your library. Waiting changes stay queued.")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button("Pair again") { router.showPairing = true }
                    .font(HearthFont.subheadline)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("PairingNotice")
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
