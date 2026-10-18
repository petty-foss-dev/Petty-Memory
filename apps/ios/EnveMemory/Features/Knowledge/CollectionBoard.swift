import EnveMemoryKit
import SwiftUI

struct CollectionBoard: View {
    let collection: KnowledgeCollection
    let groups: [CollectionGroup]
    let canEdit: Bool
    let open: (CollectionRow) -> Void
    let edit: (CollectionRow) -> Void
    let changed: () -> Void

    var body: some View {
        ScrollView(.horizontal) {
            // Measure every column so taller columns stay inside the scroll view’s hit area.
            HStack(alignment: .top, spacing: HearthSpacing.md) {
                ForEach(groups, id: \.option) { group in
                    BoardColumn(collection: collection, group: group, groups: groups, canEdit: canEdit, open: open, edit: edit, moved: changed)
                }
            }
            .padding(.vertical, HearthSpacing.xs)
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.viewAligned)
        .scrollClipDisabled()
        .accessibilityIdentifier("CollectionBoard")
    }
}

private struct BoardColumn: View {
    let collection: KnowledgeCollection
    let group: CollectionGroup
    let groups: [CollectionGroup]
    let canEdit: Bool
    let open: (CollectionRow) -> Void
    let edit: (CollectionRow) -> Void
    let moved: () -> Void

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var rows: [CollectionRow] = []
    @State private var next: Int?
    @State private var loading = true
    @State private var moving: String?
    @State private var choosingMove: CollectionRow?
    @State private var error: String?

    private let width: CGFloat = 280

