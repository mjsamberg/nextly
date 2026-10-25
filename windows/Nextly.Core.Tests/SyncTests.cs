// LocalStore, SyncClient and Live against the real sync server, the same
// cases as apple/NextlyKit's SyncTests.swift, so both native apps are held to
// one behavior.

using System.Text.Json.Nodes;
using Nextly.Core;
using Xunit;

namespace Nextly.Core.Tests;

public sealed class SyncTests : IDisposable
{
    TestServer? server;
    readonly List<string> folders = [];
    readonly List<IDisposable> owned = [];

    TestServer Server => server ??= new TestServer();

    public void Dispose()
    {
        foreach (var o in owned.AsEnumerable().Reverse()) o.Dispose();
        server?.Dispose();
        foreach (var f in folders) try { Directory.Delete(f, true); } catch (IOException) { }
    }

    LocalStore NewStore()
    {
        var folder = Path.Combine(Path.GetTempPath(), $"nextly-device-{Guid.NewGuid():N}");
        folders.Add(folder);
        var store = new LocalStore(Path.Combine(folder, "nextly.sqlite"));
        owned.Add(store);
        return store;
    }

    /// <summary>A device: its own database and sync client, pointed at the test server.</summary>
    async Task<SyncClient> Device(string? url = null, string altUrl = "")
    {
        var sync = new SyncClient(NewStore());
        owned.Add(sync);
        Assert.True(sync.InStep, "sync that isn't set up counts as in step");
        await sync.SaveSettings(new SyncSettings(url ?? Server.Base, altUrl, TestServer.Token, []));
        return sync;
    }

    static JsonObject O(string json) => JsonNode.Parse(json)!.AsObject();

    [SkippableFact]
    public async Task TwoDevicesSyncEditsBothWays()
    {
        var a = await Device();
        var b = await Device();
        Assert.True(a.InStep, "a sync has finished");
        var id = a.Store.CreateTask(O("""{"title":"Call Sam","flag":"today"}"""));
        await a.SyncNow();
        Assert.True(a.Status.State == SyncState.Idle, a.Status.Message);
        Assert.Equal(0, a.Store.LocalCounts().Unsent);

        await b.SyncNow();
        Assert.Equal("Call Sam", b.Store.View.Task(id)?.Title);
        Assert.Equal([id], Lists.TasksFor(b.Store.View, "today").Select((t) => t.Id));

        b.Store.ToggleDone(id);
        await b.SyncNow();
        await a.SyncNow();
        Assert.True(a.Store.View.Task(id)?.Done);
        Assert.Equal(1, Js.Number(a.Store.Record(id)!.Data!["schema"])); // saves are stamped with the schema
    }

    [SkippableFact]
    public async Task UnknownFieldsSurviveAnEditAndNewerRecordsAreLeftAlone()
    {
        const string ts = "001792501200000-0000-otherapp";
        await Server.Post("/sync", JsonNode.Parse($$$"""
            {"cursor":0,"changes":[
              {"id":"x","kind":"task","hlc":"{{{ts}}}","deleted":false,"data":{"title":"From elsewhere","flag":"today","color":"plum",
                "notes":[{"id":"b1","type":"paragraph","text":"hi","align":"center"}],
                "repeat":{"every":1,"unit":"week","from":"schedule","until":"2027-06-01"},"createdAt":"2026-10-01T12:00:00.000Z","order":5}},
              {"id":"y","kind":"task","hlc":"{{{ts}}}","deleted":false,"data":{"title":"Newer","flag":"today","schema":2,"createdAt":"2026-10-01T12:00:00.000Z","order":6}},
              {"id":"z","kind":"someday-kind","hlc":"{{{ts}}}","deleted":false,"data":{"anything":true}}
            ]}
            """)!);
        var a = await Device();
        Assert.Equal(1, a.Store.View.Newer);
        Assert.True(a.Store.View.Task("y")?.ReadOnly);

        a.Store.UpdateTask("x", O("""{"title":"Renamed"}"""));
        a.Store.UpdateTask("y", O("""{"title":"Changed?"}"""));
        a.Store.DeleteTask("y");
        await a.SyncNow();

        var all = await Server.All();
        var x = all["x"].Data!;
        Assert.Equal("Renamed", Js.AsString(x["title"]));
        Assert.Equal("plum", Js.AsString(x["color"]));
        Assert.Equal("center", Js.AsString(x["notes"]![0]!["align"]));
        Assert.Equal("2027-06-01", Js.AsString(x["repeat"]!["until"]));
        Assert.Equal(1, Js.Number(x["schema"]));
        Assert.True(string.CompareOrdinal(all["x"].Hlc, ts) > 0, "the clock moved past the other app's");
        Assert.Equal(ts, all["y"].Hlc); // a newer-format record isn't changed
        Assert.False(all["y"].Deleted);
        Assert.True(Js.Truthy(a.Store.Record("z")!.Data!["anything"]), "unknown kinds are kept");
    }

