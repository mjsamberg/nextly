// Block editor: a note is a list of blocks, like a blog post (Notes.tsx).
// Enter makes a new block, Backspace on an empty block removes it, and "/"
// in an empty text block opens the block menu. Attaching shows the
// district's student-information warning first.

import NextlyKit
import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

struct NotesSection: View {
    let model: AppModel
    let task: TaskItem

    @State private var focus: (id: String, caret: BlockTextView.Caret)?
    @State private var menuFor: String?
    @State private var emailAt: Int?
    let files: NoteAttachments

    private var store: LocalStore { model.store }
    /// The store's current notes, not the copy from the last render: keystrokes
    /// can arrive before SwiftUI redraws after a split.
    private var blocks: [Block] { model.view.task(task.id)?.notes ?? task.notes }

    static let menu: [(type: BlockType, label: String, icon: String)] = [
        (.heading, "Heading", "textformat.size"),
        (.paragraph, "Text", "text.alignleft"),
        (.checklist, "Checklist", "checklist"),
        (.quote, "Quote", "text.quote"),
        (.divider, "Divider", "minus"),
        (.image, "Image", "photo"),
        (.file, "File", "paperclip"),
        (.email, "Email", "envelope"),
    ]

    var body: some View {
        Section("Notes") {
            if blocks.isEmpty {
                Button("Write notes, paste links, or add files and emails…") { choose(.paragraph, at: 0) }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(blocks.enumerated()), id: \.element.id) { i, b in
                blockRow(b, i)
            }
            if let attach = files.attach { attachRow(attach.type) } else if blocks.contains(where: { $0.type == .image || $0.type == .file }) {
                StudentInfoNote()
            }
            if let emailAt { EmailForm(onCancel: { self.emailAt = nil }) { url, subject in insert(emailBlock(url, subject), at: emailAt); self.emailAt = nil } }
            if let error = files.error { Text(error).font(Theme.small).foregroundStyle(Theme.danger) }
            addBar
        }
    }

    // MARK: - Saving

    private func save(_ next: [Block]) { store.setNotes(task.id, next) }
    private func patch(_ id: String, _ change: (inout Block) -> Void) {
        save(blocks.map { b in var b = b; if b.id == id { change(&b) }; return b })
    }
    private func insert(_ b: Block, at: Int) {
        var next = blocks
        next.insert(b, at: min(at, next.count))
        save(next)
        focus = (b.id, .start)
    }
    private func remove(_ id: String) { save(blocks.filter { $0.id != id }) }

    private func textBlock(_ type: BlockType, _ text: String = "") -> Block {
        Block(id: Logic.uid(), type: type, text: text, checked: type == .checklist ? false : nil)
    }

    private func emailBlock(_ url: String, _ subject: String) -> Block {
        var b = Block(id: Logic.uid(), type: .email)
        b.url = url
        b.subject = subject
        return b
    }

    /// A choice from the add-block bar (at the end) or the "/" menu (replacing that block).
    private func choose(_ type: BlockType, at: Int, replacing: String? = nil) {
        menuFor = nil
        let pos = replacing.flatMap { id in blocks.firstIndex { $0.id == id } } ?? at
        var rest = blocks
        if let replacing { rest.removeAll { $0.id == replacing } }
        switch type {
        case .image, .file:
            if replacing != nil { save(rest) }
            files.attach = (type, pos)
        case .email:
            if replacing != nil { save(rest) }
            emailAt = pos
        default:
            let b = textBlock(type)
            rest.insert(b, at: min(pos, rest.count))
            save(rest)
            focus = (b.id, .start)
        }
    }

    // MARK: - Keys

    private func enter(_ id: String, _ range: NSRange) {
        guard menuFor != id, let i = blocks.firstIndex(where: { $0.id == id }) else { return }
        let b = blocks[i]
        let text = b.text ?? ""
        // Enter on an empty checklist item ends the list.
        if b.type == .checklist && text.isEmpty {
            patch(b.id) { $0.type = .paragraph; $0.checked = nil }
            return
        }
        let ns = text as NSString
        let loc = min(range.location, ns.length)
        var cur = b
        cur.text = ns.substring(to: loc)
        let nb = textBlock(b.type == .checklist ? .checklist : .paragraph, ns.substring(from: min(loc + range.length, ns.length)))
        var next = blocks
        next[i] = cur
        next.insert(nb, at: i + 1)
        save(next)
        focus = (nb.id, .start)
    }