    var body: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            HStack {
                Text(group.name).font(HearthFont.headline).lineLimit(1)
                Spacer()
                Text(group.count.formatted()).font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
            }
            .accessibilityElement(children: .combine)
            if let error { Text(error).font(HearthFont.caption).foregroundStyle(hearth.danger) }
            if loading, rows.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            } else if rows.isEmpty {
                Text("Nothing here").font(HearthFont.footnote).foregroundStyle(hearth.textTertiary)
                    .frame(maxWidth: .infinity, minHeight: 60)
            }
            ForEach(rows) { row in
                CollectionRowCard(collection: collection, row: row, hiding: collection.groupBy, open: { open(row) }, edit: { edit(row) }) {
                    moveButton(row)
                }
                .opacity(moving == row.id ? 0.5 : 1)
            }
            if next != nil {
                Button { Task { await load(more: true) } } label: {
                    if loading { ProgressView() } else { Text("Load more") }
                }
                .buttonStyle(.hearthSecondary)
                .disabled(loading)
            }
        }
        .padding(HearthSpacing.md)
        .frame(width: width, alignment: .top)
        .background(RoundedRectangle(cornerRadius: HearthRadius.card, style: .continuous).fill(hearth.surfaceSunken))
        .overlay(RoundedRectangle(cornerRadius: HearthRadius.card, style: .continuous).strokeBorder(hearth.hairline))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("CollectionColumn")
        .confirmationDialog("Move to a column", isPresented: Binding(get: { choosingMove != nil }, set: { if !$0 { choosingMove = nil } }),
                            titleVisibility: .visible, presenting: choosingMove) { row in
            ForEach(groups.filter { $0.option != group.option }, id: \.option) { target in
                Button(target.name) { move(row, to: target.option) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { row in
            Text(row.item.displayTitle)
        }
        .task { await load(more: false) }
    }

    private func moveButton(_ row: CollectionRow) -> some View {
        Button { choosingMove = row } label: {
            Label("Move", systemImage: "arrow.left.arrow.right").font(HearthFont.subheadline)
        }
        .buttonStyle(.plain)
        .disabled(!canEdit || moving != nil)
        .accessibilityIdentifier("CollectionMove")
    }

    private func load(more: Bool) async {
        guard let client = connection.privateClient else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await client.send(.collectionRows(collection.id, offset: more ? next ?? 0 : 0, group: CollectionGroupSelection(group.option)),
                                             as: CollectionRowsPage.self)
            if more {
                let known = Set(rows.map(\.id))
                rows += page.rows.filter { !known.contains($0.id) }
            } else {
                rows = page.rows
            }
            next = page.next
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
    }

    private func move(_ row: CollectionRow, to option: String?) {
        guard let field = collection.groupBy, let client = connection.privateClient else { return }
        moving = row.id
        Task {
            defer { moving = nil }
            do {
                _ = try await client.send(.setFieldValues(collection: collection.id, item: row.item.id, values: [field: option.map(FieldValue.string)]),
                                          as: [String: FieldValue].self)
                moved()
            } catch {
                connection.note(error)
                router.show(error.onlineOnlyMessage)
            }
        }
    }
}

struct FieldValuesSheet: View {
    let collection: KnowledgeCollection
    let row: CollectionRow
    let saved: (CollectionRow) -> Void

    @Environment(Connection.self) private var connection
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var changes: [String: FieldValue?] = [:]
    @State private var numberText: [String: String] = [:]
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let reason = connection.knowledgeWriteReason { Section { OnlineOnlyNote(reason: reason) } }
                Section {
                    Text(row.item.displayTitle).font(HearthFont.cardTitle)
                }
                ForEach(collection.fields) { field in
                    Section {
                        editor(field)
                        if current(field) != nil {
                            Button("Clear \(field.name)", role: .destructive) {
                                change(field, to: nil)
                                numberText[field.id] = ""
                            }
                                .accessibilityIdentifier("FieldClear")
                        }
                    } header: {
                        Label(field.name, systemImage: field.type.symbol)
                    } footer: {
                        if changes[field.id] != nil { Text("Changed; saved when you tap Save.") }
                    }
                }
                if let problem { Section { Text(problem).foregroundStyle(hearth.textSecondary) } }
                if let error { Section { Text(error).foregroundStyle(hearth.danger) } }
            }
            .scrollContentBackground(.hidden)
            .background(hearth.background)
            .navigationTitle("Edit fields")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save", action: save)
                        .disabled(saving || changes.isEmpty || problem != nil || connection.knowledgeWriteReason != nil)
                        .accessibilityIdentifier("FieldValuesSave")
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(saving)
    }

    private func current(_ field: PropertyField) -> FieldValue? {
        if let change = changes[field.id] { return change }
        return row.values[field.id]
    }

    private func change(_ field: PropertyField, to value: FieldValue?) {
        changes[field.id] = value == row.values[field.id] ? nil : .some(value)
    }

    @ViewBuilder
    private func editor(_ field: PropertyField) -> some View {
        switch field.type {
        case .text:
            TextField(field.name, text: Binding(get: { current(field)?.string ?? "" }, set: { text in
                change(field, to: text.trimmed.isEmpty ? nil : .string(text))
            }), axis: .vertical)
            .lineLimit(1...6)
            .accessibilityIdentifier("FieldText")
        case .number:
            TextField(field.name, text: Binding(get: {
                numberText[field.id] ?? current(field)?.number.map { $0.formatted(.number.grouping(.never)) } ?? ""
            }, set: { text in
                numberText[field.id] = text
                change(field, to: NumberInput.parse(text).map(FieldValue.number))
            }))
            .keyboardType(.decimalPad)
            .accessibilityIdentifier("FieldNumber")
        case .date:
            if let day = current(field)?.string.flatMap(DueDate.parse) {
                DatePicker(field.name, selection: Binding(get: { day }, set: { change(field, to: .string(DueDate.format($0))) }), displayedComponents: .date)
                    .accessibilityIdentifier("FieldDate")
            } else {
                Button("Set a date") { change(field, to: .string(DueDate.format(.now))) }
                    .accessibilityIdentifier("FieldDateSet")
            }
        case .checkbox:
            Toggle(field.name, isOn: Binding(get: { current(field)?.bool ?? false }, set: { change(field, to: .bool($0)) }))
                .accessibilityIdentifier("FieldCheckbox")
        case .select:
            Picker(field.name, selection: Binding(get: { current(field)?.string }, set: { change(field, to: $0.map(FieldValue.string)) })) {
                Text("None").tag(String?.none)
                ForEach(field.options ?? []) { Text($0.name).tag(Optional($0.id)) }
            }
            .accessibilityIdentifier("FieldSelect")
        }
    }

    private var problem: String? {
        for field in collection.fields {
            if field.type == .number, let text = numberText[field.id], !text.trimmed.isEmpty, NumberInput.parse(text) == nil {
                return "\(field.name) needs a number no larger than a quadrillion either way."
            }
            if field.type == .text, let text = current(field)?.string, text.trimmed.utf16.count > KnowledgeLimits.textValue {
                return "\(field.name) can be up to \(KnowledgeLimits.textValue) characters."
            }
        }
        return nil
    }

    private func save() {
        guard problem == nil, let client = connection.privateClient else { return }
        saving = true
        error = nil
        let values = changes.mapValues { value in value.map { $0.string.map { FieldValue.string($0.trimmed) } ?? $0 } }
        Task {
            defer { saving = false }
            do {
                let stored = try await client.send(.setFieldValues(collection: collection.id, item: row.item.id, values: values),
                                                   as: [String: FieldValue].self)
                saved(row.replacingValues(stored))
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
