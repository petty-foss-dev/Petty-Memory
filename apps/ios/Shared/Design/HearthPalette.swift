import SwiftUI

enum HearthMode: String, CaseIterable, Identifiable, Sendable {
    case system, ink, paper
    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .system: "System"
        case .ink: "Dark"
        case .paper: "Light"
        }
    }
}

/// Semantic colors. Screens use only these tokens, so a mode change repaints everything.
struct HearthPalette: Equatable {
    var background: Color
    var surface: Color
    var surfaceSunken: Color
    var textPrimary: Color
    var textSecondary: Color
    var textTertiary: Color
    var accent: Color
    var accentText: Color
    var accentMuted: Color
    var onAccent: Color
    var hairline: Color
    var controlBorder: Color
    var scrim: Color
    var danger: Color
    var success: Color
    var isDark: Bool
}

extension HearthPalette {
    static let ink = HearthPalette(
        background: Color(hex: 0x0E1113),
        surface: Color(hex: 0x181D20),
        surfaceSunken: Color(hex: 0x0A0D0F),
        textPrimary: Color(hex: 0xE6EBEE),
        textSecondary: Color(hex: 0xAEB8BE),
        textTertiary: Color(hex: 0x939EA5),
        accent: Color(hex: 0x4FC1C9),
        accentText: Color(hex: 0x7FD3D9),
        accentMuted: Color(hex: 0x173238),
        onAccent: Color(hex: 0x0B1F22),
        hairline: .white.opacity(0.09),
        controlBorder: Color(hex: 0x71818A),
        scrim: .black,
        danger: Color(hex: 0xEE8277),
        success: Color(hex: 0x6CC79A),
        isDark: true)

    static let paper = HearthPalette(
        background: Color(hex: 0xF3F5F6),
        surface: .white,
        surfaceSunken: Color(hex: 0xEEF1F3),
        textPrimary: Color(hex: 0x1B2328),
        textSecondary: Color(hex: 0x4A565E),
        textTertiary: Color(hex: 0x5C6870),
        accent: Color(hex: 0x0F7A8A),
        accentText: Color(hex: 0x0F6573),
        accentMuted: Color(hex: 0xE2F1F3),
        onAccent: .white,
        hairline: .black.opacity(0.08),
        controlBorder: Color(hex: 0x74838D),
        scrim: Color(hex: 0x1B2328),
        danger: Color(hex: 0xB23A31),
        success: Color(hex: 0x2F7D55),
        isDark: false)

    static let oled = HearthPalette(
        background: .black,
        surface: Color(hex: 0x0B0D0E),
        surfaceSunken: .black,
        textPrimary: Color(hex: 0xE6EBEE),
        textSecondary: Color(hex: 0xAEB8BE),
        textTertiary: Color(hex: 0x939EA5),
        accent: Color(hex: 0x4FC1C9),
        accentText: Color(hex: 0x7FD3D9),
        accentMuted: Color(hex: 0x173238),
        onAccent: Color(hex: 0x0B1F22),
        hairline: .white.opacity(0.09),
        controlBorder: Color(hex: 0x71818A),
        scrim: .black,
        danger: Color(hex: 0xEE8277),
        success: Color(hex: 0x6CC79A),
        isDark: true)

    static func resolve(_ mode: HearthMode, systemDark: Bool, oled: Bool) -> HearthPalette {
        switch mode {
        case .system: systemDark ? (oled ? .oled : .ink) : .paper
        case .ink: oled ? .oled : .ink
        case .paper: .paper
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255)
    }
}