    private func deleteEmpty(_ id: String) {
        guard let i = blocks.firstIndex(where: { $0.id == id }) else { return }
        let prev = i > 0 ? blocks[i - 1].id : nil
        remove(id)
        if let prev { focus = (prev, .end) }
    }

    // MARK: - Rows

    @ViewBuilder private func blockRow(_ b: Block, _ i: Int) -> some View {
        switch b.type {
        case .heading, .paragraph, .checklist, .quote:
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 8) {
                    if b.type == .checklist {
                        Button { patch(b.id) { $0.checked = !($0.checked ?? false) } } label: {
                            Image(systemName: b.checked == true ? "checkmark.square.fill" : "square")
                                .foregroundStyle(b.checked == true ? Theme.plum : .secondary)
                                #if os(iOS)
                                .frame(minWidth: 32, minHeight: 32)
                                .padding(.vertical, -6) // centered on the first line, still a 32pt target
                                #endif
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Toggle item")
                    }
                    textView(b)
                }
                if menuFor == b.id { slashMenu(b, i) }
            }
        case .divider:
            removable(b) { Rectangle().fill(.quaternary).frame(height: 1).frame(maxWidth: .infinity).padding(.vertical, 6) }
        case .image:
            removable(b) { ImageBlockView(model: model, b: b) }
        case .file:
            removable(b) { FileCard(b: b) { files.open(b) } }
        case .email:
            removable(b) { emailCard(b) }
        }
    }

    private func textView(_ b: Block) -> some View {
        BlockTextView(
            text: b.text ?? "",
            style: b.type == .heading ? .heading : b.type == .quote ? .quote : .body,
            dimmed: b.type == .checklist && b.checked == true,
            placeholder: b.type == .heading ? "Heading" : b.type == .paragraph && blocks.count == 1 ? "Type / for blocks" : "",
            focus: focus?.id == b.id ? focus?.caret : nil,
            onFocused: { if focus?.id == b.id { focus = nil } },
            onChange: { text in
                patch(b.id) { $0.text = text }
                menuFor = text == "/" && b.type == .paragraph ? b.id : nil
            },
            onEnter: b.type == .quote ? nil : { enter(b.id, $0) },
            onDeleteEmpty: { deleteEmpty(b.id) },
            onEscape: { if menuFor != nil { menuFor = nil; return true }; return false }
        )
    }

    private func slashMenu(_ b: Block, _ i: Int) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Self.menu, id: \.label) { m in
                Button { choose(m.type, at: i, replacing: b.id) } label: {
                    Label(m.label, systemImage: m.icon)
                        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
    }

    private func removable(_ b: Block, @ViewBuilder _ content: () -> some View) -> some View {
        HStack(alignment: .center, spacing: 6) {
            content()
            Button { remove(b.id) } label: {
                Image(systemName: "xmark").foregroundStyle(.secondary)
                    #if os(iOS)
                    .frame(minWidth: 44, minHeight: 44)
                    #endif
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Remove block")
        }
    }

    private func emailCard(_ b: Block) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "envelope").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                TextField("Email subject", text: Binding(get: { b.subject ?? "" }, set: { s in patch(b.id) { $0.subject = s } }))
                    .font(Theme.body(.bold))
                    .textFieldStyle(.plain)
                if let u = b.url, let url = URL(string: u) {
                    Link(u.hasPrefix("message:") ? "Open in Mail \u{2197}\u{FE0E}" : "Open in Gmail \u{2197}\u{FE0E}", destination: url)
                        .font(Theme.small)
                        .buttonStyle(.borderless)
                }
            }
        }
        .padding(.leading, 8)
        .overlay(alignment: .leading) { Rectangle().fill(Theme.navy).frame(width: 3) }
    }

    // MARK: - Adding blocks and files

    private var addBar: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 4), spacing: 4) {
            ForEach(Self.menu, id: \.label) { m in
                Button { choose(m.type, at: blocks.count) } label: {
                    VStack(spacing: 2) {
                        Image(systemName: m.icon)
                        Text(m.label).font(Theme.body(size: 10, relativeTo: .caption2))
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .help(m.label)
            }
        }
        .accessibilityLabel("Add block")
    }

    private func attachRow(_ type: BlockType) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            StudentInfoNote()
            HStack {
                Spacer()
                Button("Cancel") { files.attach = nil }
                Button(type == .image ? "Choose an image…" : "Choose files…") {
                    if type == .image { files.showPhotos = true } else { files.showFiles = true }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.navy)
            }
            .buttonStyle(.bordered)
        }
    }

}

