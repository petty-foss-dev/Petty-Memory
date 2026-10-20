import EnveMemoryKit
import SwiftUI

struct LibraryView: View {
    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @AppStorage(GettingStartedCard.dismissedKey) private var gettingStartedDismissed = false
    @State private var hasItems = false

    var body: some View {
        HearthScreen(title: "Library") {
            VStack(alignment: .leading, spacing: HearthSpacing.xl) {
                section("Browse", browse)
                section("Look again", lookAgain)
                section("Shelves", Shelf.all.map {
                    LibraryDestination(id: "Shelf_\($0.id)", title: $0.title, symbol: $0.symbol, route: .shelf($0))
                })
                section("AI", ai)
                section("Vault and sharing", privacy)
                section("Import and guides", imports)
                if !gettingStartedDismissed { gettingStarted }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("LibraryScreen")
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var browse: [LibraryDestination] {
        [
            LibraryDestination(id: "OpenOutline", title: "Outline", detail: "Everything in order, branch by branch",
                               symbol: "list.bullet.indent", route: .outline(nil)),
            LibraryDestination(id: "OpenSavedViews", title: "Saved views", detail: "Searches you come back to",
                               symbol: "line.3.horizontal.decrease.circle", route: .savedViews),
            LibraryDestination(id: "OpenTemplates", title: "Templates", detail: "Reusable notes and checklists",
                               symbol: "doc.on.doc", route: .templates),
            LibraryDestination(id: "OpenKnowledge", title: "Knowledge", detail: "Workflows, collections, research and sources",
                               symbol: "books.vertical", route: .knowledge),
            LibraryDestination(id: "OpenMeetings", title: "Meetings", detail: "Meeting notes, speakers and follow-ups",
                               symbol: "person.2.wave.2", route: .biscottiMeetings),
        ]
    }

    private var lookAgain: [LibraryDestination] {
        [LibraryDestination(id: "OpenReview", title: "Daily review", detail: "Notes that are due for another look",
                            symbol: "calendar.badge.clock", route: .review)]
            + Shelf.suggestions.filter { $0 == .review || $0 == .attention(.high) }.map {
                LibraryDestination(id: "Suggestion_\($0.id)", title: $0.title, detail: suggestionDetail($0),
                                   symbol: $0.symbol, route: .shelf($0))
            }
    }

    private var ai: [LibraryDestination] {
        [
            LibraryDestination(id: "LibraryAIChat", title: "Ask AI", detail: "Answers from your notes, with sources",
                               symbol: "bubble.left.and.text.bubble.right", route: .aiChat),
            LibraryDestination(id: "OpenSavedChats", title: "Saved chats", detail: "Conversations you chose to keep",
                               symbol: "tray.full", route: .conversations),
        ]
    }

    private var privacy: [LibraryDestination] {
        var destinations: [LibraryDestination] = []
        if connection.canUseVault {
            destinations.append(LibraryDestination(id: "OpenVault", title: "Vault", detail: "Protected notes and private files",
                                                   symbol: "lock", route: .vault))
        }
        destinations.append(LibraryDestination(id: "OpenPublicLinks", title: "Public links", detail: "See and revoke read-only links",
                                               symbol: "link", route: .shares))
        return destinations
    }

    private var imports: [LibraryDestination] {
        [LibraryDestination(id: "OpenEnveImport", title: "Import Enve highlights", detail: "Book highlights and notes from an Enve export file",
                            symbol: "square.and.arrow.down", route: .enveImport)]
    }

    private func suggestionDetail(_ shelf: Shelf) -> String? {
        switch shelf {
        case .review: "Marked for review"
        case .attention: "Set to high attention"
        default: nil
        }
    }

    private func section(_ title: String, _ destinations: [LibraryDestination]) -> some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Overline(title)
            RowStack(data: destinations) { destination in
                Button { router.open(destination.route) } label: { LibraryRow(destination: destination) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(destination.id)
            }
        }
    }

    private var gettingStarted: some View {
        DisclosureGroup {
            GettingStartedCard(hasItems: hasItems)
                .padding(.top, HearthSpacing.sm)
                .task { await checkForItems() }
        } label: {
            Text("Getting started checklist")
                .font(HearthFont.subheadline)
                .foregroundStyle(hearth.textPrimary)
        }
    }

    private func checkForItems() async {
        guard let loaded = try? await connection.load(.items(ItemFilter(limit: 1)), as: [Item].self) else { return }
        hasItems = !loaded.value.isEmpty
    }
}

private struct LibraryDestination: Identifiable {
    let id: String
    let title: String
    var detail: String?
    let symbol: String
    let route: Route
}

private struct LibraryRow: View {
    let destination: LibraryDestination

    @Environment(\.hearth) private var hearth

    var body: some View {
        HStack(spacing: HearthSpacing.md) {
            TypeGlyph(symbol: destination.symbol)
            VStack(alignment: .leading, spacing: 2) {
                Text(destination.title)
                    .font(HearthFont.cardTitle)
                    .foregroundStyle(hearth.textPrimary)
                if let detail = destination.detail {
                    Text(detail)
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(HearthFont.caption)
                .foregroundStyle(hearth.textTertiary)
                .accessibilityHidden(true)
        }
        .padding(.vertical, HearthSpacing.sm)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}
