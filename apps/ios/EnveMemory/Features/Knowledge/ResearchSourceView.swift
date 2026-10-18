import EnveMemoryKit
import SwiftUI

struct ResearchSourceView: View {
    let location: ResearchLocation

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var detail: ItemDetail?
    @State private var error: String?

    var body: some View {
        Group {
            if let detail, let pdf = detail.attachments.first(where: \.isPDF) {
                PdfResearchView(source: detail, attachment: pdf, location: location)
            } else if let detail, let audio = detail.attachments.first(where: \.isAudio) {
                AudioResearchView(source: detail, attachment: audio, start: location.start)
            } else {
                HearthScreen(title: detail?.item.displayTitle ?? "Source", overline: "Research") {
                    if let error { ErrorBanner(message: error) { Task { await load() } } }
                    if let reason = connection.knowledgeReadReason { OnlineOnlyNote(reason: reason) }
                    if let detail {
                        EmptyStateView(symbol: "doc.questionmark", title: "Not a PDF or recording",
                                       message: "This item has no PDF or audio file to open here.")
                        Button("Open the item") { router.open(.item(detail.id)) }.buttonStyle(.hearthSecondary)
                    } else if error == nil {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, HearthSpacing.xxxl)
                    }
                }
                .toolbar(.visible, for: .navigationBar)
                .navigationBarTitleDisplayMode(.inline)
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard detail == nil, connection.client != nil else { return }
        do {
            detail = try await connection.load(.item(location.sourceId), as: ItemDetail.self).value
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.localizedDescription
        }
    }
}

struct ResearchLinkCard: View {
    let itemID: String
    let link: ResearchLink

    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                HStack(spacing: HearthSpacing.md) {
                    TypeGlyph(symbol: symbol)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(HearthFont.subheadline)
                        Text("This note is kept as written; the original file is never changed.").font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                FlowLayout(spacing: HearthSpacing.sm) {
                    switch link.kind {
                    case .pdfAnnotation, .pdfOcrPage:
                        FilterChip(title: link.page.map { "Open page \($0)" } ?? "Open PDF", systemImage: "doc.richtext", isSelected: false) {
                            router.open(.research(link.location))
                        }
                    case .transcript:
                        FilterChip(title: "Play with transcript", systemImage: "text.quote", isSelected: false) { router.open(.transcript(itemID)) }
                        FilterChip(title: "Open recording", systemImage: "waveform", isSelected: false) { router.open(.research(link.location)) }
                    case .transcriptPassage:
                        FilterChip(title: link.start.map { "Play from \(Timestamp.label($0))" } ?? "Play", systemImage: "play.circle", isSelected: false) {
                            router.open(.research(link.location))
                        }
                        FilterChip(title: "Open transcript", systemImage: "text.quote", isSelected: false) { router.open(.transcript(link.sourceId)) }
                    }
                }
            }
        }
        .accessibilityIdentifier("ResearchLinkCard")
    }

    private var title: String {
        switch link.kind {
        case .pdfAnnotation: "PDF annotation\(link.page.map { " · page \($0)" } ?? "")"
        case .pdfOcrPage: "Reviewed page text\(link.page.map { " · page \($0)" } ?? "")"
        case .transcript: "Timed transcript of a recording"
        case .transcriptPassage: "Transcript passage\(link.start.map { " at \(Timestamp.label($0))" } ?? "")"
        }
    }

    private var symbol: String {
        switch link.kind {
        case .pdfAnnotation: "highlighter"
        case .pdfOcrPage: "text.viewfinder"
        case .transcript, .transcriptPassage: "text.quote"
        }
    }
}
