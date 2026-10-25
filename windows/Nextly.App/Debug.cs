// A trace for chasing timing problems: set NEXTLY_DEBUG_LOG to a file path
// and the app appends what it does there. Off (and free) otherwise.

namespace Nextly.App;

static class Debug
{
    static readonly string? Path = Environment.GetEnvironmentVariable("NEXTLY_DEBUG_LOG") is { Length: > 0 } p ? p : null;

    public static void Log(string message)
    {
        if (Path is null) return;
        lock (typeof(Debug)) File.AppendAllText(Path, $"{DateTime.Now:HH:mm:ss.fff} {message}{Environment.NewLine}");
    }
}
