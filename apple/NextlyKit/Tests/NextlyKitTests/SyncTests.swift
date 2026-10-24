// LocalStore, SyncClient and Live against the real sync server
// (server/server.js), started on a spare port with a throwaway data folder,
// the same way as server/files.test.js. Needs Node 24 (node:sqlite): on PATH,
// in $NODE, or Homebrew's node@24.

import XCTest
@testable import NextlyKit

/// The sync server, running in a child process.
final class TestServer {
    static let token = "test-token"
    let port: Int
    let data: URL
    private let process = Process()

    var base: String { "http://127.0.0.1:\(port)" }

    static func node() -> String? {
        let env = ProcessInfo.processInfo.environment
        var candidates = [env["NODE"]].compactMap { $0 }
        candidates += (env["PATH"] ?? "").split(separator: ":").map { "\($0)/node" }
        candidates += ["/opt/homebrew/opt/node@24/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: c)
            p.arguments = ["-e", "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"]
            try? p.run()
            p.waitUntilExit()
            if p.terminationStatus == 0 { return c }
        }
        return nil
    }

    init(port: Int = 20000 + Int.random(in: 0..<20000), data: URL? = nil) throws {
        guard let node = Self.node() else { throw XCTSkip("Node 24 not found; set NODE to run the sync tests.") }
        self.port = port
        self.data = data ?? FileManager.default.temporaryDirectory.appendingPathComponent("nextly-test-\(UUID().uuidString)")
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = ["server.js"]
        process.currentDirectoryURL = repoRoot.appendingPathComponent("server")
        var env = ProcessInfo.processInfo.environment
        env["NEXTLY_TOKEN"] = Self.token
        env["NEXTLY_DATA"] = self.data.path
        env["PORT"] = String(port)
        env["IIQ_URL"] = ""
        process.environment = env
        let out = Pipe()
        process.standardOutput = out
        let ready = DispatchSemaphore(value: 0)
        var seen = ""
        out.fileHandleForReading.readabilityHandler = { h in
            seen += String(decoding: h.availableData, as: UTF8.self)
            if seen.contains("listening") { h.readabilityHandler = nil; ready.signal() }
        }
        try process.run()
        if ready.wait(timeout: .now() + 15) == .timedOut { stop(); throw XCTSkip("The sync server didn’t start.") }
    }

    func stop(removeData: Bool = true) {
        if process.isRunning { process.terminate(); process.waitUntilExit() }
        if removeData { try? FileManager.default.removeItem(at: data) }
    }

