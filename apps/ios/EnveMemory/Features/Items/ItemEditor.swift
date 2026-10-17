import EnveMemoryKit
import SwiftUI

// Typing keeps local history; saves are guarded, journalled actions.
struct ItemEditor: View {
    let item: Item

    @Environment(OutboxService.self) private var outbox
    @Environment(EditorHistory.self) private var history
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var title = ""
    @State private var text = ""
    @State private var request: FormatRequest?
    /// The caret in whichever field has it, in UTF-16 units; nil where the system gives no selection (iOS 17).
    @State private var caret: Caret?
    @State private var prompts = EditorPrompts()
    @State private var link = ""
    @State private var saving = false
    @State private var started = false
    /// What the edit started from, sent so the server can refuse it if the item changed elsewhere meanwhile.
    @State private var baseTitle = ""
    @State private var baseText = ""

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: HearthSpacing.md) {
                TitleField(title: $title, caret: $caret)
                if RichBodyEditor.isAvailable {
                    RichBodyEditor(text: $text, label: "Text", pickReference: prompts.reference, askLink: prompts.link)
                        .frame(maxHeight: .infinity)
                } else {
                    FormattingBar { format in
                        if case .reference = format { Task { await insertReference() } } else { request = FormatRequest(format: format) }
                    }
                    FormattingTextEditor(text: $text, request: $request, caret: $caret)
                        .frame(maxHeight: .infinity)
                        .hearthField()
                }
            }
            .padding(HearthSpacing.lg)
            .background(hearth.background)
            .navigationTitle("Edit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save", action: save).disabled(saving || !hasChanges)
                }
                if canSplit {
                    ToolbarItem(placement: .secondaryAction) {
                        Button("Split at cursor", systemImage: "scissors", action: split)
                            .disabled(saving || splitPoint == nil)
                            .accessibilityHint("Moves everything after the cursor into a new note just below")
                    }
                }
            }
            .sheet(isPresented: $prompts.pickingReference, onDismiss: { prompts.answerReference(nil) }) {
                ItemPicker(title: "Link to an item", excluding: [item.id]) { prompts.answerReference($0) }
                    .environment(\.hearth, hearth)
            }
            .alert("Link", isPresented: Binding(get: { prompts.link != nil }, set: { if !$0 { prompts.answerLink(nil) } })) {
                TextField("https://example.com", text: $link)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Cancel", role: .cancel) { prompts.answerLink(nil) }
                if prompts.link?.isEmpty == false {
                    Button("Remove link", role: .destructive) { prompts.answerLink("") }
                }
                Button("Save") { prompts.answerLink(link) }
            } message: {
                Text("Only web and email addresses can be links.")
            }
            .onChange(of: prompts.link) { _, current in link = current ?? "" }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(hasChanges)
        .onAppear {
            guard !started else { return }
            started = true
            baseTitle = outbox.pending.titles[item.id] ?? item.title
            baseText = outbox.pending.bodies[item.id] ?? item.body
            title = baseTitle
            text = baseText
        }
    }

    private var hasChanges: Bool { started && (title != baseTitle || text != baseText) }

    private func insertReference() async {
        guard let choice = await prompts.reference() else { return }
        request = FormatRequest(format: .reference(InlineReference.token(id: choice.id, label: choice.title)))
    }

    private var canSplit: Bool {
        item.type == .note && !item.isSecret && item.archivedAt == nil
    }

    private var update: EditorCommand? {
        EditorCommand.update(item.id, title: title, body: text, baseTitle: baseTitle, baseBody: baseText)
    }

    /// A failed save keeps the sheet open with the draft intact.
    private func save() {
        guard let update else { return }
        saving = true
        Task {
            defer { saving = false }
            if await history.perform([update], label: "Edit “\(item.displayTitle)”", sent: "Saved") { dismiss() }
        }
    }

    /// The caret, when it falls strictly inside its field on a character boundary.
    private var splitPoint: EditorCommand? {
        guard let caret else { return nil }
        let field = caret.field == .title ? title : text
        guard caret.offset > 0, caret.offset < field.utf16.count,
              let index = field.utf16.index(field.utf16.startIndex, offsetBy: caret.offset).samePosition(in: field) else { return nil }
        return EditorCommand.split(item.id, field: caret.field, text: field, at: index)
    }

    /// Saves any unsaved text and splits in one action.
    private func split() {
        guard let splitPoint else { return }
        let commands = [update, splitPoint].compactMap(\.self)
        saving = true
        Task {
            defer { saving = false }
            if await history.perform(commands, label: "Split “\(item.displayTitle)”", sent: "Split") { dismiss() }
        }
    }
}

