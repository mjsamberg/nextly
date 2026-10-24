// Pure rules shared by the store and the UI: blocking, Next order, swipes,
// dates, repeats, quick add, request headers and capture links. A port of
// app/src/logic.ts; spec/fixtures holds both to the same cases.

import Foundation

public enum Logic {
    /// A new record id.
    public static func uid() -> String { UUID().uuidString.lowercased() }

    // MARK: - Blocking and order

    public typealias TaskLookup = (String) -> TaskItem?

    /// Open tasks this one is still waiting on. Deleted or missing tasks don't block.
    public static func openBlockers(_ t: TaskItem, _ get: TaskLookup) -> [TaskItem] {
        t.dependsOn.compactMap(get).filter { !$0.done }
    }

    /// True if making `taskId` depend on `depId` would create a loop.
    public static func wouldCycle(_ taskId: String, _ depId: String, _ get: TaskLookup) -> Bool {
        if taskId == depId { return true }
        var seen = Set<String>()
        var stack = [depId]
        while let id = stack.popLast() {
            if id == taskId { return true }
            if !seen.insert(id).inserted { continue }
            if let t = get(id) { stack.append(contentsOf: t.dependsOn) }
        }
        return false
    }

    /// Order value that places a task between two neighbours in Next.
    public static func orderBetween(_ before: Double?, _ after: Double?, now: Double = (Date().timeIntervalSince1970 * 1000).rounded()) -> Double {
        switch (before, after) {
        case (nil, nil): return now
        case (nil, let a?): return a - 1000
        case (let b?, nil): return b + 1000
        case (let b?, let a?): return (b + a) / 2
        }
    }

    /// Swipe right promotes (… → Today → In Progress), swipe left defers. Never touches dates.
    public static func promote(_ f: Flag?) -> Flag {
        f == .today || f == .doing ? .doing : .today
    }

    public static func `defer`(_ f: Flag?) -> Flag {
        switch f {
        case .doing: return .today
        case .today: return .next
        case .next: return .someday
        case .inbox, nil: return .next
        case .someday: return .someday
        }
    }

    // MARK: - Dates (local, YYYY-MM-DD)

