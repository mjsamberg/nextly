// The few JavaScript conversions the TypeScript rules lean on (String(x),
// Number(x), truthiness, Date.parse, spreading objects), so this port reads
// records exactly as app/src does. Record data stays JSON (System.Text.Json
// nodes): fields this app doesn't know pass through untouched.

using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Nextly.Core;

public static class Js
{
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public static JsonValueKind Kind(JsonNode? v) => v is null ? JsonValueKind.Null : v.GetValueKind();

    public static bool IsString(JsonNode? v, out string s)
    {
        if (v is JsonValue jv && jv.GetValueKind() == JsonValueKind.String) { s = jv.GetValue<string>(); return true; }
        s = "";
        return false;
    }

    public static string? AsString(JsonNode? v) => IsString(v, out var s) ? s : null;

    /// <summary>A JSON number as a double, whether it was parsed or made from an int, long or double.</summary>
    static double D(JsonNode v)
    {
        var jv = v.AsValue();
        if (jv.TryGetValue<double>(out var d)) return d;
        if (jv.TryGetValue<long>(out var l)) return l;
        if (jv.TryGetValue<int>(out var i)) return i;
        if (jv.TryGetValue<decimal>(out var m)) return (double)m;
        if (jv.TryGetValue<float>(out var f)) return f;
        return double.NaN;
    }

    public static bool IsNumber(JsonNode? v, out double n)
    {
        if (v is JsonValue jv && jv.GetValueKind() == JsonValueKind.Number) { n = D(jv); return true; }
        n = double.NaN;
        return false;
    }

    /// <summary>`o.key`: whether the key is there (JSON null counts as there), and its value.</summary>
    public static bool Has(JsonNode? o, string key, out JsonNode? v)
    {
        if (o is JsonObject obj && obj.TryGetPropertyValue(key, out v)) return true;
        v = null;
        return false;
    }

    /// <summary>`o?.key ?? null`, cloned.</summary>
    public static JsonNode? Get(JsonNode? o, string key) => Has(o, key, out var v) ? Clone(v) : null;

    public static JsonNode? Clone(JsonNode? v) => v?.DeepClone();

    /// <summary>`!!x`.</summary>
    public static bool Truthy(JsonNode? v) => Kind(v) switch
    {
        JsonValueKind.Null => false,
        JsonValueKind.False => false,
        JsonValueKind.True => true,
        JsonValueKind.Number => IsNumber(v, out var n) && n != 0 && !double.IsNaN(n),
        JsonValueKind.String => AsString(v)!.Length > 0,
        _ => true,
    };

    /// <summary>`String(x)` (not for undefined).</summary>
    public static string Str(JsonNode? v) => Kind(v) switch
    {
        JsonValueKind.Null => "null",
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        JsonValueKind.Number => Num(D(v!)),
        JsonValueKind.String => AsString(v)!,
        JsonValueKind.Array => string.Join(",", v!.AsArray().Select((x) => x is null ? "" : Str(x))),
        _ => "[object Object]",
    };

    /// <summary>How JavaScript prints a number.</summary>
    public static string Num(double n)
    {
        if (double.IsNaN(n)) return "NaN";
        if (double.IsPositiveInfinity(n)) return "Infinity";
        if (double.IsNegativeInfinity(n)) return "-Infinity";
        if (n == 0) return "0";
        if (Math.Abs(n) < 1e21 && Math.Abs(n) >= 1e-6 && n == Math.Floor(n)) return n.ToString("0", Inv);
        var r = n.ToString("R", Inv);
        var m = Regex.Match(r, "^(-?)([0-9])(?:\\.([0-9]+))?E([+-][0-9]+)$");
        if (!m.Success) return r;
        var sign = m.Groups[1].Value;
        var digits = m.Groups[2].Value + m.Groups[3].Value;
        var exp = int.Parse(m.Groups[4].Value, Inv);
        if (exp >= 21 || exp <= -7)
        {
            var mant = digits.Length > 1 ? $"{digits[0]}.{digits[1..]}" : digits;
            return $"{sign}{mant}e{(exp > 0 ? "+" : "-")}{Math.Abs(exp)}";
        }
        // Plain decimal, as JavaScript writes 1e-6 to 1e21.
        if (exp < 0) return $"{sign}0.{new string('0', -exp - 1)}{digits}";
        if (digits.Length <= exp + 1) return sign + digits + new string('0', exp + 1 - digits.Length);
        return $"{sign}{digits[..(exp + 1)]}.{digits[(exp + 1)..]}";
    }

