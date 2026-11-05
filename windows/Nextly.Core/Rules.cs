// Port of app/src/rules.ts: the store's rules as pure functions. Given the
// records, an action works on a Draft and leaves behind the records it
// changed; the store saves them. The TypeScript and Swift apps implement the
// same rules and spec/fixtures holds all three to them (spec/protocol.md).
//
// Determinism: time comes from Ctx.Now / Ctx.Today, new ids from Ctx.NewId
// (in the order documented at each action), and tasks are visited in id order.

using System.Text.Json.Nodes;

namespace Nextly.Core;

public sealed record Ctx(DateTimeOffset Now, string Today, Func<string> NewId)
{
    public double NowMs => Js.Ms(Now);
    public string NowIso => Js.Iso(NowMs);
}

public sealed record Change(string Kind, string Id, JsonNode? Data, bool Deleted);

public static class Schema
{
    /// <summary>The record format this app writes. Bump only for changes older apps can't safely save over.</summary>
    public const int Current = 1;

    public static double Of(JsonNode? data) => Js.Has(data, "schema", out var s) && Js.IsNumber(s, out var n) ? n : 1;

    /// <summary>A record this app may change: present, not deleted, and not from a newer format.</summary>
    public static bool Editable(Rec? r) => r is not null && !r.Deleted && Of(r.Data) <= Current;
}

/// <summary>The records as an action sees them: the stored ones plus its own changes so far.</summary>
public sealed class Draft
{
    public OrderedDictionary<string, Change> Changes { get; } = new();
    readonly OrderedDictionary<string, Rec> based;
    public Ctx Ctx { get; }

    public Draft(OrderedDictionary<string, Rec> records, Ctx ctx) { based = records; Ctx = ctx; }

    public Rec? Rec(string id) =>
        Changes.TryGetValue(id, out var c) ? new Rec(c.Id, c.Kind, "", c.Deleted, c.Data) : based.GetValueOrDefault(id);

    public void Save(string kind, string id, JsonNode? data, bool deleted = false) => Changes[id] = new Change(kind, id, data, deleted);

    /// <summary>A task this action may change, normalized.</summary>
    public JsonObject? Task(string id) =>
        Rec(id) is { } r && Schema.Editable(r) && r.Kind == "task" ? Logic.NormTask(r.Data) : null;

    public void SaveTask(string id, JsonObject t) => Save("task", id, t);

    /// <summary>Every record, with this action's changes.</summary>
    public IEnumerable<Rec> Records()
    {
        foreach (var c in Changes.Values.ToList()) yield return new Rec(c.Id, c.Kind, "", c.Deleted, c.Data);
        foreach (var r in based.Values) if (!Changes.ContainsKey(r.Id)) yield return r;
    }

    /// <summary>Every task that isn't deleted, in id order.</summary>
    public List<TaskItem> Tasks() =>
        Js.Sorted(Records().Where((r) => r.Kind == "task" && !r.Deleted).Select(Rules.Item), (a, b) => Js.Cmp(a.Id, b.Id));

    public TaskItem? TaskItem(string id) => Rec(id) is { Kind: "task", Deleted: false } r ? Rules.Item(r) : null;

    public List<TaskItem> Children(string id) => Js.Sorted(Tasks().Where((t) => t.ParentId == id), Rules.ByOrder);
    public List<TaskItem> Blocks(string id) => Tasks().Where((t) => t.DependsOn.Contains(id)).ToList();
    public List<TaskItem> Blockers(TaskItem t) => Logic.OpenBlockers(t, TaskItem);
}

/// <summary>The view every list is built from.</summary>
public sealed class ViewData
{
    public required List<TaskItem> Tasks { get; init; }
    public required List<ProjectItem> Projects { get; init; }
    public required List<AreaItem> Areas { get; init; }
    /// <summary>How many records came from a newer Nextly and can't be changed here.</summary>
    public int Newer { get; init; }
    internal Dictionary<string, TaskItem> TasksById { get; init; } = [];
    internal Dictionary<string, List<TaskItem>> Kids { get; init; } = [];
    internal Dictionary<string, List<TaskItem>> BlocksMap { get; init; } = [];
    internal Dictionary<string, List<IiqActionItem>> Actions { get; init; } = [];