/// Native pickers answering the editor's requests for a reference or a link.
@Observable
final class EditorPrompts {
    var pickingReference = false
    /// The link being edited ("" for a new one) while the prompt is up.
    private(set) var link: String?
    @ObservationIgnored private var referenceReply: CheckedContinuation<ItemPicker.Choice?, Never>?
    @ObservationIgnored private var linkReply: CheckedContinuation<String?, Never>?

    func reference() async -> ItemPicker.Choice? {
        await withCheckedContinuation { reply in
            referenceReply = reply
            pickingReference = true
        }
    }

    func answerReference(_ choice: ItemPicker.Choice?) {
        referenceReply?.resume(returning: choice)
        referenceReply = nil
    }

    /// Nil cancels, "" removes the link.
    func link(current: String?) async -> String? {
        await withCheckedContinuation { reply in
            linkReply = reply
            link = current ?? ""
        }
    }

    func answerLink(_ value: String?) {
        linkReply?.resume(returning: value)
        linkReply = nil
        link = nil
    }
}

struct Caret: Equatable {
    let field: EditorCommand.Field
    let offset: Int
}

/// The title, reporting its caret on iOS 18 so a title can be split.
private struct TitleField: View {
    @Binding var title: String
    @Binding var caret: Caret?

    var body: some View {
        Group {
            if #available(iOS 18.0, *) {
                SelectableTitleField(title: $title, caret: $caret)
            } else {
                TextField("Title", text: $title, axis: .vertical)
            }
        }
        .font(HearthFont.sectionTitle)
        .lineLimit(1...3)
        .accessibilityIdentifier("EditorTitle")
    }
}

@available(iOS 18.0, *)
private struct SelectableTitleField: View {
    @Binding var title: String
    @Binding var caret: Caret?

    @State private var selection: TextSelection?

    var body: some View {
        TextField("Title", text: $title, selection: $selection, axis: .vertical)
            .onChange(of: selection) { _, selection in
                if let offset = selection?.caretOffset(in: title) { caret = Caret(field: .title, offset: offset) }
            }
    }
}

enum TextFormat: Hashable {
    case bold, italic, heading, bullet, checkbox, quote
    case reference(String)

    /// Applies the format to `selection` (character offsets) and returns the new text and selection.
    func apply(to text: String, selection: Range<Int>) -> (String, Range<Int>) {
        let lower = min(selection.lowerBound, text.count)
        let upper = min(max(selection.upperBound, lower), text.count)
        let start = text.index(text.startIndex, offsetBy: lower)
        let end = text.index(text.startIndex, offsetBy: upper)
        switch self {
        case .bold, .italic:
            let marker = self == .bold ? "**" : "_"
            let selected = String(text[start..<end])
            let inner = selected.isEmpty ? (self == .bold ? "bold" : "italic") : selected
            let result = text.replacingCharacters(in: start..<end, with: marker + inner + marker)
            return (result, (lower + marker.count)..<(lower + marker.count + inner.count))
        case .heading, .bullet, .checkbox, .quote:
            let prefix = switch self {
            case .heading: "## "
            case .bullet: "- "
            case .checkbox: "- [ ] "
            default: "> "
            }
            let lineStart = text[..<start].lastIndex(of: "\n").map { text.index(after: $0) } ?? text.startIndex
            var result = text
            if text[lineStart...].hasPrefix(prefix) {
                result.removeSubrange(lineStart..<text.index(lineStart, offsetBy: prefix.count))
                return (result, max(0, lower - prefix.count)..<max(0, upper - prefix.count))
            }
            result.insert(contentsOf: prefix, at: lineStart)
            return (result, (lower + prefix.count)..<(upper + prefix.count))
        case .reference(let token):
            let spaced = (lower > 0 && !text[text.index(before: start)].isWhitespace ? " " : "") + token
            let result = text.replacingCharacters(in: start..<end, with: spaced)
            let cursor = lower + spaced.count
            return (result, cursor..<cursor)
        }
    }
}