    [SkippableFact]
    public async Task EditedWhileInFlightStaysQueued()
    {
        var a = await Device();
        var id = a.Store.CreateTask(O("""{"title":"one"}"""));
        var sent = a.Store.PendingChanges();
        a.Store.UpdateTask(id, O("""{"title":"two"}"""));
        a.Store.MarkSent(sent);
        Assert.Equal([id], a.Store.PendingChanges().Select((r) => r.Id)); // the newer edit still needs sending
        await a.SyncNow();
        Assert.Equal("two", Js.AsString((await Server.All())[id].Data!["title"]));
    }

    [SkippableFact]
    public async Task ServerThatLostItsDataGetsEverythingAgain()
    {
        var a = await Device();
        var id = a.Store.CreateTask(O("""{"title":"keep me"}"""));
        var file = a.AddFile("hello"u8.ToArray(), "hello.txt", "text/plain");
        await a.SyncNow();
        Assert.True((await Server.All()).ContainsKey(id));

        // The same address, a new data volume.
        var port = Server.Port;
        server!.Dispose();
        server = new TestServer(port);
        Assert.False((await Server.All()).ContainsKey(id));
        await a.SyncNow();
        Assert.True(a.Status.State == SyncState.Idle, a.Status.Message);
        Assert.Equal("keep me", Js.AsString((await Server.All())[id].Data!["title"]));
        Assert.True(await Server.HasFile(file.Sha), "files are sent again too");
    }

    [SkippableFact]
    public async Task SecondAddressTakesOverWhenTheFirstIsDown()
    {
        var a = await Device("http://127.0.0.1:9", Server.Base);
        Assert.True(a.Status.State == SyncState.Idle, a.Status.Message);
        Assert.Equal($"127.0.0.1:{Server.Port}", a.Status.Via);
        var (_, lines) = await a.CheckConnection();
        Assert.True(lines.Any((l) => l.Contains("127.0.0.1:9: doesn’t answer")), string.Join("\n", lines));
    }

    [SkippableFact]
    public async Task WrongTokenIsExplained()
    {
        var a = await Device();
        await a.SaveSettings(a.Settings with { Token = "wrong" });
        Assert.Equal(SyncState.Error, a.Status.State);
        Assert.Equal("The server rejected the sync token. Check it in Settings.", a.Status.Message);
        var b = await Device(Server.Base);
        Assert.True(b.InStep);
        var c = new SyncClient(b.Store);
        owned.Add(c);
        await c.SaveSettings(new SyncSettings(Server.Base, "", "wrong", []));
        Assert.False(c.InStep, "automatic edits wait for a sync that worked");
    }

    [SkippableFact]
    public async Task FilesUploadAndOpenThroughALink()
    {
        var a = await Device();
        var b = await Device();
        var bytes = "attached notes"u8.ToArray();
        var f = a.AddFile(bytes, "notes.txt", "text/plain");
        await a.SyncNow();
        var link = await a.FileLink(f.Sha, f.Name, f.Mime);
        using var http = new HttpClient();
        using var res = await http.GetAsync(link);
        Assert.Equal(200, (int)res.StatusCode);
        Assert.Equal(bytes, await res.Content.ReadAsByteArrayAsync());
        Assert.Equal(bytes, await b.LoadFile(f.Sha, f.Name, f.Mime));
        Assert.True(b.Store.File(f.Sha)?.Uploaded);
    }

    [SkippableFact]
    public async Task LiveUpdatesSayWhenAnotherDeviceSyncs()
    {
        var a = await Device();
        var b = await Device();
        var connected = new TaskCompletionSource();
        var changed = new TaskCompletionSource();
        var states = new List<LiveState>();
        a.Live.Start(new LiveOptions(
            Url: (_) => Task.FromResult(Server.Base),
            Headers: a.AuthHeaders,
            DeviceId: a.Store.DeviceId,
            OnChanged: () => changed.TrySetResult(),
            OnConnected: () => connected.TrySetResult(),
            OnState: (s, _) => { lock (states) states.Add(s); }));
        await connected.Task.WaitAsync(TimeSpan.FromSeconds(10));
        b.Store.CreateTask(O("""{"title":"from b"}"""));
        await b.SyncNow();
        await changed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        lock (states)
        {
            Assert.Equal(LiveState.Connecting, states.First());
            Assert.Equal(LiveState.Live, states.Last());
        }
        a.Live.Stop();
    }

