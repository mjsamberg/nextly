// Port of app/src/logic.ts: pure rules shared by the store and the UI.
// Records stay JSON; normTask returns the normalized task as a JsonObject,
// keeping fields this app doesn't know (spec/protocol.md, "Unknown fields").

using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Nextly.Core;

/// <summary>How a task repeats (normalized; see Logic.NormRepeat).</summary>
public sealed record RepeatRule(double Every, string Unit, IReadOnlyList<double> Weekdays, string From)
{
    public static RepeatRule? Parse(JsonNode? normalized)
    {
        if (normalized is not JsonObject o || Js.AsString(o["unit"]) is not { } unit) return null;
        var days = o["weekdays"] is JsonArray a ? a.Select((x) => Js.Number(x)).ToList() : new List<double>();
        return new RepeatRule(Js.Number(o["every"]), unit, days, Js.AsString(o["from"]) ?? "schedule");
    }
}

public static class Logic
{
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public static readonly string[] Flags = ["inbox", "doing", "today", "next", "someday"];
    static readonly string[] Units = ["day", "week", "month", "year"];
    static readonly HashSet<string> BlockTypes = ["heading", "paragraph", "checklist", "quote", "divider", "image", "file", "email"];

    public static string Uid() => Guid.NewGuid().ToString();

    /// <summary>Keys an app doesn't know, kept so another app's fields aren't erased.</summary>
    static JsonObject Extras(JsonNode? o, string[] known)
    {
        var outp = new JsonObject();
        if (o is JsonObject obj) foreach (var (k, v) in obj) if (!known.Contains(k)) outp[k] = Js.Clone(v);
        return outp;
    }

    static JsonObject NormBlock(JsonNode? b, int i)
    {
        var type = Js.Has(b, "type", out var t) ? Js.AsString(t) : null;
        var outp = Js.Spread(b);
        outp["id"] = Js.Has(b, "id", out var id) && id is not null ? Js.Str(id) : $"b{i}";
        outp["type"] = type == "text" ? "paragraph" : type is not null && BlockTypes.Contains(type) ? type : "paragraph";
        return outp;
    }

    static readonly string[] RepeatKeys = ["every", "unit", "weekdays", "from"];

    public static JsonObject? NormRepeat(JsonNode? r)
    {
        if (r is not JsonObject o || Js.AsString(o["unit"]) is not { } unit || !Units.Contains(unit)) return null;
        var raw = Js.Has(o, "every", out var e) ? Js.Number(e) : double.NaN;
        var n = double.IsNaN(raw) || raw == 0 ? 1 : raw;
        var every = Math.Min(365, Math.Max(1, Js.Round(n)));
        var days = new List<double>();
        if (o["weekdays"] is JsonArray wa)
        {
            foreach (var x in wa)
            {
                var d = x is null ? 0 : Js.Number(x);
                if (d >= 0 && d <= 6 && !days.Contains(d)) days.Add(d);
            }
            // Array.prototype.sort with no comparator sorts by the numbers' text.
            days = Js.Sorted(days, (a, b) => Js.Cmp(Js.Num(a), Js.Num(b)));
        }
        var outp = Extras(o, RepeatKeys);
        outp["every"] = every;
        outp["unit"] = unit;
        if (unit == "week" && days.Count > 0) outp["weekdays"] = new JsonArray(days.Select((d) => (JsonNode)d).ToArray());
        outp["from"] = Js.AsString(o["from"]) == "completion" ? "completion" : "schedule";
        return outp;
    }

    // Task fields this app knows. `links` and `list` are older forms, folded into
    // notes and flag; `id` belongs to the record, never its data.
    static readonly string[] TaskKeys = ["title", "flag", "projectId", "parentId", "deadline", "startOn", "repeat", "nextId", "external",
        "done", "doneAt", "order", "dependsOn", "notes", "createdAt", "links", "list", "id"];

