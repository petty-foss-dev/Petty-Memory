import EnveMemoryKit
import SwiftUI

struct KnowledgeHubView: View {
    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthScreen(title: "Knowledge", overline: "Library") {
            KnowledgeNote(text: "These run on the computer that holds your library. The phone shows and sends them only while it can reach that computer; nothing here is cached or queued. AI steps use the AI set up there, and every change is a preview until you apply it.")
            if let reason = connection.knowledgeReadReason {
                OnlineOnlyNote(reason: reason)
            } else if connection.knowledgeWriteReason != nil {
                OnlineOnlyNote(reason: "This pairing is read-only. You can browse workflows, collections, research and sources, but changes need read and write access.")
            }
            VStack(spacing: HearthSpacing.md) {
                ForEach(KnowledgeArea.allCases) { area in
                    Button { router.open(.knowledgeArea(area)) } label: { row(area) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier(area.identifier)
                }
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ area: KnowledgeArea) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            HStack(alignment: .top, spacing: HearthSpacing.md) {
                TypeGlyph(symbol: area.symbol)
                VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                    Text(area.title).font(HearthFont.cardTitle).foregroundStyle(hearth.textPrimary)
                    Text(area.summary).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
            }
            .contentShape(Rectangle())
        }
        .accessibilityElement(children: .combine)
    }
}

struct KnowledgeAreaView: View {
    let area: KnowledgeArea

    var body: some View {
        switch area {
        case .workflows: WorkflowsView()
        case .collections: CollectionsView()
        case .research: ResearchLibraryView()
        case .sources: SourcesView()
        case .freshness: FreshnessView()
        case .preferences: PreferencesView()
        }
    }
}