struct FormatRequest: Equatable {
    let id = UUID()
    let format: TextFormat
}

private struct FormattingBar: View {
    let apply: (TextFormat) -> Void

    @Environment(\.hearth) private var hearth

    private let buttons: [(TextFormat, String, String)] = [
        (.bold, "bold", "Bold"), (.italic, "italic", "Italic"), (.heading, "textformat.size", "Heading"),
        (.bullet, "list.bullet", "Bulleted line"), (.checkbox, "checklist", "Checkbox line"), (.quote, "text.quote", "Quote"),
        (.reference(""), "link.badge.plus", "Link to an item"),
    ]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: HearthSpacing.xs) {
                ForEach(buttons, id: \.1) { format, symbol, label in
                    Button { apply(format) } label: {
                        Image(systemName: symbol)
                            .frame(width: 40, height: 36)
                            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(hearth.surface))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(hearth.textPrimary)
                    .accessibilityLabel(label)
                }
            }
        }
    }
}

/// Applies formatting at the selection on iOS 18; iOS 17's editor has no selection API, so it formats the last line
/// and reports no caret.
struct FormattingTextEditor: View {
    @Binding var text: String
    @Binding var request: FormatRequest?
    @Binding var caret: Caret?

    var body: some View {
        if #available(iOS 18.0, *) {
            SelectionEditor(text: $text, request: $request, caret: $caret)
        } else {
            TextEditor(text: $text)
                .scrollContentBackground(.hidden)
                .onChange(of: request) { _, request in
                    guard let request else { return }
                    text = request.format.apply(to: text, selection: text.count..<text.count).0
                    self.request = nil
                }
        }
    }
}

@available(iOS 18.0, *)
private struct SelectionEditor: View {
    @Binding var text: String
    @Binding var request: FormatRequest?
    @Binding var caret: Caret?

    @State private var selection: TextSelection?

    var body: some View {
        TextEditor(text: $text, selection: $selection)
            .scrollContentBackground(.hidden)
            .onChange(of: selection) { _, selection in
                if let offset = selection?.caretOffset(in: text) { caret = Caret(field: .body, offset: offset) }
            }
            .onChange(of: request) { _, request in
                guard let request else { return }
                let (result, range) = request.format.apply(to: text, selection: offsets)
                text = result
                let lower = result.index(result.startIndex, offsetBy: range.lowerBound)
                let upper = result.index(result.startIndex, offsetBy: range.upperBound)
                selection = TextSelection(range: lower..<upper)
                self.request = nil
            }
    }

    private var offsets: Range<Int> {
        guard case .selection(let range)? = selection?.indices,
              range.lowerBound <= text.endIndex, range.upperBound <= text.endIndex else { return text.count..<text.count }
        let lower = text.distance(from: text.startIndex, to: range.lowerBound)
        return lower..<(lower + text.distance(from: range.lowerBound, to: range.upperBound))
    }
}

@available(iOS 18.0, *)
extension TextSelection {
    /// The insertion point in UTF-16 units, when the selection is a caret inside `text`.
    func caretOffset(in text: String) -> Int? {
        guard case .selection(let range) = indices, range.isEmpty, range.lowerBound <= text.endIndex else { return nil }
        return text.utf16.distance(from: text.startIndex, to: range.lowerBound)
    }
}