/// Picking, storing and opening attachments. The detail view owns it and
/// its Form presents the pickers and Quick Look: Form rows scrolled off
/// screen aren't drawn, so a picker attached to one would never open.
@MainActor
@Observable
final class NoteAttachments {
    let model: AppModel
    let taskId: String
    /// The attach panel (with the student-information warning) is open for this kind, inserting at `at`.
    var attach: (type: BlockType, at: Int)?
    var error: String?
    var showPhotos = false
    var showFiles = false
    var photoItems: [PhotosPickerItem] = []
    var preview: URL?

    init(model: AppModel, taskId: String) { self.model = model; self.taskId = taskId }

    private var blocks: [Block] { model.view.task(taskId)?.notes ?? [] }
    private func save(_ next: [Block]) { model.store.setNotes(taskId, next) }

    private func addBlocks(_ added: [Block]) {
        guard !added.isEmpty else { return }
        var next = blocks
        next.insert(contentsOf: added, at: min(attach?.at ?? next.count, next.count))
        save(next)
        attach = nil
    }

    private func fileBlock(_ bytes: Data, name: String, mime: String?, image: Bool) -> Block {
        let meta = model.sync.addFile(bytes, name: name, mime: mime)
        var b = Block(id: Logic.uid(), type: image || meta.mime.hasPrefix("image/") ? .image : .file)
        b.sha = meta.sha
        b.name = meta.name
        b.size = Double(meta.size)
        b.mime = meta.mime
        return b
    }

