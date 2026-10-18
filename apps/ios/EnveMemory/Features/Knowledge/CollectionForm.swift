import EnveMemoryKit
import SwiftUI

struct CollectionDraft {
    struct OptionDraft: Identifiable, Hashable {
        let id = UUID()
        var serverID: String?
        var name: String
    }

    struct FieldDraft: Identifiable, Hashable {
        let id = UUID()
        var serverID: String?
        var key: String?
        var name: String
        var type: PropertyType
        var options: [OptionDraft]

        var isSaved: Bool { serverID != nil }
        var label: String { name.trimmed.isEmpty ? "Untitled field" : name.trimmed }
    }

    enum SortTarget: Hashable {
        case builtIn(String)
        case field(UUID)
    }

    struct SortDraft: Identifiable, Hashable {
        let id = UUID()
        var target: SortTarget
        var direction: SortDirection
    }

    struct FilterDraft: Identifiable, Hashable {
        let id = UUID()
        var field: UUID
        var op: FilterOp
        var text = ""
        var number = ""
        var date = Date()
        var checkbox = true
        var option: UUID?
    }

    var name = ""
    var project: String?
    var topic = ""
    var type: ItemType?
    var fields: [FieldDraft] = []
    var layout: CollectionLayout = .table
    var groupBy: UUID?
    var sorts: [SortDraft] = []
    var filters: [FilterDraft] = []

    init() {}

    init(_ collection: KnowledgeCollection) {
        name = collection.name
        project = collection.scope.project
        topic = collection.scope.query ?? ""
        type = collection.scope.type
        let drafts = collection.fields.map { field in
            FieldDraft(serverID: field.id, key: field.key, name: field.name, type: field.type,
                       options: (field.options ?? []).map { OptionDraft(serverID: $0.id, name: $0.name) })
        }
        fields = drafts
        let local = Dictionary(uniqueKeysWithValues: zip(collection.fields.map(\.id), drafts.map(\.id)))
        layout = collection.layout
        groupBy = collection.groupBy.flatMap { local[$0] }
        sorts = collection.sort.compactMap { sort in
            if CollectionSort.builtIn.contains(sort.field) { return SortDraft(target: .builtIn(sort.field), direction: sort.direction) }
            return local[sort.field].map { SortDraft(target: .field($0), direction: sort.direction) }
        }
        filters = collection.filters.compactMap { filter in
            guard let localID = local[filter.field], let field = collection.field(filter.field),
                  let fieldDraft = drafts.first(where: { $0.id == localID }) else { return nil }
            var draft = FilterDraft(field: localID, op: filter.op)
            switch (field.type, filter.value) {
            case (.text, .string(let value)?): draft.text = value
            case (.number, .number(let value)?): draft.number = value.formatted(.number.grouping(.never))
            case (.date, .string(let day)?): draft.date = DueDate.parse(day) ?? Date()
            case (.checkbox, .bool(let value)?): draft.checkbox = value
            case (.select, .string(let id)?): draft.option = fieldDraft.options.first(where: { $0.serverID == id })?.id
            default: break
            }
            return draft
        }
    }

    func field(_ id: UUID?) -> FieldDraft? { id.flatMap { id in fields.first { $0.id == id } } }
    var selectFields: [FieldDraft] { fields.filter { $0.type == .select } }

    mutating func removeFields(at offsets: IndexSet) {
        let removed = Set(offsets.map { fields[$0].id })
        fields.remove(atOffsets: offsets)
        if let groupBy, removed.contains(groupBy) { self.groupBy = nil }
        sorts.removeAll { sort in
            if case .field(let id) = sort.target { return removed.contains(id) }
            return false
        }
        filters.removeAll { removed.contains($0.field) }
        if layout == .kanban, groupBy == nil { layout = .table }
    }

