// The record format (spec/protocol.md). Each model reads its known fields from
// a record's JSON and keeps the rest in `extras`; writing it back puts the
// extras first and the known fields over them, so a field another app (or a
// newer Nextly) wrote survives this app's save.
//
// TaskData.init(json:) is normTask in app/src/logic.ts: it accepts older and
// partial records and cleans up bad values the same way.

import Foundation

/// The record format this app writes. Bump only for changes older apps can't safely save over.
public enum Schema {
    public static let current = 1

    /// A record's `schema`; none means 1.
    public static func of(_ data: JSONValue) -> Int {
        guard let n = data["schema"]?.number else { return 1 }
        return Int(exactly: n) ?? Int(n.rounded(.up))
    }
}

/// Which list a task is in. `doing` is In Progress. A task with no flag is a
/// subtask, a project task, or one waiting for its start date.
public enum Flag: String, Codable, CaseIterable, Sendable {
    case inbox, doing, today, next, someday
}

// MARK: - Record

/// The unit of sync, as the server stores it.
public struct Record: Hashable, Sendable {
    public var id: String
    public var kind: String
    public var hlc: String
    public var deleted: Bool
    public var data: JSONValue
    /// Anything else on the row (the server adds `seq`).
    public var extras: [String: JSONValue]

    public init(id: String, kind: String, hlc: String, deleted: Bool = false, data: JSONValue, extras: [String: JSONValue] = [:]) {
        self.id = id; self.kind = kind; self.hlc = hlc; self.deleted = deleted; self.data = data; self.extras = extras
    }

    public init?(json: JSONValue) {
        guard var o = json.object, let id = o.removeValue(forKey: "id")?.string else { return nil }
        self.id = id
        kind = o.removeValue(forKey: "kind")?.string ?? ""
        hlc = o.removeValue(forKey: "hlc")?.string ?? ""
        deleted = JS.truthy(o.removeValue(forKey: "deleted"))
        data = o.removeValue(forKey: "data") ?? .object([:])
        extras = o
    }

    public var json: JSONValue {
        .object(merged(extras, ["id": .string(id), "kind": .string(kind), "hlc": .string(hlc), "deleted": .bool(deleted), "data": data]))
    }

    /// Saved by a newer Nextly: shown, synced, never changed here.
    public var isNewer: Bool { Schema.of(data) > Schema.current }
}

public enum Kind {
    public static let task = "task", project = "project", area = "area", iiqAction = "iiq-action"
}

/// Takes known keys out of an object, leaving the rest as extras. A known key
/// whose value has the wrong type stays in the extras untouched.
struct FieldReader {
    var rest: [String: JSONValue]

    init(_ v: JSONValue?) { rest = v?.object ?? [:] }

    mutating func string(_ k: String) -> String? {
        guard case .string(let s)? = rest[k] else { return nil }
        rest[k] = nil
        return s
    }

    mutating func number(_ k: String) -> Double? {
        guard case .number(let n)? = rest[k] else { return nil }
        rest[k] = nil
        return n
    }

    mutating func bool(_ k: String) -> Bool? {
        guard case .bool(let b)? = rest[k] else { return nil }
        rest[k] = nil
        return b
    }

    mutating func raw(_ k: String) -> JSONValue? { rest.removeValue(forKey: k) }
}

// MARK: - Repeat

public struct Repeat: Hashable, Sendable {
    public enum Unit: String, Codable, CaseIterable, Sendable { case day, week, month, year }
    public enum From: String, Codable, Sendable { case schedule, completion }

    /// 1–365.
    public var every: Int
    public var unit: Unit
    /// Days of the week (0 = Sunday), only for weekly repeats.
    public var weekdays: [Int]?
    public var from: From
    public var extras: [String: JSONValue]

    public init(every: Int, unit: Unit, weekdays: [Int]? = nil, from: From = .schedule, extras: [String: JSONValue] = [:]) {
        self.every = every; self.unit = unit; self.weekdays = weekdays; self.from = from; self.extras = extras
    }

