import SwiftUI

/// Elevated content surface.
struct HearthCard<Content: View>: View {
    var padding: CGFloat = HearthSpacing.lg
    @ViewBuilder var content: Content

    @Environment(\.hearth) private var hearth

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: HearthRadius.card, style: .continuous).fill(hearth.surface))
            .overlay(RoundedRectangle(cornerRadius: HearthRadius.card, style: .continuous).strokeBorder(hearth.hairline))
            .shadow(color: hearth.scrim.opacity(hearth.isDark ? 0.3 : 0.08), radius: 14, x: 0, y: 8)
    }
}

struct TagChip: View {
    let tag: String

    @Environment(\.hearth) private var hearth

    var body: some View {
        Text("#\(tag)")
            .font(HearthFont.footnote.weight(.medium))
            .foregroundStyle(hearth.accentText)
            .padding(.horizontal, HearthSpacing.md)
            .padding(.vertical, HearthSpacing.xs + 2)
            .background(Capsule(style: .continuous).fill(hearth.accentMuted))
            .accessibilityLabel("Tag \(tag)")
    }
}

/// A selectable filter pill.
struct FilterChip: View {
    let title: String
    var systemImage: String?
    let isSelected: Bool
    let action: () -> Void

    @Environment(\.hearth) private var hearth

    var body: some View {
        Button(action: action) {
            Label {
                Text(title)
            } icon: {
                if let systemImage { Image(systemName: systemImage) }
            }
            .labelStyle(.titleAndIcon)
            .font(HearthFont.subheadline)
            .foregroundStyle(isSelected ? hearth.onAccent : hearth.textSecondary)
            .padding(.horizontal, HearthSpacing.md)
            .padding(.vertical, HearthSpacing.sm)
            .background(Capsule(style: .continuous).fill(isSelected ? hearth.accent : hearth.surface))
            .overlay(Capsule(style: .continuous).strokeBorder(isSelected ? .clear : hearth.controlBorder))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

enum HearthButtonVariant {
    case primary, secondary, quiet, destructive
}

struct HearthButtonStyle: ButtonStyle {
    var variant: HearthButtonVariant

    func makeBody(configuration: Configuration) -> some View {
        HearthButtonBody(variant: variant, configuration: configuration)
    }
}

private struct HearthButtonBody: View {
    let variant: HearthButtonVariant
    let configuration: ButtonStyleConfiguration

    @Environment(\.hearth) private var hearth
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        configuration.label
            .font(HearthFont.headline)
            .padding(.horizontal, HearthSpacing.lg)
            .padding(.vertical, HearthSpacing.md)
            .frame(maxWidth: variant == .quiet ? nil : .infinity)
            .foregroundStyle(foreground)
            .background(RoundedRectangle(cornerRadius: HearthRadius.button, style: .continuous).fill(background))
            .overlay(RoundedRectangle(cornerRadius: HearthRadius.button, style: .continuous).strokeBorder(border))
            .opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1) : 0.45)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }

    private var foreground: Color {
        switch variant {
        case .primary: hearth.onAccent
        case .secondary: hearth.textPrimary
        case .quiet: hearth.accent
        case .destructive: hearth.danger
        }
    }

    private var background: Color {
        switch variant {
        case .primary: hearth.accent
        case .secondary: hearth.surface
        case .quiet: .clear
        case .destructive: hearth.danger.opacity(0.12)
        }
    }

    private var border: Color {
        switch variant {
        case .secondary: hearth.controlBorder
        case .destructive: hearth.danger.opacity(0.35)
        case .primary, .quiet: .clear
        }
    }
}

extension ButtonStyle where Self == HearthButtonStyle {
    static var hearthPrimary: HearthButtonStyle { .init(variant: .primary) }
    static var hearthSecondary: HearthButtonStyle { .init(variant: .secondary) }
    static var hearthQuiet: HearthButtonStyle { .init(variant: .quiet) }
    static var hearthDestructive: HearthButtonStyle { .init(variant: .destructive) }
}

/// Uppercase, tracked label that introduces a section.
struct Overline: View {
    let text: String
    @Environment(\.hearth) private var hearth

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(HearthFont.overline)
            .tracking(1.4)
            .foregroundStyle(hearth.textSecondary)
            .accessibilityLabel(text)
            .accessibilityAddTraits(.isHeader)
    }
}