    /// What's wrong, in words the person can act on; nil when it can be saved.
    var problem: String? {
        if name.trimmed.isEmpty { return "Give the collection a name." }
        if name.trimmed.utf16.count > KnowledgeLimits.name { return "Names can be up to \(KnowledgeLimits.name) characters." }
        if topic.trimmed.utf16.count > KnowledgeLimits.query { return "The topic can be up to \(KnowledgeLimits.query) characters." }
        if fields.count > KnowledgeLimits.fields { return "A collection can have up to \(KnowledgeLimits.fields) fields." }
        for field in fields {
            if field.name.trimmed.isEmpty { return "Every field needs a name." }
            if field.name.trimmed.utf16.count > KnowledgeLimits.fieldName { return "\(field.label): names can be up to \(KnowledgeLimits.fieldName) characters." }
            guard field.type == .select else { continue }
            if field.options.isEmpty || field.options.count > KnowledgeLimits.options {
                return "\(field.label) needs between 1 and \(KnowledgeLimits.options) choices."
            }
            var names = Set<String>()
            for option in field.options {
                let name = option.name.trimmed
                if name.isEmpty { return "Every choice in \(field.label) needs a name." }
                if name.utf16.count > KnowledgeLimits.optionName { return "Choices in \(field.label) can be up to \(KnowledgeLimits.optionName) characters." }
                if !names.insert(name.lowercased()).inserted { return "\(field.label) lists “\(name)” twice." }
            }
        }
        if layout == .kanban, field(groupBy)?.type != .select { return "Kanban needs a choice field to make its columns." }
        if sorts.count > KnowledgeLimits.sorts { return "Sort by at most \(KnowledgeLimits.sorts) things." }
        if Set(sorts.map(\.target)).count != sorts.count { return "Sort by each field once." }
        if filters.count > KnowledgeLimits.filters { return "Use at most \(KnowledgeLimits.filters) filters." }
        for filter in filters where filter.op.takesValue {
            guard let fieldDraft = self.field(filter.field) else { return "A filter uses a removed field." }
            if filterValue(filter, field: fieldDraft) == nil { return "The filter on \(fieldDraft.label) needs a value." }
        }
        return nil
    }

    /// Only the definition's accepted fields. New fields get a key here so sort, filter and grouping can refer to them in the same save.
    func input(id: String?) -> CollectionInput {
        var taken: Set<String> = ["title"]
        for field in fields { if let key = field.key { taken.insert(key) } }
        var keys: [UUID: String] = [:]
        for field in fields { keys[field.id] = field.key ?? Self.derivedKey(field.name, taken: &taken) }
        let inputs = fields.map { field in
            PropertyFieldInput(id: field.serverID, key: keys[field.id], name: field.name.trimmed, type: field.type,
                               options: field.options.map { PropertyFieldInput.Option(id: $0.serverID, name: $0.name.trimmed) })
        }
        let sort = sorts.compactMap { sort -> CollectionSort? in
            switch sort.target {
            case .builtIn(let name): return CollectionSort(field: name, direction: sort.direction)
            case .field(let local): return keys[local].map { CollectionSort(field: $0, direction: sort.direction) }
            }
        }
        let filterInputs = filters.compactMap { filter -> CollectionFilter? in
            guard let key = keys[filter.field], let fieldDraft = self.field(filter.field) else { return nil }
            return CollectionFilter(field: key, op: filter.op, value: filter.op.takesValue ? filterValue(filter, field: fieldDraft) : nil)
        }
        let query = topic.trimmed
        return CollectionInput(id: id, name: name.trimmed, fields: inputs,
                               scope: CollectionScope(project: project, query: query.isEmpty ? nil : query, type: type),
                               layout: layout, groupBy: groupBy.flatMap { keys[$0] }, sort: sort, filters: filterInputs)
    }