    /// normRepeat: nil unless the unit is known; `every` clamped; weekdays sorted, for weeks only.
    public init?(json: JSONValue?) {
        guard let json, let o = json.object, let unit = o["unit"]?.string.flatMap(Unit.init) else { return nil }
        self.unit = unit
        let n = JS.toNumber(o["every"]).flatMap { $0 == 0 ? nil : $0 } ?? 1
        every = Int(min(365, max(1, JS.round(n))))
        var days: [Int] = []
        if let list = o["weekdays"]?.array {
            for v in list {
                guard let d = JS.toNumber(v), d >= 0, d <= 6, let i = Int(exactly: d), !days.contains(i) else { continue }
                days.append(i)
            }
        }
        weekdays = unit == .week && !days.isEmpty ? days.sorted() : nil
        from = o["from"]?.string == "completion" ? .completion : .schedule
        extras = o.filter { !["every", "unit", "weekdays", "from"].contains($0.key) }
    }

    public var json: JSONValue {
        var o = extras
        o["every"] = .number(Double(every))
        o["unit"] = .string(unit.rawValue)
        if let weekdays, !weekdays.isEmpty { o["weekdays"] = .array(weekdays.map { .number(Double($0)) }) } else { o["weekdays"] = nil }
        o["from"] = .string(from.rawValue)
        return .object(o)
    }
}

// MARK: - Note blocks

public enum BlockType: String, Codable, CaseIterable, Sendable {
    case heading, paragraph, checklist, quote, divider, image, file, email
}

public struct Block: Hashable, Sendable, Identifiable {
    public var id: String
    public var type: BlockType
    public var text: String?
    public var checked: Bool?
    // image / file
    public var sha: String?
    public var name: String?
    public var size: Double?
    public var mime: String?
    // email
    public var url: String?
    public var subject: String?
    public var from: String?
    public var extras: [String: JSONValue]

    public init(id: String, type: BlockType, text: String? = nil, checked: Bool? = nil, extras: [String: JSONValue] = [:]) {
        self.id = id; self.type = type; self.text = text; self.checked = checked; self.extras = extras
    }

    /// normBlock: `text` blocks are paragraphs, unknown types too; a missing id is `b<index>`.
    public init(json: JSONValue, index: Int) {
        var r = FieldReader(json)
        let rawId = r.raw("id")
        id = rawId.map { $0.isNull ? "b\(index)" : JS.string($0) } ?? "b\(index)"
        let t = r.raw("type")?.string
        type = t == "text" ? .paragraph : t.flatMap(BlockType.init) ?? .paragraph
        text = r.string("text")
        checked = r.bool("checked")
        sha = r.string("sha")
        name = r.string("name")
        size = r.number("size")
        mime = r.string("mime")
        url = r.string("url")
        subject = r.string("subject")
        from = r.string("from")
        extras = r.rest
    }

    public var json: JSONValue {
        var o = extras
        o["id"] = .string(id)
        o["type"] = .string(type.rawValue)
        if let text { o["text"] = .string(text) }
        if let checked { o["checked"] = .bool(checked) }
        if let sha { o["sha"] = .string(sha) }
        if let name { o["name"] = .string(name) }
        if let size { o["size"] = .number(size) }
        if let mime { o["mime"] = .string(mime) }
        if let url { o["url"] = .string(url) }
        if let subject { o["subject"] = .string(subject) }
        if let from { o["from"] = .string(from) }
        return .object(o)
    }
}

// MARK: - Incident IQ

/// An Incident IQ ticket a task mirrors. The server (server/iiq.js) keeps it current.
public struct External: Hashable, Sendable {
    public var source: String
    public var id: String
    /// A number or a string, or null.
    public var number: JSONValue
    public var url: String?
    public var status: String?
    public var closed: Bool
    public var requester: String?
    public var location: String?
    public var issue: String?
    public var priority: String?
    /// When the ticket was submitted (ISO date), if Incident IQ says.
    public var created: String?
    public var syncedAt: String?
    public var extras: [String: JSONValue]

    static let nullable = ["url", "status", "requester", "location", "issue", "priority", "syncedAt"]

    /// Only Incident IQ tickets with an id count.
    public init?(json: JSONValue?) {
        guard json?["source"]?.string == "iiq", let rawId = json?["id"], JS.truthy(rawId) else { return nil }
        var r = FieldReader(json)
        source = r.string("source")!
        id = r.string("id") ?? JS.string(r.raw("id") ?? rawId)
        number = r.raw("number") ?? .null
        url = r.string("url")
        status = r.string("status")
        requester = r.string("requester")
        location = r.string("location")
        issue = r.string("issue")
        priority = r.string("priority")
        syncedAt = r.string("syncedAt")
        created = r.string("created")
        if let b = r.bool("closed") { closed = b } else { closed = JS.truthy(r.rest["closed"]) }
        extras = r.rest
    }