    /// <summary>Reads a task record, tolerating older or partial ones.</summary>
    public static JsonObject NormTask(JsonNode? d)
    {
        var notes = new JsonArray();
        if (d is JsonObject && d["notes"] is JsonArray na) for (var i = 0; i < na.Count; i++) notes.Add(NormBlock(na[i], i));
        if (d is JsonObject && d["links"] is JsonArray la)
        {
            for (var i = 0; i < la.Count; i++)
            {
                var link = new JsonObject { ["id"] = $"link{i}", ["type"] = "email" };
                if (Js.Has(la[i], "url", out var u)) link["url"] = Js.Clone(u);
                if (Js.Has(la[i], "subject", out var s)) link["subject"] = Js.Clone(s);
                notes.Add(link);
            }
        }
        var flagRaw = Js.Has(d, "flag", out var f) ? Js.AsString(f) : null;
        string? flag = flagRaw is not null && Flags.Contains(flagRaw) ? flagRaw
            : Js.Has(d, "list", out var l) && Js.AsString(l) == "inbox" ? "inbox" : null;

        JsonNode? external = null;
        if (Js.Has(d, "external", out var ext) && Js.AsString(Js.Get(ext, "source")) == "iiq" && Js.Truthy(Js.Get(ext, "id")))
        {
            external = Js.Merge(new JsonObject
            {
                ["number"] = null, ["url"] = null, ["status"] = null, ["closed"] = false, ["requester"] = null,
                ["location"] = null, ["issue"] = null, ["priority"] = null, ["syncedAt"] = null,
            }, (JsonObject)ext!);
        }

        double order;
        if (Js.Has(d, "order", out var o) && Js.IsNumber(o, out var on)) order = on;
        else
        {
            var created = Js.Has(d, "createdAt", out var c) && c is not null ? Js.Str(c) : "";
            var ms = Js.DateParse(created);
            order = double.IsNaN(ms) || ms == 0 ? 0 : ms;
        }

        var dependsOn = new JsonArray();
        if (d is JsonObject && d["dependsOn"] is JsonArray da) foreach (var x in da) dependsOn.Add(Js.Str(x));

        var t = Extras(d, TaskKeys);
        t["title"] = Js.Has(d, "title", out var title) && title is not null ? Js.Str(title) : "";
        t["flag"] = flag;
        t["projectId"] = Js.Get(d, "projectId");
        t["parentId"] = Js.Get(d, "parentId");
        t["deadline"] = Js.AsString(Js.Get(d, "deadline"));
        t["startOn"] = Js.AsString(Js.Get(d, "startOn"));
        t["repeat"] = NormRepeat(Js.Get(d, "repeat"));
        t["nextId"] = Js.AsString(Js.Get(d, "nextId"));
        t["external"] = external;
        t["done"] = Js.Truthy(Js.Get(d, "done"));
        t["doneAt"] = Js.Get(d, "doneAt");
        t["order"] = order;
        t["dependsOn"] = dependsOn;
        t["notes"] = notes;
        t["createdAt"] = Js.Get(d, "createdAt") ?? Js.Iso(0);
        return t;
    }

    /// <summary>Open tasks this one is still waiting on. Deleted or missing tasks don't block.</summary>
    public static List<TaskItem> OpenBlockers(TaskItem t, Func<string, TaskItem?> get) =>
        t.DependsOn.Select(get).Where((d) => d is not null && !d.Done).Select((d) => d!).ToList();

    /// <summary>True if making `taskId` depend on `depId` would create a loop.</summary>
    public static bool WouldCycle(string taskId, string depId, Func<string, TaskItem?> get)
    {
        if (taskId == depId) return true;
        var seen = new HashSet<string>();
        var stack = new Stack<string>([depId]);
        while (stack.Count > 0)
        {
            var id = stack.Pop();
            if (id == taskId) return true;
            if (!seen.Add(id)) continue;
            if (get(id) is { } t) foreach (var x in t.DependsOn) stack.Push(x);
        }
        return false;
    }

    /// <summary>Order value that places a task between two neighbours in Next.</summary>
    public static double OrderBetween(double? before, double? after, double now)
    {
        if (before is null && after is null) return now;
        if (before is null) return after!.Value - 1000;
        if (after is null) return before.Value + 1000;
        return (before.Value + after.Value) / 2;
    }

    /// <summary>Swipe right promotes (â€¦ â†’ Today â†’ In Progress).</summary>
    public static string? Promote(string? f) => f is "today" or "doing" ? "doing" : "today";

    /// <summary>Swipe left defers. Never touches dates.</summary>
    public static string? Defer(string? f) => f switch
    {
        "doing" => "today",
        "today" => "next",
        "next" => "someday",
        "inbox" or null => "next",
        _ => "someday",
    };

    // ---------- dates (local, YYYY-MM-DD) ----------

    public const string BadDate = "NaN-NaN-NaN";

    public static string Ymd(DateOnly d) => $"{d.Year}-{d.Month:00}-{d.Day:00}";

