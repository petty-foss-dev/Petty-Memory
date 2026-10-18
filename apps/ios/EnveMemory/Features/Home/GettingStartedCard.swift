import SwiftUI

/// A first-run checklist that only points at workflows; it never changes the library or turns anything on.
struct GettingStartedCard: View {
    static let dismissedKey = "gettingStartedDismissed"

    let hasItems: Bool

    @AppStorage(Self.dismissedKey) private var dismissed = false
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    var body: some View {
        if !dismissed {
            HearthCard(padding: HearthSpacing.md) {
                VStack(alignment: .leading, spacing: HearthSpacing.md) {
                    HStack {
                        Text("Getting started").font(HearthFont.cardTitle)
                        Spacer()
                        Button("Hide") { dismissed = true }
                            .font(HearthFont.subheadline)
                            .accessibilityIdentifier("GettingStartedHide")
                    }
                    Step(done: hasItems, title: "Capture your first note",
                         detail: hasItems ? "Your library already has notes." : "Type above, dictate a note, or read the text from a photo.",
                         action: hasItems ? nil : "New note") { router.capture = .note }
                    Step(title: "Review what's due", detail: "Daily review brings notes back when it's time to look again, and you choose when to see each one next.",
                         action: "Daily review") { router.open(.review) }
                    Step(title: "Import Enve highlights", detail: "Bring in book highlights and notes from an Enve export file.",
                         action: "Import") { router.open(.enveImport) }
                    Step(title: "AI is optional", detail: "Everything here works without AI. To chat, choose a provider in Petty Memory's settings on your computer, then open AI chat. Chats are kept only when you save them.",
                         action: "AI chat") { router.open(.aiChat) }
                    Text("You can bring this list back from Settings.")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textTertiary)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("GettingStarted")
        }
    }
}

private struct Step: View {
    var done = false
    let title: String
    let detail: String
    let action: String?
    let perform: () -> Void

    @Environment(\.hearth) private var hearth

    var body: some View {
        HStack(alignment: .top, spacing: HearthSpacing.md) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(done ? hearth.success : hearth.textTertiary)
                .accessibilityLabel(done ? "Done" : "Not done")
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(HearthFont.subheadline)
                Text(LocalizedStringKey(detail)).font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let action {
                Button(action, action: perform).font(HearthFont.subheadline)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