    public TaskItem? Task(string id) => TasksById.GetValueOrDefault(id);
    public ProjectItem? Project(string? id) => id is null ? null : Projects.FirstOrDefault((p) => p.Id == id);
    public List<TaskItem> Children(string id) => Kids.GetValueOrDefault(id) ?? [];
    public List<TaskItem> Blockers(TaskItem t) => Logic.OpenBlockers(t, Task);
    public List<TaskItem> Blocks(string id) => BlocksMap.GetValueOrDefault(id) ?? [];
    /// <summary>Incident IQ requests for a task, newest first.</summary>
    public List<IiqActionItem> IiqActions(string taskId) =>
        Js.Sorted(Actions.GetValueOrDefault(taskId) ?? [], (a, b) => Js.Cmp(b.CreatedAt, a.CreatedAt));
}

public static class Rules
{
    public static double ByOrder(TaskItem a, TaskItem b) => a.Order - b.Order is var d && d != 0 ? d : Js.Cmp(a.Id, b.Id);

    public static TaskItem Item(Rec r) => new(r.Id, Logic.NormTask(r.Data), Schema.Of(r.Data) > Schema.Current);

    public static ViewData BuildView(IEnumerable<Rec> records)
    {
        var tasks = new List<TaskItem>();
        var projects = new List<ProjectItem>();
        var areas = new List<AreaItem>();
        var actions = new Dictionary<string, List<IiqActionItem>>();
        var newer = 0;
        foreach (var r in records)
        {
            if (r.Deleted) continue;
            var ro = Schema.Of(r.Data) > Schema.Current;
            if (ro) newer++;
            switch (r.Kind)
            {
                case "task": tasks.Add(Item(r)); break;
                case "project": projects.Add(new ProjectItem(r.Id, Js.Spread(r.Data), ro)); break;
                case "area": areas.Add(new AreaItem(r.Id, Js.Spread(r.Data), ro)); break;
                case "iiq-action":
                    var a = new IiqActionItem(r.Id, Js.Spread(r.Data));
                    (actions.TryGetValue(a.TaskId, out var l) ? l : actions[a.TaskId] = []).Add(a);
                    break;
            }
        }
        tasks = Js.Sorted(tasks, (a, b) => Js.Cmp(a.Id, b.Id));
        var kids = new Dictionary<string, List<TaskItem>>();
        var blocks = new Dictionary<string, List<TaskItem>>();
        foreach (var t in tasks)
        {
            if (t.HasParent && t.ParentId is { } p) (kids.TryGetValue(p, out var k) ? k : kids[p] = []).Add(t);
            foreach (var d in t.DependsOn) (blocks.TryGetValue(d, out var b) ? b : blocks[d] = []).Add(t);
        }
        foreach (var key in kids.Keys.ToList()) kids[key] = Js.Sorted(kids[key], ByOrder);
        return new ViewData
        {
            Tasks = tasks,
            Projects = Js.Sorted(projects, (a, b) => a.Order - b.Order),
            Areas = Js.Sorted(areas, (a, b) => a.Order - b.Order),
            Newer = newer,
            TasksById = tasks.ToDictionary((t) => t.Id),
            Kids = kids,
            BlocksMap = blocks,
            Actions = actions,
        };
    }

    // ---------- tasks ----------

    static double NextOrderEnd(Draft d) =>
        d.Tasks().Where((t) => t.Flag == "next").Select((t) => t.Order).Prepend(0).Max() + 1000;

    static bool OpenTicket(JsonObject t) => new TaskItem("", t).IsOpenTicket;

    /// <summary>New ids: the task's.</summary>
    public static string CreateTask(Draft d, JsonObject? p)
    {
        var id = d.Ctx.NewId();
        var t = Js.Merge(new JsonObject
        {
            ["title"] = "", ["flag"] = "inbox", ["projectId"] = null, ["parentId"] = null, ["deadline"] = null,
            ["startOn"] = null, ["repeat"] = null, ["nextId"] = null, ["external"] = null,
            ["done"] = false, ["doneAt"] = null, ["order"] = 0, ["dependsOn"] = new JsonArray(), ["notes"] = new JsonArray(),
            ["createdAt"] = d.Ctx.NowIso,
        }, p);
        if (!Js.Truthy(t["order"])) t["order"] = Js.AsString(t["flag"]) == "next" ? NextOrderEnd(d) : d.Ctx.NowMs;
        d.SaveTask(id, t);
        return id;
    }

