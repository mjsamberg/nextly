// What the app shows and where: the open list, the selected task, search,
// the undo toast. Data changes go through `store` (NextlyKit's LocalStore),
// which runs the shared rules; `sync` keeps it in step with the server.
// Mirrors app/src/App.tsx and main.tsx.

import NextlyKit
import Observation
import SwiftUI

@MainActor
@Observable
final class AppModel {
    let store: LocalStore
    let sync: SyncClient
    /// Settings and a snapshot for the widgets and Siri (AppleShare.swift).
    let share: AppleShare

    /// The open list. Nil on a phone means the list of lists is showing.
    var list: ListView? = .today
    var selectedTaskId: String?
    var query = "" {
        didSet { if !query.isEmpty && list != .search { list = .search } }
    }
    var showSettings = false
    var toast: Toast?

    /// Set to focus the quick add field (⌘N) or search (⌘K).
    var focusQuickAdd = 0
    var focusSearch = 0

    struct Toast: Identifiable {
        let id = UUID()
        var text: String
        var undo: (() -> Void)?
    }

    /// The database fails to open only if the disk is full or the folder is unwritable.
    var fatal: String?

    init() {
        let store: LocalStore
        do {
            store = try LocalStore(url: Self.databaseURL())
        } catch {
            // Keep the app usable enough to say what's wrong.
            store = try! LocalStore(url: FileManager.default.temporaryDirectory.appendingPathComponent("nextly-\(UUID().uuidString).sqlite"))
            fatal = "Nextly couldn’t open its local database: \(error.localizedDescription)"
        }
        self.store = store
        sync = SyncClient(store: store)
        share = AppleShare(store: store)
    }

    /// Application Support, separate from the Tauri app's data. The widgets
    /// don't read it; they get settings and a snapshot through AppleShare.
    private static func databaseURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Nextly Native", isDirectory: true).appendingPathComponent("nextly.sqlite")
    }

    var view: ViewData { store.view }
    var selectedTask: TaskItem? { selectedTaskId.flatMap { view.task($0) } }

    // MARK: - Starting up

    private var started = false
    private var dailyTimer: Timer?

    func start() {
        guard !started else { return }
        started = true
        sync.onSynced = { [weak self] in self?.dailyCheck() }
        sync.onSettings = { [weak self] s, urls in self?.share.settingsChanged(s, urls) }
        sync.start()
        share.importPending()
        watchStore()
        dailyCheck()
        dailyTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.dailyCheck() }
        }
    }

    /// Tasks with a start date move into Today on that day: at launch, after
    /// each sync, when the app comes back, and every minute. Not before this
    /// device has synced since launch: moving a stale copy would undo newer
    /// edits from other devices (spec/protocol.md).
    func dailyCheck() {
        if sync.inStep { store.promoteDue() }
    }

    /// Every change, local or synced, refreshes the widgets' snapshot.
    private func watchStore() {
        withObservationTracking { _ = store.version } onChange: { [weak self] in
            Task { @MainActor in
                self?.share.shareSoon()
                self?.watchStore()
            }
        }
    }

    /// The app came back to the front.
    func becameActive() {
        share.importPending()
        dailyCheck()
        Task { await sync.syncNow() }
    }

    // MARK: - nextly:// links

    /// nextly://add?title=…&url=…&list=…&note=… (the Gmail bookmarklet; any web
    /// page can open these, so they only ever add a task, through
    /// Logic.parseCaptureLink), and the widgets' nextly://open/<task id> and
    /// nextly://list/<today|next>.
    func handle(_ url: URL) {
        guard url.scheme == "nextly" else { return }
        let parts = ([url.host ?? ""] + url.pathComponents.filter { $0 != "/" }).filter { !$0.isEmpty }
        switch parts.first {
        case "open":
            guard parts.count > 1, let t = view.task(parts[1]) else { return }
            list = listFor(t)
            selectedTaskId = t.id
        case "list":
            if parts.count > 1, let l = ListView(name: parts[1]) { go(l) }
        default:
            guard let c = Logic.parseCaptureLink(url.absoluteString) else { return }
            var notes: [JSONValue] = []
            if !c.note.isEmpty { notes.append(Block(id: Logic.uid(), type: .paragraph, text: c.note).json) }
            if let mail = c.emailUrl {
                var b = Block(id: Logic.uid(), type: .email)
                b.url = mail
                b.subject = c.title
                notes.append(b.json)
            }
            if let other = c.otherUrl { notes.append(Block(id: Logic.uid(), type: .paragraph, text: other).json) }
            let id = store.createTask(["title": .string(c.title), "flag": .string(c.flag.rawValue), "notes": .array(notes)])
            let l = ListView(name: c.flag.rawValue) ?? .inbox
            go(l)
            selectedTaskId = id
            show(Toast(text: "Added “\(c.title)” to \(Lists.viewTitle(view, l))"))
        }
    }

    /// The list a task opened from a widget shows in.
    private func listFor(_ t: TaskItem) -> ListView {
        if let f = t.flag, let l = ListView(name: f.rawValue) { return l }
        if let p = t.projectId { return .project(p) }
        return .all
    }

    // MARK: - Navigation

    func go(_ l: ListView) {
        list = l
        selectedTaskId = nil
        if l != .search { query = "" }
    }

    func open(_ id: String) { selectedTaskId = id }
    func closeDetail() { selectedTaskId = nil }

    // MARK: - Actions with feedback

    func remove(_ id: String) {
        let title = view.task(id)?.title.nonEmpty ?? "task"
        let undo = store.deleteTask(id)
        if selectedTaskId == id { selectedTaskId = nil }
        show(Toast(text: "Deleted “\(title)”", undo: undo))
    }

    func show(_ t: Toast) {
        toast = t
        let id = t.id
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if toast?.id == id { toast = nil }
        }
    }

    /// What a task added from this list starts as (TaskList.tsx defaultsFor).
    func quickAdd(_ text: String, in l: ListView) {
        let q = Logic.parseQuickAdd(text)
        guard !q.title.isEmpty || q.emailUrl != nil else { return }
        var flag: JSONValue = "inbox"
        var projectId: JSONValue = nil
        switch l {
        case .today: flag = "today"
        case .next: flag = "next"
        case .someday: flag = "someday"
        case .doing: flag = "doing"
        case .project(let id): flag = nil; projectId = .string(id)
        default: break
        }
        if let f = q.flag { flag = .string(f.rawValue) }
        var p: [String: JSONValue] = [
            "title": .string(q.title.isEmpty ? "Email" : q.title),
            "flag": flag,
            "projectId": projectId,
            "deadline": q.deadline.map(JSONValue.string) ?? nil,
            "repeat": q.repeat?.json ?? nil,
        ]
        if let url = q.emailUrl {
            p["notes"] = [["id": .string(Logic.uid()), "type": "email", "url": .string(url), "subject": .string(q.title)]]
        }
        let id = store.createTask(p)
        // @date: waits in Scheduled (or goes straight to Today if it's today or past).
        if let start = q.startOn { store.setStartOn(id, start) }
    }
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
