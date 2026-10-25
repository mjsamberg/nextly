// Port of app/src/sync.ts: talks to the Nextly sync server (server/server.js).
// Push every unsent record, pull everything newer than our cursor, repeat
// while the server says there's more. Then upload any attachments not yet sent.
//
// One server, one or two addresses (say Cloudflare and Tailscale): whichever
// answers is used, and a failing one is swapped for the other.

using System.Net.Http.Headers;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Nextly.Core;

/// <summary>
/// Url: the server address. AltUrl: optionally a second address for the same
/// server. Headers: sent with every request, e.g. a Cloudflare Access service token.
/// </summary>
public sealed record SyncSettings(string Url, string AltUrl, string Token, IReadOnlyList<Logic.HeaderRow> Headers)
{
    public static readonly SyncSettings Empty = new("", "", "", []);
}

public enum SyncState { Off, Idle, Syncing, Error }

/// <summary>Idle (green) only ever means the last sync actually completed. Via: the address in use, when there are two.</summary>
public sealed record SyncStatus(SyncState State, string Message, string? LastSync, int? Sent, int? Received, LiveState Live, string LiveDetail, string? Via);

public sealed class SyncClient : IDisposable
{
    public LocalStore Store { get; }
    public Live Live { get; } = new();
    public SyncSettings Settings { get; private set; } = SyncSettings.Empty;
    public SyncStatus Status { get; private set; } = new(SyncState.Off, "Sync isn’t set up yet", null, null, null, LiveState.Off, "", null);

    public event Action? StatusChanged;
    /// <summary>A sync finished: the device has what the server has (run automatic edits now).</summary>
    public event Action? Synced;

    static readonly TimeSpan PollLive = TimeSpan.FromMinutes(5);
    static readonly TimeSpan PollOffline = TimeSpan.FromSeconds(30);
    static readonly TimeSpan IdleRecheck = TimeSpan.FromMinutes(2);
    const int ProbeMs = 6_000;
    const string AccessHelp = "Cloudflare Access blocked the request. Check the CF-Access-Client-Id and CF-Access-Client-Secret headers in Settings.";

    readonly HttpClient http;
    readonly object gate = new();
    int active; // which address answered last
    DateTimeOffset lastOk = DateTimeOffset.MinValue; // when it last answered
    DateTimeOffset lastSyncAt = DateTimeOffset.MinValue;
    Task? running;
    bool again;
    bool started;
    Timer? poll;
    Timer? soon;

    public SyncClient(LocalStore store, HttpMessageHandler? handler = null)
    {
        Store = store;
        http = new HttpClient(handler ?? new SocketsHttpHandler
        {
            ConnectTimeout = TimeSpan.FromSeconds(10),
            PooledConnectionLifetime = TimeSpan.FromMinutes(2), // networks change; don't keep old routes
        }) { Timeout = Timeout.InfiniteTimeSpan };
        Settings = ReadSettings(store.GetMeta("sync"));
        var last = Js.AsString(store.GetMeta("activeUrl"));
        active = Math.Max(0, Urls().IndexOf(last ?? ""));
        var problem = NotReady();
        Status = Status with
        {
            State = problem is not null && Settings.Url.Length > 0 ? SyncState.Error : SyncState.Off,
            Message = problem ?? "Not synced yet",
            LastSync = Js.AsString(store.GetMeta("lastSync")),
        };
    }

    static SyncSettings ReadSettings(JsonNode? s) => s is not JsonObject o ? SyncSettings.Empty : new(
        Js.AsString(o["url"]) ?? "", Js.AsString(o["altUrl"]) ?? "", Js.AsString(o["token"]) ?? "",
        (o["headers"] as JsonArray ?? []).Select((h) => new Logic.HeaderRow(Js.AsString(h?["name"]) ?? "", Js.AsString(h?["value"]) ?? "")).ToList());

    static JsonObject WriteSettings(SyncSettings s) => new()
    {
        ["url"] = s.Url, ["altUrl"] = s.AltUrl, ["token"] = s.Token,
        ["headers"] = new JsonArray(s.Headers.Select((h) => (JsonNode)new JsonObject { ["name"] = h.Name, ["value"] = h.Value }).ToArray()),
    };

    void SetStatus(Func<SyncStatus, SyncStatus> f)
    {
        lock (gate) Status = f(Status);
        StatusChanged?.Invoke();
    }

    /// <summary>
    /// Whether this device has what the server has: sync is off, or a sync has
    /// finished since launch. Automatic edits (PromoteDue) wait for this.
    /// </summary>
    public bool InStep => Settings.Url.Length == 0 || Settings.Token.Length == 0 || lastSyncAt > DateTimeOffset.MinValue;

