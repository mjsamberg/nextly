// The store's rules as pure functions: given the records, an action works on a
// Draft and leaves behind the records it changed; LocalStore saves them. A
// port of app/src/rules.ts. The shared cases in spec/fixtures hold both apps
// to the same results, so keep the two in step (spec/protocol.md).
//
// Determinism, so both apps produce the same records for the same action:
// time comes from ctx.now / ctx.today, new ids from ctx.newId (in the order
// documented at each call), and tasks are visited in id order.

import Foundation

/// What an action may use from outside: the time, the local date, and new ids.
public struct Ctx {
    public var now: Date
    /// The device's local date, YYYY-MM-DD.
    public var today: String
    public var newId: () -> String

    public init(now: Date, today: String, newId: @escaping () -> String) {
        self.now = now; self.today = today; self.newId = newId
    }

    /// The real clock and random ids.
    public static func live() -> Ctx {
        let now = Date()
        return Ctx(now: now, today: Logic.ymd(now), newId: Logic.uid)
    }

    var nowISO: String { JS.iso(now) }
    var nowMs: Double { JS.ms(now) }
}

/// A record an action changed, before it's stamped and saved.
public struct Change: Hashable, Sendable {
    public var kind: String
    public var id: String
    public var data: JSONValue
    public var deleted: Bool
}

/// A record this app may change: present, not deleted, and not from a newer format.
public func editable(_ r: Record?) -> Bool {
    guard let r else { return false }
    return !r.deleted && Schema.of(r.data) <= Schema.current
}

func byId(_ a: TaskItem, _ b: TaskItem) -> Bool { a.id < b.id }
func byOrder(_ a: TaskItem, _ b: TaskItem) -> Bool { a.order != b.order ? a.order < b.order : a.id < b.id }

extension Array {
    /// A sort that keeps equal elements in their order, like JavaScript's.
    func stableSorted(by less: (Element, Element) -> Bool) -> [Element] {
        enumerated().sorted { a, b in
            less(a.element, b.element) || (!less(b.element, a.element) && a.offset < b.offset)
        }.map(\.element)
    }
}

func item(_ r: Record) -> TaskItem { TaskItem(id: r.id, task: TaskData(json: r.data), readOnly: r.isNewer) }

/// The records as an action sees them: the stored ones plus its own changes so far.
public final class Draft {
    public private(set) var changes: [String: Change] = [:]
    /// Change ids in the order they were first made.
    public private(set) var changeOrder: [String] = []
    private let base: [String: Record]
    private let baseOrder: [String]
    public let ctx: Ctx

    public init(records: [Record], ctx: Ctx) {
        var base: [String: Record] = [:]
        var order: [String] = []
        for r in records {
            if base[r.id] == nil { order.append(r.id) }
            base[r.id] = r
        }
        self.base = base
        baseOrder = order
        self.ctx = ctx
    }

    public init(base: [String: Record], ctx: Ctx) {
        self.base = base
        baseOrder = base.keys.sorted()
        self.ctx = ctx
    }

    /// The changes in the order they were made.
    public var changeList: [Change] { changeOrder.compactMap { changes[$0] } }

    public func rec(_ id: String) -> Record? {
        if let c = changes[id] { return Record(id: c.id, kind: c.kind, hlc: "", deleted: c.deleted, data: c.data) }
        return base[id]
    }

    public func save(_ kind: String, _ id: String, _ data: JSONValue, deleted: Bool = false) {
        if changes[id] == nil { changeOrder.append(id) }
        changes[id] = Change(kind: kind, id: id, data: data, deleted: deleted)
    }

    /// A task this action may change, normalized.
    public func task(_ id: String) -> TaskData? {
        guard let r = rec(id), editable(r), r.kind == Kind.task else { return nil }
        return TaskData(json: r.data)
    }

    public func saveTask(_ id: String, _ t: TaskData) { save(Kind.task, id, t.json) }

    /// Every record, with this action's changes.
    public func records() -> [Record] {
        changeList.map { Record(id: $0.id, kind: $0.kind, hlc: "", deleted: $0.deleted, data: $0.data) }
            + baseOrder.filter { changes[$0] == nil }.compactMap { base[$0] }
    }

    /// Every task that isn't deleted, in id order.
    public func tasks() -> [TaskItem] {
        records().filter { $0.kind == Kind.task && !$0.deleted }.map(item).sorted(by: byId)
    }

    public func taskItem(_ id: String) -> TaskItem? {
        guard let r = rec(id), r.kind == Kind.task, !r.deleted else { return nil }
        return item(r)
    }

    public func children(_ id: String) -> [TaskItem] { tasks().filter { $0.parentId == id }.sorted(by: byOrder) }
    public func blocks(_ id: String) -> [TaskItem] { tasks().filter { $0.dependsOn.contains(id) } }
    public func blockers(_ t: TaskItem) -> [TaskItem] { Logic.openBlockers(t, taskItem) }
}