    /// <summary>`new Date(y, m, d)`: months and days roll over, like JavaScript.</summary>
    static DateOnly? MakeDate(double y, double m, double d)
    {
        if (double.IsNaN(y) || double.IsNaN(m) || double.IsNaN(d) || double.IsInfinity(y) || double.IsInfinity(m) || double.IsInfinity(d)) return null;
        var yi = (long)Math.Truncate(y);
        if (yi is >= 0 and <= 99) yi += 1900;
        var totalMonths = yi * 12 + (long)Math.Truncate(m);
        var year = (int)Math.Floor(totalMonths / 12.0);
        var month = (int)(totalMonths - (long)year * 12);
        if (year < 1 || year > 9999) return null;
        try { return new DateOnly(year, month + 1, 1).AddDays((int)Math.Truncate(d) - 1); }
        catch (ArgumentOutOfRangeException) { return null; }
    }

    public static DateOnly? ParseYmd(string s)
    {
        var p = s.Split('-').Select(Js.Number).ToArray();
        if (p.Length < 3) return null;
        return MakeDate(p[0], p[1] - 1, p[2]);
    }

    static readonly string[] Days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    static readonly Regex IsoWord = new("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})$");
    static readonly Regex UsWord = new("^([0-9]{1,2})/([0-9]{1,2})(?:/([0-9]{2,4}))?$");

    /// <summary>Parses "today", "tom", "fri", "10/23", "2026-10-23". Weekdays mean the next one, counting today.</summary>
    public static string? ParseDateWord(string word, DateOnly today)
    {
        var w = word.ToLowerInvariant();
        if (w is "today" or "tod") return Ymd(today);
        if (w is "tom" or "tomorrow") return Ymd(today.AddDays(1));
        var day = Array.FindIndex(Days, (d) => w.StartsWith(d, StringComparison.Ordinal) && w.Length >= 3);
        if (day >= 0)
        {
            var diff = (day - (int)today.DayOfWeek + 7) % 7;
            return Ymd(today.AddDays(diff));
        }
        var m = IsoWord.Match(w);
        if (m.Success) return MakeDate(Js.Number(m.Groups[1].Value), Js.Number(m.Groups[2].Value) - 1, Js.Number(m.Groups[3].Value)) is { } iso ? Ymd(iso) : BadDate;
        m = UsWord.Match(w);
        if (m.Success)
        {
            var y = m.Groups[3].Success ? Js.Number(m.Groups[3].Value) : today.Year;
            if (y < 100) y += 2000;
            var d = MakeDate(y, Js.Number(m.Groups[1].Value) - 1, Js.Number(m.Groups[2].Value));
            if (d is null) return BadDate;
            if (!m.Groups[3].Success && d.Value < today) d = MakeDate(y + 1, Js.Number(m.Groups[1].Value) - 1, Js.Number(m.Groups[2].Value));
            return d is { } dd ? Ymd(dd) : BadDate;
        }
        return null;
    }

    // ---------- repeating tasks ----------

    /// <summary>Moves a YYYY-MM-DD date by n days.</summary>
    public static string ShiftDate(string s, double n) =>
        ParseYmd(s) is { } d && MakeDate(d.Year, d.Month - 1, d.Day + n) is { } r ? Ymd(r) : BadDate;

    /// <summary>Adds months, clamping to the month's end (Jan 31 + 1 month = Feb 28/29).</summary>
    static string AddMonths(string s, double n)
    {
        if (ParseYmd(s) is not { } d || MakeDate(d.Year, d.Month - 1 + n, 1) is not { } first) return BadDate;
        var last = DateTime.DaysInMonth(first.Year, first.Month);
        return Ymd(new DateOnly(first.Year, first.Month, Math.Min(d.Day, last)));
    }

    static int DayOfWeek(string s) => ParseYmd(s) is { } d ? (int)d.DayOfWeek : -1;

    /// <summary>The first date after `after` that the rule lands on.</summary>
    public static string NextOccurrence(RepeatRule r, string after)
    {
        if (r.Unit == "week" && r.Weekdays.Count > 0)
        {
            // Next chosen weekday; with every > 1, skip whole weeks once the week's days are used.
            var d = after;
            for (var i = 1; i <= 7; i++)
            {
                d = ShiftDate(after, i);
                if (r.Weekdays.Contains(DayOfWeek(d))) break;
            }
            if (r.Every > 1 && DayOfWeek(d) <= DayOfWeek(after)) d = ShiftDate(d, 7 * (r.Every - 1));
            return d;
        }
        return r.Unit switch
        {
            "day" => ShiftDate(after, r.Every),
            "week" => ShiftDate(after, 7 * r.Every),
            "month" => AddMonths(after, r.Every),
            _ => AddMonths(after, 12 * r.Every),
        };
    }