    [SkippableFact]
    public async Task LiveRetriesWithAWrongToken()
    {
        var a = await Device();
        var retrying = new TaskCompletionSource<string>();
        var live = new Live();
        live.Start(new LiveOptions(
            Url: (_) => Task.FromResult(Server.Base),
            Headers: new Dictionary<string, string> { ["Authorization"] = "Bearer wrong" },
            DeviceId: a.Store.DeviceId,
            OnChanged: () => { }, OnConnected: () => { },
            OnState: (s, d) => { if (s == LiveState.Retrying && d.Length > 0) retrying.TrySetResult(d); }));
        var detail = await retrying.Task.WaitAsync(TimeSpan.FromSeconds(10));
        live.Stop();
        Assert.EndsWith("Retrying in 1 s.", detail);
        Assert.StartsWith("The server rejected the sync token.", detail);
    }
}

public sealed class LocalStoreTests
{
    static string TempDb() => Path.Combine(Path.GetTempPath(), $"nextly-{Guid.NewGuid():N}", "nextly.sqlite");

    [Fact]
    public void RecordsAndOutboxSurviveReopening()
    {
        var path = TempDb();
        string id, device, hlc;
        using (var store = new LocalStore(path))
        {
            id = store.CreateTask(new JsonObject { ["title"] = "persist" });
            device = store.DeviceId;
            hlc = store.Record(id)!.Hlc;
            store.PutFile(new StoredFile("abc", "a.txt", "text/plain", false, []));
        }
        using var again = new LocalStore(path);
        Assert.Equal(device, again.DeviceId);
        Assert.Equal("persist", again.View.Task(id)?.Title);
        Assert.Equal([id], again.PendingChanges().Select((r) => r.Id));
        Assert.Equal(["abc"], again.UnsentFiles());
        again.UpdateTask(id, new JsonObject { ["title"] = "later" });
        Assert.True(string.CompareOrdinal(again.Record(id)!.Hlc, hlc) > 0, "the clock carries on past saved records");
    }

    [Fact]
    public void TicketTaskAsksForNotesBeforeResolving()
    {
        using var store = new LocalStore(TempDb());
        store.ApplyRemote([new Rec("iiq-1", "task", "001792501200000-0000-iiq", false,
            JsonNode.Parse("""{"title":"Charger","projectId":"iiq-project","external":{"source":"iiq","id":"T1","closed":false}}"""))]);
        store.ToggleDone("iiq-1");
        Assert.Equal("iiq-1", store.ResolvingId);
        Assert.False(store.View.Task("iiq-1")?.Done);
        store.ResolveWithNotes("iiq-1", "Replaced it");
        Assert.Null(store.ResolvingId);
        Assert.Equal("Replaced it", store.View.IiqActions("iiq-1").First().Text);
    }

    [Fact]
    public void UndoBringsBackADeletedTaskAndItsSubtasks()
    {
        using var store = new LocalStore(TempDb());
        var parent = store.CreateTask(new JsonObject { ["title"] = "parent" });
        var child = store.CreateTask(new JsonObject { ["title"] = "child", ["parentId"] = parent, ["flag"] = null });
        var undo = store.DeleteTask(parent);
        Assert.Null(store.View.Task(parent));
        Assert.Null(store.View.Task(child));
        undo();
        Assert.Equal("parent", store.View.Task(parent)?.Title);
        Assert.Equal([child], store.View.Children(parent).Select((t) => t.Id));
    }

    [Fact]
    public void HlcOrdersAndObserves()
    {
        var h = new Hlc { Device = "dev" };
        var t = DateTimeOffset.FromUnixTimeMilliseconds(1_000_000);
        Assert.Equal("000000001000000-0000-dev", h.Now(t));
        Assert.Equal("000000001000000-0001-dev", h.Now(t));
        h.Observe("000000002000000-0005-other");
        Assert.Equal("000000002000000-0006-dev", h.Now(t));
        Assert.Equal("000000003000000-0000-dev", h.Now(DateTimeOffset.FromUnixTimeMilliseconds(3_000_000)));
    }

    [Fact]
    public void WebSocketAddress()
    {
        Assert.Equal("wss://nextly.example.com/events?device=d1", Live.WsUrl("https://nextly.example.com/", "d1")?.ToString());
        Assert.Equal("ws://100.64.0.1:8080/events?device=d1", Live.WsUrl("http://100.64.0.1:8080", "d1")?.ToString());
    }
}
