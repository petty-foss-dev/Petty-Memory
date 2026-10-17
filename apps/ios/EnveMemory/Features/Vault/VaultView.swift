import EnveMemoryKit
import SwiftUI

/// Secret notes, sealed and opened on this phone, shown nested under the secret notes they sit in. The list itself is
/// ciphertext; titles appear only once unlocked.
struct VaultView: View {
    @Environment(Connection.self) private var connection
    @Environment(VaultSession.self) private var vault
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var notes: [Item] = []
    @State private var hasMore = false
    @State private var loadingMore = false
    @State private var error: String?
    @State private var loaded = false
    @State private var composing = false
    /// Each note's parent, read from the outline once the vault is open; placement is visible metadata, not secret.
    @State private var parents: [String: String] = [:]
    @State private var placed: Set<String> = []

    private let pageSize = 50

    private struct Row: Identifiable {
        let item: Item
        let depth: Int
        var id: String { item.id }
    }

    /// Notes under their secret parents, in list order. A note whose parent isn't loaded yet starts its own branch.
    private var rows: [Row] {
        let ids = Set(notes.map(\.id))
        var below: [String: [Item]] = [:]
        var roots: [Item] = []
        for note in notes {
            if let parent = parents[note.id], ids.contains(parent), parent != note.id { below[parent, default: []].append(note) } else { roots.append(note) }
        }
        var result: [Row] = []
        var seen: Set<String> = []
        func add(_ item: Item, depth: Int) {
            guard seen.insert(item.id).inserted else { return }
            result.append(Row(item: item, depth: depth))
            for child in below[item.id] ?? [] { add(child, depth: depth + 1) }
        }
        for root in roots { add(root, depth: 0) }
        for note in notes where !seen.contains(note.id) { add(note, depth: 0) }
        return result
    }

    var body: some View {
        HearthScreen(title: "Vault", overline: "Secret notes") {
            if !connection.canUseVault {
                VaultScopeNotice()
            } else {
                if let error { ErrorBanner(message: error) { Task { await load() } } }
                if !vault.isUnlocked {
                    if loaded { VaultUnlockCard(notes: notes) }
                } else {
                    unlockedContent
                }
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if vault.isUnlocked {
                ToolbarItem(placement: .primaryAction) {
                    Button("Lock", systemImage: "lock") { vault.lock() }
                        .accessibilityIdentifier("VaultLock")
                }
            }
        }
        .sheet(isPresented: $composing) {
            VaultEditor(item: nil) { _ in Task { await load() } }.environment(\.hearth, hearth)
        }
        .vaultShield()
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
        .task(id: vault.isUnlocked) { await openTitles() }
    }

    @ViewBuilder
    private var unlockedContent: some View {
        Button { composing = true } label: { Label("New secret note", systemImage: "plus") }
            .buttonStyle(.hearthPrimary)
            .accessibilityIdentifier("VaultNewNote")
        if notes.isEmpty {
            EmptyStateView(symbol: "lock.doc", title: "No secret notes yet",
                           message: "Notes you add here are encrypted on this phone before they're sent. Your computer stores only ciphertext.")
        } else {
            RowStack(data: rows) { row in
                Button { router.open(.vaultNote(row.id)) } label: { VaultRow(item: row.item, plain: vault.opened[row.id]) }
                    .buttonStyle(.plain)
                    .padding(.leading, CGFloat(min(row.depth, 6)) * HearthSpacing.lg)
                    .accessibilityHint(row.depth > 0 ? "Inside the secret note above" : "")
            }
        }
        VaultRecoveryCard()
        if hasMore {
            Button { Task { await loadMore() } } label: {
                if loadingMore { ProgressView() } else { Text("Show older secret notes") }
            }
            .buttonStyle(.hearthSecondary)
            .disabled(loadingMore)
            .accessibilityIdentifier("VaultShowMore")
        }
    }

    private func load() async {
        guard connection.canUseVault, connection.privateClient != nil else { return }
        do {
            var (page, more) = try await fetchPage(after: [])
            // Unlocking checks the passphrase against a note sealed here; keep paging until one turns up, or none is left.
            while more, !page.contains(where: { $0.metadata.vault?.isPortable == true }) {
                (page, more) = try await fetchPage(after: page)
            }
            notes = page
            hasMore = more
            parents = [:]
            placed = []
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
            connection.note(error)
        }
        loaded = true
        await openTitles()
    }

    private func loadMore() async {
        loadingMore = true
        defer { loadingMore = false }
        do {
            (notes, hasMore) = try await fetchPage(after: notes)
            await openTitles()
        } catch is CancellationError {
            return
        } catch {
            router.show(error.localizedDescription)
            connection.note(error)
        }
    }

    /// Online only, through the client that never caches: the list is ciphertext and generic labels.
    private func fetchPage(after loaded: [Item]) async throws -> ([Item], Bool) {
        guard let client = connection.privateClient else { return (loaded, false) }
        let page = try await client.send(.secretItems(limit: pageSize, before: loaded.last?.pageCursor), as: [Item].self)
        let seen = Set(loaded.map(\.id))
        return (loaded + page.filter { !seen.contains($0.id) }, page.count == pageSize)
    }

    private func openTitles() async {
        guard vault.isUnlocked else { return }
        for item in notes where vault.opened[item.id] == nil && item.metadata.vault?.isPortable == true {
            _ = try? await vault.open(item)
        }
        guard let client = connection.privateClient else { return }
        for item in notes where !placed.contains(item.id) {
            guard vault.isUnlocked, !Task.isCancelled else { return }
            guard let entry = try? await client.send(.outlineEntry(item.id), as: OutlineEntry.self) else { continue }
            placed.insert(item.id)
            parents[item.id] = entry.parentId
        }
    }
}

private struct VaultRow: View {
    let item: Item
    let plain: VaultCrypto.Plain?