// MARK: - The view every list is built from

public struct ViewData {
    public let tasks: [TaskItem]
    public let projects: [ProjectItem]
    public let areas: [AreaItem]
    /// How many records came from a newer Nextly and can't be changed here.
    public let newer: Int
    private let tasksById: [String: TaskItem]
    private let projectsById: [String: ProjectItem]
    private let kids: [String: [TaskItem]]
    private let blocksMap: [String: [TaskItem]]
    private let actions: [String: [IiqActionItem]]

    public init(records: [Record]) {
        var tasks: [TaskItem] = [], projects: [ProjectItem] = [], areas: [AreaItem] = []
        var actions: [String: [IiqActionItem]] = [:]
        var newer = 0
        for r in records where !r.deleted {
            let ro = r.isNewer
            if ro { newer += 1 }
            switch r.kind {
            case Kind.task: tasks.append(item(r))
            case Kind.project: projects.append(ProjectItem(id: r.id, project: Project(json: r.data), readOnly: ro))
            case Kind.area: areas.append(AreaItem(id: r.id, area: Area(json: r.data), readOnly: ro))
            case Kind.iiqAction:
                let a = IiqActionItem(id: r.id, action: IiqAction(json: r.data))
                actions[a.action.taskId, default: []].append(a)
            default: break
            }
        }
        tasks.sort(by: byId)
        var kids: [String: [TaskItem]] = [:], blocksMap: [String: [TaskItem]] = [:]
        for t in tasks {
            if let p = t.parentId { kids[p, default: []].append(t) }
            for d in t.dependsOn { blocksMap[d, default: []].append(t) }
        }
        self.kids = kids.mapValues { $0.sorted(by: byOrder) }
        self.blocksMap = blocksMap
        self.tasks = tasks
        self.projects = projects.stableSorted { $0.order < $1.order }
        self.areas = areas.stableSorted { $0.order < $1.order }
        self.actions = actions.mapValues { $0.stableSorted { $0.action.createdAt > $1.action.createdAt } }
        self.newer = newer
        tasksById = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        projectsById = Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    }

    public func task(_ id: String) -> TaskItem? { tasksById[id] }
    public func project(_ id: String?) -> ProjectItem? { id.flatMap { projectsById[$0] } }
    public func children(_ id: String) -> [TaskItem] { kids[id] ?? [] }
    public func blockers(_ t: TaskItem) -> [TaskItem] { Logic.openBlockers(t) { tasksById[$0] } }
    public func blocks(_ id: String) -> [TaskItem] { blocksMap[id] ?? [] }
    /// Incident IQ requests for a task, newest first.
    public func iiqActions(_ taskId: String) -> [IiqActionItem] { actions[taskId] ?? [] }
}

// MARK: - Rules

public enum Rules {
    public enum ToggleResult: String, Sendable {
        /// An open ticket's task: ask for resolution notes, then call resolveWithNotes.
        case needsNotes = "needs-notes"
    }

    static func nextOrderEnd(_ d: Draft) -> Double {
        (d.tasks().filter { $0.flag == .next }.map(\.order) + [0]).max()! + 1000
    }

    static func openTicket(_ t: TaskData) -> Bool { t.external.map { $0.source == "iiq" && !$0.closed } ?? false }

    // MARK: Tasks

    /// `p` holds the task's fields, as JSON. New ids: the task's.
    @discardableResult
    public static func createTask(_ d: Draft, _ p: [String: JSONValue]) -> String {
        let id = d.ctx.newId()
        var t: [String: JSONValue] = merged([
            "title": "", "flag": "inbox", "projectId": nil, "parentId": nil, "deadline": nil,
            "startOn": nil, "repeat": nil, "nextId": nil, "external": nil,
            "done": false, "doneAt": nil, "order": 0, "dependsOn": [], "notes": [],
            "createdAt": .string(d.ctx.nowISO),
        ], p)
        if !JS.truthy(t["order"]) { t["order"] = .number(t["flag"] == "next" ? nextOrderEnd(d) : d.ctx.nowMs) }
        d.save(Kind.task, id, .object(t))
        return id
    }

    /// `{...task, ...patch}`.
    public static func updateTask(_ d: Draft, _ id: String, _ patch: [String: JSONValue]) {
        guard let t = d.task(id), let o = t.json.object else { return }
        d.save(Kind.task, id, .object(merged(o, patch)))
    }

    public static func updateTask(_ d: Draft, _ id: String, _ change: (inout TaskData) -> Void) {
        guard var t = d.task(id) else { return }
        change(&t)
        d.saveTask(id, t)
    }