struct HearthDivider: View {
    @Environment(\.hearth) private var hearth
    var body: some View {
        Rectangle().fill(hearth.hairline).frame(height: 1)
    }
}

/// Text input on a sunken surface.
struct HearthFieldStyle: ViewModifier {
    @Environment(\.hearth) private var hearth

    func body(content: Content) -> some View {
        content
            .font(HearthFont.body)
            .padding(.horizontal, HearthSpacing.md)
            .padding(.vertical, HearthSpacing.md - 1)
            .background(RoundedRectangle(cornerRadius: HearthRadius.inner, style: .continuous).fill(hearth.surfaceSunken))
            .overlay(RoundedRectangle(cornerRadius: HearthRadius.inner, style: .continuous).strokeBorder(hearth.controlBorder))
    }
}

extension View {
    func hearthField() -> some View { modifier(HearthFieldStyle()) }
}

/// The ambient two-circle accent glow behind every screen. Reduce Motion stills the drift.
struct DynamicBackground: View {
    @Environment(\.hearth) private var hearth
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false

    var body: some View {
        ZStack {
            hearth.background
            ember(hearth.accent, opacity: hearth.isDark ? 0.16 : 0.10, size: 520)
                .offset(x: drift ? -110 : -70, y: drift ? -290 : -240)
            ember(hearth.accent, opacity: hearth.isDark ? 0.07 : 0.05, size: 440)
                .offset(x: drift ? 150 : 110, y: drift ? 320 : 360)
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 16).repeatForever(autoreverses: true)) { drift = true }
        }
    }

    private func ember(_ color: Color, opacity: Double, size: CGFloat) -> some View {
        Circle()
            .fill(RadialGradient(colors: [color.opacity(opacity), color.opacity(0)], center: .center, startRadius: 0, endRadius: size / 2))
            .frame(width: size, height: size)
            .blur(radius: 40)
    }
}

/// Scroll container with the serif screen title, standard margins and room for the dock.
struct HearthScreen<Content: View>: View {
    var title: String?
    var overline: String?
    @ViewBuilder var content: Content

    @Environment(\.hearth) private var hearth
    @Environment(\.bottomBarInset) private var bottomInset

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: HearthSpacing.lg) {
                if title != nil || overline != nil {
                    VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                        if let overline { Overline(overline) }
                        if let title {
                            Text(title)
                                .font(HearthFont.screenTitle)
                                .foregroundStyle(hearth.textPrimary)
                                .accessibilityAddTraits(.isHeader)
                        }
                    }
                    .padding(.top, HearthSpacing.sm)
                }
                content
            }
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, HearthSpacing.lg)
            .padding(.bottom, bottomInset + HearthSpacing.xl)
        }
        .scrollDismissesKeyboard(.interactively)
        .hearthChrome()
    }
}

private struct HearthChrome: ViewModifier {
    @Environment(\.hearth) private var hearth

    func body(content: Content) -> some View {
        content
            .background(DynamicBackground())
            .foregroundStyle(hearth.textPrimary)
            .tint(hearth.accent)
    }
}

extension View {
    func hearthChrome() -> some View { modifier(HearthChrome()) }
}

/// Left-aligned wrapping layout for chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = HearthSpacing.xs + 2

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
        let rows = rows(subviews, maxWidth: proposal.width ?? .infinity)
        let height = rows.last.map { $0.y + $0.height } ?? 0
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) {
        for row in rows(subviews, maxWidth: bounds.width) {
            for (index, x) in row.items {
                subviews[index].place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + row.y), proposal: .unspecified)
            }
        }
    }

    private struct Row {
        var y: CGFloat
        var height: CGFloat = 0
        var width: CGFloat = 0
        var items: [(Int, CGFloat)] = []
    }

    private func rows(_ subviews: Subviews, maxWidth: CGFloat) -> [Row] {
        var rows: [Row] = []
        var row = Row(y: 0)
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if row.width + size.width > maxWidth, !row.items.isEmpty {
                rows.append(row)
                row = Row(y: row.y + row.height + spacing)
            }
            row.items.append((index, row.width))
            row.width += size.width + spacing
            row.height = max(row.height, size.height)
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}
