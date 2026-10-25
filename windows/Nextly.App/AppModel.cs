// The app's state: the local store and sync engine (Nextly.Core), plus which
// list and task are on screen. Store and sync events arrive on any thread;
// this gathers them into one Changed event on the UI thread.

using Microsoft.UI.Dispatching;
using Nextly.Core;

namespace Nextly.App;

public sealed class AppModel : IDisposable
{
    public LocalStore Store { get; }
    public SyncClient Sync { get; }
    readonly DispatcherQueue ui;
    readonly DispatcherQueueTimer daily;
    bool pending;

    /// <summary>Data changed (locally or from sync), on the UI thread, at most once per frame.</summary>
    public event Action? Changed;
    /// <summary>Sync status changed, on the UI thread.</summary>
    public event Action? SyncChanged;

    /// <summary>The list on screen: "today", "project:&lt;id&gt;", … or "settings".</summary>
    public string View { get; set; } = "today";
    public string? Selected { get; set; }
    public string Query { get; set; } = "";

    /// <summary>Where the local database lives; NEXTLY_DATA_DIR points elsewhere (tests, demos).</summary>
    public static string DataFolder => Environment.GetEnvironmentVariable("NEXTLY_DATA_DIR") is { Length: > 0 } dir ? dir
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nextly");

    public AppModel(DispatcherQueue dispatcher)
    {
        ui = dispatcher;
        Store = new LocalStore(Path.Combine(DataFolder, "nextly.sqlite"));
        Sync = new SyncClient(Store);
        Store.Changed += () => Post();
        Sync.StatusChanged += () => ui.TryEnqueue(() => SyncChanged?.Invoke());
        // Tasks with a start date move into Today on that day: after each sync,
        // and every minute in case the date rolls over. Never before this
        // device has synced since launch: moving a stale copy would undo newer
        // edits from other devices.
        Sync.Synced += () => ui.TryEnqueue(PromoteDue);
        daily = ui.CreateTimer();
        daily.Interval = TimeSpan.FromMinutes(1);
        daily.Tick += (_, _) => PromoteDue();
        daily.Start();
        PromoteDue();
        Sync.Start();
    }

    public void PromoteDue()
    {
        if (Sync.InStep) Store.PromoteDue();
    }

    void Post()
    {
        lock (this)
        {
            if (pending) return;
            pending = true;
        }
        ui.TryEnqueue(DispatcherQueuePriority.Low, () =>
        {
            lock (this) pending = false;
            Changed?.Invoke();
        });
    }

    public void Dispose()
    {
        daily.Stop();
        Sync.Dispose();
        Store.Dispose();
    }
}
