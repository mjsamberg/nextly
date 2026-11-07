// Dropping emails on the window: a message dragged from Mail (or a Gmail
// message's link dragged from a browser) becomes an Inbox task with an email
// card, as the Gmail bookmarklet's nextly://add link does.
//
// Mail puts each dragged message on the pasteboard as its own item, with
// `public.url` set to the message's link (message:%3C<Message-ID>%3E) and
// `public.url-name` to its subject. Only those two are read, never the
// message itself. Each goes through Logic.parseCaptureLink, the same checks
// and limits as a link from the bookmarklet, and anything that isn't an email
// link is ignored.

#if os(macOS)
import AppKit
#endif
import Foundation
import NextlyKit
import UniformTypeIdentifiers

extension AppModel {
    /// What the window accepts. Task drags carry only `.nextlyTask`, so they aren't caught here.
    static let mailDropTypes: [UTType] = [.url]

    /// Adds a task for each dropped email. Returns false (the drag snaps back)
    /// when nothing dropped is a link.
    func dropEmails(_ providers: [NSItemProvider]) -> Bool {
        #if os(macOS)
        // SwiftUI's item providers for a Mail drag come with no types at all,
        // so read the drag pasteboard, which has them while the drop is handled.
        let items = NSPasteboard(name: .drag).pasteboardItems ?? []
        let dropped = items.compactMap { item -> (url: String, subject: String)? in
            guard let url = item.string(forType: .URL) else { return nil }
            let name = item.string(forType: NSPasteboard.PasteboardType("public.url-name")) ?? ""
            return (url, name == url ? "" : name)
        }
        guard !dropped.isEmpty else { return false }
        addEmails(dropped.compactMap { Self.emailCapture(url: $0.url, subject: $0.subject) })
        return true
        #else
        let links = providers.filter { $0.canLoadObject(ofClass: URL.self) }
        guard !links.isEmpty else { return false }
        Task { @MainActor in
            var captures: [Logic.Capture] = []
            for p in links {
                guard let url = await p.url() else { continue }
                if let c = Self.emailCapture(url: url.absoluteString, subject: p.suggestedName ?? "") { captures.append(c) }
            }
            addEmails(captures)
        }
        return true
        #endif
    }

    /// The task a dropped email makes, or nil if `url` isn't a Mail or Gmail link.
    /// Built as the bookmarklet's link would be, so it is read the same way.
    nonisolated static func emailCapture(url: String, subject: String) -> Logic.Capture? {
        // Form encoding: "+" and "&" in a Message-ID must stay literal.
        let plain = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: plain) ?? "" }
        let link = "nextly://add?title=\(enc(subject))&url=\(enc(url.trimmingCharacters(in: .whitespacesAndNewlines)))"
        guard let c = Logic.parseCaptureLink(link), c.emailUrl != nil else { return nil }
        return c
    }

    private func addEmails(_ captures: [Logic.Capture]) {
        switch captures.count {
        case 0:
            show(Toast(text: "Only emails from Mail or Gmail can be dropped here."))
        case 1:
            add(captures[0])
        default:
            for c in captures { add(c, open: false) }
            go(.inbox)
            show(Toast(text: "Added \(captures.count) emails to \(Lists.viewTitle(view, .inbox))"))
        }
    }
}

#if !os(macOS)
private extension NSItemProvider {
    func url() async -> URL? {
        await withCheckedContinuation { done in
            _ = loadObject(ofClass: URL.self) { url, _ in done.resume(returning: url) }
        }
    }
}
#endif