    /// <summary>
    /// When the next copy of a finished repeating task should move into Today.
    /// "schedule" counts from where this one was scheduled (start date, else
    /// deadline) and skips dates already past; "completion" counts from today.
    /// </summary>
    public static string NextStart(RepeatRule r, string? startOn, string? deadline, string today)
    {
        var b = r.From == "completion" ? today : startOn ?? deadline ?? today;
        var next = NextOccurrence(r, b);
        for (var i = 0; Js.Cmp(next, today) <= 0 && i < 1000; i++) next = NextOccurrence(r, next);
        return next;
    }

    /// <summary>Days between two YYYY-MM-DD dates.</summary>
    public static double DaysBetween(string a, string b) =>
        ParseYmd(a) is { } x && ParseYmd(b) is { } y ? y.DayNumber - x.DayNumber : double.NaN;

    static readonly string[] WeekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    public static string RepeatLabel(RepeatRule r)
    {
        if (r.Unit == "week" && r.Weekdays.Count > 0)
        {
            var days = string.Join(",", r.Weekdays.Select(Js.Num));
            var what = days == "1,2,3,4,5" ? "weekday" : string.Join(", ", r.Weekdays.Select((d) => d >= 0 && d <= 6 && d == Math.Floor(d) ? WeekdayNames[(int)d] : ""));
            return r.Every == 1 ? $"Every {what}" : $"Every {Js.Num(r.Every)} weeks on {(what == "weekday" ? "weekdays" : what)}";
        }
        var unit = r.Every == 1 ? r.Unit : $"{Js.Num(r.Every)} {r.Unit}s";
        return $"Every {unit}";
    }

    static JsonObject? RepeatWord(string w) => w switch
    {
        "daily" => new JsonObject { ["every"] = 1, ["unit"] = "day" },
        "weekdays" => new JsonObject { ["every"] = 1, ["unit"] = "week", ["weekdays"] = new JsonArray(1, 2, 3, 4, 5) },
        "weekly" => new JsonObject { ["every"] = 1, ["unit"] = "week" },
        "biweekly" => new JsonObject { ["every"] = 2, ["unit"] = "week" },
        "monthly" => new JsonObject { ["every"] = 1, ["unit"] = "month" },
        "yearly" => new JsonObject { ["every"] = 1, ["unit"] = "year" },
        _ => null,
    };

    static readonly Regex RepeatNum = new("^([0-9]{1,3})([dwmy])$");

    /// <summary>"*daily", "*weekdays", "*weekly", "*monthly", "*yearly", "*3d", "*2w", "*6m", "*1y".</summary>
    public static JsonObject? ParseRepeatWord(string word)
    {
        var w = word.ToLowerInvariant();
        if (RepeatWord(w) is { } r) { r["from"] = "schedule"; return r; }
        var m = RepeatNum.Match(w);
        if (!m.Success || Js.Number(m.Groups[1].Value) < 1) return null;
        var unit = m.Groups[2].Value switch { "d" => "day", "w" => "week", "m" => "month", _ => "year" };
        return new JsonObject { ["every"] = Js.Number(m.Groups[1].Value), ["unit"] = unit, ["from"] = "schedule" };
    }

    /// <summary>Short label for a deadline chip: "Today", "Tomorrow", "Fri", "Oct 23".</summary>
    public static string DeadlineLabel(string s, DateOnly today)
    {
        if (ParseYmd(s) is not { } d) return s;
        var days = d.DayNumber - today.DayNumber;
        if (days == 0) return "Today";
        if (days == 1) return "Tomorrow";
        var dt = d.ToDateTime(TimeOnly.MinValue);
        if (days > 1 && days < 7) return dt.ToString("ddd", CultureInfo.CurrentCulture);
        return dt.ToString(d.Year == today.Year ? "MMM d" : "MMM d, yyyy", CultureInfo.CurrentCulture);
    }

    // ---------- quick add ----------

    static string? FlagToken(string t) => t switch
    {
        "t" or "today" => "today",
        "n" or "next" => "next",
        "s" or "someday" => "someday",
        "i" or "inbox" => "inbox",
        "p" or "progress" or "doing" => "doing",
        _ => null,
    };

