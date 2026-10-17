import EnveMemoryKit
import SwiftUI

/// Block-level Markdown, parsed once so long archived articles don't re-parse on every render.
struct MarkdownDocument: Equatable {
    enum Block: Equatable {
        case heading(level: Int, text: String)
        case paragraph(String)
        case list(ordered: Bool, items: [ListItem])
        case quote(String)
        case code(String)
        case table([[String]])
        case rule
    }

    struct ListItem: Equatable {
        let depth: Int
        let marker: String
        let text: String
    }

    let blocks: [Block]

    init(_ source: String) {
        blocks = Self.parse(source)
    }

    var isEmpty: Bool { blocks.isEmpty }

    private static func parse(_ source: String) -> [Block] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [Block] = []
        var paragraph: [String] = []
        var index = 0

        func flushParagraph() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph = []
            }
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                let fence = String(trimmed.prefix(3))
                var code: [String] = []
                index += 1
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    code.append(lines[index])
                    index += 1
                }
                blocks.append(.code(code.joined(separator: "\n")))
                index += 1
                continue
            }
            if trimmed.isEmpty {
                flushParagraph()
                index += 1
                continue
            }
            if let heading = headingLevel(trimmed) {
                flushParagraph()
                blocks.append(.heading(level: heading, text: trimmed.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)))
                index += 1
                continue
            }
            if isRule(trimmed) {
                flushParagraph()
                blocks.append(.rule)
                index += 1
                continue
            }
            if trimmed.hasPrefix(">") {
                flushParagraph()
                var quoted: [String] = []
                while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    quoted.append(String(lines[index].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces))
                    index += 1
                }
                blocks.append(.quote(quoted.joined(separator: "\n")))
                continue
            }
            if trimmed.hasPrefix("|"), index + 1 < lines.count, isTableSeparator(lines[index + 1]) {
                flushParagraph()
                var rows = [cells(trimmed)]
                index += 2
                while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    rows.append(cells(lines[index].trimmingCharacters(in: .whitespaces)))
                    index += 1
                }
                blocks.append(.table(rows))
                continue
            }
            if let first = listItem(line) {
                flushParagraph()
                var items = [first.item]
                let ordered = first.ordered
                index += 1
                while index < lines.count {
                    let next = lines[index]
                    if let item = listItem(next) {
                        items.append(item.item)
                    } else if !next.trimmingCharacters(in: .whitespaces).isEmpty, next.hasPrefix("  ") || next.hasPrefix("\t"), let last = items.popLast() {
                        items.append(ListItem(depth: last.depth, marker: last.marker, text: last.text + " " + next.trimmingCharacters(in: .whitespaces)))
                    } else {
                        break
                    }
                    index += 1
                }
                blocks.append(.list(ordered: ordered, items: items))
                continue
            }
            paragraph.append(trimmed)
            index += 1
        }
        flushParagraph()
        return blocks
    }

    private static func headingLevel(_ line: String) -> Int? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
        return hashes
    }

    private static func isRule(_ line: String) -> Bool {
        let compact = line.replacingOccurrences(of: " ", with: "")
        guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
        return compact.allSatisfy { $0 == first }
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("|") && trimmed.contains("-") && trimmed.allSatisfy { "|-: ".contains($0) }
    }

    private static func cells(_ line: String) -> [String] {
        var parts = line.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        if parts.first == "" { parts.removeFirst() }
        if parts.last == "" { parts.removeLast() }
        return parts
    }

    private static func listItem(_ line: String) -> (item: ListItem, ordered: Bool)? {
        let indent = line.prefix { $0 == " " || $0 == "\t" }.count
        let rest = line.dropFirst(indent)
        let depth = min(indent / 2, 3)
        if let marker = rest.first, "-*+".contains(marker), rest.dropFirst().first == " " {
            var text = rest.dropFirst(2).trimmingCharacters(in: .whitespaces)
            var symbol = "•"
            if text.hasPrefix("[ ] ") { symbol = "☐"; text = String(text.dropFirst(4)) }
            if text.lowercased().hasPrefix("[x] ") { symbol = "☑"; text = String(text.dropFirst(4)) }
            return (ListItem(depth: depth, marker: symbol, text: text), false)
        }
        let digits = rest.prefix { $0.isNumber }
        if !digits.isEmpty, digits.count < 4 {
            let after = rest.dropFirst(digits.count)
            if let punctuation = after.first, ".)".contains(punctuation), after.dropFirst().first == " " {
                return (ListItem(depth: depth, marker: "\(digits).", text: after.dropFirst(2).trimmingCharacters(in: .whitespaces)), true)
            }
        }
        return nil
    }
}

private struct ReferenceTitlesKey: EnvironmentKey {
    static let defaultValue: [String: String] = [:]
}

extension EnvironmentValues {
    /// Current names of referenced items, so inline references show what the target is called now.
    var referenceTitles: [String: String] {
        get { self[ReferenceTitlesKey.self] }
        set { self[ReferenceTitlesKey.self] = newValue }
    }
}