    // ---------- one server, one or two addresses ----------

    /// <summary>The server's addresses, primary first.</summary>
    public List<string> Urls() =>
        new[] { Settings.Url, Settings.AltUrl }.Select((u) => u.Trim().TrimEnd('/')).Where((u) => u.Length > 0).Distinct().ToList();

    string Base { get { var u = Urls(); return active < u.Count ? u[active] : u.FirstOrDefault() ?? ""; } }

    static string Host(string u) => Uri.TryCreate(u, UriKind.Absolute, out var x) ? x.Authority : u;
    string Hosts() => string.Join(" or ", Urls().Select(Host));

    sealed record Resp(int Status, string? ContentType, string FinalUrl, byte[] Body)
    {
        public bool Ok => Status is >= 200 and < 300;
        public JsonNode? Json() { try { return JsonNode.Parse(Body); } catch (System.Text.Json.JsonException) { return null; } }
    }

    /// <summary>Answers that mean "this address can't reach the server right now" (Cloudflare's tunnel and Access errors).</summary>
    static bool Unreachable(Resp r) => Logic.BlockedByAccess(r.Status, r.ContentType, r.FinalUrl)
        || r.Status is 502 or 503 or 504 or 520 or 521 or 522 or 523 or 524 or 525 or 526 or 527 or 530;

    public IReadOnlyDictionary<string, string> AuthHeaders
    {
        get
        {
            var h = Logic.HeaderObject(Settings.Headers);
            h["Authorization"] = $"Bearer {Settings.Token}";
            return h;
        }
    }

    /// <summary>A request that hangs would otherwise block every later sync.</summary>
    async Task<Resp> Once(string url, HttpMethod method, Func<HttpContent>? body, int ms)
    {
        using var cts = new CancellationTokenSource(ms);
        using var req = new HttpRequestMessage(method, url);
        foreach (var (k, v) in AuthHeaders) req.Headers.TryAddWithoutValidation(k, v);
        if (body is not null) req.Content = body();
        try
        {
            using var res = await http.SendAsync(req, cts.Token);
            var bytes = await res.Content.ReadAsByteArrayAsync(cts.Token);
            return new Resp((int)res.StatusCode, res.Content.Headers.ContentType?.ToString(), res.RequestMessage?.RequestUri?.ToString() ?? url, bytes);
        }
        catch (OperationCanceledException) when (cts.IsCancellationRequested)
        {
            throw new TimeoutException($"{Host(url)} didn’t answer within {ms / 1000} seconds.");
        }
    }

    /// <summary>Whether one address answers like a Nextly server, quickly.</summary>
    async Task<bool> Answers(string u)
    {
        try
        {
            var r = await Once($"{u}/health", HttpMethod.Get, null, ProbeMs);
            return r.Ok && !Unreachable(r) && r.Json()?["ok"] is JsonValue ok && ok.GetValueKind() == System.Text.Json.JsonValueKind.True;
        }
        catch (Exception) { return false; }
    }

    /// <summary>Asks every address at once and switches to the first that answers.</summary>
    async Task<bool> PickAddress()
    {
        var list = Urls();
        if (list.Count < 2) return false;
        var pending = list.Select(async (u, i) => (i, ok: await Answers(u))).ToList();
        var winner = -1;
        while (pending.Count > 0)
        {
            var done = await Task.WhenAny(pending);
            pending.Remove(done);
            if (done.Result.ok) { winner = done.Result.i; break; }
        }
        if (winner < 0) return false;
        if (winner != active) { active = winner; Store.SetMeta("activeUrl", list[winner]); }
        lastOk = DateTimeOffset.UtcNow;
        SetStatus((s) => s with { Via = Host(list[winner]) });
        return true;
    }

    /// <summary>
    /// A request to the server at `path`, through whichever address works. With
    /// two addresses: after a quiet spell, check which one answers first; and
    /// if the one in use fails, switch to the other and try once more.
    /// </summary>
    async Task<Resp> Request(string path, HttpMethod method, Func<HttpContent>? body = null, int ms = 30_000)
    {
        var two = Urls().Count > 1;
        if (two && DateTimeOffset.UtcNow - lastOk > IdleRecheck) await PickAddress();
        object failure;
        try
        {
            var r = await Once(Base + path, method, body, ms);
            if (!two || !Unreachable(r)) { lastOk = DateTimeOffset.UtcNow; return r; }
            failure = r;
        }
        catch (Exception e) when (two) { failure = e; }
        var before = active;
        if (await PickAddress() && active != before)
        {
            var r = await Once(Base + path, method, body, ms);
            lastOk = DateTimeOffset.UtcNow;
            return r;
        }
        if (failure is Resp resp) return resp;
        throw (Exception)failure;
    }

