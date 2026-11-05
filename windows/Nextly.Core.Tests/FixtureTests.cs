// Runs the shared cases in spec/fixtures, which the TypeScript app
// (app/src/fixtures.test.ts) and the Swift apps (apple/NextlyKit) run too. A
// rule change goes in the fixtures first; every app must then pass them
// (spec/protocol.md, "Shared test cases").
//
// Every fixture file has "now" (an instant, for timestamps and new orders)
// and "today" (the local date, for date words and start dates).

using System.Text.Json.Nodes;
using Nextly.Core;
using Xunit;

namespace Nextly.Core.Tests;

public class FixtureTests
{
    static readonly string Root = FindRoot();

    static string FindRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (Directory.Exists(Path.Combine(dir.FullName, "spec", "fixtures"))) return dir.FullName;
        throw new InvalidOperationException("Can't find spec/fixtures above the test folder.");
    }

    static readonly Dictionary<string, JsonObject> Files = new();

    static JsonObject Fixture(string file)
    {
        lock (Files)
        {
            if (!Files.TryGetValue(file, out var f))
                Files[file] = f = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "spec", "fixtures", file)))!.AsObject();
            return f;
        }
    }

    static string[] Manifest() =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures.manifest.json")))!.AsArray()
            .Select((x) => x!.GetValue<string>()).ToArray();

    public static IEnumerable<object[]> Cases() =>
        Manifest().SelectMany((file) => Fixture(file)["cases"]!.AsArray().Select((c) => new object[] { file, c!["id"]!.GetValue<string>() }));

    [Fact]
    public void EveryManifestFileHasARunner()
    {
        foreach (var file in Manifest()) Assert.True(Runners.ContainsKey(file), $"no runner for {file}");
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Case(string file, string id)
    {
        var f = Fixture(file);
        var c = f["cases"]!.AsArray().First((x) => x!["id"]!.GetValue<string>() == id)!.AsObject();
        Runners[file](f, c);
    }

    // ---------- helpers ----------

    static DateOnly Today(JsonObject f) => DateOnly.ParseExact(f["today"]!.GetValue<string>(), "yyyy-MM-dd");
    static string? Str(JsonNode? n) => Js.AsString(n);

    static void Same(JsonNode? expected, JsonNode? actual, string what = "")
    {
        if (!Js.DeepEquals(expected, actual))
            Assert.Fail($"{what}\nexpected: {Js.Json(expected)}\n  actual: {Js.Json(actual)}");
    }

    /// <summary>Records as fixtures write them: hlc and deleted are optional.</summary>
    static OrderedDictionary<string, Rec> Recs(JsonNode? rows)
    {
        var outp = new OrderedDictionary<string, Rec>();
        foreach (var r in rows?.AsArray() ?? [])
        {
            var id = r!["id"]!.GetValue<string>();
            outp[id] = new Rec(id, r["kind"]!.GetValue<string>(), Str(r["hlc"]) ?? "", Js.Truthy(r["deleted"]), Js.Clone(r["data"]));
        }
        return outp;
    }

    /// <summary>A fresh draft whose new ids are n1, n2, ...</summary>
    static Draft NewDraft(JsonObject f, JsonNode? rows)
    {
        var n = 0;
        var now = DateTimeOffset.FromUnixTimeMilliseconds((long)Js.DateParse(f["now"]!.GetValue<string>()));
        return new Draft(Recs(rows), new Ctx(now, f["today"]!.GetValue<string>(), () => $"n{++n}"));
    }

    static readonly Dictionary<string, Func<Draft, JsonObject, JsonNode?>> Actions = new()
    {
        ["createTask"] = (d, a) => Rules.CreateTask(d, a["task"] as JsonObject),
        ["updateTask"] = (d, a) => { Rules.UpdateTask(d, Str(a["id"])!, a["patch"]!.AsObject()); return null; },
        ["setFlag"] = (d, a) => { Rules.SetFlag(d, Str(a["id"])!, Str(a["flag"])); return null; },
        ["toggleDone"] = (d, a) => Rules.ToggleDone(d, Str(a["id"])!),
        ["resolveWithNotes"] = (d, a) => { Rules.ResolveWithNotes(d, Str(a["id"])!, Str(a["notes"]) ?? "", Str(a["resolutionActionId"])); return null; },
        ["queueIiq"] = (d, a) => { Rules.QueueIiq(d, Str(a["id"])!, Str(a["iiq"])!, Str(a["text"])); return null; },
        ["setStartOn"] = (d, a) => { Rules.SetStartOn(d, Str(a["id"])!, Str(a["startOn"])); return null; },
        ["promoteDue"] = (d, _) => { Rules.PromoteDue(d); return null; },
        ["deleteTask"] = (d, a) => { Rules.DeleteTask(d, Str(a["id"])!); return null; },
        ["addDependency"] = (d, a) => Rules.AddDependency(d, Str(a["id"])!, Str(a["dependsOn"])!),
        ["removeDependency"] = (d, a) => { Rules.RemoveDependency(d, Str(a["id"])!, Str(a["dependsOn"])!); return null; },
        ["moveInNext"] = (d, a) => { Rules.MoveInNext(d, Str(a["id"])!, Str(a["before"])); return null; },
        ["createProject"] = (d, a) => Rules.CreateProject(d, Str(a["title"]) ?? "", Str(a["areaId"])),
        ["updateProject"] = (d, a) => { Rules.UpdateProject(d, Str(a["id"])!, a["patch"]!.AsObject()); return null; },
        ["deleteProject"] = (d, a) => { Rules.DeleteProject(d, Str(a["id"])!); return null; },
        ["createArea"] = (d, a) => Rules.CreateArea(d, Str(a["title"]) ?? ""),
        ["updateArea"] = (d, a) => { Rules.UpdateArea(d, Str(a["id"])!, a["patch"]!.AsObject()); return null; },
        ["deleteArea"] = (d, a) => { Rules.DeleteArea(d, Str(a["id"])!); return null; },
    };

    /// <summary>Runs an action and returns { result, changed } in the fixtures' shape.</summary>
    static JsonObject Act(JsonObject f, JsonObject c)
    {
        var d = NewDraft(f, c["records"]);
        var a = c["action"]!.AsObject();
        var type = Str(a["type"])!;
        Assert.True(Actions.ContainsKey(type), $"unknown action {type}");
        var result = Actions[type](d, a);
        var changed = new JsonObject();
        foreach (var ch in d.Changes.Values)
            changed[ch.Id] = new JsonObject { ["kind"] = ch.Kind, ["deleted"] = ch.Deleted, ["data"] = Js.Clone(ch.Data) };
        return new JsonObject { ["result"] = result, ["changed"] = changed };
    }

    static JsonArray Ids(IEnumerable<TaskItem> ts) => new(ts.Select((t) => (JsonNode)t.Id).ToArray());

    static readonly Dictionary<string, Action<JsonObject, JsonObject>> Runners = new()
    {
        ["quick-add.json"] = (f, c) => Same(c["expect"], Logic.ParseQuickAdd(Str(c["input"])!, Today(f))),
        ["date-words.json"] = (f, c) => Same(c["expect"], Logic.ParseDateWord(Str(c["word"])!, Today(f))),
        ["repeats.json"] = (f, c) =>
        {
            var fn = Str(c["fn"]);
            RepeatRule Rule() => RepeatRule.Parse(Logic.NormRepeat(c["repeat"]))!;
            JsonNode? got = fn switch
            {
                "nextOccurrence" => Logic.NextOccurrence(Rule(), Str(c["after"])!),
                "nextStart" => Logic.NextStart(Rule(), Str(c["task"]?["startOn"]), Str(c["task"]?["deadline"]), Str(f["today"])!),
                "daysBetween" => Logic.DaysBetween(Str(c["a"])!, Str(c["b"])!),
                "label" => Logic.RepeatLabel(Rule()),
                "normRepeat" => Logic.NormRepeat(c["input"]),
                "parseRepeatWord" => Logic.ParseRepeatWord(Str(c["word"])!),
                _ => throw new InvalidOperationException($"unknown fn {fn}"),
            };
            Same(c["expect"], got, fn ?? "");
        },
        ["capture-links.json"] = (_, c) => Same(c["expect"], Logic.ParseCaptureLink(Str(c["link"])!)),
        ["network.json"] = (_, c) =>
        {
            var rows = (c["rows"]?.AsArray() ?? []).Select((r) => new Logic.HeaderRow(Str(r!["name"]) ?? "", Str(r["value"]) ?? "")).ToList();
            switch (Str(c["fn"]))
            {
                case "checkHeaders":
                    var err = Logic.CheckHeaders(rows);
                    if (c["expect"] is null) Assert.Null(err);
                    else Assert.True(err is not null && err.Contains(Str(c["expect"])!), $"{err} should contain {Str(c["expect"])}");
                    break;
                case "headerObject":
                    var o = new JsonObject();
                    foreach (var (k, v) in Logic.HeaderObject(rows)) o[k] = v;
                    Same(c["expect"], o);
                    break;
                case "blockedByAccess":
                    Assert.Equal(Js.Truthy(c["expect"]), Logic.BlockedByAccess((int)Js.Number(c["status"]), Str(c["contentType"]), Str(c["url"]) ?? ""));
                    break;
                default: Assert.Fail($"unknown fn {Str(c["fn"])}"); break;
            }
        },
        ["flags.json"] = (f, c) =>
        {
            switch (Str(c["fn"]))
            {
                case "promote": Same(c["expect"], Logic.Promote(Str(c["flag"]))); break;
                case "defer": Same(c["expect"], Logic.Defer(Str(c["flag"]))); break;
                case "orderBetween":
                    double? Opt(JsonNode? n) => n is null ? null : Js.Number(n);
                    Same(c["expect"], Logic.OrderBetween(Opt(c["before"]), Opt(c["after"]), Js.DateParse(Str(f["now"])!)));
                    break;
                default: Assert.Fail($"unknown fn {Str(c["fn"])}"); break;
            }
        },
        ["normalize.json"] = (_, c) => Same(c["expect"], Logic.NormTask(c["input"])),
        ["lists.json"] = (_, c) =>
        {
            var v = Rules.BuildView(Recs(c["records"]).Values);
            foreach (var (view, ids) in c["views"]!.AsObject())
                Same(ids, Ids(Lists.TasksFor(v, view, Str(c["query"]) ?? "")), view);
            if (c["counts"] is { } counts) Same(counts, Lists.Counts(v), "counts");
        },
        ["actions.json"] = (f, c) => Same(c["expect"], Act(f, c)),
        ["roundtrip.json"] = (f, c) => Same(c["expect"], Act(f, c)),
    };
}
