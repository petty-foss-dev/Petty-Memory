import PDFKit
import SwiftUI
import Vision

struct PdfKitView: UIViewRepresentable {
    let document: PDFDocument
    /// Zero-based.
    @Binding var pageIndex: Int
    let highlight: String?
    let onSelection: (_ text: String, _ pageIndex: Int) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = .clear
        view.document = document
        view.accessibilityIdentifier = "PdfView"
        context.coordinator.attach(to: view)
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        context.coordinator.parent = self
        if view.document !== document { view.document = document }
        if let page = document.page(at: pageIndex), view.currentPage !== page { view.go(to: page) }
        context.coordinator.highlight(in: view, pageIndex: pageIndex, quote: highlight)
    }

    static func dismantleUIView(_ view: PDFView, coordinator: Coordinator) {
        coordinator.detach()
    }

    final class Coordinator {
        var parent: PdfKitView
        private var observers: [any NSObjectProtocol] = []
        private var shown: Shown?

        private struct Shown: Equatable {
            let pageIndex: Int
            let quote: String?
        }

        init(parent: PdfKitView) { self.parent = parent }

        func attach(to view: PDFView) {
            let center = NotificationCenter.default
            observers = [
                center.addObserver(forName: .PDFViewPageChanged, object: view, queue: .main) { [weak self, weak view] _ in
                    MainActor.assumeIsolated {
                        guard let self, let view, let page = view.currentPage, let index = view.document?.index(for: page) else { return }
                        if self.parent.pageIndex != index { self.parent.pageIndex = index }
                    }
                },
                center.addObserver(forName: .PDFViewSelectionChanged, object: view, queue: .main) { [weak self, weak view] _ in
                    MainActor.assumeIsolated {
                        guard let self, let view, let selection = view.currentSelection, let page = selection.pages.first,
                              let index = view.document?.index(for: page) else { return }
                        let text = (selection.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        if !text.isEmpty { self.parent.onSelection(text, index) }
                    }
                },
            ]
        }

        func detach() {
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers = []
        }

        /// Finds the quote on the page by its words, tolerating line breaks and spacing that differ from the stored text.
        func highlight(in view: PDFView, pageIndex: Int, quote: String?) {
            let next = Shown(pageIndex: pageIndex, quote: quote)
            guard next != shown else { return }
            shown = next
            guard let quote, let page = view.document?.page(at: pageIndex), let text = page.string,
                  let range = Self.range(of: quote, in: text), let selection = page.selection(for: range) else {
                view.highlightedSelections = nil
                return
            }
            selection.color = UIColor.systemTeal.withAlphaComponent(0.35)
            view.highlightedSelections = [selection]
        }

        static func range(of quote: String, in text: String) -> NSRange? {
            let words = quote.split(whereSeparator: \.isWhitespace).prefix(40).map { NSRegularExpression.escapedPattern(for: String($0)) }
            guard !words.isEmpty, let pattern = try? NSRegularExpression(pattern: words.joined(separator: "\\s+"), options: [.caseInsensitive]) else { return nil }
            let match = pattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
            return match?.range
        }
    }
}

nonisolated enum PdfPageRecognition {
    static let engine = "Apple Vision on iPhone"

    @concurrent static func recognize(pdf: Data, pageIndex: Int) async throws -> String {
        guard let document = PDFDocument(data: pdf), let page = document.page(at: pageIndex) else { throw ResearchFiles.Failure.unreadable }
        let bounds = page.bounds(for: .mediaBox)
        let turned = page.rotation % 180 != 0
        let width = turned ? bounds.height : bounds.width
        let height = turned ? bounds.width : bounds.height
        let longest = max(width, height)
        guard longest > 0 else { throw ResearchFiles.Failure.unreadable }
        let scale = min(CGFloat(TextRecognition.recognitionPixels) / longest, 4)
        guard let image = page.thumbnail(of: CGSize(width: width * scale, height: height * scale), for: .mediaBox).cgImage else {
            throw ResearchFiles.Failure.unreadable
        }
        try Task.checkCancellation()
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.automaticallyDetectsLanguage = true
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
        try Task.checkCancellation()
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}