    /// Starting an Incident IQ ticket's task (In Progress) starts the ticket too.
    public static func setFlag(_ d: Draft, _ id: String, _ flag: Flag?) {
        guard var t = d.task(id), t.flag != flag else { return }
        let ticket = openTicket(t)
        if flag == .next { t.order = nextOrderEnd(d) }
        t.flag = flag
        d.saveTask(id, t)
        if flag == .doing && ticket { queueIiq(d, id, "start") }
    }

    /// Asks the server to do something in Incident IQ (server/iiq.js). New ids: the action's.
    public static func queueIiq(_ d: Draft, _ taskId: String, _ type: String, text: String? = nil) {
        guard let ext = d.task(taskId)?.external, ext.source == "iiq" else { return }
        let a = IiqAction(type: type, taskId: taskId, ticketId: ext.id, text: text?.isEmpty == false ? text : nil, createdAt: d.ctx.nowISO)
        d.save(Kind.iiqAction, d.ctx.newId(), a.json)
    }

    /// Completing a task also completes its open subtasks. Any task that was
    /// waiting on it and is now free moves to Next (unless it's already in Today
    /// or In Progress). Completing a repeating task files its next copy under
    /// Scheduled; un-completing it removes that copy again if it's still open.
    ///
    /// Completing an open Incident IQ ticket's task resolves the ticket, which
    /// needs notes: then nothing changes and this returns .needsNotes; the app
    /// asks, and finishes with resolveWithNotes.
    @discardableResult
    public static func toggleDone(_ d: Draft, _ id: String) -> ToggleResult? {
        if let t = d.task(id), !t.done, openTicket(t) { return .needsNotes }
        finish(d, id, viaParent: false)
        return nil
    }

    public static func resolveWithNotes(_ d: Draft, _ id: String, _ notes: String) {
        let n = JS.trim(notes)
        finish(d, id, viaParent: false, notes: n.isEmpty ? nil : n)
    }

    static func finish(_ d: Draft, _ id: String, viaParent: Bool, notes: String? = nil) {
        guard var t = d.task(id) else { return }
        if t.done {
            if let next = t.nextId, let copy = d.task(next), !copy.done { deleteTask(d, next) }
            t.done = false; t.doneAt = nil; t.nextId = nil
            d.saveTask(id, t)
            return
        }
        // Subtasks finished along with a repeating parent come back with its copy.
        let nextId = t.repeat != nil && !viaParent ? spawnNext(d, id, t) : nil
        if openTicket(t) && !viaParent { queueIiq(d, id, "resolve", text: notes) }
        t.done = true; t.doneAt = d.ctx.nowISO; t.nextId = nextId
        d.saveTask(id, t)
        for c in d.children(id) where !c.done { finish(d, c.id, viaParent: true) }
        for w in d.blocks(id) {
            if w.done || w.flag == .today || w.flag == .doing { continue }
            if d.blockers(w).isEmpty { setFlag(d, w.id, .next) }
        }
    }

    /// The next copy of a repeating task: same title, notes and subtasks, all
    /// unchecked, waiting for its date. New ids, in this order: the copy, its note
    /// blocks, then for each subtask (by order) the subtask and its note blocks.
    static func spawnNext(_ d: Draft, _ id: String, _ t: TaskData) -> String {
        let start = Logic.nextStart(t.repeat!, startOn: t.startOn, deadline: t.deadline, today: d.ctx.today)
        // Keep the deadline the same distance from the start as before.
        let offset = t.deadline.map { Logic.daysBetween(t.startOn ?? $0, $0) } ?? 0
        func reset(_ notes: [Block]) -> [Block] {
            notes.map { b in
                var b = b
                b.id = d.ctx.newId()
                if b.type == .checklist { b.checked = false; b.extras["checked"] = nil }
                return b
            }
        }
        let now = d.ctx.nowISO
        let copyId = d.ctx.newId()
        var copy = t
        copy.flag = nil
        copy.startOn = start
        copy.deadline = t.deadline != nil ? Logic.shiftDate(start, offset) : nil
        copy.done = false; copy.doneAt = nil; copy.nextId = nil; copy.external = nil; copy.dependsOn = []
        copy.order = d.ctx.nowMs
        copy.notes = reset(t.notes)
        copy.createdAt = now
        d.saveTask(copyId, copy)
        for c in d.children(id) {
            guard var raw = d.task(c.id) else { continue }
            let childId = d.ctx.newId()
            raw.parentId = copyId
            raw.done = false; raw.doneAt = nil; raw.nextId = nil; raw.dependsOn = []
            raw.order = d.ctx.nowMs
            raw.notes = reset(raw.notes)
            raw.createdAt = now
            d.saveTask(childId, raw)
        }
        return copyId
    }

