// Port of app/src/hlc.ts. Hybrid logical clock:
// "<ms, 15 digits>-<counter, 4 digits>-<deviceId>". Sorts correctly as plain
// text, keeps moving forward even if this device's clock is behind another's,
// and breaks exact ties by device id.

using System.Globalization;

namespace Nextly.Core;

public sealed class Hlc
{
    long last;
    int counter;
    readonly object gate = new();

    public string Device { get; set; } = "unknown";

    string Fmt(long ms, int c) => $"{ms.ToString("D15", CultureInfo.InvariantCulture)}-{c.ToString("D4", CultureInfo.InvariantCulture)}-{Device}";

    public string Now(DateTimeOffset? at = null)
    {
        lock (gate)
        {
            var t = (at ?? DateTimeOffset.UtcNow).ToUnixTimeMilliseconds();
            if (t > last) { last = t; counter = 0; } else counter++;
            return Fmt(last, counter);
        }
    }

    /// <summary>Move the clock past a timestamp seen from another device.</summary>
    public void Observe(string h)
    {
        var parts = h.Split('-');
        if (parts.Length < 1 || !long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var ms)) return;
        var c = parts.Length > 1 && int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var cc) ? cc : 0;
        lock (gate)
        {
            if (ms > last) { last = ms; counter = c; }
            else if (ms == last && c > counter) counter = c;
        }
    }
}