    static readonly Regex Decimal = new("^[+-]?(?:[0-9]+\\.?[0-9]*|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$");

    /// <summary>`Number(x)` for a string.</summary>
    public static double Number(string s)
    {
        var t = s.Trim();
        if (t.Length == 0) return 0;
        if (t is "Infinity" or "+Infinity") return double.PositiveInfinity;
        if (t == "-Infinity") return double.NegativeInfinity;
        if (t.Length > 2 && t[0] == '0' && (t[1] is 'x' or 'X' or 'o' or 'O' or 'b' or 'B'))
        {
            var b = t[1] is 'x' or 'X' ? 16 : t[1] is 'o' or 'O' ? 8 : 2;
            double acc = 0;
            foreach (var c in t[2..])
            {
                var d = c is >= '0' and <= '9' ? c - '0' : c is >= 'a' and <= 'z' ? c - 'a' + 10 : c is >= 'A' and <= 'Z' ? c - 'A' + 10 : 99;
                if (d >= b) return double.NaN;
                acc = acc * b + d;
            }
            return acc;
        }
        return Decimal.IsMatch(t) ? double.Parse(t, NumberStyles.Float, Inv) : double.NaN;
    }

    /// <summary>`Number(x)` (not for undefined, which is NaN).</summary>
    public static double Number(JsonNode? v) => Kind(v) switch
    {
        JsonValueKind.Null => 0,
        JsonValueKind.True => 1,
        JsonValueKind.False => 0,
        JsonValueKind.Number => D(v!),
        JsonValueKind.String => Number(AsString(v)!),
        JsonValueKind.Array => v!.AsArray().Count == 0 ? 0 : v.AsArray().Count == 1 ? Number(Str(v.AsArray()[0])) : double.NaN,
        _ => double.NaN,
    };

    /// <summary>`Math.round`: halves go up.</summary>
    public static double Round(double n) => Math.Floor(n + 0.5);

    /// <summary>`date.toISOString()`.</summary>
    public static string Iso(double ms) =>
        DateTimeOffset.FromUnixTimeMilliseconds((long)ms).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", Inv);

    public static double Ms(DateTimeOffset t) => t.ToUnixTimeMilliseconds();

    static readonly Regex IsoDate = new(
        "^([+-][0-9]{6}|[0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:[Tt ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\\.([0-9]+))?)?([Zz]|[+-][0-9]{2}:[0-9]{2})?)?$");

    /// <summary>`Date.parse` for the ISO forms records use; NaN otherwise.</summary>
    public static double DateParse(string s)
    {
        var m = IsoDate.Match(s.Trim());
        if (!m.Success) return double.NaN;
        int G(int i, int def) => m.Groups[i].Success ? int.Parse(m.Groups[i].Value, Inv) : def;
        var y = int.Parse(m.Groups[1].Value, Inv);
        int mo = G(2, 1), d = G(3, 1), h = G(4, 0), mi = G(5, 0), sec = G(6, 0);
        var frac = m.Groups[7].Success ? int.Parse((m.Groups[7].Value + "00")[..3], Inv) : 0;
        if (y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > DateTime.DaysInMonth(y, mo) || h > 24 || mi > 59 || sec > 59) return double.NaN;
        var hasTime = m.Groups[4].Success;
        var zone = m.Groups[8].Success ? m.Groups[8].Value : null;
        var local = new DateTime(y, mo, d, 0, 0, 0).AddHours(h).AddMinutes(mi).AddSeconds(sec).AddMilliseconds(frac);
        if (!hasTime || zone is "Z" or "z") return new DateTimeOffset(local, TimeSpan.Zero).ToUnixTimeMilliseconds();
        if (zone is null) return new DateTimeOffset(local, TimeZoneInfo.Local.GetUtcOffset(local)).ToUnixTimeMilliseconds();
        var off = new TimeSpan(int.Parse(zone[1..3], Inv), int.Parse(zone[4..6], Inv), 0);
        return new DateTimeOffset(local, zone[0] == '-' ? -off : off).ToUnixTimeMilliseconds();
    }