    public var json: JSONValue {
        var o = extras
        o["source"] = .string(source)
        o["id"] = .string(id)
        o["number"] = number
        let values = ["url": url, "status": status, "requester": requester, "location": location, "issue": issue, "priority": priority, "syncedAt": syncedAt]
        for k in Self.nullable {
            if let v = values[k] ?? nil { o[k] = .string(v) } else if o[k] == nil { o[k] = .null }
        }
        if o["closed"] == nil || o["closed"]?.bool != nil { o["closed"] = .bool(closed) }
        if let created { o["created"] = .string(created) }
        return .object(o)
    }
}

/// A request for the server to carry out in Incident IQ, and its result.
public struct IiqAction: Hashable, Sendable {
    /// comment, start or resolve.
    public var type: String
    public var taskId: String
    public var ticketId: String
    public var text: String?
    /// pending, done, manual or failed.
    public var state: String
    public var message: String?
    public var createdAt: String
    public var finishedAt: String?
    public var extras: [String: JSONValue]

    public init(json: JSONValue) {
        var r = FieldReader(json)
        type = r.string("type") ?? ""
        taskId = r.string("taskId") ?? ""
        ticketId = r.string("ticketId") ?? ""
        text = r.string("text")
        state = r.string("state") ?? ""
        message = r.string("message")
        createdAt = r.string("createdAt") ?? ""
        finishedAt = r.string("finishedAt")
        extras = r.rest
    }

    public init(type: String, taskId: String, ticketId: String, text: String? = nil, state: String = "pending", createdAt: String) {
        self.type = type; self.taskId = taskId; self.ticketId = ticketId; self.text = text
        self.state = state; self.createdAt = createdAt; extras = [:]
    }

    public var json: JSONValue {
        var o = extras
        o["type"] = .string(type)
        o["taskId"] = .string(taskId)
        o["ticketId"] = .string(ticketId)
        if let text { o["text"] = .string(text) }
        o["state"] = .string(state)
        if let message { o["message"] = .string(message) }
        o["createdAt"] = .string(createdAt)
        if let finishedAt { o["finishedAt"] = .string(finishedAt) }
        return .object(o)
    }
}

// MARK: - Tasks

/// A task record's data (`Task` in app/src/types.ts; named so it doesn't hide Swift's `Task`).
public struct TaskData: Hashable, Sendable {
    public var title: String
    public var flag: Flag?
    public var projectId: String?
    /// Set on a subtask.
    public var parentId: String?
    /// YYYY-MM-DD. Shown only; never used to sort.
    public var deadline: String?
    /// YYYY-MM-DD: waits in Scheduled, then moves into Today that day.
    public var startOn: String?
    public var `repeat`: Repeat?
    /// The copy made when this repeating task was finished.
    public var nextId: String?
    public var external: External?
    public var done: Bool
    public var doneAt: String?
    /// Position in Next (and the order in other lists).
    public var order: Double
    public var dependsOn: [String]
    public var notes: [Block]
    public var createdAt: String
    public var extras: [String: JSONValue]

    public init(title: String = "", flag: Flag? = .inbox, projectId: String? = nil, parentId: String? = nil,
                deadline: String? = nil, startOn: String? = nil, repeat: Repeat? = nil, nextId: String? = nil,
                external: External? = nil, done: Bool = false, doneAt: String? = nil, order: Double = 0,
                dependsOn: [String] = [], notes: [Block] = [], createdAt: String = "1970-01-01T00:00:00.000Z",
                extras: [String: JSONValue] = [:]) {
        self.title = title; self.flag = flag; self.projectId = projectId; self.parentId = parentId
        self.deadline = deadline; self.startOn = startOn; self.repeat = `repeat`; self.nextId = nextId
        self.external = external; self.done = done; self.doneAt = doneAt; self.order = order
        self.dependsOn = dependsOn; self.notes = notes; self.createdAt = createdAt; self.extras = extras
    }

    // TaskData fields this app knows. `links` and `list` are older forms, folded into
    // notes and flag; `id` belongs to the record, never its data.
    static let keys: Set<String> = ["title", "flag", "projectId", "parentId", "deadline", "startOn", "repeat", "nextId", "external",
                                    "done", "doneAt", "order", "dependsOn", "notes", "createdAt", "links", "list", "id"]

