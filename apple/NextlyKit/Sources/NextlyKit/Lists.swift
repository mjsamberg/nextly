// Which tasks appear in which list. One place, so counts and lists agree.
// A port of app/src/lists.ts.

import Foundation

public enum ListView: Hashable, Sendable {
    case inbox, doing, today, next, scheduled, someday, all, logbook, search
    case project(String)

    /// "inbox", "project:<id>" and so on, as app/src names them.
    public init?(name: String) {
        if name.hasPrefix("project:") { self = .project(String(name.dropFirst("project:".count))); return }
        switch name {
        case "inbox": self = .inbox
        case "doing": self = .doing
        case "today": self = .today
        case "next": self = .next
        case "scheduled": self = .scheduled
        case "someday": self = .someday
        case "all": self = .all
        case "logbook": self = .logbook
        case "search": self = .search
        default: return nil
        }
    }
}

public enum Lists {
    private static func byOrder(_ a: TaskItem, _ b: TaskItem) -> Bool { a.order < b.order }
    private static func byCreated(_ a: TaskItem, _ b: TaskItem) -> Bool { a.createdAt < b.createdAt }

    /// A task with no flag, project or parent would otherwise be lost, so it shows
    /// in Inbox, unless it's waiting for a start date (then it's in Scheduled).
    /// Incident IQ tickets stay in their project, never the Inbox.
    static func inInbox(_ t: TaskItem) -> Bool {
        t.external?.source != "iiq"
            && (t.flag == .inbox || (t.flag == nil && t.projectId == nil && t.parentId == nil && t.startOn == nil))
    }

    /// In the All list, what you're doing comes first and Someday last.
    static func flagRank(_ t: TaskItem) -> Int {
        switch t.flag {
        case .doing: return 0
        case .today: return 1
        case .next: return 2
        case .inbox: return 3
        case nil: return 4
        case .someday: return 5
        }
    }

    public struct AllGroup: Hashable, Sendable {
        public struct ProjectGroup: Hashable, Sendable {
            public var projectId: String?
            public var title: String
            public var tasks: [TaskItem]
        }
        public var areaId: String?
        public var title: String
        public var projects: [ProjectGroup]
    }

    /// All open tasks (not subtasks, which stay with their parent), grouped by
    /// area, then project. Projects without an area come after the areas, and
    /// tasks without a project come last.
    public static func allGrouped(_ v: ViewData) -> [AllGroup] {
        let tasks = tasksFor(v, .all)
        let inProject = { (pid: String) in newestTicketsFirst(tasks.filter { $0.projectId == pid }) }
        let knownArea = { (id: String?) in id.map { id in v.areas.contains { $0.id == id } } ?? false }
        let projectsIn = { (areaId: String?) -> [AllGroup.ProjectGroup] in
            v.projects
                .filter { areaId != nil ? $0.areaId == areaId : !knownArea($0.areaId) }
                .map { AllGroup.ProjectGroup(projectId: $0.id, title: $0.title.isEmpty ? "Untitled project" : $0.title, tasks: inProject($0.id)) }
                .filter { !$0.tasks.isEmpty }
        }
        var groups = v.areas
            .map { AllGroup(areaId: $0.id, title: $0.title.isEmpty ? "Untitled area" : $0.title, projects: projectsIn($0.id)) }
            .filter { !$0.projects.isEmpty }
        let loose = projectsIn(nil)
        if !loose.isEmpty { groups.append(AllGroup(areaId: nil, title: v.areas.isEmpty ? "Projects" : "Other projects", projects: loose)) }
        let known = Set(v.projects.map(\.id))
        let noProject = tasks.filter { $0.projectId.map { !known.contains($0) } ?? true }
        if !noProject.isEmpty { groups.append(AllGroup(areaId: nil, title: "No project", projects: [.init(projectId: nil, title: "", tasks: noProject)])) }
        return groups
    }

    /// A list of Incident IQ tickets (every task has a submitted date) goes newest
    /// submitted first; any other list keeps its order.
    static func newestTicketsFirst(_ tasks: [TaskItem]) -> [TaskItem] {
        guard !tasks.isEmpty, tasks.allSatisfy({ !($0.external?.created ?? "").isEmpty }) else { return tasks }
        let when = { (t: TaskItem) in JS.parseDate(t.external!.created!) ?? 0 }
        return tasks.stableSorted { when($0) > when($1) }
    }

    /// The date a task is filed under in Scheduled: its start date, else its deadline.
    public static func scheduledDate(_ t: TaskItem) -> String? { t.startOn ?? t.deadline }

    public static func tasksFor(_ v: ViewData, _ view: ListView, query: String = "") -> [TaskItem] {
        let ts = v.tasks
        switch view {
        case .inbox: return ts.filter { !$0.done && inInbox($0) }.stableSorted(by: byCreated)
        case .doing: return ts.filter { !$0.done && $0.flag == .doing }.stableSorted(by: byOrder)
        case .today: return ts.filter { !$0.done && $0.flag == .today }.stableSorted(by: byOrder)
        case .next: return ts.filter { !$0.done && $0.flag == .next }.stableSorted(by: byOrder)
        case .someday: return ts.filter { !$0.done && $0.flag == .someday }.stableSorted(by: byCreated)
        case .scheduled:
            return ts.filter { !$0.done && !(scheduledDate($0) ?? "").isEmpty }.stableSorted { scheduledDate($0)! < scheduledDate($1)! }
        case .all:
            return ts.filter { !$0.done && $0.parentId == nil }.stableSorted { a, b in
                flagRank(a) != flagRank(b) ? flagRank(a) < flagRank(b) : byOrder(a, b)
            }
        case .logbook: return ts.filter(\.done).stableSorted { ($0.doneAt ?? "") > ($1.doneAt ?? "") }
        case .search:
            let q = JS.trim(query).lowercased()
            if q.isEmpty { return [] }
            return ts.filter { ($0.title + " " + Logic.noteText($0.task)).lowercased().contains(q) }
                .stableSorted { a, b in a.done != b.done ? !a.done : byCreated(a, b) }
        case .project(let pid):
            return newestTicketsFirst(ts.filter { !$0.done && $0.projectId == pid && $0.parentId == nil }.stableSorted(by: byOrder))
        }
    }

    public struct Counts: Hashable, Sendable {
        public var inbox, doing, today, next: Int
        public var json: JSONValue { ["inbox": .number(Double(inbox)), "doing": .number(Double(doing)), "today": .number(Double(today)), "next": .number(Double(next))] }
    }

    public static func counts(_ v: ViewData) -> Counts {
        Counts(inbox: tasksFor(v, .inbox).count, doing: tasksFor(v, .doing).count,
               today: tasksFor(v, .today).count, next: tasksFor(v, .next).count)
    }

    public static func viewTitle(_ v: ViewData, _ view: ListView) -> String {
        switch view {
        case .inbox: return "Inbox"
        case .doing: return "In Progress"
        case .today: return "Today"
        case .next: return "Next"
        case .scheduled: return "Scheduled"
        case .all: return "All"
        case .someday: return "Someday"
        case .logbook: return "Logbook"
        case .search: return "Search"
        case .project(let id):
            let t = v.project(id)?.title ?? ""
            return t.isEmpty ? "Untitled project" : t
        }
    }
}
