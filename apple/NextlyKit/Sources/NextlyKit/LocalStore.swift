// Every record on this device, kept in SQLite and queued for sync. The app
// reads `view` and changes data only through the actions below, which run a
// rule from Rules.swift and save what it changed. A port of app/src/store.ts
// (with app/src/db.ts's IndexedDB stores as tables: records, outbox, meta, files).
//
// The database lives in the App Group folder so the widgets can read it.

import Foundation
import Observation
import SQLite3

@MainActor
@Observable
public final class LocalStore {
    /// Bumps on every change; `view` is rebuilt once per version.
    public private(set) var version = 0
    /// The Incident IQ task waiting for resolution notes, if any.
    public private(set) var resolvingId: String?
    public private(set) var deviceId = ""

    @ObservationIgnored public private(set) var records: [String: Record] = [:]
    @ObservationIgnored private var outbox = Set<String>()
    @ObservationIgnored public let hlc = HLC()
    @ObservationIgnored private let db: SQLiteDB
    /// Called after every local change (SyncClient pushes it soon after).
    @ObservationIgnored public var onLocalChange: () -> Void = {}
    @ObservationIgnored private var cache: (version: Int, view: ViewData)?

    /// Opens (or creates) the database at `url` and loads it.
    public init(url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        db = try SQLiteDB(path: url.path)
        try db.exec("""
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, hlc TEXT NOT NULL,
              deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, extras TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS files (sha TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL,
              uploaded INTEGER NOT NULL DEFAULT 0, bytes BLOB NOT NULL);
            """)
        try load()
    }