    /// A raw request, as another app would make it.
    func post(_ path: String, _ body: JSONValue) async throws -> JSONValue {
        var req = URLRequest(url: URL(string: base + path)!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(Self.token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body.data()
        return try JSONValue.parse(try await URLSession.shared.data(for: req).0)
    }

    /// Every record the server holds.
    func all() async throws -> [String: Record] {
        let rows = try await post("/sync", ["cursor": 0, "changes": []])["changes"]?.array ?? []
        return Dictionary(rows.compactMap(Record.init(json:)).map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
    }
}

@MainActor
final class SyncTests: XCTestCase {
    var server: TestServer!
    var folders: [URL] = []

    override func setUp() async throws {
        server = try TestServer()
    }

    override func tearDown() async throws {
        server?.stop()
        for f in folders { try? FileManager.default.removeItem(at: f) }
    }

    /// A device: its own database and sync client, pointed at the test server.
    func device(url: String? = nil, altUrl: String = "") async throws -> SyncClient {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("nextly-device-\(UUID().uuidString)")
        folders.append(folder)
        let store = try LocalStore(url: folder.appendingPathComponent("nextly.sqlite"))
        let sync = SyncClient(store: store)
        XCTAssertTrue(sync.inStep, "sync that isn't set up counts as in step")
        await sync.saveSettings(SyncSettings(url: url ?? server.base, altUrl: altUrl, token: TestServer.token))
        return sync
    }

    func testTwoDevicesSyncEditsBothWays() async throws {
        let a = try await device(), b = try await device()
        XCTAssertTrue(a.inStep, "a sync has finished")
        let id = a.store.createTask(["title": "Call Sam", "flag": "today"])
        await a.syncNow()
        XCTAssertEqual(a.status.state, .idle, a.status.message)
        XCTAssertEqual(a.store.localCounts().unsent, 0)

        await b.syncNow()
        XCTAssertEqual(b.store.view.task(id)?.title, "Call Sam")
        XCTAssertEqual(Lists.tasksFor(b.store.view, .today).map(\.id), [id])

        b.store.toggleDone(id)
        await b.syncNow()
        await a.syncNow()
        XCTAssertEqual(a.store.view.task(id)?.done, true)
        XCTAssertEqual(a.store.records[id]?.data["schema"], 1, "saves are stamped with the schema")
    }

    func testUnknownFieldsSurviveAnEditAndNewerRecordsAreLeftAlone() async throws {
        let ts = "001792501200000-0000-otherapp"
        _ = try await server.post("/sync", ["cursor": 0, "changes": [
            ["id": "x", "kind": "task", "hlc": .string(ts), "deleted": false,
             "data": ["title": "From elsewhere", "flag": "today", "color": "plum", "notes": [["id": "b1", "type": "paragraph", "text": "hi", "align": "center"]],
                      "repeat": ["every": 1, "unit": "week", "from": "schedule", "until": "2027-06-01"], "createdAt": "2026-10-01T12:00:00.000Z", "order": 5]],
            ["id": "y", "kind": "task", "hlc": .string(ts), "deleted": false,
             "data": ["title": "Newer", "flag": "today", "schema": 2, "createdAt": "2026-10-01T12:00:00.000Z", "order": 6]],
            ["id": "z", "kind": "someday-kind", "hlc": .string(ts), "deleted": false, "data": ["anything": true]],
        ]])
        let a = try await device()
        XCTAssertEqual(a.store.view.newer, 1)
        XCTAssertEqual(a.store.view.task("y")?.readOnly, true)

        a.store.updateTask("x") { $0.title = "Renamed" }
        a.store.updateTask("y") { $0.title = "Changed?" }
        a.store.deleteTask("y")
        await a.syncNow()

        let all = try await server.all()
        let x = try XCTUnwrap(all["x"]?.data)
        XCTAssertEqual(x["title"], "Renamed")
        XCTAssertEqual(x["color"], "plum")
        XCTAssertEqual(x["notes"]?.array?.first?["align"], "center")
        XCTAssertEqual(x["repeat"]?["until"], "2027-06-01")
        XCTAssertEqual(x["schema"], 1)
        XCTAssertGreaterThan(all["x"]!.hlc, ts, "the clock moved past the other app's")
        XCTAssertEqual(all["y"]?.hlc, ts, "a newer-format record isn't changed")
        XCTAssertEqual(all["y"]?.deleted, false)
        XCTAssertEqual(a.store.records["z"]?.data["anything"], true, "unknown kinds are kept")
    }

    func testEditedWhileInFlightStaysQueued() async throws {
        let a = try await device()
        let id = a.store.createTask(["title": "one"])
        let sent = a.store.pendingChanges()
        a.store.updateTask(id) { $0.title = "two" }
        a.store.markSent(sent)
        XCTAssertEqual(a.store.pendingChanges().map(\.id), [id], "the newer edit still needs sending")
        await a.syncNow()
        let rec = try await server.all()[id]
        XCTAssertEqual(rec?.data["title"], "two")
    }

    func testServerThatLostItsDataGetsEverythingAgain() async throws {
        let a = try await device()
        let id = a.store.createTask(["title": "keep me"])
        let file = a.addFile(Data("hello".utf8), name: "hello.txt", mime: "text/plain")
        await a.syncNow()
        let before = try await server.all()
        XCTAssertNotNil(before[id])

        // The same address, a new data volume.
        let port = server.port
        server.stop()
        server = try TestServer(port: port)
        let empty = try await server.all()
        XCTAssertNil(empty[id])
        await a.syncNow()
        XCTAssertEqual(a.status.state, .idle, a.status.message)
        let after = try await server.all()
        XCTAssertEqual(after[id]?.data["title"], "keep me")
        XCTAssertTrue(FileManager.default.fileExists(atPath: server.data.appendingPathComponent("files/\(file.sha)").path), "files are sent again too")
    }

    func testSecondAddressTakesOverWhenTheFirstIsDown() async throws {
        let a = try await device(url: "http://127.0.0.1:9", altUrl: server.base)
        XCTAssertEqual(a.status.state, .idle, a.status.message)
        XCTAssertEqual(a.status.via, "127.0.0.1:\(server.port)")
        let lines = await a.checkConnection().lines
        XCTAssertTrue(lines.contains { $0.contains("127.0.0.1:9: doesn’t answer") }, lines.joined(separator: "\n"))
    }

    func testWrongTokenIsExplained() async throws {
        let a = try await device()
        var s = a.settings
        s.token = "wrong"
        await a.saveSettings(s)
        XCTAssertEqual(a.status.state, .error)
        XCTAssertEqual(a.status.message, "The server rejected the sync token. Check it in Settings.")
        let b = try await device(url: server.base)
        XCTAssertTrue(b.inStep)
        let c = SyncClient(store: b.store)
        await c.saveSettings(SyncSettings(url: server.base, token: "wrong"))
        XCTAssertFalse(c.inStep, "automatic edits wait for a sync that worked")
    }

    func testFilesUploadAndOpenThroughALink() async throws {
        let a = try await device(), b = try await device()
        let bytes = Data("attached notes".utf8)
        let f = a.addFile(bytes, name: "notes.txt", mime: "text/plain")
        await a.syncNow()
        let link = try await a.fileLink(f.sha, name: f.name, mime: f.mime)
        let (got, res) = try await URLSession.shared.data(from: URL(string: link)!)
        XCTAssertEqual((res as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(got, bytes)
        let loaded = await b.loadFile(f.sha, name: f.name, mime: f.mime)
        XCTAssertEqual(loaded, bytes)
        XCTAssertEqual(b.store.file(f.sha)?.uploaded, true)
    }

    func testLiveUpdatesSayWhenAnotherDeviceSyncs() async throws {
        let a = try await device(), b = try await device()
        let connected = expectation(description: "live")
        let changed = expectation(description: "changed")
        var states: [LiveState] = []
        a.live.start(Live.Options(
            url: { _ in self.server.base },
            headers: a.authHeaders,
            deviceId: a.store.deviceId,
            onChanged: { changed.fulfill() },
            onConnected: { connected.fulfill() },
            onState: { s, _ in states.append(s) }
        ))
        await fulfillment(of: [connected], timeout: 10)
        b.store.createTask(["title": "from b"])
        await b.syncNow()
        await fulfillment(of: [changed], timeout: 10)
        XCTAssertEqual(states.first, .connecting)
        XCTAssertEqual(states.last, .live)
        a.live.stop()
    }

    func testLiveRetriesWithAWrongToken() async throws {
        let a = try await device()
        let retrying = expectation(description: "retrying")
        retrying.assertForOverFulfill = false
        var detail = ""
        let live = Live()
        live.start(Live.Options(
            url: { _ in self.server.base },
            headers: ["Authorization": "Bearer wrong"],
            deviceId: a.store.deviceId,
            onChanged: {}, onConnected: {},
            onState: { s, d in if s == .retrying && !d.isEmpty { detail = d; retrying.fulfill() } }
        ))
        await fulfillment(of: [retrying], timeout: 10)
        live.stop()
        XCTAssertTrue(detail.hasSuffix("Retrying in 1 s."), detail)
    }
}

@MainActor
final class LocalStoreTests: XCTestCase {
    func testRecordsAndOutboxSurviveReopening() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("nextly-\(UUID().uuidString).sqlite")
        defer { try? FileManager.default.removeItem(at: url) }
        var store: LocalStore? = try LocalStore(url: url)
        let id = store!.createTask(["title": "persist"])
        let device = store!.deviceId
        let hlc = store!.records[id]!.hlc
        store!.putFile(.init(sha: "abc", name: "a.txt", mime: "text/plain", uploaded: false, bytes: Data()))
        store = nil

        let again = try LocalStore(url: url)
        XCTAssertEqual(again.deviceId, device)
        XCTAssertEqual(again.view.task(id)?.title, "persist")
        XCTAssertEqual(again.pendingChanges().map(\.id), [id])
        XCTAssertEqual(again.unsentFiles(), ["abc"])
        again.updateTask(id) { $0.title = "later" }
        XCTAssertGreaterThan(again.records[id]!.hlc, hlc, "the clock carries on past saved records")
    }

    func testTicketTaskAsksForNotesBeforeResolving() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("nextly-\(UUID().uuidString).sqlite")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try LocalStore(url: url)
        store.applyRemote([Record(id: "iiq-1", kind: Kind.task, hlc: "001792501200000-0000-iiq",
                                  data: ["title": "Charger", "projectId": "iiq-project", "external": ["source": "iiq", "id": "T1", "closed": false]])])
        store.toggleDone("iiq-1")
        XCTAssertEqual(store.resolvingId, "iiq-1")
        XCTAssertEqual(store.view.task("iiq-1")?.done, false)
        store.resolveWithNotes("iiq-1", "Replaced it")
        XCTAssertNil(store.resolvingId)
        XCTAssertEqual(store.view.iiqActions("iiq-1").first?.action.text, "Replaced it")
    }

    func testHLCOrdersAndObserves() {
        var t = Date(timeIntervalSince1970: 1000)
        let h = HLC(device: "dev", clock: { t })
        XCTAssertEqual(h.now(), "000000001000000-0000-dev")
        XCTAssertEqual(h.now(), "000000001000000-0001-dev")
        h.observe("000000002000000-0005-other")
        XCTAssertEqual(h.now(), "000000002000000-0006-dev")
        t = Date(timeIntervalSince1970: 3000)
        XCTAssertEqual(h.now(), "000000003000000-0000-dev")
    }

    func testWebSocketAddress() {
        XCTAssertEqual(Live.wsURL("https://nextly.example.com/", deviceId: "d1")?.absoluteString, "wss://nextly.example.com/events?device=d1")
        XCTAssertEqual(Live.wsURL("http://100.64.0.1:8080", deviceId: "d1")?.absoluteString, "ws://100.64.0.1:8080/events?device=d1")
    }
}
