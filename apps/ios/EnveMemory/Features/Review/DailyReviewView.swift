import EnveMemoryKit
import SwiftUI

/// What's due for another look today. Choosing when to see it again is online only, so the schedule never forks.
struct DailyReviewView: View {
    @Environment(Connection.self) private var connection
    @Environment(ProjectStore.self) private var projects
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var projectID: String?
    @State private var cards: [ReviewCard] = []
    @State private var loaded = false
    @State private var loading = false
    @State private var error: String?
    @State private var reviewed = 0
    @State private var scheduling: String?
    @State private var custom: ReviewCard?

    private let pageSize = 20

    var body: some View {
        HearthScreen(title: "Daily review", overline: "Library") {
            Text("Revisit notes, links, files and images. Open one to read it, then choose when to see it again. Secret notes, saved chats and workflow definitions stay out of review.")
                .font(HearthFont.footnote)
                .foregroundStyle(hearth.textSecondary)
            HStack {
                Text("Project").font(HearthFont.subheadline)
                Spacer()
                Picker("Project", selection: $projectID) {
                    Text("All projects").tag(String?.none)
                    ForEach(projects.refs, id: \.id) { Text($0.name).tag(Optional($0.id)) }
                }
                .accessibilityIdentifier("ReviewProject")
            }
            if let reason = readReason ?? writeReason { OnlineOnlyNote(reason: reason) }
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            progress
            if cards.isEmpty {
                if loaded, error == nil, readReason == nil {
                    EmptyStateView(symbol: "checkmark.seal", title: reviewed > 0 ? "Batch complete" : "Nothing due",
                                   message: reviewed > 0 ? "You reviewed \(reviewed) items. Pull to refresh for another batch."
                                                         : "New knowledge appears automatically. Scheduled items return when they're due.")
                } else if loading {
                    ProgressView().frame(maxWidth: .infinity)
                }
            } else {
                ForEach(cards) { card in
                    ReviewCardView(card: card, isBusy: scheduling == card.id, canSchedule: writeReason == nil && scheduling == nil,
                                   open: { router.open(.item(card.id)) },
                                   schedule: { schedule(card, days: $0) },
                                   chooseDays: { custom = card })
                }
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: ReloadKey(projectID: projectID, isOnline: connection.isOnline)) { await load() }
        .sheet(item: $custom) { card in
            CustomIntervalSheet(title: card.item.displayTitle) { schedule(card, days: $0) }
                .environment(\.hearth, hearth)
        }
    }

    private struct ReloadKey: Equatable {
        let projectID: String?
        let isOnline: Bool
    }

    @ViewBuilder
    private var progress: some View {
        if reviewed > 0 || !cards.isEmpty {
            let total = reviewed + cards.count
            VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                ProgressView(value: Double(reviewed), total: Double(max(total, 1)))
                Text(cards.count == pageSize ? "\(reviewed) reviewed · at least \(cards.count) due" : "\(reviewed) of \(total) reviewed")
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textTertiary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("ReviewProgress")
        }
    }

    private var readReason: String? {
        switch connection.status {
        case .online: nil
        case .unknown, .checking: "Connecting to your computer…"
        case .offline: "Daily review needs a connection to your computer. Reviews aren't queued, so your schedule stays the same everywhere."
        case .unauthorized: "This phone's pairing was revoked. Pair again to review."
        }
    }

    private var writeReason: String? {
        guard readReason == nil, !connection.scopes.contains("write") else { return nil }
        return "This pairing is read-only. You can open what's due, but choosing when to see it again needs read and write access."
    }

    private func load() async {
        guard connection.isOnline, let client = connection.privateClient else { return }
        loading = true
        defer { loading = false }
        do {
            cards = try await client.send(.reviewQueue(limit: pageSize, project: projectID), as: [ReviewCard].self)
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func schedule(_ card: ReviewCard, days: Int) {
        guard writeReason == nil, let client = connection.privateClient else { return }
        scheduling = card.id
        error = nil
        Task {
            defer { scheduling = nil }
            do {
                _ = try await client.send(.scheduleReview(card.id, days: days), as: Item.self)
                cards.removeAll { $0.id == card.id }
                reviewed += 1
                router.show("You'll see “\(card.item.displayTitle)” again \(ReviewCardView.label(days: days).lowercased())")
                if cards.isEmpty { await load() }
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }
}

private struct ReviewCardView: View {
    let card: ReviewCard
    let isBusy: Bool
    let canSchedule: Bool
    let open: () -> Void
    let schedule: (Int) -> Void
    let chooseDays: () -> Void

    @Environment(\.hearth) private var hearth

    static func label(days: Int) -> String {
        switch days {
        case ReviewInterval.tomorrow: "Tomorrow"
        case ReviewInterval.nextWeek: "In a week"
        case ReviewInterval.nextMonth: "In a month"
        default: "In \(days) days"
        }
    }

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Button(action: open) { ItemRow(item: card.item) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("ReviewOpen")
                Text(details)
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textSecondary)
                Text("See it again")
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textTertiary)
                FlowLayout(spacing: HearthSpacing.sm) {
                    ForEach([ReviewInterval.tomorrow, ReviewInterval.nextWeek, ReviewInterval.nextMonth], id: \.self) { days in
                        FilterChip(title: Self.label(days: days), isSelected: false) { schedule(days) }
                            .accessibilityIdentifier("ReviewIn\(days)")
                    }
                    FilterChip(title: "Other…", systemImage: "calendar", isSelected: false, action: chooseDays)
                        .accessibilityIdentifier("ReviewCustom")
                }
                .disabled(!canSchedule)
                if isBusy { ProgressView() }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ReviewCard")
    }

    private var details: String {
        var parts = [card.reason]
        if let last = card.lastReviewedAt {
            parts.append("Last reviewed \(last.formatted(.relative(presentation: .named)))")
        }
        if card.reviewCount > 0 { parts.append(card.reviewCount == 1 ? "Reviewed once" : "Reviewed \(card.reviewCount) times") }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

private struct CustomIntervalSheet: View {
    let title: String
    let schedule: (Int) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var days = 3

    var body: some View {
        NavigationStack {
            HearthScreen {
                Text("When should “\(title)” come back?")
                    .font(HearthFont.callout)
                Stepper(value: $days, in: ReviewInterval.range) {
                    Text(days == 1 ? "In 1 day" : "In \(days) days").font(HearthFont.headline)
                }
                .accessibilityIdentifier("ReviewDays")
                Text("Around \(Calendar.current.date(byAdding: .day, value: days, to: .now)?.formatted(date: .complete, time: .omitted) ?? "")")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
            }
            .navigationTitle("See it again")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Schedule") {
                        schedule(days)
                        dismiss()
                    }
                    .accessibilityIdentifier("ReviewDaysConfirm")
                }
            }
        }
        .tint(hearth.accent)
        .presentationDetents([.medium])
    }
}