    /// `nextly.sqlite` in the App Group folder.
    public nonisolated static func appGroupURL(_ group: String) -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appendingPathComponent("nextly.sqlite")
    }

    private func load() throws {
        deviceId = meta("deviceId")?.string ?? String(Logic.uid().prefix(8))
        setMeta("deviceId", .string(deviceId))
        hlc.setDevice(deviceId)
        for row in try db.query("SELECT id, kind, hlc, deleted, data, extras FROM records") {
            let r = Record(id: row[0].text, kind: row[1].text, hlc: row[2].text, deleted: row[3].int != 0,
                           data: (try? JSONValue.parse(row[4].text)) ?? .object([:]),
                           extras: (try? JSONValue.parse(row[5].text))?.object ?? [:])
            records[r.id] = r
            hlc.observe(r.hlc)
        }
        for row in try db.query("SELECT id FROM outbox") { outbox.insert(row[0].text) }
        bump()
    }

    private func bump() { version += 1 }

    private func store(_ r: Record) {
        try? db.run("INSERT OR REPLACE INTO records (id, kind, hlc, deleted, data, extras) VALUES (?, ?, ?, ?, ?, ?)",
                    .text(r.id), .text(r.kind), .text(r.hlc), .int(r.deleted ? 1 : 0), .text(r.data.text()), .text(JSONValue.object(r.extras).text()))
    }

    private func queue(_ id: String) {
        outbox.insert(id)
        try? db.run("INSERT OR IGNORE INTO outbox (id) VALUES (?)", .text(id))
    }

    // MARK: - Writing and syncing

    /// Saves a record, stamped with the format this app writes (Schema.current).
    func write(_ kind: String, _ id: String, _ data: JSONValue, deleted: Bool = false) {
        var stamped = data
        if case .object(var o) = data { o["schema"] = .number(Double(Schema.current)); stamped = .object(o) }
        let rec = Record(id: id, kind: kind, hlc: hlc.now(), deleted: deleted, data: stamped)
        records[id] = rec
        store(rec)
        queue(id)
        bump()
        onLocalChange()
    }

    /// Applies rows from the server. Returns how many were newer than ours.
    @discardableResult
    public func applyRemote(_ rows: [Record]) -> Int {
        var changed = 0
        try? db.exec("BEGIN")
        for rec in rows {
            hlc.observe(rec.hlc)
            if let cur = records[rec.id], cur.hlc >= rec.hlc { continue }
            records[rec.id] = rec
            store(rec)
            changed += 1
        }
        try? db.exec("COMMIT")
        if changed > 0 { bump() }
        return changed
    }

    /// Queues every local record to be sent again, for a server that lost its data.
    public func requeueAll() {
        try? db.exec("BEGIN")
        for id in records.keys { queue(id) }
        try? db.exec("COMMIT")
    }

    public struct Counts: Sendable { public var records, tasks, unsent: Int }

    public func localCounts() -> Counts {
        Counts(records: records.count, tasks: records.values.filter { $0.kind == Kind.task && !$0.deleted }.count, unsent: outbox.count)
    }

    public func pendingChanges() -> [Record] { outbox.sorted().compactMap { records[$0] } }

    public func markSent(_ sent: [Record]) {
        for r in sent {
            guard records[r.id]?.hlc == r.hlc else { continue } // edited again while in flight
            outbox.remove(r.id)
            try? db.run("DELETE FROM outbox WHERE id = ?", .text(r.id))
        }
    }

    // MARK: - Meta (settings, cursor, server id)

    public func meta(_ key: String) -> JSONValue? {
        guard let row = try? db.query("SELECT value FROM meta WHERE key = ?", .text(key)).first else { return nil }
        return try? JSONValue.parse(row[0].text)
    }

    public func setMeta(_ key: String, _ value: JSONValue?) {
        if let value { try? db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", .text(key), .text(value.text())) }
        else { try? db.run("DELETE FROM meta WHERE key = ?", .text(key)) }
    }

    // MARK: - Attachments

    public struct StoredFile: Sendable {
        public var sha: String
        public var name: String
        public var mime: String
        public var uploaded: Bool
        public var bytes: Data
    }

    public func file(_ sha: String) -> StoredFile? {
        guard let row = try? db.query("SELECT sha, name, mime, uploaded, bytes FROM files WHERE sha = ?", .text(sha)).first else { return nil }
        return StoredFile(sha: row[0].text, name: row[1].text, mime: row[2].text, uploaded: row[3].int != 0, bytes: row[4].blob)
    }

    public func putFile(_ f: StoredFile) {
        try? db.run("INSERT OR REPLACE INTO files (sha, name, mime, uploaded, bytes) VALUES (?, ?, ?, ?, ?)",
                    .text(f.sha), .text(f.name), .text(f.mime), .int(f.uploaded ? 1 : 0), .blob(f.bytes))
    }

    /// Files not yet on the server.
    public func unsentFiles() -> [String] {
        ((try? db.query("SELECT sha FROM files WHERE uploaded = 0")) ?? []).map { $0[0].text }
    }

    public func setUploaded(_ sha: String, _ uploaded: Bool) {
        try? db.run("UPDATE files SET uploaded = ? WHERE sha = ?", .int(uploaded ? 1 : 0), .text(sha))
    }

    /// For a server that lost its data: send every file again.
    public func markAllFilesUnsent() { try? db.exec("UPDATE files SET uploaded = 0") }

    // MARK: - The view, rebuilt once per change

    public var view: ViewData {
        if let cache, cache.version == version { return cache.view }
        let v = ViewData(records: Array(records.values))
        cache = (version, v)
        return v
    }

    // MARK: - Actions: run a rule, then save what it changed

    /// Runs a rule on the current records with the real clock, and saves its changes.
    @discardableResult
    public func run<T>(_ rule: (Draft) -> T) -> T {
        let d = Draft(base: records, ctx: .live())
        let result = rule(d)
        for c in d.changeList { write(c.kind, c.id, c.data, deleted: c.deleted) }
        return result
    }

    /// `p`: the task's fields as JSON, e.g. ["title": "Call Sam", "flag": "today"].
    @discardableResult
    public func createTask(_ p: [String: JSONValue]) -> String { run { Rules.createTask($0, p) } }
    public func updateTask(_ id: String, _ patch: [String: JSONValue]) { run { Rules.updateTask($0, id, patch) } }
    public func updateTask(_ id: String, _ change: @escaping (inout TaskData) -> Void) { run { Rules.updateTask($0, id, change) } }
    public func setFlag(_ id: String, _ flag: Flag?) { run { Rules.setFlag($0, id, flag) } }
    public func queueIiq(_ taskId: String, _ type: String, text: String? = nil) { run { Rules.queueIiq($0, taskId, type, text: text) } }
    public func setNotes(_ id: String, _ notes: [Block]) { updateTask(id) { $0.notes = notes } }
    public func setStartOn(_ id: String, _ startOn: String?) { run { Rules.setStartOn($0, id, startOn) } }
    public func promoteDue() { run { Rules.promoteDue($0) } }
    @discardableResult
    public func addDependency(_ id: String, _ depId: String) -> String? { run { Rules.addDependency($0, id, depId) } }
    public func removeDependency(_ id: String, _ depId: String) { run { Rules.removeDependency($0, id, depId) } }
    public func moveInNext(_ id: String, before: String?) { run { Rules.moveInNext($0, id, before: before) } }

    public func toggleDone(_ id: String) {
        if run({ Rules.toggleDone($0, id) }) == .needsNotes { resolvingId = id; bump() }
    }

    public func resolveWithNotes(_ id: String, _ notes: String, resolutionActionId: String? = nil) {
        resolvingId = nil
        run { Rules.resolveWithNotes($0, id, notes, resolutionActionId: resolutionActionId) }
    }

    public func cancelResolve() {
        resolvingId = nil
        bump()
    }

    /// Soft-deletes a task and its subtasks. Returns a function that undoes it.
    @discardableResult
    public func deleteTask(_ id: String) -> () -> Void {
        let deleted = run { d -> [Change] in Rules.deleteTask(d, id); return d.changeList }
        return { [weak self] in for c in deleted { self?.write(Kind.task, c.id, c.data) } }
    }

    @discardableResult
    public func createProject(_ title: String, areaId: String?) -> String { run { Rules.createProject($0, title, areaId: areaId) } }
    public func updateProject(_ id: String, _ patch: [String: JSONValue]) { run { Rules.updateProject($0, id, patch) } }
    public func deleteProject(_ id: String) { run { Rules.deleteProject($0, id) } }
    @discardableResult
    public func createArea(_ title: String) -> String { run { Rules.createArea($0, title) } }
    public func updateArea(_ id: String, _ patch: [String: JSONValue]) { run { Rules.updateArea($0, id, patch) } }
    public func deleteArea(_ id: String) { run { Rules.deleteArea($0, id) } }
}

