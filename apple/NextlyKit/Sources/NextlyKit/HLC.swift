// Hybrid logical clock: "<ms, 15 digits>-<counter, 4 digits>-<deviceId>".
// Sorts correctly as plain text, keeps moving forward even if this device's
// clock is behind another's, and breaks exact ties by device id. A port of
// app/src/hlc.ts.

import Foundation

public final class HLC: @unchecked Sendable {
    private var last: Double = 0
    private var counter = 0
    private var device: String
    private let clock: () -> Date
    private let lock = NSLock()

    public init(device: String = "unknown", clock: @escaping () -> Date = Date.init) {
        self.device = device
        self.clock = clock
    }

    public func setDevice(_ id: String) {
        lock.withLock { device = id }
    }

    private func fmt(_ ms: Double, _ c: Int) -> String {
        let m = String(format: "%.0f", ms), n = String(c)
        return String(repeating: "0", count: max(0, 15 - m.count)) + m + "-"
            + String(repeating: "0", count: max(0, 4 - n.count)) + n + "-" + device
    }

    public func now() -> String {
        lock.withLock {
            let t = JS.ms(clock())
            if t > last { last = t; counter = 0 } else { counter += 1 }
            return fmt(last, counter)
        }
    }

    /// Move the clock past a timestamp seen from another device.
    public func observe(_ h: String) {
        let parts = h.split(separator: "-", omittingEmptySubsequences: false).map { JS.toNumber(.string(String($0))) }
        guard let first = parts.first, let ms = first, ms.isFinite else { return }
        let c = parts.count > 1 ? parts[1] : nil
        lock.withLock {
            if ms > last { last = ms; counter = c.map { Int($0) } ?? 0 }
            else if ms == last, let c, Int(c) > counter { counter = Int(c) }
        }
    }
}