/// `[[item:<id>|label]]` becomes an in-app link; everything around it stays text.
enum InlineReferences {
    static func attributed(_ text: String, titles: [String: String], accent: Color,
                           segment: (String) -> AttributedString = { AttributedString($0) }) -> AttributedString {
        var result = AttributedString()
        var cursor = text.startIndex
        for match in InlineReference.matches(in: text) {
            result += segment(String(text[cursor..<match.range.lowerBound]))
            var link = AttributedString(titles[match.id] ?? match.label.flatMap { $0.isEmpty ? nil : $0 } ?? "Linked item")
            link.link = ItemLink.url(for: match.id)
            link.foregroundColor = accent
            link.underlineStyle = .single
            result += link
            cursor = match.range.upperBound
        }
        result += segment(String(text[cursor...]))
        return result
    }
}

/// Saved text is data: only web links leave the app, and item references navigate inside it.
private struct SafeLinks: ViewModifier {
    @Environment(Router.self) private var router

    func body(content: Content) -> some View {
        content.environment(\.openURL, OpenURLAction { url in
            if let id = ItemLink.itemID(from: url) {
                router.open(.item(id))
                return .handled
            }
            return ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
        })
    }
}

/// Plain text with inline references as links, for previews where Markdown blocks would be too much.
struct ReferenceText: View {
    let text: String

    @Environment(\.referenceTitles) private var titles
    @Environment(\.hearth) private var hearth

    var body: some View {
        Text(InlineReferences.attributed(text, titles: titles, accent: hearth.accent))
            .modifier(SafeLinks())
    }
}

/// Renders saved Markdown as a quiet reading column.
struct MarkdownView: View {
    let document: MarkdownDocument

    @Environment(\.hearth) private var hearth
    @Environment(\.referenceTitles) private var titles

    var body: some View {
        LazyVStack(alignment: .leading, spacing: HearthSpacing.md) {
            ForEach(document.blocks.indices, id: \.self) { index in
                block(document.blocks[index])
            }
        }
        .modifier(SafeLinks())
    }

    @ViewBuilder
    private func block(_ block: MarkdownDocument.Block) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(inline(text))
                .font(level == 1 ? HearthFont.heading1 : level == 2 ? HearthFont.heading2 : HearthFont.heading3)
                .foregroundStyle(hearth.textPrimary)
                .padding(.top, level <= 2 ? HearthSpacing.sm : HearthSpacing.xs)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            Text(inline(text))
                .font(HearthFont.body)
                .lineSpacing(4)
                .foregroundStyle(hearth.textPrimary)
        case .list(_, let items):
            VStack(alignment: .leading, spacing: HearthSpacing.xs + 2) {
                ForEach(items.indices, id: \.self) { index in
                    let item = items[index]
                    HStack(alignment: .firstTextBaseline, spacing: HearthSpacing.sm) {
                        Text(item.marker)
                            .foregroundStyle(hearth.accent)
                            .monospacedDigit()
                        Text(inline(item.text))
                            .lineSpacing(3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .font(HearthFont.body)
                    .padding(.leading, CGFloat(item.depth) * HearthSpacing.lg)
                }
            }
        case .quote(let text):
            Text(inline(text))
                .font(HearthFont.body.italic())
                .lineSpacing(4)
                .foregroundStyle(hearth.textSecondary)
                .padding(.leading, HearthSpacing.md)
                .overlay(alignment: .leading) {
                    Capsule().fill(hearth.accent.opacity(0.6)).frame(width: 3)
                }
        case .code(let code):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(HearthFont.monospace)
                    .foregroundStyle(hearth.textPrimary)
                    .textSelection(.enabled)
                    .padding(HearthSpacing.md)
            }
            .background(RoundedRectangle(cornerRadius: HearthRadius.inner, style: .continuous).fill(hearth.surfaceSunken))
        case .table(let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: HearthSpacing.lg, verticalSpacing: HearthSpacing.sm) {
                    ForEach(rows.indices, id: \.self) { row in
                        GridRow {
                            ForEach(rows[row].indices, id: \.self) { column in
                                Text(inline(rows[row][column]))
                                    .font(row == 0 ? HearthFont.footnote.weight(.semibold) : HearthFont.footnote)
                            }
                        }
                        if row == 0 { HearthDivider() }
                    }
                }
                .padding(HearthSpacing.md)
            }
            .background(RoundedRectangle(cornerRadius: HearthRadius.inner, style: .continuous).fill(hearth.surfaceSunken))
        case .rule:
            HearthDivider().padding(.vertical, HearthSpacing.sm)
        }
    }

    private func inline(_ text: String) -> AttributedString {
        InlineReferences.attributed(text, titles: titles, accent: hearth.accent, segment: markdown)
    }

    private func markdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        var attributed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        for run in attributed.runs {
            if run.inlinePresentationIntent?.contains(.code) == true {
                attributed[run.range].font = HearthFont.monospace
                attributed[run.range].backgroundColor = hearth.surfaceSunken
            }
            if run.link != nil {
                attributed[run.range].foregroundColor = hearth.accent
                attributed[run.range].underlineStyle = .single
            }
        }
        return attributed
    }
}
