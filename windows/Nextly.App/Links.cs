// nextly:// links (port of app/src/capture.ts), from the Gmail bookmarklet in
// capture/. Each one becomes an Inbox task (with an email card for a mail
// link), and the app opens it so you can choose Today or Next. Any web page
// can open a nextly:// link, so all it can ever do is add a task.
//
// Windows sends a link to the app registered for the nextly: scheme. The
// Tauri app registers for every user when installed; this app registers only
// for you, and only when nothing else handles the links or you ask it to in
// Settings, so installing it doesn't take links away from the other app.

using System.Text.Json.Nodes;
using Microsoft.Win32;
using Nextly.Core;

namespace Nextly.App;

public static class Links
{
    const string Key = @"Software\Classes\nextly";
    static string Exe => Environment.ProcessPath ?? "";

    /// <summary>The command Windows runs for a nextly: link, or null when nothing handles them.</summary>
    public static string? Handler()
    {
        using var k = Registry.ClassesRoot.OpenSubKey(@"nextly\shell\open\command");
        return k?.GetValue(null) as string;
    }

    public static bool HandledHere => Handler() is { } h && h.Contains(Exe, StringComparison.OrdinalIgnoreCase);

    const string Marker = "NextlyNative";

    /// <summary>Whether this app made the registration for you (which overrides one for every user).</summary>
    public static bool RegisteredForUser()
    {
        using var k = Registry.CurrentUser.OpenSubKey(Key);
        return k?.GetValue(Marker) is not null;
    }

    public static void Register()
    {
        using var k = Registry.CurrentUser.CreateSubKey(Key);
        k.SetValue(null, "URL:Nextly");
        k.SetValue("URL Protocol", "");
        k.SetValue(Marker, "1"); // marks the registration as this app's
        using (var icon = k.CreateSubKey("DefaultIcon")) icon.SetValue(null, $"\"{Exe}\",0");
        using var cmd = k.CreateSubKey(@"shell\open\command");
        cmd.SetValue(null, $"\"{Exe}\" \"%1\"");
    }

    /// <summary>Removes this app's own registration, so links go back to whatever handled them before.</summary>
    public static void Unregister()
    {
        if (RegisteredForUser()) Registry.CurrentUser.DeleteSubKeyTree(Key, false);
    }

    /// <summary>At launch: take links when nothing handles them, and follow this app if it has moved.</summary>
    public static void AutoRegister()
    {
        try
        {
            if (Handler() is null || (RegisteredForUser() && !HandledHere)) Register();
        }
        catch (Exception e) { Debug.Log($"nextly: registration skipped: {e.Message}"); }
    }

    /// <summary>The nextly: link in a launch's command line, if any.</summary>
    public static string? FromArguments(string? arguments)
    {
        if (string.IsNullOrWhiteSpace(arguments)) return null;
        foreach (var part in arguments.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select((p) => p.Trim('"')))
            if (part.StartsWith("nextly:", StringComparison.OrdinalIgnoreCase)) return part;
        var whole = arguments.Trim().Trim('"');
        return whole.StartsWith("nextly:", StringComparison.OrdinalIgnoreCase) ? whole : null;
    }

    static readonly HashSet<string> handled = [];

    /// <summary>Adds the task a link describes. Returns its id, or null for anything that isn't an add link (or a repeat).</summary>
    public static string? Capture(LocalStore store, string link)
    {
        // The same link can arrive twice (launch and redirect); only add it once.
        if (!handled.Add(link) || Logic.ParseCaptureLink(link) is not { } c) return null;
        var title = Js.AsString(c["title"]) ?? "";
        var notes = new JsonArray();
        if (Js.AsString(c["note"]) is { Length: > 0 } note) notes.Add(new JsonObject { ["id"] = Logic.Uid(), ["type"] = "paragraph", ["text"] = note });
        if (Js.AsString(c["emailUrl"]) is { } email) notes.Add(new JsonObject { ["id"] = Logic.Uid(), ["type"] = "email", ["url"] = email, ["subject"] = title });
        if (Js.AsString(c["otherUrl"]) is { } other) notes.Add(new JsonObject { ["id"] = Logic.Uid(), ["type"] = "paragraph", ["text"] = other });
        return store.CreateTask(new JsonObject { ["title"] = title, ["flag"] = Js.Clone(c["flag"]), ["notes"] = notes });
    }
}