    public static void UpdateTask(Draft d, string id, JsonObject patch)
    {
        if (d.Task(id) is { } t) d.SaveTask(id, Js.Merge(t, patch));
    }

    /// <summary>Starting an Incident IQ ticket's task (In Progress) starts the ticket too.</summary>
    public static void SetFlag(Draft d, string id, string? flag)
    {
        if (d.Task(id) is not { } t || Js.AsString(t["flag"]) == flag && (flag is not null || t["flag"] is null)) return;
        d.SaveTask(id, Js.With(t, ("flag", flag), ("order", flag == "next" ? NextOrderEnd(d) : Js.Clone(t["order"]))));
        if (flag == "doing" && OpenTicket(t)) QueueIiq(d, id, "start");
    }

    /// <summary>Asks the server to do something in Incident IQ (server/iiq.js). New ids: the action's.</summary>
    public static void QueueIiq(Draft d, string taskId, string type, string? text = null, string? resolutionActionId = null)
    {
        if (d.Task(taskId) is not { } t || Js.AsString(t["external"]?["source"]) != "iiq") return;
        var action = new JsonObject
        {
            ["type"] = type, ["taskId"] = taskId, ["ticketId"] = Js.Clone(t["external"]!["id"]),
            ["state"] = "pending", ["createdAt"] = d.Ctx.NowIso,
        };
        if (!string.IsNullOrEmpty(text)) action["text"] = text;
        if (!string.IsNullOrEmpty(resolutionActionId)) action["resolutionActionId"] = resolutionActionId;
        d.Save("iiq-action", d.Ctx.NewId(), action);
    }

    /// <summary>
    /// Completing a task also completes its open subtasks; tasks it was blocking
    /// that are now free move to Next (unless in Today or In Progress); a
    /// repeating task files its next copy. Un-completing removes that copy if
    /// it's still open. An open Incident IQ ticket's task needs resolution
    /// notes first: nothing changes and this returns "needs-notes".
    /// </summary>
    public static string? ToggleDone(Draft d, string id)
    {
        if (d.Task(id) is { } t && !Js.Truthy(t["done"]) && OpenTicket(t)) return "needs-notes";
        Finish(d, id, false);
        return null;
    }

    /// <summary>
    /// Finishes an open ticket's task with resolution notes. A resolution
    /// action chosen in the app (from the server's list) goes with it; none
    /// means the server's default.
    /// </summary>
    public static void ResolveWithNotes(Draft d, string id, string notes, string? resolutionActionId = null)
    {
        var n = notes.Trim();
        Finish(d, id, false, n.Length > 0 ? n : null, resolutionActionId);
    }

    static void Finish(Draft d, string id, bool viaParent, string? notes = null, string? resolutionActionId = null)
    {
        if (d.Task(id) is not { } t) return;
        var item = new TaskItem(id, t);
        if (item.Done)
        {
            var copy = item.NextId is { } nid && Js.Truthy(t["nextId"]) ? d.Task(nid) : null;
            if (copy is not null && !Js.Truthy(copy["done"])) DeleteTask(d, item.NextId!);
            d.SaveTask(id, Js.With(t, ("done", false), ("doneAt", null), ("nextId", null)));
            return;
        }
        // Subtasks finished along with a repeating parent come back with its copy.
        var nextId = item.Repeat is not null && !viaParent ? SpawnNext(d, id, t, item) : null;
        if (item.IsOpenTicket && !viaParent) QueueIiq(d, id, "resolve", notes, resolutionActionId);
        d.SaveTask(id, Js.With(t, ("done", true), ("doneAt", d.Ctx.NowIso), ("nextId", nextId)));
        foreach (var c in d.Children(id)) if (!c.Done) Finish(d, c.Id, true);
        foreach (var w in d.Blocks(id))
        {
            if (w.Done || w.Flag is "today" or "doing") continue;
            if (d.Blockers(w).Count == 0) SetFlag(d, w.Id, "next");
        }
    }

