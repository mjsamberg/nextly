// Renders brand/icon.svg (the app icon source) to the native app's
// icons: a full-bleed square for iOS (the system rounds it) and the macOS
// grid (824px tile centered in 1024). Run after changing the SVG:
//
//   swift apple/scripts/render-icons.swift brand/icon.svg apple/App/Assets.xcassets/AppIcon.appiconset
import AppKit
let args = CommandLine.arguments
let svg = NSImage(contentsOfFile: args[1])!
func render(_ size: Int, inset: CGFloat, flatten: Bool, to path: String) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(size)
    if flatten {
        // iOS: no transparency; the tile's own plum fills the corners.
        NSColor(srgbRed: 0x7a/255, green: 0x3c/255, blue: 0x59/255, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: s, height: s).fill()
    }
    svg.draw(in: NSRect(x: s * inset, y: s * inset, width: s * (1 - 2 * inset), height: s * (1 - 2 * inset)))
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}
let out = args[2]
render(1024, inset: 0, flatten: true, to: "\(out)/ios-1024.png")
for px in [16, 32, 64, 128, 256, 512, 1024] {
    render(px, inset: 100.0 / 1024.0, flatten: false, to: "\(out)/mac-\(px).png")
}
