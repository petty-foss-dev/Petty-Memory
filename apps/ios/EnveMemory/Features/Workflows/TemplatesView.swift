import EnveMemoryKit
import SwiftUI

/// Template roots. Using one copies its notes on the server; editing one is ordinary note editing.
struct TemplatesView: View {
    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var templates: [Item] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var cachedAt: Date?
    @State private var using: Item?

    var body: some View {
        HearthScreen(title: "Templates", overline: "Library") {
            if let cachedAt { SavedResultsBanner(savedAt: cachedAt) }
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            if let reason = connection.onlineOnlyReason { OnlineOnlyNote(reason: reason) }
            if templates.isEmpty {
                if loaded, error == nil {
                    EmptyStateView(symbol: "doc.on.doc", title: "No templates yet",
                                   message: "Open a note and choose “Save as template…” from its menu; the notes inside it come along. Write {{date}} or {{project}} in a title or text, like “Weekly review {{date}}”, and each new copy fills them in.")
                }
            } else {
                RowStack(data: templates) { template in
                    HStack(spacing: HearthSpacing.md) {
                        Button { using = template } label: {
                            HStack(alignment: .top, spacing: HearthSpacing.md) {
                                TypeGlyph(symbol: "doc.on.doc")
                                VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                                    Text(template.displayTitle).font(HearthFont.cardTitle).foregroundStyle(hearth.textPrimary).lineLimit(2)
                                    if let preview = template.preview {
                                        Text(preview).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary).lineLimit(2)
                                    }
                                    Text("Updated \(template.updatedAt.formatted(.relative(presentation: .named)))")
                                        .font(HearthFont.caption)
                                        .foregroundStyle(hearth.textTertiary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.vertical, HearthSpacing.sm)
                            .contentShape(Rectangle())
                            .accessibilityElement(children: .combine)
                        }
                        .buttonStyle(.plain)
                        .disabled(connection.onlineOnlyReason != nil)
                        .accessibilityHint("Makes a new copy")
                        Button("Edit") { router.open(.item(template.id)) }
                            .font(HearthFont.subheadline)
                            .accessibilityLabel("Edit \(template.displayTitle)")
                    }
                }
                Text("Change a template by editing its notes like any other. New copies start from what's there when you use it.")
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textTertiary)
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $using) { template in
            TemplateUseSheet(template: template) { router.open(.item($0.id)) }
                .environment(\.hearth, hearth)
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private func load() async {
        guard connection.client != nil else { return }
        do {
            let loaded = try await connection.load(.templates, as: [Item].self)
            templates = loaded.value
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

/// Picks the copy's title, project and date, then asks the server to make it.
struct TemplateUseSheet: View {
    let template: Item
    let created: (ItemDetail) -> Void

    @Environment(Connection.self) private var connection
    @Environment(ProjectStore.self) private var projects
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var title = ""
    @State private var projectID: String?
    @State private var date = Date.now
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let reason = connection.onlineOnlyReason {
                    Section { OnlineOnlyNote(reason: reason) }
                }
                Section {
                    TextField("Title", text: $title, prompt: Text(template.displayTitle))
                        .accessibilityIdentifier("TemplateUseTitle")
                } footer: {
                    Text("Leave it empty to use the template's title. {{date}} and {{project}} are filled in; anything else in braces stays as written.")
                }
                Section {
                    Picker("Project", selection: $projectID) {
                        Text("Inbox").tag(String?.none)
                        ForEach(projects.refs, id: \.id) { Text($0.name).tag(Optional($0.id)) }
                    }
                    .accessibilityIdentifier("TemplateUseProject")
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                } footer: {
                    Text("Every note in the copy goes to this project. The date is what {{date}} becomes.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(hearth.danger) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(hearth.background)
            .navigationTitle("Use template")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(working ? "Creating…" : "Create", action: use)
                        .disabled(working || connection.onlineOnlyReason != nil)
                        .accessibilityIdentifier("TemplateUseCreate")
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(working)
    }

    private func use() {
        guard let client = connection.client else { return }
        working = true
        error = nil
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let input = TemplateUseInput(title: trimmed.isEmpty ? nil : trimmed, project: projectID, date: DueDate.format(date))
        Task {
            defer { working = false }
            do {
                let detail = try await client.send(.useTemplate(template.id, input), as: ItemDetail.self)
                connection.didWrite()
                dismiss()
                created(detail)
                router.show("Created “\(detail.item.displayTitle)”")
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }
}

/// Copies a note and everything inside it into a new template; the note itself is left as it is.
struct SaveAsTemplateSheet: View {
    let item: Item

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var name = ""
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let reason = connection.onlineOnlyReason {
                    Section { OnlineOnlyNote(reason: reason) }
                }
                Section {
                    TextField("Name", text: $name, prompt: Text("\(item.displayTitle) template"))
                        .accessibilityIdentifier("TemplateName")
                } footer: {
                    Text("Copies “\(item.displayTitle)” and every note inside it, keeping their order, tags and how they show. Checkmarks, reminders and pins start fresh. Only notes can be copied: if a task, link, file, decision or secret note is inside, nothing is saved.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(hearth.danger) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(hearth.background)
            .navigationTitle("Save as template")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(working ? "Saving…" : "Save", action: save)
                        .disabled(working || connection.onlineOnlyReason != nil)
                        .accessibilityIdentifier("TemplateSave")
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(working)
    }

    private func save() {
        guard let client = connection.client else { return }
        working = true
        error = nil
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer { working = false }
            do {
                let template = try await client.send(.createTemplate(sourceId: item.id, name: trimmed.isEmpty ? nil : trimmed), as: ItemDetail.self)
                connection.didWrite()
                dismiss()
                router.show("Saved template “\(template.item.displayTitle)”")
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }
}
