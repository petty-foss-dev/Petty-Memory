import EnveMemoryKit
import SwiftUI

struct ShareRoot: View {
    let model: ShareModel

    @State private var theme = ThemeManager()
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = theme.palette(systemDark: colorScheme == .dark)
        ShareView(model: model)
            .environment(\.hearth, palette)
            .preferredColorScheme(theme.preferredScheme)
            .tint(palette.accent)
    }
}

struct ShareView: View {
    @Bindable var model: ShareModel

    @Environment(\.hearth) private var hearth

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: HearthSpacing.md) {
                    switch model.phase {
                    case .loading:
                        ProgressView().frame(maxWidth: .infinity).padding(.vertical, HearthSpacing.xxxl)
                    case .finished(let message):
                        Label {
                            Text(message).foregroundStyle(hearth.textPrimary)
                        } icon: {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(hearth.accentText)
                        }
                            .font(HearthFont.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, HearthSpacing.xxxl)
                            .accessibilityIdentifier("ShareResult")
                    case .failed(let message) where model.content == nil:
                        ErrorText(message: message)
                    default:
                        form
                    }
                }
                .padding(HearthSpacing.lg)
            }
            .background(hearth.background.ignoresSafeArea())
            .navigationTitle("Petty Memory")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { model.dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.phase == .saving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await model.save() } }
                            .fontWeight(.semibold)
                            .disabled(model.content == nil || isFinished)
                    }
                }
            }
        }
    }

    private var isFinished: Bool {
        if case .finished = model.phase { true } else { false }
    }

    @ViewBuilder
    private var form: some View {
        if let content = model.content { SharePreview(content: content) }
        if model.takesTitle {
            TextField(model.isLink ? "Title" : "Title (optional)", text: $model.form.title)
                .hearthField()
        }
        if model.takesIntent {
            Overline("Keep it for")
            IntentChips(intent: $model.form.intent)
        }
        if model.takesReminder {
            Overline("Remind me")
            ReminderChips(preset: $model.remindPreset)
        }
        ProjectPicker(projectID: $model.form.projectID, projects: model.projects)
        TextField("Tags, comma separated", text: $model.form.tags)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .hearthField()
        TextField("Note (optional)", text: $model.form.note, axis: .vertical)
            .lineLimit(2...6)
            .hearthField()
        if case .failed(let message) = model.phase { ErrorText(message: message) }
    }
}

private struct SharePreview: View {
    let content: SharedContent
    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            HStack(alignment: .top, spacing: HearthSpacing.md) {
                Image(systemName: symbol)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(hearth.accentText)
                    .frame(width: 34, height: 34)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(hearth.accentMuted))
                VStack(alignment: .leading, spacing: 2) {
                    Text(headline).font(HearthFont.subheadline).lineLimit(2)
                    Text(detail).font(HearthFont.caption).foregroundStyle(hearth.textSecondary).lineLimit(3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var symbol: String {
        switch content {
        case .link: "link"
        case .text: "text.quote"
        case .files(let files): files.allSatisfy { $0.mimeType.hasPrefix("image/") } ? "photo" : "doc"
        }
    }

    private var headline: String {
        switch content {
        case .link(let url, _): url.host() ?? url.absoluteString
        case .text: "Text"
        case .files(let files): files.count == 1 ? files[0].filename : "\(files.count) files"
        }
    }

    private var detail: String {
        switch content {
        case .link(let url, _): url.absoluteString
        case .text(let text): text
        case .files(let files): files.count == 1 ? files[0].mimeType : files.map(\.filename).joined(separator: ", ")
        }
    }
}

private struct ErrorText: View {
    let message: String
    @Environment(\.hearth) private var hearth

    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(HearthFont.footnote)
            .foregroundStyle(hearth.danger)
    }
}
