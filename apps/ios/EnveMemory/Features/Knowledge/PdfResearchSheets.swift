import EnveMemoryKit
import PDFKit
import SwiftUI

struct AnnotationSheet: View {
    let source: PdfSource
    let page: Int
    let pageInfo: PdfPage?
    let saved: (PdfAnnotation) -> Void

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var quote: String
    @State private var note = ""
    @State private var textSource: PdfTextSource
    @State private var saving = false
    @State private var error: String?

    init(source: PdfSource, page: Int, quote: String, pageInfo: PdfPage?, saved: @escaping (PdfAnnotation) -> Void) {
        self.source = source
        self.page = page
        self.pageInfo = pageInfo
        self.saved = saved
        _quote = State(initialValue: quote)
        _textSource = State(initialValue: pageInfo?.ocr != nil && (page > source.storedPages || pageInfo?.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true) ? .ocr : .pdf)
    }

    private var hasOCR: Bool { pageInfo?.ocr != nil || source.ocrPages.contains { $0.page == page } }
    private var hasPdfText: Bool { page <= source.storedPages && pageInfo?.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != true }

    var body: some View {
        NavigationStack {
            Form {
                if let reason = connection.knowledgeWriteReason { Section { OnlineOnlyNote(reason: reason) } }
                Section {
                    TextField("Quote", text: $quote, axis: .vertical)
                        .lineLimit(3...10)
                        .accessibilityIdentifier("AnnotationQuote")
                } header: {
                    Text("Quote from page \(page)")
                } footer: {
                    Text("It must match the page's text exactly, apart from spacing and line breaks. Your computer checks it against the page before saving.")
                }
                if hasOCR, hasPdfText {
                    Section {
                        Picker("Quote from", selection: $textSource) {
                            Text("PDF text").tag(PdfTextSource.pdf)
                            Text("Reviewed OCR").tag(PdfTextSource.ocr)
                        }
                        .pickerStyle(.segmented)
                    }
                } else if !hasPdfText, !hasOCR {
                    Section {
                        Text("The library keeps no text for this page. Recognize its text first, then quote from the reviewed OCR.")
                            .foregroundStyle(hearth.danger)
                    }
                }
                Section("Note") {
                    TextField("Your note (optional)", text: $note, axis: .vertical)
                        .lineLimit(2...8)
                        .accessibilityIdentifier("AnnotationNote")
                }
                if let error { Section { Text(error).foregroundStyle(hearth.danger) } }
            }
            .scrollContentBackground(.hidden)
            .background(hearth.background)
            .navigationTitle("Annotate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save", action: save)
                        .disabled(!canSave)
                        .accessibilityIdentifier("AnnotationSave")
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(saving)
    }

    private var canSave: Bool {
        !saving && connection.knowledgeWriteReason == nil && !quote.trimmed.isEmpty && quote.trimmed.utf16.count <= ResearchLimits.quoteChars
            && note.trimmed.utf16.count <= ResearchLimits.noteChars && (textSource == .ocr ? hasOCR : hasPdfText)
    }

    private func save() {
        guard canSave, let client = connection.privateClient else { return }
        saving = true
        error = nil
        let input = AnnotationInput(sourceId: source.id, page: page, quote: quote.trimmed, sha256: source.sha256, note: note.trimmed, textSource: textSource)
        Task {
            defer { saving = false }
            do {
                let result = try await client.send(.annotate(input), as: CreatedNote.self)
                let annotation = try await client.send(.annotation(result.item.id), as: PdfAnnotation.self)
                router.show(result.created ? "Annotation saved" : "That annotation was already saved")
                saved(annotation)
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.isStaleConflict
                    ? "This PDF was replaced since you opened it. Go back and open it again; nothing was saved."
                    : error.onlineOnlyMessage
            }
        }
    }
}

struct PdfOcrSheet: View {
    let source: PdfSource
    let page: Int
    let pdfData: Data
    let preview: PDFPage?
    let existing: String?
    let saved: () -> Void

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var draft: String
    @State private var recognizing = false
    @State private var recognition: Task<Void, Never>?
    @State private var currentRun: UUID?
    @State private var notice: String?
    @State private var saving = false
    @State private var error: String?