    /// <summary>
    /// The next copy of a repeating task: same title, notes and subtasks, all
    /// unchecked, waiting for its date. New ids, in this order: the copy, its
    /// note blocks, then for each subtask (by order) the subtask and its notes.
    /// </summary>
    static string SpawnNext(Draft d, string id, JsonObject t, TaskItem item)
    {
        var start = Logic.NextStart(item.Repeat!, item.StartOn, item.Deadline, d.Ctx.Today);
        // Keep the deadline the same distance from the start as before.
        var offset = item.Deadline is { Length: > 0 } dl ? Logic.DaysBetween(item.StartOn ?? dl, dl) : 0;
        JsonArray Reset(JsonNode? notes)
        {
            var outp = new JsonArray();
            if (notes is JsonArray a)
                foreach (var b in a)
                {
                    var nb = Js.Spread(b);
                    nb["id"] = d.Ctx.NewId();
                    if (Js.AsString(b?["type"]) == "checklist") nb["checked"] = false;
                    outp.Add(nb);
                }
            return outp;
        }
        var now = d.Ctx.NowIso;
        var copyId = d.Ctx.NewId();
        d.SaveTask(copyId, Js.With(t,
            ("flag", null),
            ("startOn", start),
            ("deadline", item.Deadline is { Length: > 0 } ? Logic.ShiftDate(start, offset) : null),
            ("done", false), ("doneAt", null), ("nextId", null), ("external", null), ("dependsOn", new JsonArray()),
            ("order", d.Ctx.NowMs),
            ("notes", Reset(t["notes"])),
            ("createdAt", now)));
        foreach (var c in d.Children(id))
        {
            if (d.Task(c.Id) is not { } raw) continue;
            var childId = d.Ctx.NewId();
            d.SaveTask(childId, Js.With(raw,
                ("parentId", copyId), ("done", false), ("doneAt", null), ("nextId", null), ("dependsOn", new JsonArray()),
                ("order", d.Ctx.NowMs), ("notes", Reset(raw["notes"])), ("createdAt", now)));
        }
        return copyId;
    }

    /// <summary>
    /// Moves tasks whose start date has arrived into Today (In Progress stays
    /// put). The app runs it only once it's in step with the server, so it
    /// never saves over newer edits.
    /// </summary>
    public static void PromoteDue(Draft d)
    {
        foreach (var t in d.Tasks())
        {
            if (t.Done || t.StartOn is not { } s || Js.Cmp(s, d.Ctx.Today) > 0) continue;
            UpdateTask(d, t.Id, new JsonObject { ["flag"] = t.Flag == "doing" ? "doing" : "today", ["startOn"] = null });
        }
    }

    /// <summary>Sets or clears a start date. A future date takes the task off its list until then.</summary>
    public static void SetStartOn(Draft d, string id, string? startOn)
    {
        if (d.Task(id) is not { } t) return;
        var item = new TaskItem(id, t);
        if (string.IsNullOrEmpty(startOn))
        {
            JsonNode? flag = t["flag"] is not null ? Js.Clone(t["flag"]) : item.HasParent || item.HasProject ? null : "inbox";
            d.SaveTask(id, Js.With(t, ("startOn", null), ("flag", flag)));
            return;
        }
        if (Js.Cmp(startOn, d.Ctx.Today) <= 0)
        {
            d.SaveTask(id, Js.With(t, ("startOn", null), ("flag", item.Flag == "doing" ? "doing" : "today")));
            return;
        }
        d.SaveTask(id, Js.With(t, ("startOn", startOn), ("flag", item.HasParent ? Js.Clone(t["flag"]) : null)));
    }

