import EnveMemoryKit
import SwiftUI

/// Organizing writes go through the outbox (with their idempotency key), like every other write.
struct ItemActions {
    let outbox: OutboxService
    let router: Router

    @discardableResult
    func run(_ endpoint: Endpoint, kind: OutboxEntry.Kind = .note, title: String, sent: String) async -> Bool {
        router.report(await outbox.submit(endpoint, kind: kind, title: title), sent: sent)
    }

    @discardableResult
    func edit(_ endpoint: Endpoint?, title: String, sent: String) async -> Bool {
        guard let endpoint else { return false }
        return await run(endpoint, kind: .edit, title: title, sent: sent)
    }

    /// A signal for the "unopened" shelf; it shouldn't reload the screen.
    func markOpened(_ item: Item) {
        Task { _ = await outbox.submit(.opened(item.id), kind: .link, title: "Opened “\(item.displayTitle)”", refresh: false) }
    }
}

struct PinButton: View {
    let item: Item

    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router

    var body: some View {
        Button {
            let pinned = !item.isPinned
            Task {
                guard let endpoint = try? Endpoint.pin(item.id, pinned) else { return }
                await ItemActions(outbox: outbox, router: router).run(endpoint, title: pinned ? "Pin" : "Unpin", sent: pinned ? "Pinned" : "Unpinned")
            }
        } label: {
            Image(systemName: item.isPinned ? "pin.fill" : "pin")
        }
        .accessibilityLabel(item.isPinned ? "Unpin" : "Pin")
        .accessibilityIdentifier("PinButton")
    }
}

/// Intent chips and the "Remind me" menu.
struct OrganizeCard: View {
    let item: Item

    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router
    @Environment(ReminderScheduler.self) private var reminders
    @Environment(\.hearth) private var hearth

    @State private var pickingDate = false
    @State private var pickedDate = ReminderPreset.tomorrow.date()

    private var actions: ItemActions { ItemActions(outbox: outbox, router: router) }

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.md) {
                HStack {
                    Overline("Keep it for")
                    Spacer()
                    if item.intent != nil, item.metadata.intentAuto == true {
                        Text("Guessed").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                    }
                }
                IntentChips(intent: Binding(get: { item.intent }, set: setIntent))
                HearthDivider()
                HStack(spacing: HearthSpacing.md) {
                    Image(systemName: activeReminder == nil ? "bell" : "bell.fill").foregroundStyle(hearth.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(activeReminder.map { "Reminds you \($0.formatted(.relative(presentation: .named)))" } ?? "No reminder")
                            .font(HearthFont.subheadline)
                        if let activeReminder {
                            Text(activeReminder.formatted(date: .complete, time: .shortened))
                                .font(HearthFont.caption)
                                .foregroundStyle(hearth.textSecondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    remindMenu
                }
            }
        }
        .sheet(isPresented: $pickingDate) { datePicker }
    }

    private var activeReminder: Date? {
        item.remindAt.flatMap { $0 > .now ? $0 : nil }
    }

    private var remindMenu: some View {
        Menu {
            ForEach(ReminderPreset.allCases) { preset in
                Button(preset.title) { setReminder(preset.date()) }
            }
            Button("Pick a date…", systemImage: "calendar") { pickingDate = true }
            if item.remindAt != nil {
                Button("Clear reminder", systemImage: "bell.slash", role: .destructive) { setReminder(nil) }
            }
        } label: {
            Text("Remind me")
                .font(HearthFont.subheadline)
                .foregroundStyle(hearth.accentText)
                .padding(.horizontal, HearthSpacing.md)
                .padding(.vertical, HearthSpacing.sm)
                .background(Capsule().fill(hearth.accentMuted))
        }
        .accessibilityIdentifier("RemindMenu")
    }

    private var datePicker: some View {
        NavigationStack {
            DatePicker("Remind me", selection: $pickedDate, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                .datePickerStyle(.graphical)
                .padding(HearthSpacing.lg)
                .navigationTitle("Remind me")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { pickingDate = false } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Set") {
                            pickingDate = false
                            setReminder(pickedDate)
                        }
                        .fontWeight(.semibold)
                    }
                }
        }
        .tint(hearth.accent)
        .presentationDetents([.large])
    }

    private func setIntent(_ intent: Intent?) {
        Task {
            guard let endpoint = try? Endpoint.setIntent(item.id, intent) else { return }
            await actions.run(endpoint, title: "Intent", sent: intent.map { "Marked “\($0.label)”" } ?? "Intent cleared")
        }
    }

    private func setReminder(_ date: Date?) {
        Task {
            guard let endpoint = try? Endpoint.setReminder(item.id, at: date) else { return }
            if let date {
                await reminders.requestAuthorizationIfNeeded()
                await reminders.schedule(item, at: date)
            } else {
                reminders.cancel(itemID: item.id)
            }
            let sent = date.map { "Reminder set for \($0.formatted(date: .abbreviated, time: .shortened))" } ?? "Reminder cleared"
            await actions.run(endpoint, title: "Reminder for “\(item.displayTitle)”", sent: sent)
        }
    }
}

/// The optional AI enrichment's summary and suggestions. Nothing is applied until the user accepts.
struct SuggestionsCard: View {
    let ai: AISuggestions
    let itemID: String

    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var accepting = false

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                HStack {
                    Label("Summary", systemImage: "sparkles")
                        .font(HearthFont.overline)
                        .foregroundStyle(hearth.textSecondary)
                    Spacer()
                    if ai.accepted == true {
                        Text("Suggestions applied").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                    }
                }
                if let summary = ai.summary, !summary.isEmpty {
                    Text(summary).font(HearthFont.callout)
                }
                if ai.isPending {
                    if let tags = ai.tags, !tags.isEmpty {
                        FlowLayout { ForEach(tags, id: \.self) { TagChip(tag: $0) } }
                    }
                    if let project = ai.project {
                        Label("Suggested project: \(project.name)", systemImage: "folder")
                            .font(HearthFont.footnote)
                            .foregroundStyle(hearth.textSecondary)
                    }
                    Button(accepting ? "Applying…" : "Accept suggestions") { accept() }
                        .buttonStyle(.hearthSecondary)
                        .disabled(accepting)
                        .accessibilityIdentifier("AcceptSuggestions")
                }
                if let model = ai.model {
                    Text("Suggested by \(model)").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                }
            }
        }
    }

    private func accept() {
        accepting = true
        Task {
            await ItemActions(outbox: outbox, router: router).run(.acceptSuggestions(itemID), title: "Accept suggestions", sent: "Suggestions applied")
            accepting = false
        }
    }
}
