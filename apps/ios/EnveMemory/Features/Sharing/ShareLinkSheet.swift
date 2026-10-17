import EnveMemoryKit
import SwiftUI
import UniformTypeIdentifiers

/// Creates a read-only public link to an item and what's inside it. The link is shown once and never stored.
struct ShareLinkSheet: View {
    let item: Item

    @Environment(Connection.self) private var connection
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    enum Expiry: Hashable, CaseIterable {
        case never, day, week, month, custom

        var title: String {
            switch self {
            case .never: "Never"
            case .day: "1 day"
            case .week: "1 week"
            case .month: "30 days"
            case .custom: "Pick"
            }
        }
    }

    @State private var children: [OutlineEntry] = []
    @State private var childCount = 0
    @State private var excluded: Set<String> = []
    @State private var expiry: Expiry = .week
    @State private var customDate = Date.now.addingTimeInterval(14 * 86_400)
    @State private var creating = false
    @State private var created: URL?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let created {
                    createdSection(created)
                } else {
                    Section {
                        Text("Anyone with the link can read “\(item.displayTitle)” and what's inside it, without signing in. Secret notes, decisions and archived items are never included.")
                            .font(HearthFont.footnote)
                    }
                    Section("Expires") {
                        Picker("Expires", selection: $expiry) {
                            ForEach(Expiry.allCases, id: \.self) { Text($0.title).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        if expiry == .custom {
                            DatePicker("Expires", selection: $customDate, in: Date.now.addingTimeInterval(3600)..., displayedComponents: [.date, .hourAndMinute])
                        }
                    }
                    if !children.isEmpty {
                        Section {
                            ForEach(children) { entry in
                                Toggle(entry.item.displayTitle, isOn: Binding(
                                    get: { !excluded.contains(entry.id) },
                                    set: { if $0 { excluded.remove(entry.id) } else { excluded.insert(entry.id) } }))
                                    .disabled(entry.item.isSecret || entry.item.type == .decision)
                            }
                            if children.count < childCount {
                                Button("Show more (\(childCount - children.count))") { Task { await loadChildren() } }
                            }
                        } header: {
                            Text("Include")
                        } footer: {
                            Text("Leaving something out also leaves out everything inside it.")
                        }
                    }
                    if let error {
                        Section { Text(error).foregroundStyle(hearth.danger) }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(hearth.background)
            .navigationTitle("Public link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(created == nil ? "Cancel" : "Done") { close() } }
                if created == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(creating ? "Creating…" : "Create", action: create).disabled(creating)
                    }
                }
            }
            .task { await loadChildren() }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(creating || created != nil)
    }

    private func createdSection(_ url: URL) -> some View {
        Section {
            Text(url.absoluteString)
                .font(HearthFont.monospace)
                .textSelection(.enabled)
            Button("Copy link", systemImage: "doc.on.doc") {
                UIPasteboard.general.setItems([[UTType.url.identifier: url]], options: [.expirationDate: Date.now.addingTimeInterval(600)])
            }
            ShareLink(item: url) { Label("Share link", systemImage: "square.and.arrow.up") }
        } header: {
            Text("Your link")
        } footer: {
            Text("This is the only time the link is shown. If you lose it, revoke this share and create a new one. A copied link leaves the clipboard after 10 minutes.")
        }
    }

    private var expiresAt: Date? {
        switch expiry {
        case .never: nil
        case .day: .now.addingTimeInterval(86_400)
        case .week: .now.addingTimeInterval(7 * 86_400)
        case .month: .now.addingTimeInterval(30 * 86_400)
        case .custom: customDate
        }
    }

    private func create() {
        guard let client = connection.privateClient, let baseURL = connection.pairing?.baseURL else { return }
        creating = true
        error = nil
        Task {
            defer { creating = false }
            do {
                let share = try await client.send(.createShare(rootId: item.id, excludedIds: Array(excluded), expiresAt: expiresAt), as: CreatedShare.self)
                created = share.link(on: baseURL)
                connection.didWrite()
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = (error as? APIError)?.allowsCachedFallback == true
                    ? "Creating a link needs a connection to your server."
                    : error.localizedDescription
            }
        }
    }

    private func close() {
        created = nil
        dismiss()
    }

    private func loadChildren() async {
        guard let page = try? await connection.load(.outline(parent: item.id, offset: children.count, limit: 100), as: OutlinePage.self).value else { return }
        let seen = Set(children.map(\.id))
        children += page.items.filter { !seen.contains($0.id) }
        childCount = page.items.isEmpty ? children.count : page.total
    }
}
