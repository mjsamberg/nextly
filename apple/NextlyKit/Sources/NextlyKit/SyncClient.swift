// Talks to the Nextly sync server (server/server.js). A port of app/src/sync.ts.
// Push every unsent record, pull everything newer than our cursor, repeat
// while the server says there's more. Then upload any attachments not yet sent.

import CryptoKit
import Foundation
import Observation

/// url: the server address. altUrl: optionally a second address for the same
/// server (say Cloudflare and Tailscale); whichever answers is used.
/// headers: sent with every request, e.g. a Cloudflare Access service token.
public struct SyncSettings: Codable, Hashable, Sendable {
    public var url: String
    public var altUrl: String
    public var token: String
    public var headers: [Logic.HeaderRow]

    public init(url: String = "", altUrl: String = "", token: String = "", headers: [Logic.HeaderRow] = []) {
        self.url = url; self.altUrl = altUrl; self.token = token; self.headers = headers
    }
}

public enum LiveState: String, Sendable { case off, connecting, live, retrying }

/// `.idle` (green) only ever means the last sync actually completed.
public struct SyncStatus: Hashable, Sendable {
    public enum State: String, Sendable { case off, idle, syncing, error }
    public var state: State = .off
    public var message = "Sync isn’t set up yet"
    public var lastSync: String?
    public var sent: Int?
    public var received: Int?
    public var live: LiveState = .off
    public var liveDetail = ""
    /// The address in use, when there are two.
    public var via: String?
}

public struct SyncError: Error, CustomStringConvertible, LocalizedError {
    public let description: String
    public init(_ s: String) { description = s }
    public var errorDescription: String? { description }
}

/// The server's Incident IQ sync status (server/iiq.js).
public struct IiqStatus: Codable, Hashable, Sendable {
    public var enabled: Bool
    public var lastSync: String?
    public var lastError: String?
    public var tickets: Int?
    public var pollSeconds: Double?
    public var canResolve: Bool?
    public var knowsUser: Bool?
    /// The resolution actions the server lets the app choose from (empty or
    /// missing: no choice, the server uses its default), and that default.
    public var resolutionActions: [IiqResolutionAction]?
    public var defaultResolutionActionId: String?
}

/// One of the site's resolution actions, as the server lists it.
public struct IiqResolutionAction: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
}

/// An HTTP answer, with the address it finally came from (after redirects).
public struct HTTPAnswer: Sendable {
    public var status: Int
    public var contentType: String?
    public var url: String
    public var data: Data
    public var ok: Bool { (200..<300).contains(status) }
    var json: JSONValue? { try? JSONValue.parse(data) }
}

@MainActor
@Observable
public final class SyncClient {
    public private(set) var status = SyncStatus()
    public private(set) var settings = SyncSettings()

    @ObservationIgnored public let store: LocalStore
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private var lastSyncAt: Date?
    @ObservationIgnored private var running = false
    @ObservationIgnored private var again = false
    @ObservationIgnored private var waiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var active = 0 // which address answered last
    @ObservationIgnored private var lastOk: Date = .distantPast // when it last answered
    @ObservationIgnored private var pushTask: Task<Void, Never>?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored public let live = Live()
    /// After every completed sync (the app then runs promoteDue).
    @ObservationIgnored public var onSynced: () -> Void = {}
    /// When the settings change, with every address: the widgets and Siri read these.
    @ObservationIgnored public var onSettings: (SyncSettings, [String]) -> Void = { _, _ in }

    // With live updates connected, polling is only a safety net.
    static let pollLive: TimeInterval = 5 * 60
    static let pollOffline: TimeInterval = 30
    static let idleRecheck: TimeInterval = 2 * 60
    static let probe: TimeInterval = 6

    public init(store: LocalStore, session: URLSession = .shared) {
        self.store = store
        self.session = session
        if let saved = store.meta("sync"), let s = try? JSONDecoder().decode(SyncSettings.self, from: saved.data()) { settings = s }
        // Start with the address that worked last time.
        active = max(0, urls.firstIndex(of: store.meta("activeUrl")?.string ?? "") ?? 0)
        let problem = notReady
        status.state = problem != nil && !settings.url.isEmpty ? .error : .off
        status.message = problem ?? "Not synced yet"
        status.lastSync = store.meta("lastSync")?.string
    }