    func filterValue(_ filter: FilterDraft, field: FieldDraft) -> FieldValue? {
        switch field.type {
        case .text:
            let text = filter.text.trimmed
            return text.isEmpty || text.utf16.count > KnowledgeLimits.textValue ? nil : .string(text)
        case .number:
            return NumberInput.parse(filter.number).map(FieldValue.number)
        case .date:
            return .string(DueDate.format(filter.date))
        case .checkbox:
            return .bool(filter.checkbox)
        case .select:
            // A choice added in this edit has no id yet; the server matches it by name.
            guard let option = field.options.first(where: { $0.id == filter.option }) else { return nil }
            return .string(option.serverID ?? option.name.trimmed)
        }
    }

    /// Lowercase letters, digits and underscores, starting with a letter, never "title", unique in the collection.
    static func derivedKey(_ name: String, taken: inout Set<String>) -> String {
        let folded = name.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).lowercased()
        var slug = String(folded.map { $0.isASCII && ($0.isLetter || $0.isNumber) ? $0 : "_" })
        while slug.contains("__") { slug = slug.replacingOccurrences(of: "__", with: "_") }
        slug = slug.trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        if slug.first?.isLetter != true { slug = slug.isEmpty ? "field" : "field_\(slug)" }
        slug = String(slug.prefix(keyBase)).trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        var key = slug
        var n = 2
        while taken.contains(key) {
            key = "\(slug)_\(n)"
            n += 1
        }
        taken.insert(key)
        return key
    }

    /// Leaves room for a `_NN` suffix under the server's 40-character key limit.
    private static let keyBase = 36
}

enum NumberInput {
    /// Accepts the phone's own decimal separator as well as a dot.
    static func parse(_ text: String) -> Double? {
        let trimmed = text.trimmed
        guard !trimmed.isEmpty else { return nil }
        let value = (try? Double(trimmed, format: .number)) ?? Double(trimmed)
        guard let value, value.isFinite, abs(value) <= KnowledgeLimits.number else { return nil }
        return value
    }
}

struct CollectionForm: View {
    let existing: KnowledgeCollection?
    let saved: (KnowledgeCollection) -> Void

    @Environment(Connection.self) private var connection
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var draft: CollectionDraft
    @State private var saving = false
    @State private var error: String?

    init(existing: KnowledgeCollection?, saved: @escaping (KnowledgeCollection) -> Void) {
        self.existing = existing
        self.saved = saved
        _draft = State(initialValue: existing.map(CollectionDraft.init) ?? CollectionDraft())
    }