    string? NotReady() =>
        Settings.Url.Length == 0 ? "Sync isn’t set up yet" : Settings.Token.Length == 0 ? "Add the sync token in Settings to start syncing." : null;

    /// <summary>Throws a readable error for anything but a real answer from the Nextly server.</summary>
    static void Check(Resp r, string what)
    {
        if (Logic.BlockedByAccess(r.Status, r.ContentType, r.FinalUrl)) throw new InvalidOperationException(AccessHelp);
        if (r.Status == 401) throw new InvalidOperationException("The server rejected the sync token. Check it in Settings.");
        if (!r.Ok) throw new InvalidOperationException($"{what}: the server answered {r.Status}.");
    }

    static bool IsNetwork(Exception e) => e is HttpRequestException or SocketException || e.InnerException is SocketException;

    // ---------- running ----------

    /// <summary>
    /// Keeps the device in sync: soon after local edits, on a timer (every 30 s,
    /// or every 5 minutes while live updates are connected), when the network
    /// comes back, and whenever another device syncs (live updates).
    /// </summary>
    public void Start()
    {
        if (started) return;
        started = true;
        Store.LocalChanged += () => soon?.Change(800, Timeout.Infinite);
        soon = new Timer((_) => _ = SyncNow(), null, Timeout.Infinite, Timeout.Infinite);
        poll = new Timer((_) =>
        {
            var every = Status.Live == LiveState.Live ? PollLive : PollOffline;
            if (DateTimeOffset.UtcNow - lastSyncAt >= every - TimeSpan.FromSeconds(1)) _ = SyncNow();
        }, null, PollOffline, PollOffline);
        NetworkChange.NetworkAvailabilityChanged += OnNetwork;
        RestartLive();
        _ = SyncNow();
    }

    void OnNetwork(object? sender, NetworkAvailabilityEventArgs e)
    {
        if (!e.IsAvailable) return;
        lastOk = DateTimeOffset.MinValue; // a new network may favor the other address
        RestartLive();
        _ = SyncNow();
    }

    public void Dispose()
    {
        NetworkChange.NetworkAvailabilityChanged -= OnNetwork;
        poll?.Dispose();
        soon?.Dispose();
        Live.Stop();
        http.Dispose();
    }

    void RestartLive()
    {
        if (!started) return;
        if (NotReady() is not null)
        {
            Live.Stop();
            SetStatus((s) => s with { Live = LiveState.Off, LiveDetail = "" });
            return;
        }
        Live.Start(new LiveOptions(
            // Each (re)connect asks again, so live updates follow a switch of address.
            Url: async (retrying) => { if (retrying) await PickAddress(); return Base; },
            Headers: AuthHeaders,
            DeviceId: Store.DeviceId,
            OnChanged: () => _ = SyncNow(),
            OnConnected: () => _ = SyncNow(),
            OnState: (live, detail) => SetStatus((s) => s with { Live = live, LiveDetail = detail })));
    }

    public async Task SaveSettings(SyncSettings s)
    {
        var changedServer = s.Url.Trim() != Settings.Url;
        Settings = new SyncSettings(s.Url.Trim(), s.AltUrl.Trim(), s.Token.Trim(),
            s.Headers.Where((h) => h.Name.Trim().Length > 0).Select((h) => new Logic.HeaderRow(h.Name.Trim(), h.Value.Trim())).ToList());
        Store.SetMeta("sync", WriteSettings(Settings));
        active = 0;
        lastOk = DateTimeOffset.MinValue; // check which address answers on the next request
        SetStatus((st) => st with { Via = null });
        if (changedServer) Store.SetMeta("cursor", 0); // new server: pull everything
        RestartLive();
        await SyncNow();
    }

    /// <summary>Syncs now. If a sync is already running, waits for it and one more after it.</summary>
    public Task SyncNow()
    {
        lock (gate)
        {
            if (running is not null) { again = true; return running; }
            // The loop takes the lock before finishing, so it can't end before
            // `running` is set, and a request made while it ran isn't dropped.
            running = Task.Run(async () =>
            {
                while (true)
                {
                    await SyncOnce();
                    lock (gate)
                    {
                        if (!again) { running = null; return; }
                        again = false;
                    }
                }
            });
            return running;
        }
    }

