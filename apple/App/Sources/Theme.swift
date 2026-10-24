// Chatham County Schools branding (CLAUDE.md): plum, navy, gold and mist;
// Oswald for headings (the fallback for Zing Rust, which isn't licensed for
// bundling) and Mulish for body text. Both fonts are SIL OFL and come from
// the same @fontsource packages as the Tauri app (apple/scripts/woff-to-ttf.py).

import CoreText
import SwiftUI

enum Theme {
    static let plum = Color(light: 0x7A3C59, dark: 0xC98DAA)
    static let navy = Color(light: 0x134169, dark: 0x8FB4DA)
    static let gold = Color(light: 0xFFB600, dark: 0xFFC633)
    static let mist = Color(light: 0xD2D8E6, dark: 0x3A3F4B)
    /// In Progress, as in the widgets.
    static let teal = Color(light: 0x0F7B7B, dark: 0x5CC8C8)
    static let danger = Color(light: 0xB3261E, dark: 0xF2B8B5)

    /// Registers the bundled fonts once, before the first view draws.
    static func registerFonts() {
        for name in ["oswald-latin-500", "oswald-latin-600", "mulish-latin-400", "mulish-latin-600", "mulish-latin-700", "mulish-latin-800"] {
            guard let url = Bundle.main.url(forResource: name, withExtension: "ttf") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    /// List and screen titles.
    static func heading(_ size: CGFloat = 28, relativeTo style: Font.TextStyle = .largeTitle) -> Font {
        .custom("Oswald-SemiBold", size: size, relativeTo: style)
    }

    /// Section labels ("In progress · 2").
    static let section = Font.custom("Oswald-Medium", size: 13, relativeTo: .footnote)

    static func body(_ weight: Font.Weight = .regular, size: CGFloat = 15, relativeTo style: Font.TextStyle = .body) -> Font {
        let name = switch weight {
        case .semibold: "Mulish-SemiBold"
        case .bold: "Mulish-Bold"
        case .heavy, .black: "Mulish-ExtraBold"
        default: "Mulish-Regular"
        }
        return .custom(name, size: size, relativeTo: style)
    }

    static let small = body(size: 12, relativeTo: .caption)
}

extension Color {
    /// A color with a light and a dark variant, as 0xRRGGBB.
    init(light: UInt32, dark: UInt32) {
        #if canImport(UIKit)
        self.init(UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgb: dark) : UIColor(rgb: light) })
        #else
        self.init(NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(rgb: dark) : NSColor(rgb: light) })
        #endif
    }
}

#if canImport(UIKit)
extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
}
#else
extension NSColor {
    convenience init(rgb: UInt32) {
        self.init(srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
}
#endif

/// A small rounded label, like the web app's flag chips.
struct Chip: View {
    var text: String
    var systemImage: String?
    var color: Color = .secondary

    var body: some View {
        HStack(spacing: 3) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small) }
            Text(text)
        }
        .font(Theme.small.weight(.semibold))
        .foregroundStyle(color)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(color.opacity(0.12), in: Capsule())
        .lineLimit(1)
    }
}

/// The plum warning box used for student-information and newer-format notes.
struct WarnNote: View {
    var title: String
    var text: String

    var body: some View {
        (Text(title + " ").font(Theme.body(.bold, size: 13)).foregroundStyle(Theme.plum) + Text(text).font(Theme.body(size: 13)))
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.plum.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.plum.opacity(0.6)))
    }
}

/// The round sync status dot, as in the sidebar footer.
struct SyncDot: View {
    var state: String

    var body: some View {
        Circle().fill(color).frame(width: 8, height: 8).accessibilityHidden(true)
    }

    private var color: Color {
        switch state {
        case "idle", "live": .green
        case "syncing", "connecting": Theme.gold
        case "error", "retrying": .red
        default: .gray
        }
    }
}