    static readonly Regex Gmail = new("^https://mail\\.google\\.com/");
    static readonly Regex AppleMail = new("^message:");
    static readonly Regex Spaces = new("\\s+");

    /// <summary>
    /// "Reply to Ortiz !t ^fri" â†’ { title, flag: "today", deadline: &lt;friday&gt; }.
    /// !t !n !p !s !i flag, ^date deadline, @date start, *weekly repeat; a pasted
    /// Gmail or Apple Mail link becomes an email block.
    /// </summary>
    public static JsonObject ParseQuickAdd(string input, DateOnly today)
    {
        var outp = new JsonObject { ["title"] = "" };
        var words = new List<string>();
        foreach (var w in Spaces.Split(input.Trim()))
        {
            if (w.Length == 0) continue;
            if (w.StartsWith('!') && FlagToken(w[1..].ToLowerInvariant()) is { } flag) { outp["flag"] = flag; continue; }
            if (w.StartsWith('^') && ParseDateWord(w[1..], today) is { } dl) { outp["deadline"] = dl; continue; }
            if (w.StartsWith('@') && ParseDateWord(w[1..], today) is { } st) { outp["startOn"] = st; continue; }
            if (w.StartsWith('*') && ParseRepeatWord(w[1..]) is { } rp) { outp["repeat"] = rp; continue; }
            if (Gmail.IsMatch(w) || AppleMail.IsMatch(w)) { outp["emailUrl"] = w; continue; }
            words.Add(w);
        }
        outp["title"] = string.Join(" ", words);
        return outp;
    }

    // ---------- extra request headers (Cloudflare Access and similar) ----------

    public sealed record HeaderRow(string Name, string Value);

    static readonly HashSet<string> Reserved = ["authorization", "content-type", "content-length", "host", "connection", "transfer-encoding"];
    static readonly Regex HeaderName = new("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$");

    /// <summary>Checks the rows from Settings. Blank rows are ignored.</summary>
    public static string? CheckHeaders(IEnumerable<HeaderRow> rows)
    {
        var seen = new HashSet<string>();
        foreach (var (name, value) in rows)
        {
            var n = name.Trim();
            if (n.Length == 0 && value.Trim().Length == 0) continue;
            if (!HeaderName.IsMatch(n)) return $"â€œ{(n.Length > 0 ? n : "(blank)")}â€ isnâ€™t a valid header name. Use letters, numbers and dashes, like CF-Access-Client-Id.";
            if (Reserved.Contains(n.ToLowerInvariant())) return $"Nextly sets {n} itself, so it canâ€™t be added here.";
            if (seen.Contains(n.ToLowerInvariant())) return $"{n} is listed twice.";
            if (value.Contains('\r') || value.Contains('\n')) return $"The value for {n} canâ€™t contain line breaks.";
            seen.Add(n.ToLowerInvariant());
        }
        return null;
    }

    public static Dictionary<string, string> HeaderObject(IEnumerable<HeaderRow> rows)
    {
        var outp = new Dictionary<string, string>();
        foreach (var (name, value) in rows) if (name.Trim().Length > 0) outp[name.Trim()] = value.Trim();
        return outp;
    }

    static readonly Regex AccessUrl = new("cloudflareaccess\\.com|/cdn-cgi/access/");

    /// <summary>Cloudflare Access answers without a valid service token with a 403 or its login page.</summary>
    public static bool BlockedByAccess(int status, string? contentType, string finalUrl)
    {
        if (AccessUrl.IsMatch(finalUrl)) return true;
        return status == 403 || status == 302 || (status == 200 && !string.IsNullOrEmpty(contentType) && contentType.Contains("text/html"));
    }

    // ---------- nextly:// capture links ----------

    static readonly Regex Web = new("^https?://");