    async Task SyncOnce()
    {
        if (NotReady() is { } problem)
        {
            SetStatus((s) => s with { State = Settings.Url.Length > 0 ? SyncState.Error : SyncState.Off, Message = problem });
            return;
        }
        SetStatus((s) => s with { State = SyncState.Syncing, Message = "Syncing…" });
        try
        {
            var cursor = Js.Number(Store.GetMeta("cursor"));
            if (double.IsNaN(cursor)) cursor = 0;
            int sent = 0, received = 0, resets = 0;
            while (true)
            {
                var changes = Store.PendingChanges();
                var body = new JsonObject
                {
                    ["cursor"] = cursor,
                    ["changes"] = new JsonArray(changes.Select((r) => (JsonNode)new JsonObject
                    {
                        ["id"] = r.Id, ["kind"] = r.Kind, ["hlc"] = r.Hlc, ["deleted"] = r.Deleted, ["data"] = Js.Clone(r.Data),
                    }).ToArray()),
                    ["deviceId"] = Store.DeviceId, // so the server doesn't wake us for our own change
                };
                var json = body.ToJsonString();
                var res = await Request("/sync", HttpMethod.Post, () => new StringContent(json, Encoding.UTF8, "application/json"));
                Check(res, "Sync failed");
                var b = res.Json() as JsonObject;
                if (b is null || !Js.IsNumber(b["cursor"], out var newCursor) || b["changes"] is not JsonArray rows)
                    throw new InvalidOperationException($"{Base} answered, but not like a Nextly server. Check the server address.");
                Store.MarkSent(changes);
                sent += changes.Count;

                // A different server, or one that's behind us, has lost or never had our
                // data: start from the beginning and send everything again.
                var knownId = Js.AsString(Store.GetMeta("serverId"));
                var serverId = Js.AsString(b["serverId"]);
                var isNewServer = !string.IsNullOrEmpty(serverId) && serverId != knownId;
                var isBehind = Js.IsNumber(b["lastSeq"], out var lastSeq) && lastSeq < cursor;
                if (!string.IsNullOrEmpty(serverId)) Store.SetMeta("serverId", serverId);
                if ((isNewServer && (!string.IsNullOrEmpty(knownId) || cursor > 0)) || isBehind)
                {
                    Store.RequeueAll();
                    Store.SetMeta("cursor", 0);
                    Store.MarkAllFilesUnsent();
                    cursor = 0;
                    if (++resets > 2) throw new InvalidOperationException("The server keeps starting over. Check that its data volume is kept between restarts.");
                    continue;
                }

                // The server echoes our own changes back; count only ones that were new here.
                received += Store.ApplyRemote(rows.Select((r) => new Rec(
                    Js.AsString(r?["id"]) ?? "", Js.AsString(r?["kind"]) ?? "", Js.AsString(r?["hlc"]) ?? "", Js.Truthy(r?["deleted"]), Js.Clone(r?["data"]))));
                cursor = newCursor;
                Store.SetMeta("cursor", cursor);
                if (!Js.Truthy(b["more"])) break;
            }
            await UploadFiles();
            var now = Js.Iso(Js.Ms(DateTimeOffset.UtcNow));
            lastSyncAt = DateTimeOffset.UtcNow;
            Store.SetMeta("lastSync", now);
            SetStatus((s) => s with
            {
                State = SyncState.Idle,
                Message = sent > 0 || received > 0 ? $"Synced · sent {sent}, received {received}" : "Up to date · nothing new",
                LastSync = now, Sent = sent, Received = received,
            });
            Synced?.Invoke();
        }
        catch (Exception e)
        {
            var msg = IsNetwork(e)
                ? $"Can’t reach {Hosts()}. Check your internet connection and that the server is reachable (Cloudflare Tunnel, or Tailscale if you use it)."
                : e.Message;
            SetStatus((s) => s with { State = SyncState.Error, Message = msg });
        }
    }