// MARK: - A small SQLite wrapper

enum SQLValue {
    case text(String), int(Int64), blob(Data), null

    var text: String { if case .text(let s) = self { return s }; return "" }
    var int: Int64 { if case .int(let n) = self { return n }; return 0 }
    var blob: Data { if case .blob(let d) = self { return d }; return Data() }
}

struct SQLiteError: Error, CustomStringConvertible { let description: String }

final class SQLiteDB {
    private var handle: OpaquePointer?
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(path: String) throws {
        if sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) != SQLITE_OK {
            throw SQLiteError(description: "Couldn’t open the database: \(String(cString: sqlite3_errmsg(handle)))")
        }
        sqlite3_busy_timeout(handle, 5000)
    }

    deinit { sqlite3_close_v2(handle) }

    private var message: String { String(cString: sqlite3_errmsg(handle)) }

    func exec(_ sql: String) throws {
        if sqlite3_exec(handle, sql, nil, nil, nil) != SQLITE_OK { throw SQLiteError(description: message) }
    }

    private func prepare(_ sql: String, _ args: [SQLValue]) throws -> OpaquePointer? {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else { throw SQLiteError(description: message) }
        for (i, a) in args.enumerated() {
            let n = Int32(i + 1)
            switch a {
            case .text(let s): sqlite3_bind_text(stmt, n, s, -1, Self.transient)
            case .int(let v): sqlite3_bind_int64(stmt, n, v)
            case .blob(let d) where d.isEmpty: sqlite3_bind_zeroblob(stmt, n, 0)
            case .blob(let d): _ = d.withUnsafeBytes { sqlite3_bind_blob(stmt, n, $0.baseAddress, Int32(d.count), Self.transient) }
            case .null: sqlite3_bind_null(stmt, n)
            }
        }
        return stmt
    }

    func run(_ sql: String, _ args: SQLValue...) throws {
        let stmt = try prepare(sql, args)
        defer { sqlite3_finalize(stmt) }
        let rc = sqlite3_step(stmt)
        if rc != SQLITE_DONE && rc != SQLITE_ROW { throw SQLiteError(description: message) }
    }

    func query(_ sql: String, _ args: SQLValue...) throws -> [[SQLValue]] {
        let stmt = try prepare(sql, args)
        defer { sqlite3_finalize(stmt) }
        var rows: [[SQLValue]] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw SQLiteError(description: message) }
            rows.append((0..<sqlite3_column_count(stmt)).map { i in
                switch sqlite3_column_type(stmt, i) {
                case SQLITE_INTEGER: return .int(sqlite3_column_int64(stmt, i))
                case SQLITE_BLOB:
                    let n = Int(sqlite3_column_bytes(stmt, i))
                    return .blob(n > 0 ? Data(bytes: sqlite3_column_blob(stmt, i), count: n) : Data())
                case SQLITE_NULL: return .null
                default: return .text(String(cString: sqlite3_column_text(stmt, i)))
                }
            })
        }
        return rows
    }
}