    /// Whether this device has what the server has: sync is off, or a sync has
    /// finished since launch. Automatic edits (promoteDue) wait for this, because
    /// a change made to a stale copy would overwrite newer edits from elsewhere.
    public var inStep: Bool { settings.url.isEmpty || settings.token.isEmpty || lastSyncAt != nil }

    /// Pushes local edits shortly after they happen, polls as a safety net, and
    /// opens live updates. Other devices' edits arrive through live updates.
    public func start() {
        store.onLocalChange = { [weak self] in self?.localChanged() }
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.pollOffline * 1e9))
                guard let self else { return }
                let every = self.status.live == .live ? Self.pollLive : Self.pollOffline
                if Date().timeIntervalSince(self.lastSyncAt ?? .distantPast) >= every - 1 { await self.syncNow() }
            }
        }
        onSettings(settings, urls)
        restartLive()
        Task { await syncNow() }
    }

    public func stop() {
        pollTask?.cancel()
        pushTask?.cancel()
        live.stop()
        store.onLocalChange = {}
    }

    private func localChanged() {
        pushTask?.cancel()
        pushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 800_000_000)
            if Task.isCancelled { return }
            await self?.syncNow()
        }
    }

    // MARK: - One server, one or two addresses

    /// The server's addresses, primary first.
    public var urls: [String] {
        var seen = Set<String>()
        return [settings.url, settings.altUrl]
            .map { var u = JS.trim($0); while u.hasSuffix("/") { u.removeLast() }; return u }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    private var base: String { urls.indices.contains(active) ? urls[active] : urls.first ?? "" }
    private static func host(_ u: String) -> String { URL(string: u)?.host.map { h in URL(string: u)?.port.map { "\(h):\($0)" } ?? h } ?? u }
    private var hosts: String { urls.map(Self.host).joined(separator: " or ") }

    /// Answers that mean "this address can't reach the server right now" (Cloudflare's tunnel and Access errors).
    static func unreachable(_ res: HTTPAnswer) -> Bool {
        Logic.blockedByAccess(status: res.status, contentType: res.contentType, finalUrl: res.url)
            || [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530].contains(res.status)
    }

    /// The headers every request carries: the extra ones from Settings, then the token.
    public var authHeaders: [String: String] {
        var h = Logic.headerObject(settings.headers)
        for k in h.keys where k.lowercased() == "authorization" { h[k] = nil }
        h["Authorization"] = "Bearer \(settings.token)"
        return h
    }

    /// Whether one address answers like a Nextly server, quickly.
    private func answers(_ u: String) async -> Bool {
        guard let res = try? await once(u + "/health", timeout: Self.probe) else { return false }
        return res.ok && !Self.unreachable(res) && res.json?["ok"] == .bool(true)
    }

    /// Asks every address at once and switches to the first that answers.
    @discardableResult
    private func pickAddress() async -> Bool {
        let list = urls
        guard list.count >= 2 else { return false }
        let winner: Int? = await withTaskGroup(of: Int?.self) { g in
            for (i, u) in list.enumerated() { g.addTask { await self.answers(u) ? i : nil } }
            for await r in g { if let r { g.cancelAll(); return r } }
            return nil
        }
        guard let winner else { return false }
        if winner != active { active = winner; store.setMeta("activeUrl", .string(list[winner])) }
        lastOk = Date()
        status.via = Self.host(list[winner])
        return true
    }

    /// One request to one address. A request that hangs would otherwise block every later sync.
    private func once(_ url: String, method: String = "GET", body: Data? = nil, contentType: String? = nil, timeout: TimeInterval) async throws -> HTTPAnswer {
        guard let u = URL(string: url) else { throw SyncError("“\(url)” isn’t a valid server address.") }
        var req = URLRequest(url: u)
        req.httpMethod = method
        req.httpBody = body
        req.timeoutInterval = timeout
        req.cachePolicy = .reloadIgnoringLocalCacheData
        for (k, v) in authHeaders { req.setValue(v, forHTTPHeaderField: k) }
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        do {
            let (data, resp) = try await session.data(for: req)
            let http = resp as? HTTPURLResponse
            return HTTPAnswer(status: http?.statusCode ?? 0, contentType: http?.value(forHTTPHeaderField: "Content-Type"),
                              url: resp.url?.absoluteString ?? url, data: data)
        } catch let e as URLError where e.code == .timedOut {
            throw SyncError("\(Self.host(url)) didn’t answer within \(Int(timeout)) seconds.")
        }
    }

    /// A request to the server at `path`, through whichever address works. With
    /// two addresses: after a quiet spell (the phone slept, the network changed)
    /// check which one answers first; and if the one in use fails, switch to the
    /// other and try once more.
    public func request(_ path: String, method: String = "GET", body: Data? = nil, contentType: String? = nil, timeout: TimeInterval = 30) async throws -> HTTPAnswer {
        let two = urls.count > 1
        if two && Date().timeIntervalSince(lastOk) > Self.idleRecheck { await pickAddress() }
        var failure: Error?
        var failed: HTTPAnswer?
        do {
            let res = try await once(base + path, method: method, body: body, contentType: contentType, timeout: timeout)
            if !two || !Self.unreachable(res) { lastOk = Date(); return res }
            failed = res
        } catch {
            if !two { throw error }
            failure = error
        }
        let before = active
        if await pickAddress(), active != before {
            let res = try await once(base + path, method: method, body: body, contentType: contentType, timeout: timeout)
            lastOk = Date()
            return res
        }
        if let failed { return failed }
        throw failure!
    }

    private var notReady: String? {
        settings.url.isEmpty ? "Sync isn’t set up yet" : settings.token.isEmpty ? "Add the sync token in Settings to start syncing." : nil
    }

    static let accessHelp = "Cloudflare Access blocked the request. Check the CF-Access-Client-Id and CF-Access-Client-Secret headers in Settings."

    /// Throws a readable error for anything but a real answer from the Nextly server.
    static func check(_ res: HTTPAnswer, _ what: String) throws {
        if Logic.blockedByAccess(status: res.status, contentType: res.contentType, finalUrl: res.url) { throw SyncError(accessHelp) }
        if res.status == 401 { throw SyncError("The server rejected the sync token. Check it in Settings.") }
        if !res.ok { throw SyncError("\(what): the server answered \(res.status).") }
    }

    private func restartLive() {
        if notReady != nil { live.stop(); status.live = .off; status.liveDetail = ""; return }
        live.start(Live.Options(
            // Each (re)connect asks again, so live updates follow a switch of address.
            url: { [weak self] retrying in
                guard let self else { return "" }
                if retrying { await self.pickAddress() }
                return self.base
            },
            headers: authHeaders,
            deviceId: store.deviceId,
            onChanged: { [weak self] in Task { await self?.syncNow() } },
            onConnected: { [weak self] in Task { await self?.syncNow() } },
            onState: { [weak self] s, detail in self?.status.live = s; self?.status.liveDetail = detail }
        ))
    }

    public func saveSettings(_ s: SyncSettings) async {
        let changedServer = JS.trim(s.url) != settings.url
        settings = SyncSettings(
            url: JS.trim(s.url), altUrl: JS.trim(s.altUrl), token: JS.trim(s.token),
            headers: s.headers.filter { !JS.trim($0.name).isEmpty }.map { .init(name: JS.trim($0.name), value: JS.trim($0.value)) }
        )
        store.setMeta("sync", try? JSONValue.parse(JSONEncoder().encode(settings)))
        active = 0; lastOk = .distantPast // check which address answers on the next request
        status.via = nil
        onSettings(settings, urls)
        if changedServer { store.setMeta("cursor", .number(0)) } // new server: pull everything
        restartLive()
        await syncNow()
    }

    // MARK: - Syncing

    /// Syncs now. If a sync is already running, another follows it, and this
    /// returns once that one has finished.
    public func syncNow() async {
        if let problem = notReady {
            status.state = settings.url.isEmpty ? .off : .error
            status.message = problem
            return
        }
        if running {
            again = true
            await withCheckedContinuation { waiters.append($0) }
            return
        }
        running = true
        status.state = .syncing
        status.message = "Syncing…"
        do {
            var cursor = store.meta("cursor")?.number ?? 0
            var sent = 0, received = 0, resets = 0
            while true {
                let changes = store.pendingChanges()
                let body: JSONValue = ["cursor": .number(cursor), "changes": .array(changes.map(\.json)), "deviceId": .string(store.deviceId)]
                let res = try await request("/sync", method: "POST", body: body.data(), contentType: "application/json")
                try Self.check(res, "Sync failed")
                let answer = res.json ?? [:]
                guard let newCursor = answer["cursor"]?.number, let rows = answer["changes"]?.array else {
                    throw SyncError("\(base) answered, but not like a Nextly server. Check the server address.")
                }
                store.markSent(changes)
                sent += changes.count

                // A different server, or one that's behind us, has lost or never had our
                // data: start from the beginning and send everything again.
                let knownId = store.meta("serverId")?.string
                let serverId = answer["serverId"]?.string ?? ""
                let isNewServer = !serverId.isEmpty && serverId != knownId
                let isBehind = answer["lastSeq"]?.number.map { $0 < cursor } ?? false
                if !serverId.isEmpty { store.setMeta("serverId", .string(serverId)) }
                if (isNewServer && (knownId != nil || cursor > 0)) || isBehind {
                    resetForNewServer()
                    cursor = 0
                    resets += 1
                    if resets > 2 { throw SyncError("The server keeps starting over. Check that its data volume is kept between restarts.") }
                    continue
                }

                // The server echoes our own changes back; count only ones that were new here.
                received += store.applyRemote(rows.compactMap(Record.init(json:)))
                cursor = newCursor
                store.setMeta("cursor", .number(cursor))
                if answer["more"] != .bool(true) { break }
            }
            try await uploadFiles()
            let now = JS.iso(Date())
            lastSyncAt = Date()
            store.setMeta("lastSync", .string(now))
            status.state = .idle
            status.message = sent > 0 || received > 0 ? "Synced · sent \(sent), received \(received)" : "Up to date · nothing new"
            status.lastSync = now
            status.sent = sent
            status.received = received
            onSynced()
        } catch {
            status.state = .error
            status.message = describe(error)
        }
        running = false
        if again {
            again = false
            let w = waiters
            waiters = []
            await syncNow()
            w.forEach { $0.resume() }
        }
    }

    private func describe(_ error: Error) -> String {
        let msg = (error as? SyncError)?.description ?? error.localizedDescription
        let network = (error as? URLError) != nil || msg.range(of: "fetch|network|connect|dns|refused|timed out", options: [.regularExpression, .caseInsensitive]) != nil
        return network ? "Can’t reach \(hosts). Check your internet connection and that the server is reachable (Cloudflare Tunnel, or Tailscale if you use it)." : msg
    }

    private func resetForNewServer() {
        store.requeueAll()
        store.setMeta("cursor", .number(0))
        store.markAllFilesUnsent()
    }

    // MARK: - Connection check

    /// Compares what the server holds with this device, in plain words.
    /// If two devices agree with each other but not with the server, their
    /// changes aren't arriving; if the server count grows but a device's
    /// doesn't, that device isn't pulling.
    public func checkConnection() async -> (ok: Bool, lines: [String]) {
        if let problem = notReady { return (false, [problem]) }
        let here = store.localCounts()
        let cursor = store.meta("cursor")?.number ?? 0
        do {
            let res = try await request("/status", timeout: 15)
            if res.status == 404 {
                return (false, ["The server answered but is an older version without the connection check. Rebuild it with docker compose build --pull --no-cache && docker compose up -d."])
            }
            try Self.check(res, "Connection check failed")
            guard let s = res.json, let records = s["records"]?.number else {
                return (false, ["\(base) answered, but not like a Nextly server. Check the server address."])
            }
            let n = { (k: String) in JS.number(s[k]?.number ?? 0) }
            let lastSeq = s["lastSeq"]?.number ?? 0
            let knownId = store.meta("serverId")?.string
            let serverId = s["serverId"]?.string
            let startedOver = (serverId != nil && knownId != nil && serverId != knownId) || cursor > lastSeq
            var lines = [
                "Connected to \(Self.host(base)).",
                "Server: \(n("tasks")) tasks (\(JS.number(records)) records, latest change #\(n("lastSeq")), \(n("files")) files).",
                "This device: \(here.tasks) tasks (\(here.records) records), has seen up to change #\(JS.number(cursor)), \(here.unsent) not sent yet.",
            ]
            if urls.count > 1 {
                // Each address on its own, so a broken one shows up even while the other works.
                var each: [String] = []
                for u in urls { each.append("\(Self.host(u)): \(await answers(u) ? "answers" : "doesn’t answer")") }
                lines.append("Addresses: \(each.joined(separator: "; ")). Using \(Self.host(base)).")
            }
            if let devices = s["liveDevices"]?.number {
                lines.append("Live updates: \(JS.number(devices)) device\(devices == 1 ? "" : "s") connected to the server\(status.live == .live ? ", including this one" : "; this one isn’t").")
            }
            if startedOver { lines.append("The server has started over since this device last synced (for example, its data volume was recreated). Tap Sync now and this device will send everything it has again.") }
            else if here.unsent > 0 { lines.append("Some changes here haven’t reached the server yet. Tap Sync now.") }
            else if cursor < lastSeq { lines.append("The server has changes this device hasn’t pulled yet. Tap Sync now.") }
            else { lines.append("This device is fully in step with the server.") }
            return (true, lines)
        } catch {
            let msg = (error as? SyncError)?.description ?? error.localizedDescription
            let network = (error as? URLError) != nil || msg.range(of: "fetch|network|connect|dns|refused", options: [.regularExpression, .caseInsensitive]) != nil
            return (false, [network ? "Can’t reach \(hosts). \(msg)" : msg])
        }
    }

    // MARK: - Attachments

    private func uploadFiles() async throws {
        for sha in store.unsentFiles() {
            guard let f = store.file(sha), !f.uploaded else { continue }
            let res = try await request("/files/\(sha)", method: "PUT", body: f.bytes, timeout: 120)
            try Self.check(res, "Couldn’t upload \(f.name)")
            store.setUploaded(sha, true)
        }
    }

    public nonisolated static func sha256(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    /// Stores a picked file locally and queues it for upload. Returns what a note block needs.
    @discardableResult
    public func addFile(_ bytes: Data, name: String, mime: String?) -> (sha: String, name: String, size: Int, mime: String) {
        let sha = Self.sha256(bytes)
        let type = mime?.isEmpty == false ? mime! : "application/octet-stream"
        if store.file(sha) == nil { store.putFile(.init(sha: sha, name: name, mime: type, uploaded: false, bytes: bytes)) }
        Task { await syncNow() }
        return (sha, name, bytes.count, type)
    }

    /// Local copy if we have it, otherwise download it from the server and keep it.
    public func loadFile(_ sha: String, name: String = "", mime: String = "application/octet-stream") async -> Data? {
        if let f = store.file(sha) { return f.bytes }
        if settings.url.isEmpty { return nil }
        guard let res = try? await request("/files/\(sha)", timeout: 120) else { return nil }
        // Never cache an Access login page as the file.
        if !res.ok || Logic.blockedByAccess(status: res.status, contentType: res.contentType, finalUrl: res.url) { return nil }
        store.putFile(.init(sha: sha, name: name, mime: mime, uploaded: true, bytes: res.data))
        return res.data
    }

    /// Short-lived link the system browser can open without the token.
    public func fileLink(_ sha: String, name: String, mime: String) async throws -> String {
        try await uploadFiles()
        let body: JSONValue = ["name": .string(name), "mime": .string(mime)]
        let res = try await request("/files/\(sha)/link", method: "POST", body: body.data(), contentType: "application/json")
        try Self.check(res, "Couldn’t open the file")
        guard let path = res.json?["url"]?.string else { throw SyncError("Couldn’t open the file: the server didn’t send a link.") }
        return base + path
    }

    /// The server's Incident IQ sync status, or nil if the server doesn't say.
    public func iiqStatus() async -> IiqStatus? {
        if notReady != nil { return nil }
        guard let res = try? await request("/iiq/status", timeout: 15), res.status != 404 else { return nil } // older server
        guard (try? Self.check(res, "Incident IQ status")) != nil else { return nil }
        return try? JSONDecoder().decode(IiqStatus.self, from: res.data)
    }
}
