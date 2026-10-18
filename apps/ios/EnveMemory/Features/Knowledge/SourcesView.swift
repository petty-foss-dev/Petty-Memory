import EnveMemoryKit
import SwiftUI

struct SourcesView: View {
    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var sources: [WatchedSource] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var creating = false

    var body: some View {
        HearthScreen(title: "Watched sources", overline: "Knowledge") {
            KnowledgeNote(text: "While Petty Memory runs on your computer, it checks enabled sources about every \(SourceLimits.checkIntervalHours) hours (looking for due ones every \(SourceLimits.pollMinutes) minutes), and you can check one now. A check only queues previews: nothing is imported or overwritten until you tick it and tap Apply, and earlier versions stay in history.")
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            Button { creating = true } label: { Label("Watch a source", systemImage: "plus") }
                .buttonStyle(.hearthPrimary)
                .disabled(connection.knowledgeWriteReason != nil || sources.count >= SourceLimits.watches)
                .accessibilityIdentifier("NewWatchedSource")
            if let reason = connection.knowledgeWriteReason { OnlineOnlyNote(reason: reason) }
            if sources.isEmpty {
                if loaded, error == nil {
                    EmptyStateView(symbol: KnowledgeArea.sources.symbol, title: "Nothing watched yet",
                                   message: "Watch a page you revisit, a blog's feed, or (approved on your computer) a folder of documents.")
                }
            } else {
                RowStack(data: sources) { source in
                    Button { router.open(.watchedSource(source.id)) } label: { row(source) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("WatchedSourceRow")
                }
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $creating) {
            WatchForm(existing: nil) { router.open(.watchedSource($0.id)) }
                .environment(\.hearth, hearth)
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private func row(_ source: WatchedSource) -> some View {
        HStack(alignment: .top, spacing: HearthSpacing.md) {
            TypeGlyph(symbol: source.kind.symbol)
            VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                Text(source.name).font(HearthFont.cardTitle).foregroundStyle(hearth.textPrimary).lineLimit(2)
                Text(source.detailLine).font(HearthFont.caption).foregroundStyle(hearth.textTertiary).lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if source.pending > 0 {
                Text("\(source.pending)")
                    .font(HearthFont.caption.weight(.semibold))
                    .foregroundStyle(hearth.onAccent)
                    .padding(.horizontal, HearthSpacing.sm)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(hearth.accent))
                    .accessibilityLabel("\(source.pending) waiting for review")
            }
        }
        .padding(.vertical, HearthSpacing.sm)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        guard connection.knowledgeReadReason == nil, let client = connection.privateClient else { loaded = true; return }
        do {
            sources = try await client.send(.sources, as: [WatchedSource].self)
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
        loaded = true
    }
}

extension WatchKind {
    var symbol: String {
        switch self {
        case .url: "globe"
        case .rss: "dot.radiowaves.up.forward"
        case .folder: "folder"
        }
    }
}

extension WatchedSource {
    var detailLine: String {
        var parts = [kind.label]
        if let url { parts.append(URL(string: url)?.host() ?? url) }
        if let folder { parts.append(folder.approved ? (folder.available ? "Folder approved" : "Folder unavailable") : "Folder not approved yet") }
        parts.append(enabled ? "Checked automatically" : "Checked only when you ask")
        if let check = lastCheck { parts.append("Last checked \(check.at.formatted(.relative(presentation: .named)))") }
        return parts.joined(separator: " · ")
    }
}

struct WatchForm: View {
    let existing: WatchedSource?
    let saved: (WatchedSource) -> Void

    @Environment(Connection.self) private var connection
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var name: String
    @State private var kind: WatchKind
    @State private var url: String
    @State private var project: String?
    @State private var enabled: Bool
    @State private var saving = false
    @State private var error: String?

    init(existing: WatchedSource?, saved: @escaping (WatchedSource) -> Void) {
        self.existing = existing
        self.saved = saved
        _name = State(initialValue: existing?.name ?? "")
        _kind = State(initialValue: existing?.kind ?? .url)
        _url = State(initialValue: existing?.url ?? "")
        _project = State(initialValue: existing?.project?.id)
        _enabled = State(initialValue: existing?.enabled ?? false)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let reason = connection.knowledgeWriteReason { Section { OnlineOnlyNote(reason: reason) } }
                Section {
                    TextField("Name", text: $name, prompt: Text("Garden club news"))
                        .accessibilityIdentifier("WatchName")
                    Picker("Kind", selection: $kind) {
                        ForEach(WatchKind.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    .disabled(existing != nil)
                    .accessibilityIdentifier("WatchKind")
                    if kind != .folder {
                        TextField("Address", text: $url, prompt: Text(kind == .rss ? "https://example.org/feed.xml" : "https://example.org/page"))
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("WatchURL")
                    }
                } footer: {
                    if kind == .folder {
                        Text("For safety, only Petty Memory on the computer that holds your library can choose the folder. Save the watch here, then approve its folder there; this phone never sends folder paths.")
                    } else {
                        Text("Only http and https addresses. Your computer fetches them; the phone never does.")
                    }
                }
                Section {
                    ProjectChoice(title: "File into", selection: $project, noneLabel: "Inbox")
                    Toggle("Check automatically", isOn: $enabled)
                        .accessibilityIdentifier("WatchEnabled")
                } footer: {
                    Text("Automatic checks run about every \(SourceLimits.checkIntervalHours) hours while Petty Memory runs on your computer. Changing the address, kind or project clears previews already waiting.")
                }
                if let error { Section { Text(error).foregroundStyle(hearth.danger) } }
            }
            .scrollContentBackground(.hidden)
            .background(hearth.background)
            .navigationTitle(existing == nil ? "Watch a source" : "Edit watch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save", action: save)
                        .disabled(!canSave)
                        .accessibilityIdentifier("WatchSave")
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(saving)
    }

    private var validURL: Bool {
        guard kind != .folder else { return true }
        guard let parsed = URL(string: url.trimmed), let scheme = parsed.scheme?.lowercased() else { return false }
        return (scheme == "http" || scheme == "https") && parsed.host() != nil && url.trimmed.utf16.count <= SourceLimits.url
    }

    private var canSave: Bool {
        !saving && connection.knowledgeWriteReason == nil && !name.trimmed.isEmpty && name.trimmed.utf16.count <= SourceLimits.name && validURL
    }

    private func save() {
        guard canSave, let client = connection.privateClient else { return }
        saving = true
        error = nil
        let address = kind == .folder ? nil : url.trimmed
        Task {
            defer { saving = false }
            do {
                let endpoint: Endpoint
                if let existing {
                    endpoint = try .updateSource(existing.id, WatchPatch(
                        name: name.trimmed == existing.name ? nil : name.trimmed,
                        url: address == existing.url ? nil : address,
                        project: project == existing.project?.id ? nil : .some(project),
                        enabled: enabled == existing.enabled ? nil : enabled))
                } else {
                    endpoint = try .createSource(WatchInput(name: name.trimmed, kind: kind, url: address, project: project, enabled: enabled))
                }
                let source = try await client.send(endpoint, as: WatchedSource.self)
                dismiss()
                saved(source)
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }
}