    /// <summary>Soft-deletes a task and its subtasks, keeping their data so undo can bring them back.</summary>
    public static void DeleteTask(Draft d, string id)
    {
        IEnumerable<string> Collect(string pid) => d.Children(pid).SelectMany((c) => Collect(c.Id).Prepend(c.Id));
        foreach (var i in Collect(id).Prepend(id).ToList())
        {
            if (d.Rec(i) is { } r && Schema.Editable(r)) d.Save("task", i, Js.Clone(r.Data), true);
        }
    }

    /// <summary>An error message, or null when the dependency was added (or already there).</summary>
    public static string? AddDependency(Draft d, string id, string depId)
    {
        if (Logic.WouldCycle(id, depId, d.TaskItem))
        {
            return depId == id ? "A task can’t depend on itself."
                : $"“{d.TaskItem(depId)?.Title ?? "undefined"}” already waits on this task, so this would make a loop.";
        }
        if (d.Task(id) is not { } t || new TaskItem(id, t).DependsOn.Contains(depId)) return null;
        var deps = (JsonArray)t["dependsOn"]!.DeepClone();
        deps.Add(depId);
        d.SaveTask(id, Js.With(t, ("dependsOn", deps)));
        return null;
    }

    public static void RemoveDependency(Draft d, string id, string depId)
    {
        if (d.Task(id) is not { } t) return;
        var deps = new JsonArray(new TaskItem(id, t).DependsOn.Where((x) => x != depId).Select((x) => (JsonNode)x).ToArray());
        d.SaveTask(id, Js.With(t, ("dependsOn", deps)));
    }

    /// <summary>Moves a task in Next so it sits just before `beforeId` (or last).</summary>
    public static void MoveInNext(Draft d, string id, string? beforeId)
    {
        var list = Js.Sorted(d.Tasks().Where((t) => t.Flag == "next" && !t.Done && t.Id != id), ByOrder);
        var idx = !string.IsNullOrEmpty(beforeId) ? list.FindIndex((t) => t.Id == beforeId) : list.Count;
        double? At(int i) => i >= 0 && i < list.Count ? list[i].Order : null;
        UpdateTask(d, id, new JsonObject { ["order"] = Logic.OrderBetween(At(idx - 1), At(idx), d.Ctx.NowMs) });
    }

    // ---------- projects & areas ----------

    /// <summary>New ids: the project's.</summary>
    public static string CreateProject(Draft d, string title, string? areaId)
    {
        var id = d.Ctx.NewId();
        d.Save("project", id, new JsonObject { ["title"] = title, ["areaId"] = areaId, ["order"] = d.Ctx.NowMs });
        return id;
    }

    public static void UpdateProject(Draft d, string id, JsonObject patch)
    {
        if (d.Rec(id) is { } r && Schema.Editable(r)) d.Save("project", id, Js.Merge(Js.Spread(r.Data), patch));
    }

    /// <summary>Tasks in a deleted project go back to the Inbox.</summary>
    public static void DeleteProject(Draft d, string id)
    {
        if (d.Rec(id) is not { } r || !Schema.Editable(r)) return;
        foreach (var t in d.Tasks())
            if (t.ProjectId == id) UpdateTask(d, t.Id, new JsonObject { ["projectId"] = null, ["flag"] = t.Flag ?? "inbox" });
        d.Save("project", id, Js.Clone(r.Data), true);
    }

    /// <summary>New ids: the area's.</summary>
    public static string CreateArea(Draft d, string title)
    {
        var id = d.Ctx.NewId();
        d.Save("area", id, new JsonObject { ["title"] = title, ["order"] = d.Ctx.NowMs });
        return id;
    }

    public static void UpdateArea(Draft d, string id, JsonObject patch)
    {
        if (d.Rec(id) is { } r && Schema.Editable(r)) d.Save("area", id, Js.Merge(Js.Spread(r.Data), patch));
    }

    /// <summary>Projects in a deleted area stay, without an area.</summary>
    public static void DeleteArea(Draft d, string id)
    {
        if (d.Rec(id) is not { } r || !Schema.Editable(r)) return;
        foreach (var p in BuildView(d.Records()).Projects)
            if (p.AreaId == id) UpdateProject(d, p.Id, new JsonObject { ["areaId"] = null });
        d.Save("area", id, Js.Clone(r.Data), true);
    }
}
