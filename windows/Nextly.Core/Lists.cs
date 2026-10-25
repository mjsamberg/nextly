// Port of app/src/lists.ts: which tasks appear in which list. One place, so
// counts and lists agree. A view is "inbox", "doing", "today", "next",
// "scheduled", "someday", "all", "logbook", "search" or "project:<id>".

using System.Text.Json.Nodes;

namespace Nextly.Core;

public sealed record ProjectGroup(string? ProjectId, string Title, List<TaskItem> Tasks);
public sealed record AllGroup(string? AreaId, string Title, List<ProjectGroup> Projects);

public static class Lists
{
    static double ByOrder(TaskItem a, TaskItem b) => a.Order - b.Order;
    static double ByCreated(TaskItem a, TaskItem b) => Js.Cmp(a.CreatedAt, b.CreatedAt);

    /// <summary>
    /// A task with no flag, project or parent would otherwise be lost, so it
    /// shows in Inbox, unless it's waiting for a start date (then Scheduled).
    /// Incident IQ tickets stay in their project, never the Inbox.
    /// </summary>
    static bool InInbox(TaskItem t) => !t.IsTicket
        && (t.Flag == "inbox" || (t.Data["flag"] is null && !t.HasProject && !t.HasParent && !Js.Truthy(t.Data["startOn"])));

    /// <summary>In the All list, what you're doing comes first and Someday last.</summary>
    static int FlagRank(TaskItem t) => (t.Data["flag"] is null ? "null" : Js.Str(t.Data["flag"])) switch
    {
        "doing" => 0, "today" => 1, "next" => 2, "inbox" => 3, "null" => 4, "someday" => 5, _ => 4,
    };

    /// <summary>The date a task is filed under in Scheduled: its start date, else its deadline.</summary>
    public static string? ScheduledDate(TaskItem t) => t.StartOn ?? t.Deadline;

    /// <summary>A list of Incident IQ tickets (every task has a submitted date) goes newest submitted first.</summary>
    static List<TaskItem> NewestTicketsFirst(List<TaskItem> tasks)
    {
        if (tasks.Count == 0 || !tasks.All((t) => t.TicketCreated is not null)) return tasks;
        double When(TaskItem t) { var ms = Js.DateParse(t.TicketCreated!); return double.IsNaN(ms) ? 0 : ms; }
        return Js.Sorted(tasks, (a, b) => When(b) - When(a));
    }

    public static List<TaskItem> TasksFor(ViewData v, string view, string query = "")
    {
        var ts = v.Tasks;
        switch (view)
        {
            case "inbox": return Js.Sorted(ts.Where((t) => !t.Done && InInbox(t)), ByCreated);
            case "doing": return Js.Sorted(ts.Where((t) => !t.Done && t.Flag == "doing"), ByOrder);
            case "today": return Js.Sorted(ts.Where((t) => !t.Done && t.Flag == "today"), ByOrder);
            case "next": return Js.Sorted(ts.Where((t) => !t.Done && t.Flag == "next"), ByOrder);
            case "someday": return Js.Sorted(ts.Where((t) => !t.Done && t.Flag == "someday"), ByCreated);
            case "scheduled":
                return Js.Sorted(ts.Where((t) => !t.Done && !string.IsNullOrEmpty(ScheduledDate(t))), (a, b) => Js.Cmp(ScheduledDate(a)!, ScheduledDate(b)!));
            case "all": return Js.Sorted(ts.Where((t) => !t.Done && !t.HasParent), (a, b) => FlagRank(a) - FlagRank(b) is var d && d != 0 ? d : ByOrder(a, b));
            case "logbook": return Js.Sorted(ts.Where((t) => t.Done), (a, b) => Js.Cmp(b.DoneAt, a.DoneAt));
            case "search":
                var q = query.Trim().ToLowerInvariant();
                if (q.Length == 0) return [];
                return Js.Sorted(ts.Where((t) => (t.Title + " " + Logic.NoteText(t)).ToLowerInvariant().Contains(q)),
                    (a, b) => (a.Done ? 1 : 0) - (b.Done ? 1 : 0) is var d && d != 0 ? d : ByCreated(a, b));
            default:
                var pid = view.StartsWith("project:", StringComparison.Ordinal) ? view["project:".Length..] : view;
                return NewestTicketsFirst(Js.Sorted(ts.Where((t) => !t.Done && t.ProjectId == pid && !t.HasParent), ByOrder));
        }
    }

    public static JsonObject Counts(ViewData v) => new()
    {
        ["inbox"] = TasksFor(v, "inbox").Count,
        ["doing"] = TasksFor(v, "doing").Count,
        ["today"] = TasksFor(v, "today").Count,
        ["next"] = TasksFor(v, "next").Count,
    };

    /// <summary>
    /// All open tasks (not subtasks), grouped by area, then project. Projects
    /// without an area come after the areas; tasks without a project come last.
    /// </summary>
    public static List<AllGroup> AllGrouped(ViewData v)
    {
        var tasks = TasksFor(v, "all");
        List<TaskItem> InProject(string pid) => NewestTicketsFirst(tasks.Where((t) => t.ProjectId == pid).ToList());
        bool KnownArea(ProjectItem p) => p.HasArea && v.Areas.Any((a) => a.Id == p.AreaId);
        List<ProjectGroup> ProjectsIn(string? areaId) => v.Projects
            .Where((p) => areaId is not null ? p.AreaId == areaId : !KnownArea(p))
            .Select((p) => new ProjectGroup(p.Id, p.Title.Length > 0 ? p.Title : "Untitled project", InProject(p.Id)))
            .Where((p) => p.Tasks.Count > 0)
            .ToList();
        var groups = v.Areas
            .Select((a) => new AllGroup(a.Id, a.Title.Length > 0 ? a.Title : "Untitled area", ProjectsIn(a.Id)))
            .Where((g) => g.Projects.Count > 0)
            .ToList();
        var loose = ProjectsIn(null);
        if (loose.Count > 0) groups.Add(new AllGroup(null, v.Areas.Count > 0 ? "Other projects" : "Projects", loose));
        var known = v.Projects.Select((p) => p.Id).ToHashSet();
        var noProject = tasks.Where((t) => !t.HasProject || t.ProjectId is null || !known.Contains(t.ProjectId)).ToList();
        if (noProject.Count > 0) groups.Add(new AllGroup(null, "No project", [new ProjectGroup(null, "", noProject)]));
        return groups;
    }

    public static string ViewTitle(ViewData v, string view) => view switch
    {
        "inbox" => "Inbox", "doing" => "In Progress", "today" => "Today", "next" => "Next", "scheduled" => "Scheduled",
        "all" => "All", "someday" => "Someday", "logbook" => "Logbook", "search" => "Search",
        _ => v.Project(view.StartsWith("project:", StringComparison.Ordinal) ? view["project:".Length..] : view)?.Title is { Length: > 0 } t ? t : "Untitled project",
    };
}
