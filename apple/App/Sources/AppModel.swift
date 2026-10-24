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
    }

    /// The App Group folder once the widgets share it (Phase 4); until then,
    /// Application Support, separate from the Tauri app's data.
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
        sync.start()
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

    /// The app came back to the front.
    func becameActive() {
        dailyCheck()
        Task { await sync.syncNow() }
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