    /// normTask: tolerates older or partial records (for example ones written by the capture page).
    public init(json d: JSONValue) {
        let o = d.object ?? [:]
        var notes = (o["notes"]?.array ?? []).enumerated().map { Block(json: $1, index: $0) }
        if let links = o["links"]?.array {
            for (i, l) in links.enumerated() {
                var b = Block(id: "link\(i)", type: .email)
                b.url = l["url"]?.string
                b.subject = l["subject"]?.string
                notes.append(b)
            }
        }
        extras = o.filter { !Self.keys.contains($0.key) }
        title = o["title"].map { $0.isNull ? "" : JS.string($0) } ?? ""
        flag = o["flag"]?.string.flatMap(Flag.init) ?? (o["list"]?.string == "inbox" ? .inbox : nil)
        projectId = o["projectId"]?.string
        parentId = o["parentId"]?.string
        deadline = o["deadline"]?.string
        startOn = o["startOn"]?.string
        self.repeat = Repeat(json: o["repeat"])
        nextId = o["nextId"]?.string
        external = External(json: o["external"])
        done = JS.truthy(o["done"])
        doneAt = o["doneAt"]?.string
        let created = o["createdAt"]?.string
        order = o["order"]?.number ?? created.flatMap(JS.parseDate) ?? 0
        dependsOn = (o["dependsOn"]?.array ?? []).map(JS.string)
        self.notes = notes
        createdAt = created ?? "1970-01-01T00:00:00.000Z"
    }

    public var json: JSONValue {
        var o = extras
        o["title"] = .string(title)
        o["flag"] = .of(flag?.rawValue)
        o["projectId"] = .of(projectId)
        o["parentId"] = .of(parentId)
        o["deadline"] = .of(deadline)
        o["startOn"] = .of(startOn)
        o["repeat"] = self.repeat?.json ?? .null
        o["nextId"] = .of(nextId)
        o["external"] = external?.json ?? .null
        o["done"] = .bool(done)
        o["doneAt"] = .of(doneAt)
        o["order"] = .number(order)
        o["dependsOn"] = .array(dependsOn.map(JSONValue.string))
        o["notes"] = .array(notes.map(\.json))
        o["createdAt"] = .string(createdAt)
        return .object(o)
    }

    /// The text of its notes, for search.
    public var noteText: String { Logic.noteText(self) }
}

/// A task as the lists see it: its record id, and whether it's read-only here.
@dynamicMemberLookup
public struct TaskItem: Hashable, Sendable, Identifiable {
    public let id: String
    public var task: TaskData
    /// Saved by a newer Nextly, so this app shows it but doesn't change it.
    public var readOnly: Bool

    public init(id: String, task: TaskData, readOnly: Bool = false) { self.id = id; self.task = task; self.readOnly = readOnly }

    public subscript<T>(dynamicMember key: KeyPath<TaskData, T>) -> T { task[keyPath: key] }
}

// MARK: - Projects and areas

public struct Project: Hashable, Sendable {
    public var title: String
    public var areaId: String?
    public var order: Double
    public var extras: [String: JSONValue]

    public init(title: String, areaId: String? = nil, order: Double = 0) { self.title = title; self.areaId = areaId; self.order = order; extras = [:] }

    public init(json: JSONValue) {
        var r = FieldReader(json)
        title = r.string("title") ?? ""
        areaId = r.string("areaId")
        if r.rest["areaId"]?.isNull == true { r.rest["areaId"] = nil }
        order = r.number("order") ?? 0
        extras = r.rest
    }

    public var json: JSONValue { .object(merged(extras, ["title": .string(title), "areaId": .of(areaId), "order": .number(order)])) }
}

public struct Area: Hashable, Sendable {
    public var title: String
    public var order: Double
    public var extras: [String: JSONValue]

    public init(title: String, order: Double = 0) { self.title = title; self.order = order; extras = [:] }

    public init(json: JSONValue) {
        var r = FieldReader(json)
        title = r.string("title") ?? ""
        order = r.number("order") ?? 0
        extras = r.rest
    }

    public var json: JSONValue { .object(merged(extras, ["title": .string(title), "order": .number(order)])) }
}

public struct ProjectItem: Hashable, Sendable, Identifiable {
    public let id: String
    public var project: Project
    public var readOnly: Bool
    public var title: String { project.title }
    public var areaId: String? { project.areaId }
    public var order: Double { project.order }
}

public struct AreaItem: Hashable, Sendable, Identifiable {
    public let id: String
    public var area: Area
    public var readOnly: Bool
    public var title: String { area.title }
    public var order: Double { area.order }
}

public struct IiqActionItem: Hashable, Sendable, Identifiable {
    public let id: String
    public var action: IiqAction
}
