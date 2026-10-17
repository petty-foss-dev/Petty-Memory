import EnveMemoryKit
import SwiftUI

/// Moves a secret note to the top level or inside another secret note. Only secret notes are offered as parents:
/// a secret note may sit under ordinary content, but nothing ordinary may go under a secret one.
struct VaultMovePicker: View {
    let item: Item
    let onMoved: () -> Void

    @Environment(Connection.self) private var connection
    @Environment(VaultSession.self) private var vault
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var notes: [Item] = []
    @State private var hasMore = false
    @State private var loading = false
    @State private var moving = false
    @State private var error: String?

    private let pageSize = 50

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { move(to: nil) } label: { Label("Top level", systemImage: "list.bullet.indent") }
                } footer: {
                    Text("Where it sits is visible to your library; its text stays encrypted.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(hearth.danger) }
                }
                Section("Inside a secret note") {
                    ForEach(notes.filter { $0.id != item.id }) { note in
                        Button { move(to: note.id) } label: {
                            Label(vault.opened[note.id].map { $0.title.isEmpty ? "Untitled" : $0.title } ?? "Secret note", systemImage: "lock.fill")
                                .foregroundStyle(hearth.textPrimary)
                        }
                    }
                    if loading {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if hasMore {
                        Button("Show more") { Task { await load(more: true) } }
                    }
                }
            }
            .disabled(moving)
            .navigationTitle("Move secret note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task { await load(more: false) }
        }
        .tint(hearth.accent)
        .vaultShield()
        .onChange(of: vault.isUnlocked) { _, unlocked in
            if !unlocked { dismiss() }
        }
    }

    private func load(more: Bool) async {
        guard let client = connection.privateClient else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await client.send(.secretItems(limit: pageSize, before: more ? notes.last?.pageCursor : nil), as: [Item].self)
            notes = (more ? notes : []) + page
            hasMore = page.count == pageSize
            for note in page where vault.opened[note.id] == nil && note.metadata.vault?.isPortable == true {
                _ = try? await vault.open(note)
            }
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// The server checks the destination: no cycles, and a secret parent only for secret notes.
    private func move(to parentID: String?) {
        guard let client = connection.privateClient else { return }
        moving = true
        Task {
            defer { moving = false }
            do {
                _ = try await client.data(for: .moveOutlineItem(item.id, parentId: parentID, beforeId: nil))
                connection.didWrite()
                router.show("Moved")
                onMoved()
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.localizedDescription
            }
        }
    }
}