    /// <summary>Compares what the server holds with this device, in plain words.</summary>
    public async Task<(bool Ok, List<string> Lines)> CheckConnection()
    {
        if (NotReady() is { } problem) return (false, [problem]);
        var here = Store.LocalCounts();
        var cursor = Js.Number(Store.GetMeta("cursor"));
        if (double.IsNaN(cursor)) cursor = 0;
        try
        {
            var res = await Request("/status", HttpMethod.Get, null, 15_000);
            if (res.Status == 404)
                return (false, ["The server answered but is an older version without the connection check. Rebuild it with docker compose build --pull --no-cache && docker compose up -d."]);
            Check(res, "Connection check failed");
            if (res.Json() is not JsonObject s || !Js.IsNumber(s["records"], out var recs))
                return (false, [$"{Base} answered, but not like a Nextly server. Check the server address."]);
            var knownId = Js.AsString(Store.GetMeta("serverId"));
            var lastSeq = Js.Number(s["lastSeq"]);
            var startedOver = (Js.AsString(s["serverId"]) is { Length: > 0 } sid && !string.IsNullOrEmpty(knownId) && sid != knownId) || cursor > lastSeq;
            var lines = new List<string>
            {
                $"Connected to {Host(Base)}.",
                $"Server: {Js.Str(s["tasks"])} tasks ({Js.Num(recs)} records, latest change #{Js.Num(lastSeq)}, {Js.Str(s["files"])} files).",
                $"This device: {here.Tasks} tasks ({here.Records} records), has seen up to change #{Js.Num(cursor)}, {here.Unsent} not sent yet.",
            };
            if (Urls().Count > 1)
            {
                // Each address on its own, so a broken one shows up even while the other works.
                var each = await Task.WhenAll(Urls().Select(async (u) => $"{Host(u)}: {(await Answers(u) ? "answers" : "doesn’t answer")}"));
                lines.Add($"Addresses: {string.Join("; ", each)}. Using {Host(Base)}.");
            }
            if (Js.IsNumber(s["liveDevices"], out var ld))
                lines.Add($"Live updates: {Js.Num(ld)} device{(ld == 1 ? "" : "s")} connected to the server{(Status.Live == LiveState.Live ? ", including this one" : "; this one isn’t")}.");
            if (startedOver) lines.Add("The server has started over since this device last synced (for example, its data volume was recreated). Tap Sync now and this device will send everything it has again.");
            else if (here.Unsent > 0) lines.Add("Some changes here haven’t reached the server yet. Tap Sync now.");
            else if (cursor < lastSeq) lines.Add("The server has changes this device hasn’t pulled yet. Tap Sync now.");
            else lines.Add("This device is fully in step with the server.");
            return (true, lines);
        }
        catch (Exception e)
        {
            return (false, [IsNetwork(e) ? $"Can’t reach {Hosts()}. {e.Message}" : e.Message]);
        }
    }

    // ---------- attachments ----------

    async Task UploadFiles()
    {
        foreach (var sha in Store.UnsentFiles())
        {
            if (Store.File(sha) is not { Uploaded: false } f) continue;
            var res = await Request($"/files/{sha}", HttpMethod.Put, () => new ByteArrayContent(f.Bytes), 120_000);
            Check(res, $"Couldn’t upload {f.Name}");
            Store.MarkFileUploaded(sha);
        }
    }

    public static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    /// <summary>Stores a picked file locally and queues it for upload.</summary>
    public (string Sha, string Name, long Size, string Mime) AddFile(byte[] bytes, string name, string mime)
    {
        var sha = Sha256(bytes);
        if (mime.Length == 0) mime = "application/octet-stream";
        if (Store.File(sha) is null) Store.PutFile(new StoredFile(sha, name, mime, false, bytes));
        if (started) _ = SyncNow();
        return (sha, name, bytes.LongLength, mime);
    }

    /// <summary>Local copy if we have it, otherwise download it from the server and keep it.</summary>
    public async Task<byte[]?> LoadFile(string sha, string name = "", string mime = "application/octet-stream")
    {
        if (Store.File(sha) is { } f) return f.Bytes;
        if (Settings.Url.Length == 0) return null;
        var res = await Request($"/files/{sha}", HttpMethod.Get, null, 120_000);
        // Never cache an Access login page as the file.
        if (!res.Ok || Logic.BlockedByAccess(res.Status, res.ContentType, res.FinalUrl)) return null;
        Store.PutFile(new StoredFile(sha, name, mime, true, res.Body));
        return res.Body;
    }

    /// <summary>Short-lived link the system browser can open without the token.</summary>
    public async Task<string> FileLink(string sha, string name, string mime)
    {
        await UploadFiles();
        var json = new JsonObject { ["name"] = name, ["mime"] = mime }.ToJsonString();
        var res = await Request($"/files/{sha}/link", HttpMethod.Post, () => new StringContent(json, Encoding.UTF8, "application/json"));
        Check(res, "Couldn’t open the file");
        return Base + Js.AsString(res.Json()?["url"]);
    }

    /// <summary>The server's Incident IQ sync status (server/iiq.js), or null if the server doesn't say.</summary>
    public async Task<JsonObject?> IiqStatus()
    {
        if (NotReady() is not null) return null;
        try
        {
            var res = await Request("/iiq/status", HttpMethod.Get, null, 15_000);
            if (res.Status == 404) return null; // older server
            Check(res, "Incident IQ status");
            return res.Json() as JsonObject;
        }
        catch (Exception) { return null; }
    }
}
