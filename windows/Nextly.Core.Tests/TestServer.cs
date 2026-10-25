// The real sync server (server/server.js) on a spare port with throwaway
// data, for the sync tests. Runs it with Node 24 (NODE, or node on PATH), or,
// when there's no Node 24, in Docker (node:24-alpine). Skips the tests if
// neither is available.

using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Nextly.Core;
using Xunit;

namespace Nextly.Core.Tests;

public sealed class TestServer : IDisposable
{
    public const string Token = "test-token";
    public int Port { get; }
    public string Base => $"http://127.0.0.1:{Port}";
    readonly string? data;
    readonly Process? process;
    readonly string? container;

    static readonly string Root = FindRoot();
    static readonly HttpClient Http = new();

    static string FindRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "server", "server.js"))) return dir.FullName;
        throw new InvalidOperationException("Can't find server/server.js above the test folder.");
    }

    static string? Run(string file, string args)
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo(file, args) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false })!;
            var outp = p.StandardOutput.ReadToEnd();
            p.WaitForExit(60_000);
            return p.ExitCode == 0 ? outp : null;
        }
        catch (Exception) { return null; }
    }

    static readonly Lazy<string?> Node = new(() =>
    {
        foreach (var c in new[] { Environment.GetEnvironmentVariable("NODE"), "node" })
            if (c is not null && Run(c, "-e \"process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)\"") is not null) return c;
        return null;
    });

    static readonly Lazy<bool> Docker = new(() => Run("docker", "info --format {{.ServerVersion}}") is not null);

    public TestServer(int? port = null)
    {
        Port = port ?? Random.Shared.Next(20000, 40000);
        if (Node.Value is { } node)
        {
            data = Path.Combine(Path.GetTempPath(), $"nextly-test-{Guid.NewGuid():N}");
            var psi = new ProcessStartInfo(node, "server.js")
            {
                WorkingDirectory = Path.Combine(Root, "server"), RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false,
            };
            psi.Environment["NEXTLY_TOKEN"] = Token;
            psi.Environment["NEXTLY_DATA"] = data;
            psi.Environment["PORT"] = Port.ToString();
            psi.Environment["IIQ_URL"] = "";
            process = Process.Start(psi)!;
        }
        else
        {
            Skip.IfNot(Docker.Value, "Neither Node 24 nor Docker is available; set NODE to run the sync tests.");
            container = $"nextly-test-{Port}";
            var server = Path.Combine(Root, "server");
            var ok = Run("docker", $"run -d --rm --name {container} -p 127.0.0.1:{Port}:{Port} -v \"{server}:/srv:ro\" " +
                $"-e NEXTLY_TOKEN={Token} -e NEXTLY_DATA=/tmp/data -e PORT={Port} -e IIQ_URL= node:24-alpine node /srv/server.js");
            Skip.If(ok is null, "Docker couldn't start the sync server.");
        }
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            try { if (Http.GetAsync($"{Base}/health").Result.IsSuccessStatusCode) return; } catch (Exception) { }
            Thread.Sleep(200);
        }
        Dispose();
        Skip.If(true, "The sync server didn't start.");
    }

    public void Dispose()
    {
        if (process is { HasExited: false }) { process.Kill(true); process.WaitForExit(); }
        if (container is not null) Run("docker", $"rm -f {container}");
        if (data is not null) try { Directory.Delete(data, true); } catch (IOException) { }
    }

    HttpRequestMessage Req(HttpMethod m, string path)
    {
        var r = new HttpRequestMessage(m, Base + path);
        r.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        return r;
    }

    /// <summary>A raw request, as another app would make it.</summary>
    public async Task<JsonNode?> Post(string path, JsonNode body)
    {
        using var r = Req(HttpMethod.Post, path);
        r.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var res = await Http.SendAsync(r);
        return JsonNode.Parse(await res.Content.ReadAsStringAsync());
    }

    /// <summary>Every record the server holds.</summary>
    public async Task<Dictionary<string, Rec>> All()
    {
        var rows = (await Post("/sync", new JsonObject { ["cursor"] = 0, ["changes"] = new JsonArray() }))!["changes"]!.AsArray();
        return rows.Select((r) => new Rec(r!["id"]!.GetValue<string>(), r["kind"]!.GetValue<string>(), r["hlc"]!.GetValue<string>(),
            Js.Truthy(r["deleted"]), Js.Clone(r["data"]))).GroupBy((r) => r.Id).ToDictionary((g) => g.Key, (g) => g.Last());
    }

    /// <summary>Whether the server has a file (by its hash).</summary>
    public async Task<bool> HasFile(string sha)
    {
        using var r = Req(HttpMethod.Get, $"/files/{sha}");
        using var res = await Http.SendAsync(r);
        return res.IsSuccessStatusCode;
    }
}
