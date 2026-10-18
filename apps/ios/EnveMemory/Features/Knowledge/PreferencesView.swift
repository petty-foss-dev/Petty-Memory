import EnveMemoryKit
import SwiftUI

struct PreferencesView: View {
    @Environment(Connection.self) private var connection
    @Environment(ProjectStore.self) private var projects
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var preferences: [OrganizationPreference] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var editing: Editing?
    @State private var archiving: OrganizationPreference?

    struct Editing: Identifiable {
        let preference: OrganizationPreference?
        var id: String { preference?.id ?? "new" }
    }

    var body: some View {
        HearthScreen(title: "Organization preferences", overline: "Knowledge") {
            KnowledgeNote(text: "A preference is an instruction such as “File receipts under Finance”. It's used only when you tick it for an AI workflow or an Organize request; the AI never picks preferences on its own or learns them from your chats. A project preference can only be used for that project; one without a project can be used anywhere.")
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            Button { editing = Editing(preference: nil) } label: { Label("New preference", systemImage: "plus") }
                .buttonStyle(.hearthPrimary)
                .disabled(connection.knowledgeWriteReason != nil)
                .accessibilityIdentifier("NewPreference")
            if let reason = connection.knowledgeWriteReason { OnlineOnlyNote(reason: reason) }
            if preferences.isEmpty {
                if loaded, error == nil {
                    EmptyStateView(symbol: KnowledgeArea.preferences.symbol, title: "No preferences yet",
                                   message: "Save the way you like things organized, then choose it when you ask the AI to organize.")
                }
            } else {
                RowStack(data: preferences) { preference in
                    row(preference)
                }
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editing) { editing in
            PreferenceForm(existing: editing.preference) { saved in
                if let index = preferences.firstIndex(where: { $0.id == saved.id }) { preferences[index] = saved } else { preferences.append(saved) }
            }
            .environment(\.hearth, hearth)
        }
        .confirmationDialog("Archive “\(archiving?.name ?? "")”?", isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil } }),
                            titleVisibility: .visible, presenting: archiving) { preference in
            Button("Archive preference", role: .destructive) { archive(preference) }
        } message: { _ in
            Text("It stops appearing as a choice. The definition stays as an archived note you can restore on your computer.")
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private func row(_ preference: OrganizationPreference) -> some View {
        HStack(alignment: .top, spacing: HearthSpacing.md) {
            TypeGlyph(symbol: preference.isGlobal ? "globe" : "folder")
            VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                Text(preference.name).font(HearthFont.cardTitle).foregroundStyle(hearth.textPrimary).lineLimit(2)
                Text(verbatim: preference.instruction).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary).lineLimit(3)
                Text(preference.isGlobal ? "Can be used anywhere" : "Only for \(projects.label(for: preference.project))")
                    .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Menu {
                Button("Edit", systemImage: "pencil") { editing = Editing(preference: preference) }
                Button("Archive", systemImage: "archivebox", role: .destructive) { archiving = preference }
            } label: {
                Image(systemName: "ellipsis.circle").foregroundStyle(hearth.accent)
            }
            .disabled(connection.knowledgeWriteReason != nil)
            .accessibilityLabel("Actions for \(preference.name)")
            .accessibilityIdentifier("PreferenceMenu")
        }
        .padding(.vertical, HearthSpacing.sm)
    }

    private func load() async {
        guard connection.knowledgeReadReason == nil, let client = connection.privateClient else { loaded = true; return }
        do {
            preferences = try await client.send(.preferences(), as: [OrganizationPreference].self)
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
        loaded = true
    }

    private func archive(_ preference: OrganizationPreference) {
        guard let client = connection.privateClient else { return }
        Task {
            do {
                _ = try await client.send(.archivePreference(preference.id), as: ArchiveResult.self)
                preferences.removeAll { $0.id == preference.id }
                router.show("Preference archived")
            } catch {
                connection.note(error)
                router.show(error.onlineOnlyMessage)
            }
        }
    }
}

struct PreferenceForm: View {
    let existing: OrganizationPreference?
    let saved: (OrganizationPreference) -> Void

    @Environment(Connection.self) private var connection
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var name: String
    @State private var instruction: String
    @State private var project: String?
    @State private var saving = false
    @State private var error: String?

