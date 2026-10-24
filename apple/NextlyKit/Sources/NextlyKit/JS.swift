// The few JavaScript conversions the TypeScript rules lean on (String(x),
// Number(x), truthiness, Date.parse, new Date(y, m, d)), so the ports here
// read records exactly as app/src does.

import Foundation

enum JS {
    /// `String(x)`.
    static func string(_ v: JSONValue) -> String {
        switch v {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return number(n)
        case .string(let s): return s
        case .array(let a): return a.map { $0.isNull ? "" : string($0) }.joined(separator: ",")
        case .object: return "[object Object]"
        }
    }

    /// How JavaScript prints a number.
    static func number(_ n: Double) -> String {
        if n.isNaN { return "NaN" }
        if n.isInfinite { return n > 0 ? "Infinity" : "-Infinity" }
        if n.rounded() == n, abs(n) < 1e21 { return String(format: "%.0f", n) }
        return "\(n)"
    }

    /// `Number(x)`; nil for NaN.
    static func toNumber(_ v: JSONValue?) -> Double? {
        switch v {
        case nil: return nil
        case .null: return 0
        case .bool(let b): return b ? 1 : 0
        case .number(let n): return n.isNaN ? nil : n
        case .string(let s):
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { return 0 }
            return Double(t).flatMap { $0.isNaN ? nil : $0 }
        case .array(let a):
            if a.isEmpty { return 0 }
            return a.count == 1 ? toNumber(.string(string(a[0]))) : nil
        case .object: return nil
        }
    }

    /// `!!x`.
    static func truthy(_ v: JSONValue?) -> Bool {
        switch v {
        case nil, .null: return false
        case .bool(let b): return b
        case .number(let n): return n != 0 && !n.isNaN
        case .string(let s): return !s.isEmpty
        case .array, .object: return true
        }
    }

    /// `Math.round`: halves go up.
    static func round(_ n: Double) -> Double { (n + 0.5).rounded(.down) }

    static var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = .current
        return c
    }

    /// `new Date(y, m, d, h, min)` in local time; out-of-range months and days roll over.
    static func localDate(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 0, _ min: Int = 0) -> Date {
        let cal = calendar
        let first = cal.date(from: DateComponents(year: y, month: 1, day: 1))!
        let month = cal.date(byAdding: .month, value: m, to: first)!
        let day = cal.date(byAdding: .day, value: d - 1, to: month)!
        return cal.date(byAdding: DateComponents(hour: h, minute: min), to: day)!
    }

    /// `Date.parse` for the ISO forms records use: a date alone is UTC
    /// midnight, a date and time without an offset is local. nil for NaN.
    static func parseDate(_ s: String) -> Double? {
        let pattern = #/^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,9}))?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?$/#
        guard let m = s.wholeMatch(of: pattern) else { return nil }
        let y = Int(m.1)!, mo = Int(m.2)!, d = Int(m.3)!
        guard (1...12).contains(mo), (1...31).contains(d) else { return nil }
        var comps = DateComponents(year: y, month: mo, day: d)
        var cal = Calendar(identifier: .gregorian)
        var ms = 0.0
        if let h = m.4 {
            comps.hour = Int(h)!
            comps.minute = Int(m.5!)!
            comps.second = m.6.map { Int($0)! } ?? 0
            if let frac = m.7 { ms = (Double("0." + frac)! * 1000).rounded(.down) }
            if let z = m.8 {
                if z == "Z" { cal.timeZone = TimeZone(identifier: "UTC")! } else {
                    let sign = z.first == "-" ? -1 : 1
                    let hh = Int(z.dropFirst().prefix(2))!, mm = Int(z.suffix(2))!
                    cal.timeZone = TimeZone(secondsFromGMT: sign * (hh * 3600 + mm * 60))!
                }
            } else {
                cal.timeZone = .current
            }
        } else {
            cal.timeZone = TimeZone(identifier: "UTC")!
        }
        guard let date = cal.date(from: comps), cal.component(.day, from: date) == d else { return nil }
        return (date.timeIntervalSince1970 * 1000).rounded() + ms
    }

    /// `date.toISOString()`.
    static func iso(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: date)
    }

    /// `date.getTime()`.
    static func ms(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }

    /// `s.slice(0, n)`, counting UTF-16 units like JavaScript.
    static func slice(_ s: String, _ n: Int) -> String {
        let u = s.utf16
        guard u.count > n else { return s }
        return String(u.prefix(n)) ?? String(s.prefix(n))
    }

    /// `s.trim()`.
    static func trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// `s.trim().split(/\s+/)` without empty words, or `replace(/\s+/g, ' ')`.
    static func words(_ s: String) -> [String] { s.split(whereSeparator: { $0.isWhitespace }).map(String.init) }
}
