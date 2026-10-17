import EnveMemoryKit
import SwiftUI

extension Connection {
    /// Saved views and templates write several items at once on the server, so they're never queued; nil while it's reachable.
    var onlineOnlyReason: String? {
        switch status {
        case .online where !scopes.contains("write"): "This pairing is read-only. Pair with read and write access to change views or use templates."
        case .online: nil
        case .unknown, .checking: "Connecting to your server…"
        case .offline: "You're offline. Saved views and templates are created and changed only while your server is reachable; nothing is queued."
        case .unauthorized: "This phone's pairing was revoked. Pair again to make changes."
        }
    }
}

extension Error {
    var onlineOnlyMessage: String {
        (self as? APIError)?.allowsCachedFallback == true ? "This needs a connection to your server. Nothing was saved or queued." : localizedDescription
    }
}

/// Why a create, edit or use button is disabled.
struct OnlineOnlyNote: View {
    let reason: String

    @Environment(\.hearth) private var hearth

    var body: some View {
        Label {
            Text(reason).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
        } icon: {
            Image(systemName: "wifi.slash").foregroundStyle(hearth.textTertiary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("OnlineOnlyNote")
    }
}

/// The server's last answer, shown as is: saved views and templates aren't recalculated from the offline copy.
struct SavedResultsBanner: View {
    let savedAt: Date

    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Offline · last saved results").font(HearthFont.subheadline)
                    Text("As your server answered \(savedAt.formatted(.relative(presentation: .named))). Changes since then won't show until you're connected.")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textSecondary)
                }
            } icon: {
                Image(systemName: "icloud.slash").foregroundStyle(hearth.textSecondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("SavedResultsBanner")
    }
}

/// Marks a saved view's definition or a template's notes on their detail page; works from the offline copy too.
struct WorkflowCard: View {
    let item: Item

    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    var body: some View {
        if item.isSavedView {
            card(symbol: "line.3.horizontal.decrease.circle", title: "Saved view",
                 message: "This note holds a saved view's search and filters.") {
                Button("Show results") { router.open(.savedView(item.id)) }.font(HearthFont.subheadline)
            }
        } else if item.isTemplateMember {
            card(symbol: "doc.on.doc", title: item.isTemplateRoot ? "Template" : "Part of a template",
                 message: "Edits here change what new copies start with.") {
                Button("Templates") { router.open(.templates) }.font(HearthFont.subheadline)
            }
        }
    }

    private func card<Action: View>(symbol: String, title: String, message: String, @ViewBuilder action: () -> Action) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            HStack(spacing: HearthSpacing.md) {
                TypeGlyph(symbol: symbol)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(HearthFont.subheadline)
                    Text(message).font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                action()
            }
        }
        .accessibilityIdentifier("WorkflowCard")
    }
}