    init(existing: OrganizationPreference?, saved: @escaping (OrganizationPreference) -> Void) {
        self.existing = existing
        self.saved = saved
        _name = State(initialValue: existing?.name ?? "")
        _instruction = State(initialValue: existing?.instruction ?? "")
        _project = State(initialValue: existing?.project)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let reason = connection.knowledgeWriteReason { Section { OnlineOnlyNote(reason: reason) } }
                Section {
                    TextField("Instruction", text: $instruction, prompt: Text("File receipts under Finance, one heading per year"), axis: .vertical)
                        .lineLimit(3...10)
                        .accessibilityIdentifier("PreferenceInstruction")
                } header: {
                    Text("Instruction")
                } footer: {
                    Text("\(instruction.trimmed.utf16.count) of \(KnowledgeLimits.preferenceInstruction) characters. Saved as text; the AI reads it only for requests where you tick it.")
                        .foregroundStyle(instruction.trimmed.utf16.count > KnowledgeLimits.preferenceInstruction ? hearth.danger : hearth.textTertiary)
                }
                Section {
                    TextField("Name", text: $name, prompt: Text("Named from the instruction if empty"))
                        .accessibilityIdentifier("PreferenceName")
                }
                Section {
                    ProjectChoice(title: "Applies to", selection: $project, noneLabel: "Everywhere")
                } footer: {
                    Text(project == nil ? "Can be chosen for any workflow or Organize request."
                                        : "Can be chosen only for a workflow in this project. Organize requests across the library use preferences without a project.")
                }
                if let error { Section { Text(error).foregroundStyle(hearth.danger) } }
            }
            .scrollContentBackground(.hidden)
            .background(hearth.background)
            .navigationTitle(existing == nil ? "New preference" : "Edit preference")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save", action: save)
                        .disabled(!canSave)
                        .accessibilityIdentifier("PreferenceSave")
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(saving)
    }

    private var canSave: Bool {
        !saving && connection.knowledgeWriteReason == nil && !instruction.trimmed.isEmpty
            && instruction.trimmed.utf16.count <= KnowledgeLimits.preferenceInstruction && name.trimmed.utf16.count <= KnowledgeLimits.name
    }

    private func save() {
        guard canSave, let client = connection.privateClient else { return }
        saving = true
        error = nil
        let input = PreferenceInput(id: existing?.id, name: name.trimmed.isEmpty ? nil : name.trimmed, instruction: instruction.trimmed, project: project)
        Task {
            defer { saving = false }
            do {
                let preference = try await client.send(.savePreference(input), as: OrganizationPreference.self)
                saved(preference)
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }
}

struct PreferenceSelection: View {
    let preferences: [OrganizationPreference]
    @Binding var selected: Set<String>
    let explanation: String

    @Environment(\.hearth) private var hearth

    var body: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Overline("Organization preferences")
            Text(explanation).font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
            if preferences.isEmpty {
                Text("No saved preferences apply here. Add them under Knowledge › Organization preferences.")
                    .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
            } else {
                FlowLayout(spacing: HearthSpacing.sm) {
                    ForEach(preferences) { preference in
                        FilterChip(title: preference.name, systemImage: selected.contains(preference.id) ? "checkmark" : nil,
                                   isSelected: selected.contains(preference.id)) {
                            if selected.contains(preference.id) {
                                selected.remove(preference.id)
                            } else if selected.count < KnowledgeLimits.selectedPreferences {
                                selected.insert(preference.id)
                            }
                        }
                        .accessibilityIdentifier("PreferenceChoice")
                    }
                }
                if tooLong {
                    Text("The chosen preferences are longer than \(KnowledgeLimits.preferenceContext) characters together. Choose fewer.")
                        .font(HearthFont.caption).foregroundStyle(hearth.danger)
                }
            }
        }
    }

    var tooLong: Bool { Self.tooLong(preferences, selected) }

    static func tooLong(_ preferences: [OrganizationPreference], _ selected: Set<String>) -> Bool {
        preferences.filter { selected.contains($0.id) }.reduce(0) { $0 + $1.instruction.utf16.count } > KnowledgeLimits.preferenceContext
    }
}
