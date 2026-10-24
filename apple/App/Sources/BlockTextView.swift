// The text of one note block. SwiftUI's TextField can't tell the editor
// where Enter was pressed or that Backspace was pressed in an empty field,
// and the block editor needs both (Notes.tsx), so this wraps UITextView and
// NSTextView.

import SwiftUI

struct BlockTextView {
    enum Style { case heading, body, quote }
    /// Where to put the cursor when the block takes focus.
    enum Caret: Equatable { case start, end }

    var text: String
    var style: Style = .body
    var dimmed = false
    var placeholder = ""
    var focus: Caret?
    var onFocused: () -> Void = {}
    var onChange: (String) -> Void
    /// Enter at a UTF-16 range; nil lets Enter insert a line break.
    var onEnter: ((NSRange) -> Void)?
    var onDeleteEmpty: () -> Void = {}
    /// Escape; returns whether it was handled.
    var onEscape: () -> Bool = { false }

    final class Coordinator: NSObject {
        var parent: BlockTextView
        init(_ parent: BlockTextView) { self.parent = parent }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    fileprivate var size: CGFloat { style == .heading ? 18 : 15 }
    fileprivate var fontName: String { style == .heading ? "Mulish-ExtraBold" : "Mulish-Regular" }
}

extension BlockTextView: View {
    var body: some View {
        Platform(view: self)
            .overlay(alignment: .topLeading) {
                if text.isEmpty && !placeholder.isEmpty {
                    Text(placeholder)
                        .font(style == .heading ? Theme.body(.heavy, size: 18) : Theme.body())
                        .foregroundStyle(.tertiary)
                        .allowsHitTesting(false)
                }
            }
            .padding(.leading, style == .quote ? 10 : 0)
            .overlay(alignment: .leading) {
                if style == .quote { Rectangle().fill(Theme.mist).frame(width: 3) }
            }
    }
}

#if canImport(UIKit)
import UIKit

final class BlockUITextView: UITextView {
    var onDeleteEmpty: () -> Void = {}
    override func deleteBackward() {
        if text.isEmpty { onDeleteEmpty() } else { super.deleteBackward() }
    }
}

private struct Platform: UIViewRepresentable {
    let view: BlockTextView

    func makeCoordinator() -> BlockTextView.Coordinator { view.makeCoordinator() }

    func makeUIView(context: Context) -> BlockUITextView {
        let tv = BlockUITextView()
        tv.delegate = context.coordinator
        tv.isScrollEnabled = false
        tv.backgroundColor = .clear
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        tv.adjustsFontForContentSizeCategory = true
        tv.setContentHuggingPriority(.defaultLow, for: .horizontal)
        tv.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return tv
    }

    func updateUIView(_ tv: BlockUITextView, context: Context) {
        context.coordinator.parent = view
        tv.onDeleteEmpty = { context.coordinator.parent.onDeleteEmpty() }
        let base = UIFont(name: view.fontName, size: view.size) ?? .systemFont(ofSize: view.size)
        tv.font = UIFontMetrics(forTextStyle: view.style == .heading ? .headline : .body).scaledFont(for: base)
        tv.textColor = view.dimmed || view.style == .quote ? .secondaryLabel : .label
        if tv.text != view.text && tv.markedTextRange == nil { tv.text = view.text }
        if let caret = view.focus {
            DispatchQueue.main.async {
                tv.becomeFirstResponder()
                let at = caret == .start ? 0 : (tv.text as NSString).length
                tv.selectedRange = NSRange(location: at, length: 0)
                view.onFocused()
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView tv: BlockUITextView, context: Context) -> CGSize? {
        let w = proposal.width ?? 320
        let h = tv.sizeThatFits(CGSize(width: w, height: .greatestFiniteMagnitude)).height
        return CGSize(width: w, height: max(h, tv.font?.lineHeight ?? 20))
    }
}

extension BlockTextView.Coordinator: UITextViewDelegate {
    func textView(_ tv: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        if text == "\n", let enter = parent.onEnter { enter(range); return false }
        return true
    }

    func textViewDidChange(_ tv: UITextView) { parent.onChange(tv.text) }
}

#else
import AppKit

private struct Platform: NSViewRepresentable {
    let view: BlockTextView

    func makeCoordinator() -> BlockTextView.Coordinator { view.makeCoordinator() }

    func makeNSView(context: Context) -> NSTextView {
        let tv = NSTextView()
        tv.delegate = context.coordinator
        tv.isRichText = false
        tv.allowsUndo = true
        tv.drawsBackground = false
        tv.textContainerInset = .zero
        tv.textContainer?.lineFragmentPadding = 0
        tv.textContainer?.widthTracksTextView = true
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return tv
    }

    func updateNSView(_ tv: NSTextView, context: Context) {
        context.coordinator.parent = view
        tv.font = NSFont(name: view.fontName, size: view.size) ?? .systemFont(ofSize: view.size)
        tv.textColor = view.dimmed || view.style == .quote ? .secondaryLabelColor : .labelColor
        if tv.string != view.text && !tv.hasMarkedText() { tv.string = view.text }
        if let caret = view.focus {
            DispatchQueue.main.async {
                tv.window?.makeFirstResponder(tv)
                tv.setSelectedRange(NSRange(location: caret == .start ? 0 : (tv.string as NSString).length, length: 0))
                view.onFocused()
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView tv: NSTextView, context: Context) -> CGSize? {
        let w = proposal.width ?? 320
        guard let container = tv.textContainer, let layout = tv.layoutManager else { return nil }
        container.containerSize = NSSize(width: w, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let line = layout.defaultLineHeight(for: tv.font ?? .systemFont(ofSize: 15))
        return CGSize(width: w, height: max(ceil(layout.usedRect(for: container).height), line))
    }
}

extension BlockTextView.Coordinator: NSTextViewDelegate {
    func textView(_ tv: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.insertNewline(_:)):
            guard let enter = parent.onEnter else { return false }
            enter(tv.selectedRange())
            return true
        case #selector(NSResponder.deleteBackward(_:)) where tv.string.isEmpty:
            parent.onDeleteEmpty()
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            return parent.onEscape()
        default:
            return false
        }
    }

    func textDidChange(_ n: Notification) {
        if let tv = n.object as? NSTextView { parent.onChange(tv.string) }
    }
}
#endif