    /// <summary>`{ ...x }`: an object's own fields; an array's or a string's by index; nothing for anything else.</summary>
    public static JsonObject Spread(JsonNode? x)
    {
        var o = new JsonObject();
        switch (Kind(x))
        {
            case JsonValueKind.Object:
                foreach (var (k, v) in x!.AsObject()) o[k] = Clone(v);
                break;
            case JsonValueKind.Array:
                var a = x!.AsArray();
                for (var i = 0; i < a.Count; i++) o[i.ToString(Inv)] = Clone(a[i]);
                break;
            case JsonValueKind.String:
                var s = AsString(x)!;
                for (var i = 0; i < s.Length; i++) o[i.ToString(Inv)] = s[i].ToString();
                break;
        }
        return o;
    }

    /// <summary>`{ ...a, ...b }`, with copies.</summary>
    public static JsonObject Merge(JsonObject a, JsonObject? b)
    {
        var o = (JsonObject)a.DeepClone();
        if (b is not null) foreach (var (k, v) in b) o[k] = Clone(v);
        return o;
    }

    /// <summary>A copy of `o` with some fields replaced.</summary>
    public static JsonObject With(JsonObject o, params (string Key, JsonNode? Value)[] fields)
    {
        var c = (JsonObject)o.DeepClone();
        foreach (var (k, v) in fields) c[k] = v;
        return c;
    }

    /// <summary>Equal as JSON values (numbers by value, objects ignoring key order).</summary>
    public static bool DeepEquals(JsonNode? a, JsonNode? b)
    {
        var ka = Kind(a);
        if (ka != Kind(b)) return false;
        switch (ka)
        {
            case JsonValueKind.Null or JsonValueKind.True or JsonValueKind.False: return true;
            case JsonValueKind.Number: return D(a!) == D(b!);
            case JsonValueKind.String: return AsString(a) == AsString(b);
            case JsonValueKind.Array:
                var xa = a!.AsArray(); var xb = b!.AsArray();
                if (xa.Count != xb.Count) return false;
                for (var i = 0; i < xa.Count; i++) if (!DeepEquals(xa[i], xb[i])) return false;
                return true;
            default:
                var oa = a!.AsObject(); var ob = b!.AsObject();
                if (oa.Count != ob.Count) return false;
                foreach (var (k, v) in oa) if (!ob.TryGetPropertyValue(k, out var w) || !DeepEquals(v, w)) return false;
                return true;
        }
    }

    /// <summary>A stable sort (like Array.prototype.sort), with a comparator that may say NaN-ish 0.</summary>
    public static List<T> Sorted<T>(IEnumerable<T> items, Func<T, T, double> cmp) =>
        items.Order(Comparer<T>.Create((x, y) => { var d = cmp(x, y); return d < 0 ? -1 : d > 0 ? 1 : 0; })).ToList();

    /// <summary>JavaScript's `a < b` for strings: UTF-16 code units.</summary>
    public static int Cmp(string a, string b) => string.CompareOrdinal(a, b);

    public static string Json(JsonNode? v) => v is null ? "null" : v.ToJsonString();
}
