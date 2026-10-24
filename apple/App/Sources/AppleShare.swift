// Keeps the widget and Siri extensions supplied (a port of app/src/apple.ts).
// They read the sync settings from the App Group folder and talk to the
// server themselves; the snapshot here is their fallback when the server
// can't be reached, and is refreshed on every change so widgets update right
// away. Tasks Siri saved while offline come back through pending.json.
//
// The extensions' code (apple/Shared, Widgets, Intents) is the same one the
// Tauri builds embed, so both apps share one widget and Siri implementation
// until the Tauri Mac and iOS builds retire (docs/parity.md).

import Foundation
import NextlyKit
import Observation
import WidgetKit

@MainActor
@Observable
final class AppleShare {
    enum State: Equatable { case off, ok(Date), noGroup, error(String) }

    private(set) var state = State.off
    @ObservationIgnored private var settings = SyncSettings()
    @ObservationIgnored private var urls: [String] = []
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private let store: LocalStore

    init(store: LocalStore) { self.store = store }

    func settingsChanged(_ s: SyncSettings, _ urls: [String]) {
        settings = s
        self.urls = urls
        shareSoon()
    }

    /// Shares 1.5 s after the last change, like the Tauri app.
    func shareSoon() {
        timer?.cancel()
        timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if Task.isCancelled { return }
            self?.share()
        }
    }

    private func share() {
        guard let folder = AppGroup.folder else {
            state = .noGroup
            return
        }
        do {
            // "url" stays for extensions built before "urls".
            var url = settings.url
            while url.hasSuffix("/") { url.removeLast() }
            let config = SyncConfig(url: url, urls: urls, token: settings.token, headers: Logic.headerObject(settings.headers))
            try write(config, "config.json", in: folder)
            try write(snapshot(), "snapshot.json", in: folder)
            WidgetCenter.shared.reloadAllTimelines()
            state = .ok(Date())
        } catch {
            state = .error("\(error.localizedDescription) (App Group \(AppGroup.id))")
        }
    }

    private func write<T: Encodable>(_ value: T, _ name: String, in folder: URL) throws {
        try JSONEncoder().encode(value).write(to: folder.appendingPathComponent(name), options: .atomic)
    }

    /// In Progress, Today and Next, at most 12 each, as the widgets read them.
    private func snapshot() -> WidgetData {
        let v = store.view
        func item(_ t: TaskItem) -> WidgetTask {
            WidgetTask(
                id: t.id,
                title: t.title.isEmpty ? "Untitled task" : t.title,
                flag: t.flag?.rawValue,
                deadline: t.deadline,
                blocked: !v.blockers(t).isEmpty,
                project: v.project(t.projectId)?.title ?? t.parentId.flatMap { v.task($0)?.title }
            )
        }
        let doing = Lists.tasksFor(v, .doing), today = Lists.tasksFor(v, .today), next = Lists.tasksFor(v, .next)
        return WidgetData(
            today: today.prefix(12).map(item),
            next: next.prefix(12).map(item),
            counts: WidgetCounts(today: today.count, next: next.count, inbox: Lists.tasksFor(v, .inbox).count, doing: doing.count),
            updatedAt: ISO8601DateFormatter().string(from: Date()),
            doing: doing.prefix(12).map(item)
        )
    }

    /// Adds tasks Siri saved while the server couldn't be reached, then clears them.
    func importPending() {
        guard let folder = AppGroup.folder else { return }
        let file = folder.appendingPathComponent("pending.json")
        guard let data = try? Data(contentsOf: file) else { return }
        try? FileManager.default.removeItem(at: file)
        let items = (try? JSONDecoder().decode([PendingTask].self, from: data)) ?? []
        for p in items {
            let title = p.title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { continue }
            let flag = ["doing", "today", "next", "someday"].contains(p.list) ? p.list : "inbox"
            store.createTask(["title": .string(title), "flag": .string(flag), "createdAt": .string(p.createdAt)])
        }
    }

    /// For Settings.
    var line: (state: String, text: String) {
        switch state {
        case .ok(let at):
            ("idle", "Widget and Siri: settings shared at \(at.formatted(date: .omitted, time: .shortened)). A widget showing “set up sync” picks them up within a few minutes, or remove and re-add it.")
        case .off:
            ("off", "Widget and Siri: waiting to share settings…")
        case .noGroup:
            ("error", "Widget and Siri can’t see your settings: this build has no App Group folder (\(AppGroup.id)).")
        case .error(let m):
            ("error", "Widget and Siri can’t see your settings: \(m)")
        }
    }
}