    public static func ymd(_ d: Date) -> String {
        let c = JS.calendar.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    /// Local midnight of a YYYY-MM-DD date.
    public static func parseYmd(_ s: String) -> Date {
        let p = s.split(separator: "-", omittingEmptySubsequences: false).map { Int($0) ?? 0 }
        return JS.localDate(p.count > 0 ? p[0] : 0, (p.count > 1 ? p[1] : 1) - 1, p.count > 2 ? p[2] : 1)
    }

    private static func parts(_ d: Date) -> (y: Int, m: Int, d: Int, weekday: Int) {
        let c = JS.calendar.dateComponents([.year, .month, .day, .weekday], from: d)
        return (c.year!, c.month! - 1, c.day!, c.weekday! - 1)
    }

    private static let days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

    /// Parses "today", "tom", "fri", "10/23", "2026-10-23". Weekdays mean the next one, counting today.
    public static func parseDateWord(_ word: String, now: Date = Date()) -> String? {
        let w = word.lowercased()
        let n = parts(now)
        let base = JS.localDate(n.y, n.m, n.d)
        if w == "today" || w == "tod" { return ymd(base) }
        if w == "tom" || w == "tomorrow" { return ymd(JS.localDate(n.y, n.m, n.d + 1)) }
        if let day = days.firstIndex(where: { w.hasPrefix($0) && w.utf16.count >= 3 }) {
            let diff = (day - n.weekday + 7) % 7
            return ymd(JS.localDate(n.y, n.m, n.d + diff))
        }
        if let m = w.wholeMatch(of: #/([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})/#) {
            return ymd(JS.localDate(Int(m.1)!, Int(m.2)! - 1, Int(m.3)!))
        }
        if let m = w.wholeMatch(of: #/([0-9]{1,2})\/([0-9]{1,2})(?:\/([0-9]{2,4}))?/#) {
            var y = m.3.map { Int($0)! } ?? n.y
            if y < 100 { y += 2000 }
            var d = JS.localDate(y, Int(m.1)! - 1, Int(m.2)!)
            if m.3 == nil && d < base { d = JS.localDate(y + 1, Int(m.1)! - 1, Int(m.2)!) }
            return ymd(d)
        }
        return nil
    }

    // MARK: - Repeating tasks

    /// Moves a YYYY-MM-DD date by n days.
    public static func shiftDate(_ s: String, _ n: Int) -> String {
        let d = parts(parseYmd(s))
        return ymd(JS.localDate(d.y, d.m, d.d + n))
    }

    /// Adds months, keeping the day but clamping to the month's end (Jan 31 + 1 month = Feb 28/29).
    static func addMonths(_ s: String, _ n: Int) -> String {
        let d = parts(parseYmd(s))
        let first = parts(JS.localDate(d.y, d.m + n, 1))
        let last = parts(JS.localDate(first.y, first.m + 1, 0)).d
        return ymd(JS.localDate(first.y, first.m, min(d.d, last)))
    }

    private static func weekday(_ s: String) -> Int { parts(parseYmd(s)).weekday }

    /// The first date after `after` that the rule lands on.
    public static func nextOccurrence(_ r: Repeat, after: String) -> String {
        if r.unit == .week, let wd = r.weekdays, !wd.isEmpty {
            // Next chosen weekday; with every > 1, skip whole weeks once the week's days are used.
            var d = after
            for i in 1...7 {
                d = shiftDate(after, i)
                if wd.contains(weekday(d)) { break }
            }
            if r.every > 1 && weekday(d) <= weekday(after) { d = shiftDate(d, 7 * (r.every - 1)) }
            return d
        }
        switch r.unit {
        case .day: return shiftDate(after, r.every)
        case .week: return shiftDate(after, 7 * r.every)
        case .month: return addMonths(after, r.every)
        case .year: return addMonths(after, 12 * r.every)
        }
    }

    /// When the next copy of a finished repeating task should move into Today.
    /// "schedule" counts from where this one was scheduled (start date, else
    /// deadline) and skips any dates already past; "completion" counts from today.
    public static func nextStart(_ r: Repeat, startOn: String?, deadline: String?, today: String) -> String {
        let base = r.from == .completion ? today : (startOn ?? deadline ?? today)
        var next = nextOccurrence(r, after: base)
        var i = 0
        while next <= today && i < 1000 { next = nextOccurrence(r, after: next); i += 1 }
        return next
    }

    /// Days between two YYYY-MM-DD dates.
    public static func daysBetween(_ a: String, _ b: String) -> Int {
        Int(JS.round((parseYmd(b).timeIntervalSince1970 - parseYmd(a).timeIntervalSince1970) / 86400))
    }

    private static let weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    public static func repeatLabel(_ r: Repeat) -> String {
        if r.unit == .week, let wd = r.weekdays, !wd.isEmpty {
            let days = wd.map(String.init).joined(separator: ",")
            let what = days == "1,2,3,4,5" ? "weekday" : wd.map { weekdayNames[$0] }.joined(separator: ", ")
            return r.every == 1 ? "Every \(what)" : "Every \(r.every) weeks on \(what == "weekday" ? "weekdays" : what)"
        }
        let unit = r.every == 1 ? r.unit.rawValue : "\(r.every) \(r.unit.rawValue)s"
        return "Every \(unit)"
    }

    private static let repeatWords: [String: Repeat] = [
        "daily": Repeat(every: 1, unit: .day),
        "weekdays": Repeat(every: 1, unit: .week, weekdays: [1, 2, 3, 4, 5]),
        "weekly": Repeat(every: 1, unit: .week),
        "biweekly": Repeat(every: 2, unit: .week),
        "monthly": Repeat(every: 1, unit: .month),
        "yearly": Repeat(every: 1, unit: .year),
    ]

    /// "*daily", "*weekdays", "*weekly", "*monthly", "*yearly", "*3d", "*2w", "*6m", "*1y".
    public static func parseRepeatWord(_ word: String) -> Repeat? {
        let w = word.lowercased()
        if let r = repeatWords[w] { return r }
        guard let m = w.wholeMatch(of: #/([0-9]{1,3})([dwmy])/#), let n = Int(m.1), n >= 1 else { return nil }
        let unit: Repeat.Unit = ["d": .day, "w": .week, "m": .month, "y": .year][String(m.2)]!
        return Repeat(every: n, unit: unit)
    }

    /// Short label for a deadline chip: "Today", "Tomorrow", "Fri", "Oct 23".
    public static func deadlineLabel(_ s: String, now: Date = Date()) -> String {
        let d = parseYmd(s)
        let n = parts(now)
        let days = Int(JS.round((d.timeIntervalSince1970 - JS.localDate(n.y, n.m, n.d).timeIntervalSince1970) / 86400))
        if days == 0 { return "Today" }
        if days == 1 { return "Tomorrow" }
        let f = DateFormatter()
        if days > 1 && days < 7 { f.setLocalizedDateFormatFromTemplate("EEE"); return f.string(from: d) }
        f.setLocalizedDateFormatFromTemplate(parts(d).y == n.y ? "MMMd" : "MMMdy")
        return f.string(from: d)
    }

    // MARK: - Quick add

    public struct QuickAdd: Hashable, Sendable {
        public var title = ""
        public var flag: Flag?
        public var deadline: String?
        public var startOn: String?
        public var `repeat`: Repeat?
        public var emailUrl: String?

        /// As app/src writes it: fields that weren't given are left out.
        public var json: JSONValue {
            var o: [String: JSONValue] = ["title": .string(title)]
            if let flag { o["flag"] = .string(flag.rawValue) }
            if let deadline { o["deadline"] = .string(deadline) }
            if let startOn { o["startOn"] = .string(startOn) }
            if let r = self.repeat { o["repeat"] = r.json }
            if let emailUrl { o["emailUrl"] = .string(emailUrl) }
            return .object(o)
        }
    }

    private static let flagTokens: [String: Flag] = [
        "t": .today, "today": .today, "n": .next, "next": .next,
        "s": .someday, "someday": .someday, "i": .inbox, "inbox": .inbox,
        "p": .doing, "progress": .doing, "doing": .doing,
    ]

    static func isEmailUrl(_ s: String) -> Bool { s.hasPrefix("https://mail.google.com/") || s.hasPrefix("message:") }

    /// "Reply to Ortiz !t ^fri" -> title "Reply to Ortiz", flag today, deadline <friday>.
    ///   !t !n !p !s !i   flag (Today, Next, In Progress, Someday, Inbox)
    ///   ^fri             deadline
    ///   @mon             start date: waits in Scheduled, moves into Today that day
    ///   *weekly *3d      repeat
    /// A pasted Gmail or Apple Mail link becomes an email block instead of part of the title.
    public static func parseQuickAdd(_ input: String, now: Date = Date()) -> QuickAdd {
        var out = QuickAdd()
        var words: [String] = []
        for w in JS.words(input) {
            let rest = String(w.dropFirst())
            if w.hasPrefix("!"), let flag = flagTokens[rest.lowercased()] { out.flag = flag; continue }
            if w.hasPrefix("^"), let d = parseDateWord(rest, now: now) { out.deadline = d; continue }
            if w.hasPrefix("@"), let d = parseDateWord(rest, now: now) { out.startOn = d; continue }
            if w.hasPrefix("*"), let r = parseRepeatWord(rest) { out.repeat = r; continue }
            if isEmailUrl(w) { out.emailUrl = w; continue }
            words.append(w)
        }
        out.title = words.joined(separator: " ")
        return out
    }

    // MARK: - Extra request headers (Cloudflare Access and similar)

    public struct HeaderRow: Hashable, Codable, Sendable {
        public var name: String
        public var value: String
        public init(name: String, value: String) { self.name = name; self.value = value }
    }

    // Header names the app sets itself, or that the HTTP stack won't let us set.
    private static let reserved: Set<String> = ["authorization", "content-type", "content-length", "host", "connection", "transfer-encoding"]

    /// Checks the rows from Settings. Blank rows are ignored. Returns an error message, or nil.
    public static func checkHeaders(_ rows: [HeaderRow]) -> String? {
        var seen = Set<String>()
        for row in rows {
            let n = JS.trim(row.name)
            if n.isEmpty && JS.trim(row.value).isEmpty { continue }
            if n.isEmpty || n.wholeMatch(of: #/[!#$%&'*+.^_`|~0-9A-Za-z-]+/#) == nil {
                return "“\(n.isEmpty ? "(blank)" : n)” isn’t a valid header name. Use letters, numbers and dashes, like CF-Access-Client-Id."
            }
            if reserved.contains(n.lowercased()) { return "Nextly sets \(n) itself, so it can’t be added here." }
            if seen.contains(n.lowercased()) { return "\(n) is listed twice." }
            if row.value.contains(where: { $0 == "\r" || $0 == "\n" || $0 == "\r\n" }) { return "The value for \(n) can’t contain line breaks." }
            seen.insert(n.lowercased())
        }
        return nil
    }

    public static func headerObject(_ rows: [HeaderRow]) -> [String: String] {
        var out: [String: String] = [:]
        for row in rows where !JS.trim(row.name).isEmpty { out[JS.trim(row.name)] = JS.trim(row.value) }
        return out
    }

    /// Cloudflare Access answers a request without a valid service token with a
    /// 403 or a redirect to its login page instead of reaching the server.
    public static func blockedByAccess(status: Int, contentType: String?, finalUrl: String) -> Bool {
        if finalUrl.contains("cloudflareaccess.com") || finalUrl.contains("/cdn-cgi/access/") { return true }
        return status == 403 || status == 302 || (status == 200 && (contentType?.contains("text/html") ?? false))
    }

    // MARK: - nextly:// capture links

    public struct Capture: Hashable, Sendable {
        public var title: String
        public var flag: Flag
        /// Only Gmail or Apple Mail links become email cards.
        public var emailUrl: String?
        /// Anything else is kept as a plain link in the notes.
        public var otherUrl: String?
        public var note: String

        public var json: JSONValue {
            ["title": .string(title), "flag": .string(flag.rawValue), "emailUrl": .of(emailUrl), "otherUrl": .of(otherUrl), "note": .string(note)]
        }
    }

    /// Reads nextly://add?title=…&url=…&list=…&note=… from the bookmarklet.
    /// Any web page can open a nextly:// link, so this only ever adds a task, caps
    /// every field, and defaults to the Inbox. Returns nil for anything else.
    public static func parseCaptureLink(_ link: String) -> Capture? {
        // Parsed by hand, the way a browser's URL parser reads a non-web scheme.
        guard let colon = link.firstIndex(of: ":"), link[..<colon].lowercased() == "nextly" else { return nil }
        var rest = String(link[link.index(after: colon)...])
        if let hash = rest.firstIndex(of: "#") { rest = String(rest[..<hash]) }
        var query = ""
        if let q = rest.firstIndex(of: "?") { query = String(rest[rest.index(after: q)...]); rest = String(rest[..<q]) }
        // Browsers and Windows may hand it over as nextly://add, nextly://add/ or nextly:add.
        var place = rest
        if rest.hasPrefix("//") {
            let auth = rest.dropFirst(2)
            let host = auth.prefix { $0 != "/" }
            place = host.isEmpty ? String(auth) : String(host)
        }
        let action = place.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
        guard action == "add" else { return nil }
        let q = formParams(query)
        func clip(_ s: String?, _ n: Int) -> String { JS.slice(JS.words(s ?? "").joined(separator: " "), n) }
        let url = clip(q["url"], 2000)
        let isEmail = isEmailUrl(url)
        let isWeb = url.hasPrefix("http://") || url.hasPrefix("https://")
        let list = q["list"]
        let title = clip(q["title"], 500).isEmpty ? (isEmail ? "Email" : "") : clip(q["title"], 500)
        if title.isEmpty { return nil }
        return Capture(
            title: title,
            flag: list == "today" ? .today : list == "next" ? .next : list == "someday" ? .someday : .inbox,
            emailUrl: isEmail ? url : nil,
            otherUrl: !isEmail && isWeb ? url : nil,
            note: JS.slice(JS.trim(q["note"] ?? ""), 5000)
        )
    }

    /// application/x-www-form-urlencoded, first value per name (URLSearchParams.get).
    static func formParams(_ query: String) -> [String: String] {
        var out: [String: String] = [:]
        for pair in query.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let decode = { (s: Substring) in
                let plus = s.replacingOccurrences(of: "+", with: " ")
                return plus.removingPercentEncoding ?? plus
            }
            let k = decode(kv[0])
            if out[k] == nil { out[k] = kv.count > 1 ? decode(kv[1]) : "" }
        }
        return out
    }

    public static func noteText(_ t: TaskData) -> String {
        t.notes.map { b in [b.text, b.subject, b.name].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ") }.joined(separator: " ")
    }
}