    @Environment(\.hearth) private var hearth

    var body: some View {
        HStack(spacing: HearthSpacing.md) {
            TypeGlyph(symbol: plain == nil ? "lock.fill" : "lock.open")
            VStack(alignment: .leading, spacing: 2) {
                Text(plain.map { $0.title.isEmpty ? "Untitled" : $0.title } ?? "Secret note")
                    .font(HearthFont.cardTitle)
                    .lineLimit(2)
                Text(subtitle)
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, HearthSpacing.sm)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String {
        if item.metadata.vault?.isPortable == false { return "Sealed on your computer · open it there" }
        return "Updated \(item.updatedAt.formatted(.relative(presentation: .named)))"
    }
}

/// The passphrase never leaves this view's state and the vault session, and is cleared as soon as it's used.
struct VaultUnlockCard: View {
    let notes: [Item]

    @Environment(VaultSession.self) private var vault
    @Environment(\.hearth) private var hearth

    @State private var passphrase = ""
    @State private var confirmation = ""
    @State private var working = false
    @State private var error: String?
    @State private var recovering = false

    private var isFirst: Bool { !notes.contains { $0.metadata.vault?.isPortable == true } }
    private var legacyOnly: Bool { isFirst && notes.contains { $0.metadata.vault != nil } }

    var body: some View {
        HearthCard {
            VStack(alignment: .leading, spacing: HearthSpacing.md) {
                Label(isFirst ? "Choose a vault passphrase" : "Unlock your vault", systemImage: "lock.shield")
                    .font(HearthFont.headline)
                Text(isFirst
                     ? "Secret notes are encrypted on this phone with this passphrase. It can't be recovered, so keep it somewhere safe. Use the same passphrase in the browser."
                     : "Your passphrase stays on this phone and is forgotten when you lock the vault or leave the app.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                if legacyOnly {
                    Text("Notes sealed on your computer in the older format open only there.")
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                }
                SecureField("Passphrase", text: $passphrase)
                    .textContentType(.password)
                    .hearthField()
                    .accessibilityIdentifier("VaultPassphrase")
                if isFirst {
                    SecureField("Repeat passphrase", text: $confirmation)
                        .textContentType(.password)
                        .hearthField()
                }
                if let error {
                    Text(error).font(HearthFont.footnote).foregroundStyle(hearth.danger)
                }
                Button(action: unlock) {
                    if working { ProgressView() } else { Text(isFirst ? "Set passphrase" : "Unlock") }
                }
                .buttonStyle(.hearthPrimary)
                .disabled(!canSubmit)
                .accessibilityIdentifier("VaultUnlock")
                if !isFirst {
                    Button("Forgot it? Use a recovery kit") { recovering = true }
                        .font(HearthFont.subheadline)
                        .accessibilityIdentifier("VaultUseRecoveryKit")
                }
            }
        }
        .sheet(isPresented: $recovering) {
            VaultRecoverForm(notes: notes).environment(\.hearth, hearth)
        }
        .onDisappear { clear() }
    }

    private var canSubmit: Bool {
        guard !working, !passphrase.isEmpty else { return false }
        return !isFirst || (passphrase.count >= 8 && passphrase == confirmation)
    }

    private func unlock() {
        let entered = passphrase
        clear()
        working = true
        Task {
            defer { working = false }
            do {
                try await vault.unlock(entered, notes: notes)
                error = nil
            } catch is CancellationError {
                return
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func clear() {
        passphrase = ""
        confirmation = ""
    }
}

struct VaultScopeNotice: View {
    @Environment(Connection.self) private var connection
    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Label(connection.isOnline ? "This phone can't open the vault" : "The vault needs your server",
                      systemImage: "lock.slash")
                    .font(HearthFont.headline)
                Text(connection.isOnline
                     ? "Its pairing doesn't include the “secrets” permission, and it's never added automatically. On your computer, create a token that includes it, for example `petty-memory clients add \"My iPhone\" --scope read,write,secrets`, then use “Pair again” in Settings with that token. Revoking a phone later stops it reaching your server; it can't erase anything a phone already opened, though this app keeps nothing decrypted once the vault locks."
                     : "Secret notes are never kept on this phone. Connect to your server to open them.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
            }
        }
        .accessibilityIdentifier("VaultScopeNotice")
    }
}

/// Covers secret content whenever the app isn't frontmost, including in the app switcher snapshot.
private struct VaultShield: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.hearth) private var hearth

    func body(content: Content) -> some View {
        content
            .privacySensitive()
            .overlay {
                if scenePhase != .active {
                    ZStack {
                        hearth.background.ignoresSafeArea()
                        Image(systemName: "lock.fill").font(.largeTitle).foregroundStyle(hearth.accent)
                    }
                    .accessibilityLabel("Vault hidden")
                }
            }
    }
}

extension View {
    func vaultShield() -> some View { modifier(VaultShield()) }
}
