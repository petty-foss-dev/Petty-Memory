import EnveMemoryKit
import SwiftUI

struct SettingsView: View {
    @Environment(Connection.self) private var connection
    @Environment(OutboxService.self) private var outbox
    @Environment(OfflineSync.self) private var offline
    @Environment(Router.self) private var router
    @Environment(ThemeManager.self) private var theme
    @Environment(\.hearth) private var hearth

    @State private var confirmUnpair = false
    @State private var checking = false
    @AppStorage(GettingStartedCard.dismissedKey) private var gettingStartedDismissed = false

    var body: some View {
        HearthScreen(title: "Settings") {
            server
            offlineCopy
            outboxSection
            library
            privacy
            appearance
            about
        }
        .task { await outbox.reload() }
        .confirmationDialog("Unpair this phone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) { unpair() }
        } message: {
            Text("The token is removed from this phone. It stays valid on your computer until you revoke it with `petty-memory clients revoke`.")
        }
    }

    private var server: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Overline("Server")
            HearthCard {
                VStack(alignment: .leading, spacing: HearthSpacing.md) {
                    HStack(spacing: HearthSpacing.sm) {
                        Circle().fill(statusColor).frame(width: 10, height: 10)
                        Text(statusText)
                            .font(HearthFont.headline)
                            .accessibilityIdentifier("ConnectionStatus")
                        Spacer()
                        if checking {
                            ProgressView()
                        } else {
                            Button("Check") { check() }.font(HearthFont.subheadline)
                        }
                    }
                    if case .offline(let message) = connection.status {
                        Text(message).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
                    }
                    if let pairing = connection.pairing {
                        detail("Address", pairing.baseURL.absoluteString)
                        detail("This device", pairing.clientName)
                        if case .online(let server, let me) = connection.status {
                            detail("Server version", server.version)
                            detail("Permissions", me.scopes.joined(separator: ", "))
                        }
                    }
                    HStack(spacing: HearthSpacing.sm) {
                        Button("Pair again") { router.showPairing = true }
                            .buttonStyle(.hearthSecondary)
                        Button("Unpair") { confirmUnpair = true }
                            .buttonStyle(.hearthDestructive)
                    }
                }
            }
        }
    }

    private func detail(_ label: String, _ value: String) -> some View {
        LabeledContent {
            Text(value).foregroundStyle(hearth.textPrimary).textSelection(.enabled).multilineTextAlignment(.trailing)
        } label: {
            Text(label).foregroundStyle(hearth.textSecondary)
        }
        .font(HearthFont.callout)
    }

    private var statusText: String {
        switch connection.status {
        case .online: "Connected"
        case .offline: "Can't reach the server"
        case .unauthorized: "Pairing revoked — pair again"
        case .unknown, .checking: "Checking…"
        }
    }

    private var statusColor: Color {
        switch connection.status {
        case .online: hearth.success
        case .offline, .unauthorized: hearth.danger
        case .unknown, .checking: hearth.textTertiary
        }
    }

    private var outboxSection: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            HStack {
                Overline("Outbox")
                Spacer()
                if !outbox.entries.isEmpty {
                    Button(outbox.isFlushing ? "Syncing…" : "Sync now") { Task { await outbox.flush(ignoringBackoff: true) } }
                        .font(HearthFont.subheadline)
                        .disabled(outbox.isFlushing)
                }
            }
            ForEach(outbox.notices) { notice in
                HearthCard(padding: HearthSpacing.md) {
                    HStack(alignment: .top, spacing: HearthSpacing.md) {
                        TypeGlyph(symbol: "exclamationmark.triangle", tint: hearth.danger)
                        Text(notice.message)
                            .font(HearthFont.footnote)
                            .foregroundStyle(hearth.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button("Dismiss") { Task { await outbox.dismiss(notice) } }
                            .font(HearthFont.subheadline)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("OutboxNotice")
            }
            if outbox.entries.isEmpty {
                HearthCard(padding: HearthSpacing.md) {
                    Label("Everything is synced.", systemImage: "checkmark.circle")
                        .font(HearthFont.callout)
                        .foregroundStyle(hearth.textSecondary)
                        .accessibilityIdentifier("OutboxEmpty")
                }
            } else {
                RowStack(data: outbox.entries) { entry in
                    OutboxRow(entry: entry,
                              retry: { Task { await outbox.retry(entry) } },
                              remove: { Task { await outbox.remove(entry) } },
                              saveDraft: entry.recoverableDraft.map { edit in { saveDraft(entry, edit) } })
                }
            }
        }
    }

    private var offlineCopy: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Overline("Offline copy")
            HearthCard(padding: HearthSpacing.md) {
                HStack(alignment: .top, spacing: HearthSpacing.md) {
                    TypeGlyph(symbol: "externaldrive")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(offlineHeadline).font(HearthFont.subheadline)
                        Text(offlineDetail).font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
                        if let error = offline.lastError {
                            Text(error).font(HearthFont.caption).foregroundStyle(hearth.danger)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if offline.isRefreshing { ProgressView() }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("OfflineCopyStatus")
            }
        }
    }

    private var offlineHeadline: String {
        guard let summary = offline.summary, summary.items > 0 else { return "Not saved yet" }
        return "\(summary.items.formatted()) items · \(summary.projects.formatted()) projects"
    }

    private var offlineDetail: String {
        guard let summary = offline.summary else { return "Saved while you're connected, so you can browse and search without your server." }
        if summary.isBuilding {
            return "Saving your library for offline use. Items saved so far already open offline; browsing, lists and search follow once it's complete."
        }
        let updated = summary.refreshedAt.map { "Updated \($0.formatted(.relative(presentation: .named)))" } ?? "Waiting for the first full copy"
        return "\(updated). Browse, open and search it offline. Secret notes and unsaved AI conversations aren't cached; chats you explicitly save are ordinary library notes."
    }

    private var library: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Overline("Import and guides")
            HearthCard(padding: HearthSpacing.md) {
                VStack(alignment: .leading, spacing: HearthSpacing.md) {
                    Button { router.open(.enveImport) } label: {
                        settingsRow("Import Enve highlights", detail: "Book highlights and notes from an Enve export file", symbol: "books.vertical")
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("SettingsEnveImport")
                    HearthDivider()
                    Toggle(isOn: Binding(get: { !gettingStartedDismissed }, set: { gettingStartedDismissed = !$0 })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Getting started in Library").font(HearthFont.subheadline)
                            Text("A short checklist of capture, review, import and optional AI").font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
                        }
                    }
                    .accessibilityIdentifier("SettingsGettingStarted")
                }
            }
        }
    }

    private var privacy: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Overline("Vault and sharing")
            HearthCard(padding: HearthSpacing.md) {
                VStack(alignment: .leading, spacing: HearthSpacing.md) {
                    Button { router.open(.vault) } label: {
                        settingsRow("Vault", detail: connection.canUseVault ? "Secret notes, encrypted on this phone"
                                                                             : "Needs a pairing with the “secrets” permission",
                                    symbol: "lock")
                    }
                    HearthDivider()
                    Button { router.open(.shares) } label: {
                        settingsRow("Public links", detail: "See and revoke read-only links", symbol: "link")
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func settingsRow(_ title: String, detail: String, symbol: String) -> some View {
        HStack(spacing: HearthSpacing.md) {
            TypeGlyph(symbol: symbol)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(HearthFont.subheadline)
                Text(detail).font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(hearth.textTertiary)
        }
        .contentShape(Rectangle())
    }

    private var appearance: some View {
        @Bindable var theme = theme
        return VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Overline("Appearance")
            HearthCard {
                VStack(alignment: .leading, spacing: HearthSpacing.md) {
                    Picker("Mode", selection: $theme.mode) {
                        ForEach(HearthMode.allCases) { Text($0.displayName).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    Toggle("True black (OLED)", isOn: $theme.oledEnabled)
                        .font(HearthFont.callout)
                        .disabled(theme.mode == .paper)
                }
            }
        }
    }

    private var about: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Overline("About")
            HearthCard {
                VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                    Text("Petty Memory \(Bundle.main.shortVersion)")
                        .font(HearthFont.cardTitle)
                    Text("Your library stays on your computer. This phone keeps its pairing token in the Keychain, an outbox of changes waiting to sync, and a copy of your ordinary notes, links, tasks and projects so you can read and search them offline. Secret notes are never in that copy, and their text, your passphrase, history, public links and AI results are never kept on the phone. Unpairing or pairing again deletes the copy.")
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                    Text("Free software under AGPL-3.0.")
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textTertiary)
                }
            }
        }
    }

    private func check() {
        checking = true
        Task {
            await connection.refresh()
            await outbox.flush(ignoringBackoff: true)
            checking = false
        }
    }

    /// Keeps a refused offline edit as its own note; the original entry goes only once the copy is sent or queued.
    private func saveDraft(_ entry: OutboxEntry, _ edit: ItemUpdate) {
        let title = edit.title ?? edit.baseTitle ?? ""
        let request = NewItemRequest(type: .note, title: title.isEmpty ? "Recovered draft" : "\(title) (draft)",
                                     body: edit.body ?? edit.baseBody ?? "")
        Task {
            guard let endpoint = try? Endpoint.createItem(request) else { return }
            if router.report(await outbox.submit(endpoint, kind: .note, title: "Recovered draft"), sent: "Draft saved as a new note") {
                await outbox.remove(entry)
            }
        }
    }

    private func unpair() {
        do {
            try connection.unpair()
        } catch {
            router.show(error.localizedDescription)
        }
    }
}

