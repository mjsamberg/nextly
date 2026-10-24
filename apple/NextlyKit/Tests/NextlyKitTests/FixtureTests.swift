// Runs the shared cases in spec/fixtures, which the TypeScript app's tests
// (app/src/fixtures.test.ts) run too, with the same meaning: "now" is an
// instant, "today" a local date (date words use 9 a.m. that day), new ids are
// n1, n2, ..., and results are compared as JSON values.
//
// The files run are listed in ../fixtures.manifest.json, which the fixture
// gate (scripts/check-fixtures.mjs) checks against spec/fixtures.

import XCTest
@testable import NextlyKit

let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()

struct Fixture {
    let file: String
    let now: Date
    let today: String
    let cases: [JSONValue]

    init(_ file: String) throws {
        let json = try JSONValue.parse(Data(contentsOf: repoRoot.appendingPathComponent("spec/fixtures/\(file)")))
        self.file = file
        now = Date(timeIntervalSince1970: JS.parseDate(json["now"]!.string!)! / 1000)
        today = json["today"]!.string!
        cases = json["cases"]!.array!
    }

    /// The local date `today` at 9 a.m., for the date functions.
    var localDay: Date {
        let p = today.split(separator: "-").map { Int($0)! }
        return JS.localDate(p[0], p[1] - 1, p[2], 9, 0)
    }
}

/// Records as fixtures write them: hlc and deleted are optional.
func records(_ rows: JSONValue?) -> [Record] {
    (rows?.array ?? []).compactMap { Record(json: .object(merged(["hlc": "", "deleted": false], $0.object ?? [:]))) }
}

func headerRows(_ v: JSONValue?) -> [Logic.HeaderRow] {
    (v?.array ?? []).map { Logic.HeaderRow(name: $0["name"]?.string ?? "", value: $0["value"]?.string ?? "") }
}

/// A JSON value from a Swift one.
func json(_ s: String?) -> JSONValue { .of(s) }
func json(_ f: Flag?) -> JSONValue { .of(f?.rawValue) }
func json(_ b: Bool) -> JSONValue { .bool(b) }
func json(_ n: Double) -> JSONValue { .number(n) }
func json(_ r: Repeat?) -> JSONValue { r?.json ?? .null }

final class FixtureTests: XCTestCase {
    typealias Runner = (Fixture, JSONValue) throws -> Void

    /// A fresh draft whose new ids are n1, n2, ...
    static func draft(_ f: Fixture, _ rows: JSONValue?) -> Draft {
        var n = 0
        return Draft(records: records(rows), ctx: Ctx(now: f.now, today: f.today, newId: { n += 1; return "n\(n)" }))
    }

    static func act(_ f: Fixture, _ c: JSONValue) throws -> JSONValue {
        let d = draft(f, c["records"])
        let a = c["action"]!
        let id = a["id"]?.string ?? ""
        let patch = a["patch"]?.object ?? [:]
        var result: JSONValue = .null
        switch a["type"]?.string {
        case "createTask": result = .string(Rules.createTask(d, a["task"]?.object ?? [:]))
        case "updateTask": Rules.updateTask(d, id, patch)
        case "setFlag": Rules.setFlag(d, id, a["flag"]?.string.flatMap(Flag.init))
        case "toggleDone": result = json(Rules.toggleDone(d, id)?.rawValue)
        case "resolveWithNotes": Rules.resolveWithNotes(d, id, a["notes"]?.string ?? "")
        case "queueIiq": Rules.queueIiq(d, id, a["iiq"]?.string ?? "", text: a["text"]?.string)
        case "setStartOn": Rules.setStartOn(d, id, a["startOn"]?.string)
        case "promoteDue": Rules.promoteDue(d)
        case "deleteTask": Rules.deleteTask(d, id)
        case "addDependency": result = json(Rules.addDependency(d, id, a["dependsOn"]?.string ?? ""))
        case "removeDependency": Rules.removeDependency(d, id, a["dependsOn"]?.string ?? "")
        case "moveInNext": Rules.moveInNext(d, id, before: a["before"]?.string)
        case "createProject": result = .string(Rules.createProject(d, a["title"]?.string ?? "", areaId: a["areaId"]?.string))
        case "updateProject": Rules.updateProject(d, id, patch)
        case "deleteProject": Rules.deleteProject(d, id)
        case "createArea": result = .string(Rules.createArea(d, a["title"]?.string ?? ""))
        case "updateArea": Rules.updateArea(d, id, patch)
        case "deleteArea": Rules.deleteArea(d, id)
        default: throw Failure("unknown action \(a["type"].map(JS.string) ?? "")")
        }
        var changed: [String: JSONValue] = [:]
        for ch in d.changeList { changed[ch.id] = ["kind": .string(ch.kind), "deleted": .bool(ch.deleted), "data": ch.data] }
        return ["result": result, "changed": .object(changed)]
    }

    struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ s: String) { description = s }
    }

    static func equal(_ got: JSONValue, _ want: JSONValue?, _ what: String = "") throws {
        let want = want ?? .null
        if got != want { throw Failure("\(what)\n  got:  \(got.text())\n  want: \(want.text())") }
    }

    static let runners: [String: Runner] = [
        "quick-add.json": { f, c in try equal(Logic.parseQuickAdd(c["input"]!.string!, now: f.localDay).json, c["expect"]) },
        "date-words.json": { f, c in try equal(json(Logic.parseDateWord(c["word"]!.string!, now: f.localDay)), c["expect"]) },
        "repeats.json": { f, c in
            let r = { Repeat(json: c["repeat"])! }
            let got: JSONValue
            switch c["fn"]?.string {
            case "nextOccurrence": got = json(Logic.nextOccurrence(r(), after: c["after"]!.string!))
            case "nextStart": got = json(Logic.nextStart(r(), startOn: c["task"]?["startOn"]?.string, deadline: c["task"]?["deadline"]?.string, today: f.today))
            case "daysBetween": got = json(Double(Logic.daysBetween(c["a"]!.string!, c["b"]!.string!)))
            case "label": got = json(Logic.repeatLabel(r()))
            case "normRepeat": got = json(Repeat(json: c["input"]))
            case "parseRepeatWord": got = json(Logic.parseRepeatWord(c["word"]!.string!))
            default: throw Failure("unknown fn")
            }
            try equal(got, c["expect"])
        },
        "capture-links.json": { _, c in try equal(Logic.parseCaptureLink(c["link"]!.string!)?.json ?? .null, c["expect"]) },
        "network.json": { _, c in
            switch c["fn"]?.string {
            case "checkHeaders":
                let err = Logic.checkHeaders(headerRows(c["rows"]))
                if let want = c["expect"]?.string {
                    if !(err ?? "").contains(want) { throw Failure("\(err ?? "nil") should contain \(want)") }
                } else if let err { throw Failure("unexpected error \(err)") }
            case "headerObject":
                try equal(.object(Logic.headerObject(headerRows(c["rows"])).mapValues(JSONValue.string)), c["expect"])
            case "blockedByAccess":
                try equal(json(Logic.blockedByAccess(status: Int(c["status"]!.number!), contentType: c["contentType"]?.string, finalUrl: c["url"]!.string!)), c["expect"])
            default: throw Failure("unknown fn")
            }
        },
        "flags.json": { f, c in
            switch c["fn"]?.string {
            case "promote": try equal(json(Logic.promote(c["flag"]?.string.flatMap(Flag.init))), c["expect"])
            case "defer": try equal(json(Logic.defer(c["flag"]?.string.flatMap(Flag.init))), c["expect"])
            case "orderBetween": try equal(json(Logic.orderBetween(c["before"]?.number, c["after"]?.number, now: JS.ms(f.now))), c["expect"])
            default: throw Failure("unknown fn")
            }
        },
        "normalize.json": { _, c in try equal(TaskData(json: c["input"]!).json, c["expect"]) },
        "lists.json": { _, c in
            let v = ViewData(records: records(c["records"]))
            for (name, ids) in c["views"]?.object ?? [:] {
                guard let view = ListView(name: name) else { throw Failure("unknown view \(name)") }
                let got = Lists.tasksFor(v, view, query: c["query"]?.string ?? "").map { JSONValue.string($0.id) }
                try equal(.array(got), ids, name)
            }
            if let want = c["counts"] { try equal(Lists.counts(v).json, want, "counts") }
        },
        "actions.json": { f, c in try equal(act(f, c), c["expect"]) },
        "roundtrip.json": { f, c in try equal(act(f, c), c["expect"]) },
    ]

    static var manifest: [String] {
        get throws {
            let url = repoRoot.appendingPathComponent("apple/NextlyKit/Tests/fixtures.manifest.json")
            return try JSONValue.parse(Data(contentsOf: url)).array!.map { $0.string! }
        }
    }

    func testEveryListedFixture() throws {
        var count = 0
        for file in try Self.manifest {
            guard let run = Self.runners[file] else { XCTFail("no runner for \(file)"); continue }
            let f = try Fixture(file)
            for c in f.cases {
                count += 1
                let id = c["id"]?.string ?? "?"
                do { try run(f, c) } catch { XCTFail("\(file): \(id): \(error)") }
            }
        }
        XCTAssertGreaterThan(count, 0)
    }

    /// Every fixture file has a runner here; the gate checks the manifest lists them all.
    func testManifestMatchesFixtures() throws {
        let files = try FileManager.default.contentsOfDirectory(atPath: repoRoot.appendingPathComponent("spec/fixtures").path)
            .filter { $0.hasSuffix(".json") }.sorted()
        XCTAssertEqual(try Self.manifest.sorted(), files)
    }
}