    /// <summary>
    /// Reads nextly://add?title=â€¦&amp;url=â€¦&amp;list=â€¦&amp;note=â€¦ from the bookmarklet.
    /// Any web page can open a nextly:// link, so this only adds a task, caps
    /// every field, and defaults to the Inbox. Null for anything else.
    /// </summary>
    public static JsonObject? ParseCaptureLink(string link)
    {
        if (CaptureUrl.Parse(link) is not { } u || u.Scheme != "nextly") return null;
        var action = (u.Host.Length > 0 ? u.Host : u.Path).Trim('/').ToLowerInvariant();
        if (action != "add") return null;
        string Clip(string? s, int n) { var c = Spaces.Replace(s ?? "", " ").Trim(); return c.Length > n ? c[..n] : c; }
        var url = Clip(u.Get("url"), 2000);
        var isEmail = Gmail.IsMatch(url) || AppleMail.IsMatch(url);
        var isWeb = Web.IsMatch(url);
        var list = u.Get("list");
        var title = Clip(u.Get("title"), 500);
        if (title.Length == 0 && isEmail) title = "Email";
        if (title.Length == 0) return null;
        var note = (u.Get("note") ?? "").Trim();
        return new JsonObject
        {
            ["title"] = title,
            ["flag"] = list is "today" or "next" or "someday" ? list : "inbox",
            ["emailUrl"] = isEmail ? url : null,
            ["otherUrl"] = !isEmail && isWeb ? url : null,
            ["note"] = note.Length > 5000 ? note[..5000] : note,
        };
    }

    public static string NoteText(TaskItem t) =>
        string.Join(" ", t.Notes.Select((b) => string.Join(" ", new[] { Js.Get(b, "text"), Js.Get(b, "subject"), Js.Get(b, "name") }
            .Where(Js.Truthy).Select(Js.Str))));
}

/// <summary>Just enough of the WHATWG URL parser for nextly: links.</summary>
sealed class CaptureUrl
{
    public string Scheme = "", Host = "", Path = "";
    readonly List<(string, string)> query = [];

    public string? Get(string key) => query.FirstOrDefault((p) => p.Item1 == key) is var (k, v) && k is not null ? v : null;

    static readonly Regex SchemeRe = new("^([a-zA-Z][a-zA-Z0-9+.-]*):");

    public static CaptureUrl? Parse(string input)
    {
        var s = input.Trim(' ', '\u0000', '\u0001', '\u0002', '\u0003', '\u0004', '\u0005', '\u0006', '\u0007', '\b', '\t', '\n', '\v', '\f', '\r',
            '\u000e', '\u000f', '\u0010', '\u0011', '\u0012', '\u0013', '\u0014', '\u0015', '\u0016', '\u0017', '\u0018', '\u0019', '\u001a', '\u001b', '\u001c', '\u001d', '\u001e', '\u001f')
            .Replace("\t", "").Replace("\n", "").Replace("\r", "");
        var m = SchemeRe.Match(s);
        if (!m.Success) return null;
        var u = new CaptureUrl { Scheme = m.Groups[1].Value.ToLowerInvariant() };
        var rest = s[m.Length..];
        var hash = rest.IndexOf('#');
        if (hash >= 0) rest = rest[..hash];
        var q = rest.IndexOf('?');
        var query = q >= 0 ? rest[(q + 1)..] : null;
        if (q >= 0) rest = rest[..q];
        if (rest.StartsWith("//"))
        {
            var auth = rest[2..];
            var slash = auth.IndexOf('/');
            u.Path = slash >= 0 ? auth[slash..] : "";
            auth = slash >= 0 ? auth[..slash] : auth;
            var at = auth.LastIndexOf('@');
            if (at >= 0) auth = auth[(at + 1)..];
            var colon = auth.LastIndexOf(':');
            if (colon >= 0) auth = auth[..colon];
            u.Host = auth;
        }
        else u.Path = rest;
        if (query is not null)
        {
            foreach (var part in query.Split('&'))
            {
                if (part.Length == 0) continue;
                var eq = part.IndexOf('=');
                var k = eq >= 0 ? part[..eq] : part;
                var v = eq >= 0 ? part[(eq + 1)..] : "";
                u.query.Add((Decode(k), Decode(v)));
            }
        }
        return u;
    }

    /// <summary>application/x-www-form-urlencoded decoding: + is a space, %XX bytes as UTF-8.</summary>
    static string Decode(string s)
    {
        var bytes = new List<byte>();
        var raw = Encoding.UTF8.GetBytes(s.Replace('+', ' '));
        for (var i = 0; i < raw.Length; i++)
        {
            if (raw[i] == '%' && i + 2 < raw.Length && Uri.IsHexDigit((char)raw[i + 1]) && Uri.IsHexDigit((char)raw[i + 2]))
            {
                bytes.Add(Convert.ToByte(Encoding.ASCII.GetString(raw, i + 1, 2), 16));
                i += 2;
            }
            else bytes.Add(raw[i]);
        }
        return Encoding.UTF8.GetString(bytes.ToArray());
    }
}
