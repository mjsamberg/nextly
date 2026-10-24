// Live updates from the server's /events WebSocket (server/live.js). A port of
// app/src/live.ts. The server says {"type":"changed"} after another device
// syncs, and we sync.
//
// URLSessionWebSocketTask can send the sync token and the Cloudflare Access
// headers, so no ticket is needed. The server sends a heartbeat every 25 s; if
// nothing arrives for 70 s the connection is treated as dead and reopened,
// with backoff up to 30 s.

import Foundation

@MainActor
public final class Live {
    public struct Options {
        /// The server's base address, http(s)://…, asked on each (re)connect.
        public var url: (_ retrying: Bool) async -> String
        /// Includes Authorization.
        public var headers: [String: String]
        public var deviceId: String
        public var onChanged: () -> Void
        public var onConnected: () -> Void
        public var onState: (LiveState, String) -> Void

        public init(url: @escaping (Bool) async -> String, headers: [String: String], deviceId: String,
                    onChanged: @escaping () -> Void, onConnected: @escaping () -> Void, onState: @escaping (LiveState, String) -> Void) {
            self.url = url; self.headers = headers; self.deviceId = deviceId
            self.onChanged = onChanged; self.onConnected = onConnected; self.onState = onState
        }
    }

    /// Seconds of silence before the connection counts as dead.
    public var heartbeatTimeout: TimeInterval = 70
    private let session: URLSession
    private var generation = 0 // bumps on every start/stop so stale callbacks do nothing
    private var socket: URLSessionWebSocketTask?
    private var retryTask: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var options: Options?
    private var attempt = 0

    public init(session: URLSession = .shared) { self.session = session }

    public func stop() {
        generation += 1
        retryTask?.cancel()
        watchdog?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    public func start(_ o: Options) {
        stop()
        options = o
        attempt = 0
        let gen = generation
        Task { await connect(gen) }
    }

    /// ws(s)://<base>/events?device=<id>
    static func wsURL(_ base: String, deviceId: String) -> URL? {
        var b = base
        while b.hasSuffix("/") { b.removeLast() }
        guard var c = URLComponents(string: b + "/events") else { return nil }
        c.scheme = c.scheme == "https" ? "wss" : "ws"
        c.queryItems = [URLQueryItem(name: "device", value: deviceId)]
        return c.url
    }

    private func retry(_ gen: Int, _ why: String) {
        guard gen == generation, let o = options else { return }
        watchdog?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        let delay = min(30, pow(2, Double(attempt)))
        attempt += 1
        o.onState(.retrying, "\(why) Retrying in \(Int(delay.rounded())) s.")
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1e9))
            if Task.isCancelled { return }
            await self?.connect(gen)
        }
    }

    private func alive(_ gen: Int) {
        watchdog?.cancel()
        let timeout = heartbeatTimeout
        watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1e9))
            if Task.isCancelled { return }
            self?.retry(gen, "Live updates went quiet.")
        }
    }

    private func onText(_ gen: Int, _ raw: String) {
        guard gen == generation, let o = options else { return }
        alive(gen)
        guard let msg = try? JSONValue.parse(raw) else { return }
        switch msg["type"]?.string {
        case "hello":
            attempt = 0
            o.onState(.live, "")
            o.onConnected() // catch up on anything missed while disconnected
        case "changed":
            o.onChanged()
        default: break
        }
    }

    private func connect(_ gen: Int) async {
        guard gen == generation, let o = options else { return }
        o.onState(attempt > 0 ? .retrying : .connecting, "")
        let base = await o.url(attempt > 0)
        guard gen == generation else { return }
        guard let url = Self.wsURL(base, deviceId: o.deviceId) else { retry(gen, "Couldn’t open live updates."); return }
        var req = URLRequest(url: url)
        for (k, v) in o.headers { req.setValue(v, forHTTPHeaderField: k) }
        let ws = session.webSocketTask(with: req)
        socket = ws
        ws.resume()
        alive(gen)
        while gen == generation {
            do {
                switch try await ws.receive() {
                case .string(let s): onText(gen, s)
                case .data(let d): onText(gen, String(decoding: d, as: UTF8.self))
                @unknown default: break
                }
            } catch {
                guard gen == generation else { return }
                let status = (ws.response as? HTTPURLResponse)?.statusCode
                let why = status == 401 ? "The server rejected the sync token."
                    : status == 403 ? "Cloudflare Access blocked live updates."
                    : status == nil && ws.closeCode == .invalid ? "Couldn’t open live updates."
                    : "Live updates disconnected."
                retry(gen, why)
                return
            }
        }
    }
}