    func addPhotos(_ items: [PhotosPickerItem]) async {
        error = nil
        var added: [Block] = []
        let stamp = Date().formatted(.iso8601.year().month().day().dateSeparator(.dash))
        for (n, item) in items.enumerated() {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                let type = item.supportedContentTypes.first ?? .jpeg
                let suffix = items.count > 1 ? " \(n + 1)" : ""
                // HEIC and other camera formats become JPEG so every device can show them.
                if [UTType.jpeg, .png, .gif].contains(type) {
                    added.append(fileBlock(data, name: "Image \(stamp)\(suffix).\(type.preferredFilenameExtension ?? "jpg")", mime: type.preferredMIMEType, image: true))
                } else if let jpeg = PlatformImage.jpeg(data) {
                    added.append(fileBlock(jpeg, name: "Image \(stamp)\(suffix).jpg", mime: "image/jpeg", image: true))
                } else {
                    added.append(fileBlock(data, name: "Image \(stamp)\(suffix).\(type.preferredFilenameExtension ?? "img")", mime: type.preferredMIMEType, image: true))
                }
            } catch {
                self.error = "Couldn’t add the file: \(error.localizedDescription)"
            }
        }
        addBlocks(added)
    }

    func addFiles(_ result: Result<[URL], Error>) {
        error = nil
        do {
            var added: [Block] = []
            for url in try result.get() {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let data = try Data(contentsOf: url)
                added.append(fileBlock(data, name: url.lastPathComponent, mime: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType, image: false))
            }
            addBlocks(added)
        } catch {
            self.error = "Couldn’t add the file: \(error.localizedDescription)"
        }
    }

    /// Quick Look from the local copy (downloading it once if needed), or the server's signed link.
    func open(_ b: Block) {
        guard let sha = b.sha else { return }
        let name = b.name?.nonEmpty ?? "file"
        let mime = b.mime ?? "application/octet-stream"
        Task {
            error = nil
            if let data = await model.sync.loadFile(sha, name: name, mime: mime) {
                let dir = FileManager.default.temporaryDirectory.appendingPathComponent("Attachments/\(sha)", isDirectory: true)
                let url = dir.appendingPathComponent(name)
                do {
                    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    if !FileManager.default.fileExists(atPath: url.path) { try data.write(to: url) }
                    preview = url
                    return
                } catch {}
            }
            do {
                let link = try await model.sync.fileLink(sha, name: name, mime: mime)
                if let url = URL(string: link) { openExternally(url) }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func openExternally(_ url: URL) {
        #if canImport(UIKit)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }
}

extension View {
    /// The photo picker, file importer and Quick Look for a task's notes.
    func noteAttachments(_ files: NoteAttachments) -> some View {
        @Bindable var files = files
        return self
            .photosPicker(isPresented: $files.showPhotos, selection: $files.photoItems, matching: .images)
            .onChange(of: files.photoItems) { _, items in
                guard !items.isEmpty else { return }
                files.photoItems = []
                Task { await files.addPhotos(items) }
            }
            .fileImporter(isPresented: $files.showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { files.addFiles($0) }
            .quickLookPreview($files.preview)
    }
}

/// District policy: a warning wherever files can be attached.
struct StudentInfoNote: View {
    var body: some View {
        WarnNote(title: "Student information.", text: "Don’t attach files with more than directory information about students, such as grades, IEP or 504 details, or health records. Attachments are stored on your Nextly server and devices.")
    }
}

struct ImageBlockView: View {
    let model: AppModel
    let b: Block
    @State private var image: Image?
    @State private var missing = false

    var body: some View {
        Group {
            if let image {
                image.resizable().scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 360)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .accessibilityLabel(b.name ?? "Image")
            } else if missing {
                Text("\(b.name ?? "Image"): not downloaded yet. It will appear once this device syncs.")
                    .font(Theme.small).foregroundStyle(.secondary)
            } else {
                Text("Loading \(b.name ?? "image")…").font(Theme.small).foregroundStyle(.secondary)
            }
        }
        .task(id: b.sha) {
            guard let sha = b.sha else { missing = true; return }
            let data = await model.sync.loadFile(sha, name: b.name ?? "", mime: b.mime ?? "application/octet-stream")
            if let img = data.flatMap(PlatformImage.image) { image = img } else { missing = true }
        }
    }
}

struct FileCard: View {
    let b: Block
    var open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                Image(systemName: "doc").foregroundStyle(.secondary)
                Text(b.name ?? "File").lineLimit(1).truncationMode(.middle)
                Spacer()
                Text(formatSize(b.size ?? 0)).font(Theme.small).foregroundStyle(.secondary)
            }
            .frame(minHeight: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.primary)
    }

    private func formatSize(_ n: Double) -> String {
        n < 1024 ? "\(Int(n)) B" : n < 1_048_576 ? "\(Int((n / 1024).rounded())) KB" : String(format: "%.1f MB", n / 1_048_576)
    }
}

struct EmailForm: View {
    var onCancel: () -> Void
    var onAdd: (String, String) -> Void
    @State private var url = ""
    @State private var subject = ""

    private var trimmed: String { url.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var valid: Bool { trimmed.hasPrefix("https://mail.google.com/") || trimmed.hasPrefix("message:") }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Gmail link").font(Theme.section).foregroundStyle(.secondary)
            TextField("https://mail.google.com/mail/u/0/#inbox/…", text: $url)
                .textFieldStyle(.roundedBorder)
                #if os(iOS)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                #endif
                .autocorrectionDisabled()
            Text("Subject").font(Theme.section).foregroundStyle(.secondary)
            TextField("What the email is about", text: $subject)
                .textFieldStyle(.roundedBorder)
            if !url.isEmpty && !valid {
                Text("Paste the address of an open Gmail message. It starts with https://mail.google.com/.")
                    .font(Theme.small).foregroundStyle(Theme.danger)
            }
            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                Button("Add email") { onAdd(trimmed, subject.trimmingCharacters(in: .whitespacesAndNewlines)) }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.navy)
                    .disabled(!valid)
            }
            .buttonStyle(.bordered)
        }
    }
}

/// Images from bytes on either platform.
enum PlatformImage {
    #if canImport(UIKit)
    static func image(_ data: Data) -> Image? { UIImage(data: data).map(Image.init(uiImage:)) }
    static func jpeg(_ data: Data) -> Data? { UIImage(data: data)?.jpegData(compressionQuality: 0.85) }
    #else
    static func image(_ data: Data) -> Image? { NSImage(data: data).map(Image.init(nsImage:)) }
    static func jpeg(_ data: Data) -> Data? {
        guard let rep = NSImage(data: data)?.tiffRepresentation.flatMap(NSBitmapImageRep.init) else { return nil }
        return rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
    }
    #endif
}