private struct OutboxRow: View {
    let entry: OutboxEntry
    let retry: () -> Void
    let remove: () -> Void
    let saveDraft: (() -> Void)?

    @Environment(\.hearth) private var hearth

    var body: some View {
        HStack(alignment: .top, spacing: HearthSpacing.md) {
            TypeGlyph(symbol: symbol, tint: entry.needsAttention ? hearth.danger : nil)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title.isEmpty ? entry.kind.rawValue.capitalized : entry.title)
                    .font(HearthFont.subheadline)
                    .lineLimit(2)
                Text(status)
                    .font(HearthFont.caption)
                    .foregroundStyle(entry.needsAttention ? hearth.danger : hearth.textTertiary)
                if let error = entry.lastError {
                    Text(error)
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textSecondary)
                        .lineLimit(3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Menu {
                if let saveDraft {
                    Button("Save draft as new note", systemImage: "doc.badge.plus", action: saveDraft)
                }
                Button("Retry now", systemImage: "arrow.clockwise", action: retry)
                Button("Discard", systemImage: "trash", role: .destructive, action: remove)
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 20))
                    .foregroundStyle(hearth.textSecondary)
                    .frame(width: 34, height: 34)
            }
            .accessibilityLabel("Actions for \(entry.title)")
        }
        .padding(.vertical, HearthSpacing.xs)
        .accessibilityElement(children: .contain)
    }

    private var symbol: String {
        switch entry.kind {
        case .note: "note.text"
        case .link: "link"
        case .task: "checkmark.circle"
        case .file: "doc"
        case .edit: "pencil"
        }
    }

    private var status: String {
        let queued = "Queued \(entry.createdAt.formatted(.relative(presentation: .named)))"
        if entry.needsAttention { return "\(queued) · the server refused it" }
        if entry.attempts == 0 { return queued }
        return "\(queued) · \(entry.attempts) \(entry.attempts == 1 ? "try" : "tries"), next \(entry.nextAttemptAt.formatted(.relative(presentation: .named)))"
    }
}

extension Bundle {
    var shortVersion: String {
        (infoDictionary?["CFBundleShortVersionString"] as? String) ?? "—"
    }
}