    /// Moves tasks whose start date has arrived into Today (In Progress stays put).
    /// Every device does this; the app runs it only once it's in step with the
    /// server (SyncClient.inStep), so it never saves over newer edits.
    public static func promoteDue(_ d: Draft) {
        for t in d.tasks() {
            guard !t.done, let s = t.startOn, s <= d.ctx.today else { continue }
            updateTask(d, t.id) { $0.flag = t.flag == .doing ? .doing : .today; $0.startOn = nil }
        }
    }

    /// Sets or clears a start date. A future date takes the task off its list until then.
    public static func setStartOn(_ d: Draft, _ id: String, _ startOn: String?) {
        guard var t = d.task(id) else { return }
        if let s = startOn, !s.isEmpty {
            if s <= d.ctx.today {
                t.startOn = nil
                t.flag = t.flag == .doing ? .doing : .today
            } else {
                t.startOn = s
                if t.parentId == nil { t.flag = nil }
            }
        } else {
            t.startOn = nil
            if t.flag == nil { t.flag = t.parentId != nil || t.projectId != nil ? nil : .inbox }
        }
        d.saveTask(id, t)
    }

    /// Soft-deletes a task and its subtasks, keeping their data so undo can bring them back.
    public static func deleteTask(_ d: Draft, _ id: String) {
        func collect(_ pid: String) -> [String] { d.children(pid).flatMap { [$0.id] + collect($0.id) } }
        for i in [id] + collect(id) {
            if let r = d.rec(i), editable(r) { d.save(Kind.task, i, r.data, deleted: true) }
        }
    }

    /// Returns an error message, or nil when the dependency was added (or already there).
    @discardableResult
    public static func addDependency(_ d: Draft, _ id: String, _ depId: String) -> String? {
        if Logic.wouldCycle(id, depId, d.taskItem) {
            return depId == id ? "A task can’t depend on itself."
                : "“\(d.taskItem(depId)?.title ?? "undefined")” already waits on this task, so this would make a loop."
        }
        guard var t = d.task(id), !t.dependsOn.contains(depId) else { return nil }
        t.dependsOn.append(depId)
        d.saveTask(id, t)
        return nil
    }

    public static func removeDependency(_ d: Draft, _ id: String, _ depId: String) {
        updateTask(d, id) { $0.dependsOn.removeAll { $0 == depId } }
    }

    /// Moves a task in Next so it sits just before `beforeId` (or last).
    public static func moveInNext(_ d: Draft, _ id: String, before beforeId: String?) {
        let list = d.tasks().filter { $0.flag == .next && !$0.done && $0.id != id }.sorted(by: byOrder)
        let idx = beforeId.map { b in list.firstIndex { $0.id == b } ?? -1 } ?? list.count
        let at = { (i: Int) in list.indices.contains(i) ? list[i].order : nil }
        let order = Logic.orderBetween(at(idx - 1), at(idx), now: d.ctx.nowMs)
        updateTask(d, id) { $0.order = order }
    }

    // MARK: Projects and areas

    /// New ids: the project's.
    @discardableResult
    public static func createProject(_ d: Draft, _ title: String, areaId: String?) -> String {
        let id = d.ctx.newId()
        d.save(Kind.project, id, ["title": .string(title), "areaId": .of(areaId), "order": .number(d.ctx.nowMs)])
        return id
    }

    /// `{...project, ...patch}`.
    public static func updateProject(_ d: Draft, _ id: String, _ patch: [String: JSONValue]) {
        guard let r = d.rec(id), editable(r) else { return }
        d.save(Kind.project, id, .object(merged(r.data.object ?? [:], patch)))
    }

    /// Tasks in a deleted project go back to the Inbox.
    public static func deleteProject(_ d: Draft, _ id: String) {
        guard let r = d.rec(id), editable(r) else { return }
        for t in d.tasks() where t.projectId == id {
            updateTask(d, t.id) { $0.projectId = nil; $0.flag = t.flag ?? .inbox }
        }
        d.save(Kind.project, id, r.data, deleted: true)
    }

    /// New ids: the area's.
    @discardableResult
    public static func createArea(_ d: Draft, _ title: String) -> String {
        let id = d.ctx.newId()
        d.save(Kind.area, id, ["title": .string(title), "order": .number(d.ctx.nowMs)])
        return id
    }

    /// `{...area, ...patch}`.
    public static func updateArea(_ d: Draft, _ id: String, _ patch: [String: JSONValue]) {
        guard let r = d.rec(id), editable(r) else { return }
        d.save(Kind.area, id, .object(merged(r.data.object ?? [:], patch)))
    }

    /// Projects in a deleted area stay, without an area.
    public static func deleteArea(_ d: Draft, _ id: String) {
        guard let r = d.rec(id), editable(r) else { return }
        for p in ViewData(records: d.records()).projects where p.areaId == id {
            updateProject(d, p.id, ["areaId": nil])
        }
        d.save(Kind.area, id, r.data, deleted: true)
    }
}