    init(source: PdfSource, page: Int, pdfData: Data, preview: PDFPage?, existing: String?, saved: @escaping () -> Void) {
        self.source = source
        self.page = page
        self.pdfData = pdfData
        self.preview = preview
        self.existing = existing
        self.saved = saved
        _draft = State(initialValue: existing ?? "")
    }

    var body: some View {
        NavigationStack {
            HearthScreen {
                Text("Text is read from this page on your iPhone with Apple's Vision framework. No AI and no cloud service is used, and the PDF file isn't changed. Check the draft before saving; recognition can misread words.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                if let image = preview?.thumbnail(of: CGSize(width: 600, height: 800), for: .mediaBox) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 280)
                        .frame(maxWidth: .infinity)
                        .background(Color.white)
                        .clipShape(RoundedRectangle(cornerRadius: HearthRadius.inner, style: .continuous))
                        .accessibilityLabel("Page \(page)")
                }
                if recognizing {
                    HStack {
                        Label { Text("Reading page \(page) on this iPhone…") } icon: { ProgressView() }.font(HearthFont.footnote)
                        Spacer()
                        Button("Cancel") { stop() }.font(HearthFont.subheadline)
                    }
                } else {
                    Button(existing == nil ? "Recognize text" : "Recognize again", systemImage: "text.viewfinder", action: recognize)
                        .buttonStyle(.hearthSecondary)
                        .accessibilityIdentifier("PdfOcrRecognize")
                }
                if let notice { Text(notice).font(HearthFont.caption).foregroundStyle(hearth.textSecondary) }
                TextField("Recognized text appears here. Edit it before saving.", text: $draft, axis: .vertical)
                    .lineLimit(8...30)
                    .hearthField()
                    .disabled(recognizing)
                    .accessibilityIdentifier("PdfOcrDraft")
                if draft.utf16.count > ResearchLimits.ocrChars {
                    Text("Reviewed text can be up to \(ResearchLimits.ocrChars.formatted()) characters.").font(HearthFont.caption).foregroundStyle(hearth.danger)
                }
                if let error { ErrorBanner(message: error) }
                if let reason = connection.knowledgeWriteReason { OnlineOnlyNote(reason: reason) }
            }
            .navigationTitle("Page \(page) text")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Discard") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save", action: save)
                        .disabled(!canSave)
                        .accessibilityIdentifier("PdfOcrSave")
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(saving || recognizing)
        .onDisappear { recognition?.cancel() }
    }

    private var canSave: Bool {
        !saving && !recognizing && connection.knowledgeWriteReason == nil && !draft.trimmed.isEmpty
            && draft.utf16.count <= ResearchLimits.ocrChars && draft.trimmed != existing?.trimmed
    }

    private func recognize() {
        let data = pdfData
        let index = page - 1
        let run = UUID()
        currentRun = run
        recognizing = true
        notice = nil
        recognition = Task {
            defer { if currentRun == run { recognizing = false } }
            do {
                let text = try await PdfPageRecognition.recognize(pdf: data, pageIndex: index).trimmed
                // A cancelled read may still finish inside Vision; its result is ignored.
                guard currentRun == run, !Task.isCancelled else { return }
                if text.isEmpty {
                    notice = "No text found on this page. You can type it yourself."
                } else {
                    draft = text
                    notice = "Check the text before saving; recognition can misread words."
                }
            } catch is CancellationError {
                return
            } catch {
                if currentRun == run { notice = error.localizedDescription }
            }
        }
    }

    private func stop() {
        recognition?.cancel()
        currentRun = nil
        recognizing = false
        notice = "Stopped. The draft wasn't changed."
    }

    private func save() {
        guard canSave, let client = connection.privateClient else { return }
        saving = true
        error = nil
        let input = OcrPageInput(sourceId: source.id, page: page, text: draft.trimmed, sha256: source.sha256, engine: PdfPageRecognition.engine)
        Task {
            defer { saving = false }
            do {
                let result = try await client.send(.saveOcrPage(input), as: CreatedNote.self)
                router.show(result.created ? "Reviewed text saved for page \(page)" : "Reviewed text for page \(page) updated")
                saved()
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.isStaleConflict
                    ? "This PDF was replaced since you opened it, so the page you read may differ. Nothing was saved; open it again."
                    : error.onlineOnlyMessage
            }
        }
    }
}
