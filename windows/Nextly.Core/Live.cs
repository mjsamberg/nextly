// Port of app/src/live.ts: live updates from the server's /events WebSocket
// (server/live.js). The server says {"type":"changed"} after another device
// syncs, and we sync. The socket carries the sync token and any Cloudflare
// Access headers itself, so no ticket is needed.
//
// The server sends a heartbeat every 25 s; if nothing arrives for 70 s the
// connection is treated as dead and reopened, with backoff up to 30 s.

using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace Nextly.Core;

public enum LiveState { Off, Connecting, Live, Retrying }

/// <summary>Url: the server's base URL, asked on each (re)connect (true when retrying).</summary>
public sealed record LiveOptions(
    Func<bool, Task<string>> Url,
    IReadOnlyDictionary<string, string> Headers,
    string DeviceId,
    Action OnChanged,
    Action OnConnected,
    Action<LiveState, string> OnState);

public sealed class Live
{
    static readonly TimeSpan HeartbeatTimeout = TimeSpan.FromSeconds(70);
    CancellationTokenSource? cts;
    readonly object gate = new();

    /// <summary>ws(s)://host/events?device=…, from the server's http(s) address.</summary>
    public static Uri? WsUrl(string baseUrl, string deviceId)
    {
        if (!Uri.TryCreate(baseUrl.TrimEnd('/') + "/events", UriKind.Absolute, out var u)) return null;
        var b = new UriBuilder(u) { Scheme = u.Scheme == "https" ? "wss" : "ws", Query = "device=" + Uri.EscapeDataString(deviceId) };
        if (u.IsDefaultPort) b.Port = -1;
        return b.Uri;
    }

    public void Stop()
    {
        lock (gate) { cts?.Cancel(); cts = null; }
    }

    public void Start(LiveOptions o)
    {
        CancellationToken ct;
        lock (gate)
        {
            cts?.Cancel();
            cts = new CancellationTokenSource();
            ct = cts.Token;
        }
        _ = Task.Run(() => Loop(o, ct));
    }

    static async Task Loop(LiveOptions o, CancellationToken ct)
    {
        var attempt = 0;
        while (!ct.IsCancellationRequested)
        {
            o.OnState(attempt > 0 ? LiveState.Retrying : LiveState.Connecting, "");
            string why;
            try
            {
                var baseUrl = await o.Url(attempt > 0);
                if (ct.IsCancellationRequested) return;
                using var ws = new ClientWebSocket();
                foreach (var (k, v) in o.Headers) ws.Options.SetRequestHeader(k, v);
                var uri = WsUrl(baseUrl, o.DeviceId) ?? throw new InvalidOperationException("Not a server address.");
                using (var connect = CancellationTokenSource.CreateLinkedTokenSource(ct))
                {
                    connect.CancelAfter(TimeSpan.FromSeconds(20));
                    await ws.ConnectAsync(uri, connect.Token);
                }
                why = await Receive(ws, o, ct, () => attempt = 0);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception e)
            {
                var msg = e.Message + " " + e.InnerException?.Message;
                why = msg.Contains("401") ? "The server rejected the sync token."
                    : msg.Contains("403") ? "Cloudflare Access blocked live updates."
                    : "Couldn’t open live updates.";
            }
            if (ct.IsCancellationRequested) return;
            var delay = (int)Math.Min(30_000, 1000 * Math.Pow(2, attempt++));
            o.OnState(LiveState.Retrying, $"{why} Retrying in {delay / 1000} s.");
            try { await Task.Delay(delay, ct); } catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>Reads messages until the socket closes or goes quiet; returns why it stopped.</summary>
    static async Task<string> Receive(ClientWebSocket ws, LiveOptions o, CancellationToken ct, Action reset)
    {
        var buf = new byte[16 * 1024];
        var text = new StringBuilder();
        while (true)
        {
            WebSocketReceiveResult r;
            using (var quiet = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                quiet.CancelAfter(HeartbeatTimeout);
                try { r = await ws.ReceiveAsync(buf, quiet.Token); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return "Live updates went quiet."; }
                catch (WebSocketException) { return "The server closed live updates."; }
            }
            if (r.MessageType == WebSocketMessageType.Close) return "The server closed live updates.";
            text.Append(Encoding.UTF8.GetString(buf, 0, r.Count));
            if (!r.EndOfMessage) continue;
            var raw = text.ToString();
            text.Clear();
            string? type = null;
            try { type = Js.AsString(JsonNode.Parse(raw)?["type"]); } catch (System.Text.Json.JsonException) { }
            if (type == "hello")
            {
                reset();
                o.OnState(LiveState.Live, "");
                o.OnConnected(); // catch up on anything missed while disconnected
            }
            else if (type == "changed") o.OnChanged();
        }
    }
}
