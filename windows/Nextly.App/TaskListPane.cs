// The list on screen (port of app/src/TaskList.tsx): a heading, quick add,
// and the tasks. Today shows In Progress first, then its tasks grouped by
// project, then "Up next"; All groups by area and project; Next can be
// reordered by dragging. The header and quick add stay put while the
// tasks refresh, so typing isn't interrupted by a sync.

using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Nextly.Core;
using Windows.System;

namespace Nextly.App;

public sealed class TaskListPane : Grid
{
    readonly AppModel m;
    readonly Action<string> open;
    readonly Action<string> delete;
    readonly Action<string> go;
    readonly TextBlock heading = Ui.Heading("");
    readonly TextBlock sub = Ui.Muted("");
    readonly TextBox quick = new() { PlaceholderText = "New task…   Ctrl+N  ·  !t Today  !p In Progress  @mon start  *weekly", Margin = new Thickness(24, 12, 24, 4) };
    readonly ScrollViewer scroll = new() { HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    readonly StackPanel body = new() { Padding = new Thickness(16, 4, 16, 32) };
    readonly List<ListView> lists = [];

    static readonly Dictionary<string, string> Empty = new()
    {
        ["inbox"] = "Nothing in your Inbox. New tasks land here until you give them a flag or a project.",
        ["today"] = "Nothing flagged for today. Pull something up from Next, or add a task above.",
        ["doing"] = "Nothing in progress. Flag a Today task In Progress (Ctrl+D) when you start on it.",
        ["next"] = "Next is empty. Flag tasks as Next to line up what comes after Today.",
        ["scheduled"] = "Nothing scheduled. Tasks with a start date, a deadline or a repeat show up here.",
        ["someday"] = "No Someday tasks.",
        ["all"] = "No open tasks anywhere. Add one above, or in any list.",
        ["logbook"] = "Finished tasks show up here.",
        ["search"] = "Type to search task titles and notes.",
    };

    public TaskListPane(AppModel model, Action<string> onOpen, Action<string> onDelete, Action<string> onGo)
    {
        m = model;
        open = onOpen;
        delete = onDelete;
        go = onGo;
        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        var header = new StackPanel { Margin = new Thickness(24, 20, 24, 0), Spacing = 2 };
        header.Children.Add(heading);
        header.Children.Add(sub);
        Children.Add(header);

        quick.KeyDown += (_, e) => { if (e.Key == VirtualKey.Enter) { e.Handled = true; Add(); } };
        SetRow(quick, 1);
        Children.Add(quick);

        scroll.Content = body;
        SetRow(scroll, 2);
        Children.Add(scroll);
    }

    public void FocusQuickAdd() => quick.Focus(FocusState.Keyboard);

    /// <summary>What a task added from this list starts as.</summary>
    static (string? Flag, string? ProjectId) DefaultsFor(string view) =>
        view is "today" or "next" or "someday" or "doing" ? (view, null)
        : view.StartsWith("project:") ? (null, view["project:".Length..])
        : ("inbox", null);

    void Add()
    {
        var today = DateOnly.FromDateTime(DateTime.Now);
        var q = Logic.ParseQuickAdd(quick.Text, today);
        var title = Js.AsString(q["title"]) ?? "";
        var email = Js.AsString(q["emailUrl"]);
        if (title.Length == 0 && email is null) return;
        var (flag, projectId) = DefaultsFor(m.View);
        var notes = new JsonArray();
        if (email is not null) notes.Add(new JsonObject { ["id"] = Logic.Uid(), ["type"] = "email", ["url"] = email, ["subject"] = title });
        var id = m.Store.CreateTask(new JsonObject
        {
            ["title"] = title.Length > 0 ? title : "Email",
            ["flag"] = q.ContainsKey("flag") ? Js.Clone(q["flag"]) : flag,
            ["projectId"] = projectId,
            ["deadline"] = Js.Clone(q["deadline"]),
            ["repeat"] = Js.Clone(q["repeat"]),
            ["notes"] = notes,
        });
        // @date: waits in Scheduled (or goes straight to Today if it's today or past).
        if (Js.AsString(q["startOn"]) is { } start) m.Store.SetStartOn(id, start);
        quick.Text = "";
    }

    /// <summary>A new list: heading, quick add, tasks; back to the top.</summary>
    public void Show()
    {
        quick.Visibility = m.View is "logbook" or "search" ? Visibility.Collapsed : Visibility.Visible;
        Refresh();
        scroll.ChangeView(null, 0, null, true);
    }

    public void Refresh()
    {
        var v = m.Store.View;
        var view = m.View;
        var tasks = Lists.TasksFor(v, view, m.Query);
        heading.Text = Lists.ViewTitle(v, view).ToUpperInvariant();
        sub.Text = view switch
        {
            "today" => $"{DateTime.Now:ddd, MMM d} · {tasks.Count} open",
            "next" => $"{tasks.Count} · drag to reorder",
            "logbook" => $"{tasks.Count} done",
            _ => tasks.Count.ToString(),
        };
        lists.Clear();
        body.Children.Clear();
        switch (view)
        {
            case "all": AllBody(v); break;
            case "today": TodayBody(v, tasks); break;
            case "next": NextBody(v, tasks); break;
            default:
                if (tasks.Count > 0) body.Children.Add(RowList(v, tasks, view));
                else EmptyText(view);
                break;
        }
        Select(m.Selected);
    }

    void EmptyText(string view) =>
        body.Children.Add(new TextBlock
        {
            Text = Empty.GetValueOrDefault(view) ?? "No open tasks in this project. Add one above.",
            Foreground = Ui.Brush("TextFillColorSecondaryBrush"), TextWrapping = TextWrapping.Wrap, MaxWidth = 480,
            HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(12, 16, 0, 0),
        });

    /// <summary>Highlights the open task in whichever section holds it.</summary>
    public void Select(string? id)
    {
        selecting = true;
        foreach (var l in lists)
        {
            var row = l.Items.OfType<TaskRow>().FirstOrDefault((r) => r.TaskId == id);
            l.SelectedItem = row;
        }
        selecting = false;
    }

    bool selecting;

    ListView RowList(ViewData v, IEnumerable<TaskItem> tasks, string rowView)
    {
        var lv = new ListView
        {
            SelectionMode = ListViewSelectionMode.Single, IsItemClickEnabled = true,
        };
        ScrollViewer.SetVerticalScrollMode(lv, ScrollMode.Disabled);
        ScrollViewer.SetVerticalScrollBarVisibility(lv, ScrollBarVisibility.Disabled);
        foreach (var t in tasks) lv.Items.Add(new TaskRow(m, v, t, rowView, delete));
        lv.ItemClick += (_, e) => { if (e.ClickedItem is TaskRow r) open(r.TaskId); };
        // Arrow keys (and screen readers) move the selection: the task follows it.
        lv.SelectionChanged += (_, _) => { if (!selecting && lv.SelectedItem is TaskRow r && r.TaskId != m.Selected) open(r.TaskId); };
        lists.Add(lv);
        return lv;
    }

    void TodayBody(ViewData v, List<TaskItem> tasks)
    {
        var doing = Lists.TasksFor(v, "doing");
        if (doing.Count > 0)
        {
            var label = Ui.Section($"In progress · {doing.Count}");
            label.Foreground = Ui.Brush("NxDoing");
            body.Children.Add(label);
            body.Children.Add(RowList(v, doing, "doing"));
        }
        if (tasks.Count == 0 && doing.Count == 0) EmptyText("today");
        // Today's tasks grouped by project (a subtask goes with its parent's).
        var groups = new Dictionary<string, List<TaskItem>>();
        foreach (var t in tasks)
        {
            var parent = t.HasParent && t.ParentId is { } p ? v.Task(p) : null;
            var key = v.Project(t.ProjectId ?? parent?.ProjectId)?.Title ?? "";
            (groups.TryGetValue(key, out var l) ? l : groups[key] = []).Add(t);
        }
        var keys = groups.Keys.OrderBy((k) => k.Length == 0 ? 0 : 1).ThenBy((k) => k, StringComparer.CurrentCulture).ToList();
        if (tasks.Count > 0 && doing.Count > 0 && keys.FirstOrDefault() == "") body.Children.Add(Ui.Section("Today"));
        foreach (var k in keys)
        {
            if (k.Length > 0) body.Children.Add(Ui.Section(k));
            body.Children.Add(RowList(v, groups[k], "today"));
        }
        var next = Lists.TasksFor(v, "next");
        if (next.Count > 0)
        {
            body.Children.Add(Ui.Section($"Up next · {next.Count}"));
            body.Children.Add(RowList(v, next.Take(5), "next"));
            if (next.Count > 5)
            {
                var more = new HyperlinkButton { Content = $"Show {next.Count - 5} more in Next", Margin = new Thickness(4, 0, 0, 0) };
                more.Click += (_, _) => go("next");
                body.Children.Add(more);
            }
        }
    }

    /// <summary>Every open task on one screen: area headings, project subheadings.</summary>
    void AllBody(ViewData v)
    {
        var groups = Lists.AllGrouped(v);
        if (groups.Count == 0) { EmptyText("all"); return; }
        foreach (var g in groups)
        {
            var h = Ui.Heading(g.Title, 18);
            h.Margin = new Thickness(12, 20, 0, 0);
            body.Children.Add(h);
            foreach (var p in g.Projects)
            {
                if (p.ProjectId is { } pid)
                {
                    var link = new HyperlinkButton { Content = $"{p.Title} · {p.Tasks.Count}", Margin = new Thickness(4, 6, 0, 0), FontSize = 12 };
                    link.Click += (_, _) => go($"project:{pid}");
                    body.Children.Add(link);
                }
                // Rows render as if in the project, so they don't repeat its name.
                body.Children.Add(RowList(v, p.Tasks, p.ProjectId is { } id ? $"project:{id}" : "all"));
            }
        }
    }

    void NextBody(ViewData v, List<TaskItem> tasks)
    {
        if (tasks.Count == 0) { EmptyText("next"); return; }
        var lv = RowList(v, tasks, "next");
        lv.CanDragItems = true;
        lv.CanReorderItems = true;
        lv.AllowDrop = true;
        lv.DragItemsCompleted += (_, e) =>
        {
            if (e.DropResult != Windows.ApplicationModel.DataTransfer.DataPackageOperation.Move || e.Items.FirstOrDefault() is not TaskRow moved) return;
            var rows = lv.Items.OfType<TaskRow>().ToList();
            var at = rows.IndexOf(moved);
            m.Store.MoveInNext(moved.TaskId, at + 1 < rows.Count ? rows[at + 1].TaskId : null);
        };
        body.Children.Add(lv);
    }
}