    var body: some View {
        NavigationStack {
            Form {
                if let reason = connection.knowledgeWriteReason { Section { OnlineOnlyNote(reason: reason) } }
                Section {
                    TextField("Name", text: $draft.name, prompt: Text("Reading list"))
                        .accessibilityIdentifier("CollectionName")
                }
                scopeSection
                fieldsSection
                layoutSection
                sortSection
                filterSection
                if let problem = draft.problem {
                    Section { Text(problem).foregroundStyle(hearth.textSecondary).accessibilityIdentifier("CollectionProblem") }
                }
                if let error { Section { Text(error).foregroundStyle(hearth.danger) } }
            }
            .scrollContentBackground(.hidden)
            .background(hearth.background)
            .navigationTitle(existing == nil ? "New collection" : "Edit collection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save", action: save)
                        .disabled(saving || draft.problem != nil || connection.knowledgeWriteReason != nil)
                        .accessibilityIdentifier("CollectionSave")
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(saving)
    }

    private var scopeSection: some View {
        Section {
            ProjectChoice(title: "Project", selection: $draft.project, noneLabel: "Any project")
            TextField("Topic", text: $draft.topic, prompt: Text("Words every item must contain (optional)"))
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("CollectionTopic")
            Picker("Item type", selection: $draft.type) {
                Text("Any type").tag(ItemType?.none)
                ForEach(CollectionScope.rowTypes, id: \.self) { Text($0.pluralLabel).tag(Optional($0)) }
            }
        } header: {
            Text("Which items")
        } footer: {
            Text("Ordinary items only. Decisions, secret notes, saved views, templates and saved chats never appear.")
        }
    }

    private var fieldsSection: some View {
        Section {
            ForEach($draft.fields) { $field in
                NavigationLink {
                    FieldDraftEditor(field: $field)
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(field.label)
                            Text(field.type == .select ? "\(field.type.title) · \(field.options.count) choices" : field.type.title)
                                .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                        }
                    } icon: {
                        Image(systemName: field.type.symbol)
                    }
                }
                .accessibilityIdentifier("CollectionField")
            }
            .onDelete { draft.removeFields(at: $0) }
            .onMove { draft.fields.move(fromOffsets: $0, toOffset: $1) }
            Button {
                draft.fields.append(.init(name: "", type: .text, options: []))
            } label: {
                Label("Add field", systemImage: "plus")
            }
            .disabled(draft.fields.count >= KnowledgeLimits.fields)
            .accessibilityIdentifier("CollectionAddField")
        } header: {
            Text("Fields")
        } footer: {
            Text(existing == nil ? "Swipe to remove a field."
                                 : "Swipe to remove a field. Its values are hidden but stay stored on the items. A saved field's type can't change.")
        }
    }

    private var layoutSection: some View {
        Section {
            Picker("Layout", selection: $draft.layout) {
                ForEach(CollectionLayout.allCases, id: \.self) { Label($0.title, systemImage: $0.symbol).tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("CollectionLayout")
            Picker("Group by", selection: $draft.groupBy) {
                Text("No grouping").tag(UUID?.none)
                ForEach(draft.selectFields) { Text($0.label).tag(Optional($0.id)) }
            }
            .accessibilityIdentifier("CollectionGroupBy")
        } header: {
            Text("Layout")
        } footer: {
            Text("Kanban shows one column per choice of the group-by field, plus one for items without a value. You can switch layouts while viewing without saving.")
        }
    }

    private var sortSection: some View {
        Section {
            ForEach($draft.sorts) { $sort in
                HStack {
                    Picker("Sort by", selection: $sort.target) {
                        Text("Title").tag(CollectionDraft.SortTarget.builtIn("title"))
                        Text("Created").tag(CollectionDraft.SortTarget.builtIn("createdAt"))
                        Text("Updated").tag(CollectionDraft.SortTarget.builtIn("updatedAt"))
                        ForEach(draft.fields) { Text($0.label).tag(CollectionDraft.SortTarget.field($0.id)) }
                    }
                    Picker("Direction", selection: $sort.direction) {
                        Image(systemName: "arrow.up").accessibilityLabel("Ascending").tag(SortDirection.asc)
                        Image(systemName: "arrow.down").accessibilityLabel("Descending").tag(SortDirection.desc)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 96)
                }
            }
            .onDelete { draft.sorts.remove(atOffsets: $0) }
            .onMove { draft.sorts.move(fromOffsets: $0, toOffset: $1) }
            Button {
                draft.sorts.append(.init(target: .builtIn("updatedAt"), direction: .desc))
            } label: {
                Label("Add sort", systemImage: "arrow.up.arrow.down")
            }
            .disabled(draft.sorts.count >= KnowledgeLimits.sorts)
            .accessibilityIdentifier("CollectionAddSort")
        } header: {
            Text("Sort")
        } footer: {
            Text("Items without a value sort last either way. Without a sort, the most recently updated come first.")
        }
    }

    private var filterSection: some View {
        Section {
            ForEach($draft.filters) { $filter in
                FilterDraftRow(filter: $filter, fields: draft.fields)
            }
            .onDelete { draft.filters.remove(atOffsets: $0) }
            Button {
                if let first = draft.fields.first { draft.filters.append(.init(field: first.id, op: first.type.filterOps[0])) }
            } label: {
                Label("Add filter", systemImage: "line.3.horizontal.decrease")
            }
            .disabled(draft.fields.isEmpty || draft.filters.count >= KnowledgeLimits.filters)
            .accessibilityIdentifier("CollectionAddFilter")
        } header: {
            Text("Filters")
        } footer: {
            Text("Every filter must match. Filters use field values; use the topic above to match words.")
        }
    }

    private func save() {
        guard draft.problem == nil, connection.knowledgeWriteReason == nil, let client = connection.privateClient else { return }
        saving = true
        error = nil
        let input = draft.input(id: existing?.id)
        Task {
            defer { saving = false }
            do {
                let collection = try await client.send(.saveCollection(input), as: KnowledgeCollection.self)
                dismiss()
                saved(collection)
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }
}

private struct FieldDraftEditor: View {
    @Binding var field: CollectionDraft.FieldDraft

    @Environment(\.hearth) private var hearth

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $field.name, prompt: Text("Status"))
                    .accessibilityIdentifier("FieldName")
                Picker("Type", selection: $field.type) {
                    ForEach(PropertyType.allCases, id: \.self) { Label($0.title, systemImage: $0.symbol).tag($0) }
                }
                .disabled(field.isSaved)
                .accessibilityIdentifier("FieldType")
            } footer: {
                if field.isSaved {
                    Text("A saved field's type can't change, so its values stay valid. Add a new field for a different type.")
                }
            }
            if field.type == .select {
                Section {
                    ForEach($field.options) { $option in
                        TextField("Choice", text: $option.name, prompt: Text("Choice name"))
                            .accessibilityIdentifier("FieldOption")
                    }
                    .onDelete { field.options.remove(atOffsets: $0) }
                    .onMove { field.options.move(fromOffsets: $0, toOffset: $1) }
                    Button {
                        field.options.append(.init(name: ""))
                    } label: {
                        Label("Add choice", systemImage: "plus")
                    }
                    .disabled(field.options.count >= KnowledgeLimits.options)
                    .accessibilityIdentifier("FieldAddOption")
                } header: {
                    Text("Choices")
                } footer: {
                    Text("Renaming a choice keeps the items that hold it. Items holding a removed choice show the field as empty.")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(hearth.background)
        .navigationTitle(field.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { EditButton() }
        .onChange(of: field.type) { _, type in
            if type == .select, field.options.isEmpty { field.options = [.init(name: "")] }
        }
    }
}

private struct FilterDraftRow: View {
    @Binding var filter: CollectionDraft.FilterDraft
    let fields: [CollectionDraft.FieldDraft]

    private var field: CollectionDraft.FieldDraft? { fields.first { $0.id == filter.field } }

    var body: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Picker("Field", selection: $filter.field) {
                ForEach(fields) { Text($0.label).tag($0.id) }
            }
            if let field {
                Picker("Condition", selection: $filter.op) {
                    ForEach(field.type.filterOps, id: \.self) { Text($0.title(for: field.type)).tag($0) }
                }
                if filter.op.takesValue { valueEditor(field) }
            }
        }
        .accessibilityIdentifier("CollectionFilter")
        .onChange(of: filter.field) {
            guard let field else { return }
            if !field.type.filterOps.contains(filter.op) { filter.op = field.type.filterOps[0] }
            filter.option = nil
        }
    }

    @ViewBuilder
    private func valueEditor(_ field: CollectionDraft.FieldDraft) -> some View {
        switch field.type {
        case .text:
            TextField("Text", text: $filter.text, prompt: Text("Value"))
        case .number:
            TextField("Number", text: $filter.number, prompt: Text("0"))
                .keyboardType(.decimalPad)
        case .date:
            DatePicker("Date", selection: $filter.date, displayedComponents: .date)
        case .checkbox:
            Picker("Value", selection: $filter.checkbox) {
                Text("Checked").tag(true)
                Text("Not checked").tag(false)
            }
            .pickerStyle(.segmented)
        case .select:
            Picker("Choice", selection: $filter.option) {
                Text("Choose…").tag(UUID?.none)
                ForEach(field.options) { Text($0.name.trimmed.isEmpty ? "Untitled choice" : $0.name).tag(Optional($0.id)) }
            }
        }
    }
}
