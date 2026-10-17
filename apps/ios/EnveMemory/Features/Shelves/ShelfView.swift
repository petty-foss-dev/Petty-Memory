import EnveMemoryKit
import SwiftUI

extension Shelf {
    var title: String {
        switch self {
        case .pinned: "Pinned"
        case .intent(let intent): intent.label
        case .unopened: "Unopened"
        case .reminders: "Reminders"
        case .review: "Review"
        case .attention(let level): level == .high ? "Needs attention" : "\(level.rawValue.capitalized) attention"
        }
    }

    var symbol: String {
        switch self {
        case .pinned: "pin"
        case .intent(let intent): intent.symbol
        case .unopened: "envelope.badge"
        case .reminders: "bell"
        case .review: "eye"
        case .attention: "exclamationmark.circle"
        }
    }

    var emptyMessage: String {
        switch self {
        case .pinned: "Pin something from its detail page to keep it here."
        case .intent(let intent): "Links you mark “\(intent.label)” collect here. New links get a guess you can change."
        case .unopened(let days): "Everything saved more than \(days) days ago has been opened at least once."
        case .reminders: "Set a reminder from any item's “Remind me” menu."
        case .review: "Turn on “Marked for review” in an item's “Shows as” card to collect it here."
        case .attention: "Set an item's attention to High to keep it here."
        }
    }
}

/// One shelf, up to the server's page limit. Shelves sort by their own key, so they load in one request.
struct ShelfView: View {
    let shelf: Shelf

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(ReminderScheduler.self) private var reminders
    @Environment(\.hearth) private var hearth

    @State private var items: [Item] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var cachedAt: Date?

    var body: some View {
        HearthScreen(title: shelf.title, overline: "Shelf") {
            if shelf == .reminders, !items.isEmpty, !reminders.isAllowed { NotificationPrompt() }
            if let cachedAt { CachedBanner(savedAt: cachedAt) }
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            if items.isEmpty {
                if loaded, error == nil { EmptyStateView(symbol: shelf.symbol, title: "Nothing here", message: shelf.emptyMessage) }
            } else {
                RowStack(data: items) { item in
                    Button { router.open(.item(item.id)) } label: { ItemRow(item: item) }
                        .buttonStyle(.plain)
                }
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private func load() async {
        guard connection.client != nil else { return }
        do {
            let loaded = try await connection.load(.items(ItemFilter(limit: 200, shelf: shelf)), as: [Item].self)
            items = loaded.value
            cachedAt = loaded.cachedAt
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
            connection.note(error)
        }
        loaded = true
    }
}

/// Asks for notification permission where it obviously matters: next to the user's reminders.
struct NotificationPrompt: View {
    @Environment(ReminderScheduler.self) private var reminders
    @Environment(\.hearth) private var hearth
    @Environment(\.openURL) private var openURL

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            HStack(spacing: HearthSpacing.md) {
                TypeGlyph(symbol: "bell.badge")
                VStack(alignment: .leading, spacing: 2) {
                    Text("Get reminders on this phone").font(HearthFont.subheadline)
                    Text(reminders.canAsk ? "They'll arrive even when you're away from your network."
                                          : "Notifications are off for Petty Memory in Settings.")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button(reminders.canAsk ? "Turn on" : "Settings") {
                    if reminders.canAsk {
                        Task { await reminders.requestAuthorizationIfNeeded() }
                    } else if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                        openURL(url)
                    }
                }
                .font(HearthFont.subheadline)
            }
        }
        .accessibilityIdentifier("NotificationPrompt")
    }
}

/// What deserves a look again: review marks, high attention, and the revisit and unopened signals.
struct SuggestionsSection: View {
    @Environment(Router.self) private var router

    var body: some View {
        Overline("Suggestions")
        FlowLayout(spacing: HearthSpacing.sm) {
            ForEach(Shelf.suggestions) { shelf in
                FilterChip(title: shelf.title, systemImage: shelf.symbol, isSelected: false) {
                    router.open(.shelf(shelf))
                }
                .accessibilityIdentifier("Suggestion_\(shelf.id)")
            }
        }
    }
}

/// The shelves as a grid of chips on Home.
struct ShelvesSection: View {
    @Environment(Router.self) private var router

    var body: some View {
        Overline("Shelves")
        FlowLayout(spacing: HearthSpacing.sm) {
            ForEach(Shelf.all) { shelf in
                FilterChip(title: shelf.title, systemImage: shelf.symbol, isSelected: false) {
                    router.open(.shelf(shelf))
                }
                .accessibilityIdentifier("Shelf_\(shelf.id)")
            }
        }
    }
}
