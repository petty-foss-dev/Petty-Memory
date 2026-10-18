import EnveMemoryKit
import PDFKit
import SwiftUI

struct PdfResearchView: View {
    let source: ItemDetail
    let attachment: Attachment
    let location: ResearchLocation

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.bottomBarInset) private var bottomInset
    @Environment(\.hearth) private var hearth

    @State private var info: PdfSource?
    @State private var pdfData: Data?
    @State private var document: PDFDocument?
    @State private var pageIndex = 0
    @State private var pages: [Int: PdfPage] = [:]
    @State private var annotations: [PdfAnnotation] = []
    @State private var highlight: String?
    @State private var selection: (text: String, pageIndex: Int)?
    @State private var panel: Panel = .page
    @State private var findText = ""
    @State private var matches: [PdfMatch] = []
    @State private var finding = false
    @State private var error: String?
    @State private var fileError: String?
    @State private var indexing = false
    @State private var annotating: AnnotationDraft?
    @State private var recognizing: Int?
    @State private var scratch = ResearchScratch()
    @State private var started = false

    enum Panel: String, CaseIterable { case page, annotations, find }

    struct AnnotationDraft: Identifiable {
        let id = UUID()
        let page: Int
        let quote: String
    }

    private var page: Int { pageIndex + 1 }
    private var pageCount: Int { document?.pageCount ?? info?.pageCount ?? 0 }

    var body: some View {
        VStack(spacing: 0) {
            header
            ZStack {
                if let document {
                    PdfKitView(document: document, pageIndex: $pageIndex, highlight: highlight) { text, index in
                        selection = (text, index)
                    }
                } else if let fileError {
                    VStack(spacing: HearthSpacing.md) {
                        ErrorBanner(message: fileError) { Task { await openFile() } }
                        Button("Open the item") { router.open(.item(source.id)) }.buttonStyle(.hearthSecondary)
                    }
                    .padding(HearthSpacing.lg)
                } else {
                    ProgressView("Opening the original…")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(hearth.surfaceSunken)
            bottomPanel
        }
        .padding(.bottom, bottomInset)
        .hearthChrome()
        .navigationTitle(source.item.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Open the original item", systemImage: "doc") { router.open(.item(source.id)) }
                    Button("Annotate a passage…", systemImage: "highlighter") {
                        annotating = AnnotationDraft(page: page, quote: "")
                    }
                    .disabled(info?.status != .ready || pages[page] == nil || connection.knowledgeWriteReason != nil)
                    .accessibilityIdentifier("PdfAnnotatePage")
                    Button("Recognize text on this page", systemImage: "text.viewfinder") { recognizing = page }
                        .disabled(pdfData == nil || info?.status != .ready || connection.knowledgeWriteReason != nil)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("PDF actions")
                .accessibilityIdentifier("PdfMenu")
            }
        }
        .sheet(item: $annotating) { draft in
            if let info {
                AnnotationSheet(source: info, page: draft.page, quote: draft.quote, pageInfo: pages[draft.page]) { saved in
                    Task { await loadAnnotations() }
                    highlight = saved.quote
                    panel = .annotations
                }
                .environment(\.hearth, hearth)
            }
        }
        .sheet(item: Binding(get: { recognizing.map(PageKey.init) }, set: { recognizing = $0?.page })) { key in
            if let info, let pdfData, let document {
                PdfOcrSheet(source: info, page: key.page, pdfData: pdfData, preview: document.page(at: key.page - 1),
                            existing: pages[key.page]?.ocr?.text) {
                    Task { await reloadSource(); await loadPage(key.page, force: true) }
                }
                .environment(\.hearth, hearth)
            }
        }
        .task { await start() }
        .onChange(of: pageIndex) { _, index in Task { await loadPage(index + 1) } }
        .onDisappear { scratch.discard() }
    }

    private struct PageKey: Identifiable {
        let page: Int
        var id: Int { page }
    }

    private var header: some View {
        HStack(spacing: HearthSpacing.sm) {
            Button { pageIndex = max(0, pageIndex - 1) } label: { Image(systemName: "chevron.left") }
                .disabled(pageIndex == 0)
                .accessibilityLabel("Previous page")
                .accessibilityIdentifier("PdfPrevious")
            Menu {
                ForEach(Array(stride(from: 1, through: max(pageCount, 1), by: max(1, pageCount / 40))), id: \.self) { number in
                    Button("Page \(number)") { pageIndex = number - 1 }
                }
            } label: {
                Text(pageCount > 0 ? "Page \(page) of \(pageCount)" : "Page \(page)").font(HearthFont.subheadline.monospacedDigit())
            }
            .accessibilityIdentifier("PdfPageMenu")
            Button { pageIndex = min(max(pageCount - 1, 0), pageIndex + 1) } label: { Image(systemName: "chevron.right") }
                .disabled(pageIndex >= pageCount - 1)
                .accessibilityLabel("Next page")
                .accessibilityIdentifier("PdfNext")
            Spacer()
            if let selection {
                Button { annotating = AnnotationDraft(page: selection.pageIndex + 1, quote: selection.text) } label: {
                    Label("Annotate", systemImage: "highlighter")
                }
                .font(HearthFont.subheadline)
                .disabled(connection.knowledgeWriteReason != nil || info?.status != .ready)
                .accessibilityIdentifier("PdfAnnotateSelection")
            }
        }
        .padding(.horizontal, HearthSpacing.lg)
        .padding(.vertical, HearthSpacing.sm)
    }

    private var bottomPanel: some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Picker("Panel", selection: $panel) {
                Text("Page text").tag(Panel.page)
                Text("Annotations\(annotations.isEmpty ? "" : " (\(annotations.count))")").tag(Panel.annotations)
                Text("Find").tag(Panel.find)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("PdfPanel")
            ScrollView {
                VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                    if let error { ErrorBanner(message: error) { Task { await start() } } }
                    if let reason = connection.knowledgeReadReason { OnlineOnlyNote(reason: reason) }
                    switch panel {
                    case .page: pageText
                    case .annotations: annotationList
                    case .find: findPanel
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(HearthSpacing.md)
        .frame(height: 260)
        .background(hearth.surface)
    }

    @ViewBuilder
    private var pageText: some View {
        if let info { statusNote(info) }
        if let current = pages[page] {
            if let ocr = current.ocr {
                Label("Reviewed OCR text", systemImage: "text.viewfinder").font(HearthFont.caption).foregroundStyle(hearth.accent)
                Text(verbatim: ocr.text).font(HearthFont.footnote).textSelection(.enabled)
            }
            if current.available {
                if current.ocr != nil { Overline("Text from the PDF") }
                Text(verbatim: current.text.isEmpty ? "This page has no text layer. It may be a scan: recognize its text on this iPhone from the menu." : current.text)
                    .font(HearthFont.footnote)
                    .foregroundStyle(current.text.isEmpty ? hearth.textTertiary : hearth.textPrimary)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("PdfPageText")
                if current.clipped {
                    Text("The library kept only the start of this page's text.").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                }
            } else if current.ocr == nil {
                Text("The library doesn't keep text for this page. Recognize it on this iPhone from the menu to quote it.")
                    .font(HearthFont.footnote).foregroundStyle(hearth.textTertiary)
            }
            if selection == nil {
                Text("Select text in the PDF above to quote and annotate it.").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
            }
        }
    }

    @ViewBuilder
    private func statusNote(_ info: PdfSource) -> some View {
        switch info.status {
        case .ready:
            if info.truncated {
                Text("Your computer keeps text for \(info.storedPages) of \(info.pageCount) pages. Recognize later pages here to quote them.")
                    .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
            }
        case .pending:
            KnowledgeNote(text: "Your computer is still extracting this PDF's page text.", symbol: "hourglass")
            Button("Check again") { Task { await reloadSource(); await loadPage(page) } }
                .font(HearthFont.subheadline)
                .accessibilityIdentifier("PdfCheckAgain")
        case .unavailable:
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                KnowledgeNote(text: "This PDF was saved before page text was kept, or extraction failed. Your computer can extract it again; the file itself isn't changed.",
                              symbol: "doc.badge.gearshape")
                Button(indexing ? "Asking your computer…" : "Extract page text") { requestIndex() }
                    .buttonStyle(.hearthSecondary)
                    .disabled(indexing || connection.knowledgeWriteReason != nil)
                    .accessibilityIdentifier("PdfIndex")
            }
        }
    }

    @ViewBuilder
    private var annotationList: some View {
        if annotations.isEmpty {
            Text("No annotations yet. Select a passage in the PDF, or choose Annotate a passage from the menu to quote page text or reviewed OCR.").font(HearthFont.footnote).foregroundStyle(hearth.textTertiary)
        }
        ForEach(annotations) { annotation in
            Button {
                pageIndex = annotation.page - 1
                highlight = annotation.quote
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text("Page \(annotation.page)\(annotation.textSource == .ocr ? " · OCR" : "")").font(HearthFont.caption.weight(.semibold))
                        Spacer()
                        Text(annotation.status.label).font(HearthFont.caption)
                            .foregroundStyle(annotation.status == .current || annotation.status == .moved ? hearth.success : hearth.danger)
                    }
                    Text(verbatim: "“\(annotation.quote)”").font(HearthFont.footnote).lineLimit(3).multilineTextAlignment(.leading)
                }
                .padding(.vertical, HearthSpacing.xs)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button("Open note", systemImage: "note.text") { router.open(.item(annotation.id)) }
            }
            .accessibilityIdentifier("PdfAnnotationRow")
        }
    }

    @ViewBuilder
    private var findPanel: some View {
        HStack {
            TextField("Find in this PDF", text: $findText)
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
                .onSubmit { find() }
                .hearthField()
                .accessibilityIdentifier("PdfFindField")
            Button(action: find) { if finding { ProgressView() } else { Image(systemName: "magnifyingglass") } }
                .disabled(finding || findText.trimmed.isEmpty || findText.trimmed.utf16.count > ResearchLimits.findChars || info?.status != .ready)
                .accessibilityLabel("Find")
        }
        ForEach(Array(matches.enumerated()), id: \.offset) { _, match in
            Button {
                pageIndex = match.page - 1
                highlight = findText.trimmed
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Page \(match.page)\(match.textSource == .ocr ? " · OCR" : "")").font(HearthFont.caption.weight(.semibold))
                    Text(verbatim: match.excerpt).font(HearthFont.footnote).lineLimit(2).multilineTextAlignment(.leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("PdfFindResult")
        }
    }

    private func start() async {
        await reloadSource()
        if !started {
            started = true
            if let requested = location.page { pageIndex = max(0, requested - 1) }
            highlight = location.quote
        }
        await loadAnnotations()
        await loadPage(page)
        if document == nil { await openFile() }
    }

    private func reloadSource() async {
        guard connection.knowledgeReadReason == nil, let client = connection.privateClient else { return }
        do {
            info = try await client.send(.pdfSource(source.id), as: PdfSource.self)
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
    }

    /// Downloads the exact attachment the page text describes; a replaced file is refused rather than shown against stale text.
    private func openFile() async {
        guard let client = connection.privateClient else { return }
        fileError = nil
        do {
            let original = try await client.researchOriginal(attachment, itemID: source.id, sha256: info?.sha256 ?? attachment.sha256,
                                                             limit: ResearchLimits.pdfPreviewBytes, kind: "PDF", into: scratch)
            guard let opened = PDFDocument(data: original.data) else { throw ResearchFiles.Failure.unreadable }
            pdfData = original.data
            document = opened
            if pageIndex >= opened.pageCount { pageIndex = max(0, opened.pageCount - 1) }
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            fileError = error.onlineOnlyMessage
        }
    }

    private func loadPage(_ number: Int, force: Bool = false) async {
        guard info?.status == .ready, force || pages[number] == nil, let client = connection.privateClient else { return }
        do {
            let range = try await client.send(.pdfPages(source.id, from: number, limit: 1), as: PdfPageRange.self)
            for item in range.pages { pages[item.page] = item }
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
    }

    private func loadAnnotations() async {
        guard connection.knowledgeReadReason == nil, let client = connection.privateClient else { return }
        do {
            annotations = try await client.send(.pdfAnnotations(source.id), as: [PdfAnnotation].self)
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
        }
    }

    private func find() {
        let text = findText.trimmed
        guard !text.isEmpty, let client = connection.privateClient else { return }
        finding = true
        Task {
            defer { finding = false }
            do {
                matches = try await client.send(.findInPdf(source.id, text: text, limit: ResearchLimits.findResults), as: [PdfMatch].self)
                if matches.isEmpty { router.show("No matches in the kept page text or reviewed OCR") }
            } catch {
                connection.note(error)
                router.show(error.onlineOnlyMessage)
            }
        }
    }

    private func requestIndex() {
        guard let client = connection.privateClient else { return }
        indexing = true
        Task {
            defer { indexing = false }
            do {
                info = try await client.send(.indexPdf(source.id), as: PdfSource.self)
                pages = [:]
                await loadPage(page)
            } catch {
                connection.note(error)
                router.show(error.onlineOnlyMessage)
            }
        }
    }
}
