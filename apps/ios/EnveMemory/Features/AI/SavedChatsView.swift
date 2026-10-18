import EnveMemoryKit
import SwiftUI

extension ChatMode {
    var label: String {
        switch self {
        case .ask: "Ask"
        case .edit: "Change notes"
        case .organize: "Organize"
        case .actions: "Actions"
        }
    }
}

/// Conversations the user chose to save, fetched from the computer each time through the uncached client.
/// From Home, picking one opens it in AI chat; from a chat, `onPick` decides.
struct SavedChatsView: View {
    var currentID: String?
    /// The chat that opened this list has unsaved messages or a draft, so opening another one asks first.
    var replacesUnsaved = false
    var onPick: ((String) -> Void)?

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var conversations: [SavedConversation] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var archiving: SavedConversation?
    @State private var replacing: SavedConversation?
    @State private var working = false
    @State private var query = ""

    var body: some View {
        HearthScreen(title: "Saved chats", overline: "AI chat") {
            Text("Only conversations you saved are here. Open one to read it or carry on; saving again updates it. Earlier proposals come back as summaries and can't be applied again.")
                .font(HearthFont.footnote)
                .foregroundStyle(hearth.textSecondary)
            if let reason { OnlineOnlyNote(reason: reason) }
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            if conversations.isEmpty {
                if loaded, error == nil {
                    EmptyStateView(symbol: "tray", title: query.isEmpty ? "No saved chats" : "No matching chats",
                                   message: query.isEmpty ? "In AI chat, tap Save to keep a conversation. Unsaved chats are never stored." : "Try other words from the title or messages.")
                } else if reason == nil, error == nil {
                    ProgressView().frame(maxWidth: .infinity)
                }
            } else {
                RowStack(data: conversations) { conversation in
                    SavedChatRow(conversation: conversation, isCurrent: conversation.id == currentID, canArchive: canWrite,
                                 open: { open(conversation) }, archive: { archiving = conversation })
                }
                .disabled(!loaded)
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .searchable(text: $query, prompt: "Search saved chats")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if onPick != nil {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
        .confirmationDialog("Archive “\(archiving?.title ?? "")”?", isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil } }),
                            titleVisibility: .visible, presenting: archiving) { conversation in
            Button("Archive") { archive(conversation) }
                .accessibilityIdentifier("SavedChatArchiveConfirm")
        } message: { _ in
            Text("It leaves this list and stays in your library as an archived item, so it can be restored. Nothing is deleted.")
        }
        .confirmationDialog("Open “\(replacing?.title ?? "")”?", isPresented: Binding(get: { replacing != nil }, set: { if !$0 { replacing = nil } }),
                            titleVisibility: .visible, presenting: replacing) { conversation in
            Button("Open and clear the current chat") { onPick?(conversation.id) }
                .accessibilityIdentifier("SavedChatReplaceConfirm")
        } message: { _ in
            Text("The chat you came from isn't saved, including any message you haven't sent. Opening this one clears it.")
        }
        .refreshable { await load() }
        .task(id: "\(connection.isOnline):\(query)") { await load() }
    }

    private var reason: String? {
        switch connection.status {
        case .online: nil
        case .unknown, .checking: "Connecting to your computer…"
        case .offline: "Saved chats open only while your computer is reachable."
        case .unauthorized: "This phone's pairing was revoked. Pair again to see saved chats."
        }
    }

    private var canWrite: Bool { connection.isOnline && connection.scopes.contains("write") && !working }

    private func load() async {
        guard connection.isOnline, let client = connection.privateClient else { return }
        let search = query
        loaded = false
        do {
            if !search.isEmpty { try await Task.sleep(for: .milliseconds(250)) }
            let matches = try await client.send(Endpoint.searchConversations(search), as: [SavedConversation].self)
            try Task.checkCancellation()
            guard query == search else { return }
            conversations = matches.sorted { $0.updatedAt > $1.updatedAt }
            error = nil
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, query == search else { return }
            connection.note(error)
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func open(_ conversation: SavedConversation) {
        guard let onPick else {
            router.open(.savedChat(conversation.id))
            return
        }
        if replacesUnsaved { replacing = conversation } else { onPick(conversation.id) }
    }

    private func archive(_ conversation: SavedConversation) {
        guard let client = connection.privateClient else { return }
        archiving = nil
        working = true
        Task {
            defer { working = false }
            do {
                _ = try await client.data(for: .archiveConversation(conversation.id))
                conversations.removeAll { $0.id == conversation.id }
                connection.didWrite()
                router.show("Archived “\(conversation.title)”")
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }
}

private struct SavedChatRow: View {
    let conversation: SavedConversation
    let isCurrent: Bool
    let canArchive: Bool
    let open: () -> Void
    let archive: () -> Void

    @Environment(\.hearth) private var hearth

    var body: some View {
        HStack(spacing: HearthSpacing.md) {
            Button(action: open) {
                HStack(spacing: HearthSpacing.md) {
                    TypeGlyph(symbol: "bubble.left.and.text.bubble.right")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: conversation.title).font(HearthFont.subheadline).lineLimit(2)
                        Text(details).font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, HearthSpacing.xs)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("SavedChat")
            Menu {
                Button("Archive…", systemImage: "archivebox", action: archive)
                    .disabled(!canArchive)
            } label: {
                Image(systemName: "ellipsis.circle").foregroundStyle(hearth.textSecondary)
            }
            .accessibilityLabel("Actions for \(conversation.title)")
        }
    }

    private var details: String {
        let exchanges = conversation.exchanges.count
        return [conversation.mode.label, exchanges == 1 ? "1 exchange" : "\(exchanges) exchanges",
                isCurrent ? "Open now" : "Updated \(conversation.updatedAt.formatted(.relative(presentation: .named)))"]
            .joined(separator: " · ")
    }
}
