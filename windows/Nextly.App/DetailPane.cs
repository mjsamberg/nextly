// The open task (port of app/src/Detail.tsx): title, flag, start date,
// repeat, deadline, project, subtasks, dependencies, the Incident IQ panel,
// and notes. A refresh from sync waits while you're typing in it.

using System.Text.Json.Nodes;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Nextly.Core;
using Windows.System;

namespace Nextly.App;

/// <summary>A task offered in a picker; shows its title.</summary>
sealed record Option(string Id, string Title)
{
    public override string ToString() => Title.Length > 0 ? Title : "Untitled task";
}

public sealed class DetailPane : Grid
{
    readonly AppModel m;
    readonly Action<string> open;
    readonly Action close;
    readonly Action<string> delete;
    readonly ScrollViewer scroll = new() { HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    readonly Button back = new() { Content = "Back", Visibility = Visibility.Collapsed };
    string? shown;
    NotesView? notes;
    bool dirty;

    public DetailPane(AppModel model, Action<string> onOpen, Action onClose, Action<string> onDelete)
    {
        m = model;
        open = onOpen;
        close = onClose;
        delete = onDelete;
        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var top = new Grid { Padding = new Thickness(12, 8, 8, 0) };
        back.Click += (_, _) => close();
        top.Children.Add(back);
        var x = new Button { Content = Ui.Icon(Ui.Close, 12), HorizontalAlignment = HorizontalAlignment.Right, Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0) };
        ToolTipService.SetToolTip(x, "Close (Esc)");
        x.Click += (_, _) => close();
        top.Children.Add(x);
        Children.Add(top);
        SetRow(scroll, 1);
        Children.Add(scroll);
        // A refresh that waited for typing to finish runs when focus leaves, just
        // after the focus change: rebuilding during it can crash WinUI.
        LostFocus += (_, _) =>
        {
            if (!dirty) return;
            DispatcherQueue.TryEnqueue(() => { if (dirty && !Typing()) { dirty = false; Build(); } });
        };
    }

    /// <summary>On a narrow window the pane covers the list and has a Back button.</summary>
    public bool Narrow { set => back.Visibility = value ? Visibility.Visible : Visibility.Collapsed; }

    public void Show(string id)
    {
        shown = id;
        dirty = false;
        Build();
        scroll.ChangeView(null, 0, null, true);
    }

    /// <summary>Rebuilds after a change, unless you're typing in it (then once you leave the field).</summary>
    public void Refresh()
    {
        if (Typing()) { dirty = true; return; }
        Build();
    }

    bool Typing() => XamlRoot is not null && FocusManager.GetFocusedElement(XamlRoot) is TextBox or PasswordBox && IsInside(FocusManager.GetFocusedElement(XamlRoot) as DependencyObject);

    bool IsInside(DependencyObject? d)
    {
        for (; d is not null; d = VisualTreeHelper.GetParent(d)) if (ReferenceEquals(d, this)) return true;
        return false;
    }

    static string Ymd(DateTimeOffset d) => Logic.Ymd(DateOnly.FromDateTime(d.Date));
    static DateTimeOffset? Date(string? ymd) => ymd is not null && Logic.ParseYmd(ymd) is { } d ? new DateTimeOffset(d.ToDateTime(TimeOnly.MinValue)) : null;

    void Build()
    {
        Debug.Log($"detail build (typing={Typing()})");
        // Notes keep their editor while the same task is open (see NotesView.Attach).
        var v = m.Store.View;
        if (shown is null || v.Task(shown) is not { } t) { scroll.Content = null; return; }
        var ro = t.ReadOnly;
        var p = new StackPanel { Padding = new Thickness(24, 4, 24, 32), Spacing = 6 };
        scroll.Content = p;

        if (ro)
            p.Children.Add(new InfoBar
            {
                Title = "Saved by a newer Nextly", IsOpen = true, IsClosable = false, Severity = InfoBarSeverity.Warning,
                Message = "This task was last changed by a newer version of Nextly, so this one shows it but won’t change it. Update Nextly on this device to edit it.",
            });

        if (t.HasParent && t.ParentId is { } pid && v.Task(pid) is { } parent)
        {
            var up = new HyperlinkButton { Content = $"Subtask of {(parent.Title.Length > 0 ? parent.Title : "untitled task")}", Padding = new Thickness(0) };
            up.Click += (_, _) => open(parent.Id);
            p.Children.Add(up);
        }

        // Title with its check.
        var titleRow = new Grid { ColumnSpacing = 4 };
        titleRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        titleRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        titleRow.Children.Add(TaskRow.RoundCheck(t.Done, () => m.Store.ToggleDone(t.Id), ro, 24));
        var title = new TextBox
        {
            Text = t.Title, PlaceholderText = "New task", FontSize = 20, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap,
            IsReadOnly = ro, BorderThickness = new Thickness(0), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
        };
        Commit(title, (s) => m.Store.UpdateTask(t.Id, new JsonObject { ["title"] = s.Replace("\r", " ").Replace("\n", " ") }));
        SetColumn(title, 1);
        titleRow.Children.Add(title);
        p.Children.Add(titleRow);
        if (t.Title.Length == 0 && !ro) title.Loaded += (_, _) => title.Focus(FocusState.Programmatic);

        if (t.IsTicket) p.Children.Add(IiqPanel.Build(m, t));

        // When: the flag.
        // When: the flag, as five equal buttons that always fit the pane.
        var seg = new Grid { ColumnSpacing = 4, Margin = new Thickness(0, 8, 0, 4) };
        var flags = new (string, string)[] { ("inbox", "Inbox"), ("doing", "In Progress"), ("today", "Today"), ("next", "Next"), ("someday", "Someday") };
        for (var i = 0; i < flags.Length; i++)
        {
            var (flag, label) = flags[i];
            seg.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var b = new ToggleButton
            {
                Content = new TextBlock { Text = label, FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis },
                IsChecked = t.Flag == flag, IsEnabled = !ro, HorizontalAlignment = HorizontalAlignment.Stretch, Padding = new Thickness(4, 6, 4, 6),
            };
            ToolTipService.SetToolTip(b, label);
            b.Click += (_, _) => m.Store.SetFlag(t.Id, flag);
            SetColumn(b, i);
            seg.Children.Add(b);
        }
        p.Children.Add(seg);

        // Dates, repeat, project.
        var fields = new Grid { ColumnSpacing = 12, RowSpacing = 8, Margin = new Thickness(0, 8, 0, 0) };
        fields.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        fields.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var row = 0;
        void Field(string glyph, string label, FrameworkElement control)
        {
            fields.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var l = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Center };
            l.Children.Add(Ui.Icon(glyph, 13, Ui.Brush("TextFillColorSecondaryBrush")));
            l.Children.Add(new TextBlock { Text = label, Foreground = Ui.Brush("TextFillColorSecondaryBrush") });
            SetRow(l, row);
            SetRow(control, row);
            SetColumn(control, 1);
            fields.Children.Add(l);
            fields.Children.Add(control);
            row++;
        }
        Field(Ui.Today, "Today on", DateField(t.StartOn, ro, (d) => m.Store.SetStartOn(t.Id, d), "Waits in Scheduled, then moves into Today on this day"));
        Field(Ui.Repeat, "Repeat", RepeatField(t, ro));
        Field(Ui.Scheduled, "Deadline", DateField(t.Deadline, ro, (d) => m.Store.UpdateTask(t.Id, new JsonObject { ["deadline"] = d }), null));
        if (!t.HasParent)
        {
            var projects = new ComboBox { MinWidth = 200, IsEnabled = !ro };
            projects.Items.Add(new ComboBoxItem { Content = "None", Tag = "" });
            foreach (var pr in v.Projects) projects.Items.Add(new ComboBoxItem { Content = pr.Title.Length > 0 ? pr.Title : "Untitled project", Tag = pr.Id });
            projects.SelectedItem = projects.Items.OfType<ComboBoxItem>().FirstOrDefault((i) => (string)i.Tag == (t.ProjectId ?? "")) ?? projects.Items[0];
            projects.SelectionChanged += (_, _) =>
            {
                var id = (string)((ComboBoxItem)projects.SelectedItem).Tag;
                if (id != (t.ProjectId ?? "")) m.Store.UpdateTask(t.Id, new JsonObject { ["projectId"] = id.Length > 0 ? id : null });
            };
            Field(Ui.Folder, "Project", projects);
        }
        p.Children.Add(fields);

        Subtasks(p, v, t, ro);
        Dependencies(p, v, t, ro);
        if (notes is null || notes.TaskId != t.Id) { notes?.Retire(); notes = new NotesView(m, t.Id); }
        notes.Attach(p);

        var foot = new Grid { Margin = new Thickness(0, 24, 0, 0) };
        var dates = $"Added {Js.DateParse(t.CreatedAt) switch { var ms when !double.IsNaN(ms) => DateTimeOffset.FromUnixTimeMilliseconds((long)ms).LocalDateTime.ToShortDateString(), _ => "" }}";
        if (t.Done && Js.DateParse(t.DoneAt) is var dms && !double.IsNaN(dms)) dates += $" · Done {DateTimeOffset.FromUnixTimeMilliseconds((long)dms).LocalDateTime.ToShortDateString()}";
        foot.Children.Add(new TextBlock { Text = dates, Foreground = Ui.Brush("TextFillColorTertiaryBrush"), VerticalAlignment = VerticalAlignment.Center, FontSize = 12 });
        if (!ro)
        {
            var del = new Button { Content = "Delete", HorizontalAlignment = HorizontalAlignment.Right, Foreground = Ui.Brush("NxDanger") };
            del.Click += (_, _) => delete(t.Id);
            foot.Children.Add(del);
        }
        p.Children.Add(foot);
    }

    /// <summary>Saves a text field when you pause typing, press Enter, or leave it.</summary>
    void Commit(TextBox box, Action<string> save)
    {
        var last = box.Text;
        var timer = DispatcherQueue.CreateTimer();
        timer.Interval = TimeSpan.FromMilliseconds(500);
        timer.IsRepeating = false;
        void Flush() { timer.Stop(); if (box.Text != last) { last = box.Text; save(box.Text); } }
        timer.Tick += (_, _) => Flush();
        box.TextChanged += (_, _) => { timer.Stop(); timer.Start(); };
        box.LostFocus += (_, _) => Flush();
        box.KeyDown += (_, e) => { if (e.Key == VirtualKey.Enter && !box.AcceptsReturn) { e.Handled = true; Flush(); } };
    }

    static FrameworkElement DateField(string? value, bool ro, Action<string?> set, string? tip)
    {
        var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var picker = new CalendarDatePicker { Date = Date(value), PlaceholderText = "optional", IsEnabled = !ro, MinWidth = 160 };
        picker.DateChanged += (_, e) => { var d = e.NewDate is { } nd ? Ymd(nd) : null; if (d != value) set(d); };
        sp.Children.Add(picker);
        if (value is not null && !ro)
        {
            var clear = new HyperlinkButton { Content = "Clear" };
            clear.Click += (_, _) => set(null);
            sp.Children.Add(clear);
        }
        if (tip is not null) ToolTipService.SetToolTip(picker, tip);
        return sp;
    }

    static readonly (string Key, string Label, JsonObject? Rule)[] Presets =
    [
        ("none", "Never", null),
        ("daily", "Every day", new JsonObject { ["every"] = 1, ["unit"] = "day" }),
        ("weekdays", "Every weekday", new JsonObject { ["every"] = 1, ["unit"] = "week", ["weekdays"] = new JsonArray(1, 2, 3, 4, 5) }),
        ("weekly", "Every week", new JsonObject { ["every"] = 1, ["unit"] = "week" }),
        ("biweekly", "Every 2 weeks", new JsonObject { ["every"] = 2, ["unit"] = "week" }),
        ("monthly", "Every month", new JsonObject { ["every"] = 1, ["unit"] = "month" }),
        ("yearly", "Every year", new JsonObject { ["every"] = 1, ["unit"] = "year" }),
        ("custom", "Custom…", null),
    ];

    static string PresetOf(RepeatRule? r)
    {
        if (r is null) return "none";
        foreach (var (key, _, rule) in Presets)
        {
            if (rule is null) continue;
            var days = rule["weekdays"] is JsonArray a ? string.Join(",", a.Select((x) => Js.Number(x))) : "";
            if (Js.Number(rule["every"]) == r.Every && Js.AsString(rule["unit"]) == r.Unit && days == string.Join(",", r.Weekdays)) return key;
        }
        return "custom";
    }

    /// <summary>Repeat picker: common choices, or every N days/weeks/months/years.</summary>
    FrameworkElement RepeatField(TaskItem t, bool ro)
    {
        var panel = new StackPanel { Spacing = 6 };
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var preset = PresetOf(t.Repeat);
        var from = t.Repeat?.From ?? "schedule";
        void Set(JsonObject? r)
        {
            JsonObject? norm = null;
            if (r is not null) { var o = new JsonObject { ["from"] = from }; foreach (var (k, val) in r) o[k] = Js.Clone(val); norm = Logic.NormRepeat(o); }
            m.Store.UpdateTask(t.Id, new JsonObject { ["repeat"] = norm });
        }
        var pick = new ComboBox { IsEnabled = !ro, MinWidth = 160 };
        foreach (var (key, label, _) in Presets) pick.Items.Add(new ComboBoxItem { Content = label, Tag = key });
        pick.SelectedItem = pick.Items.OfType<ComboBoxItem>().First((i) => (string)i.Tag == preset);
        pick.SelectionChanged += (_, _) =>
        {
            var key = (string)((ComboBoxItem)pick.SelectedItem).Tag;
            if (key == preset) return;
            if (key == "none") Set(null);
            else if (key == "custom") Set(new JsonObject { ["every"] = t.Repeat?.Every ?? 3, ["unit"] = t.Repeat?.Unit ?? "day" });
            else Set((JsonObject)Presets.First((x) => x.Key == key).Rule!.DeepClone());
        };
        line.Children.Add(pick);
        if (preset == "custom" && t.Repeat is { } rr)
        {
            var every = new NumberBox { Value = rr.Every, Minimum = 1, Maximum = 365, SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Compact, IsEnabled = !ro, Width = 90 };
            every.ValueChanged += (_, e) => { if (!double.IsNaN(e.NewValue) && e.NewValue != rr.Every) Set(new JsonObject { ["every"] = e.NewValue, ["unit"] = rr.Unit }); };
            var unit = new ComboBox { IsEnabled = !ro };
            foreach (var u in new[] { "day", "week", "month", "year" }) unit.Items.Add(new ComboBoxItem { Content = u + "s", Tag = u });
            unit.SelectedItem = unit.Items.OfType<ComboBoxItem>().First((i) => (string)i.Tag == rr.Unit);
            unit.SelectionChanged += (_, _) => { var u = (string)((ComboBoxItem)unit.SelectedItem).Tag; if (u != rr.Unit) Set(new JsonObject { ["every"] = rr.Every, ["unit"] = u }); };
            line.Children.Add(new TextBlock { Text = "every", VerticalAlignment = VerticalAlignment.Center });
            line.Children.Add(every);
            line.Children.Add(unit);
        }
        if (t.Repeat is { } cur)
        {
            var fromBox = new ComboBox { IsEnabled = !ro };
            fromBox.Items.Add(new ComboBoxItem { Content = "on schedule", Tag = "schedule" });
            fromBox.Items.Add(new ComboBoxItem { Content = "after I finish it", Tag = "completion" });
            fromBox.SelectedItem = fromBox.Items.OfType<ComboBoxItem>().First((i) => (string)i.Tag == cur.From);
            fromBox.SelectionChanged += (_, _) =>
            {
                var f = (string)((ComboBoxItem)fromBox.SelectedItem).Tag;
                if (f == cur.From) return;
                var r = (JsonObject)t.Data["repeat"]!.DeepClone();
                r["from"] = f;
                m.Store.UpdateTask(t.Id, new JsonObject { ["repeat"] = Logic.NormRepeat(r) });
            };
            line.Children.Add(fromBox);
        }
        panel.Children.Add(new ScrollViewer { Content = line, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, HorizontalScrollMode = ScrollMode.Enabled });
        if (t.Repeat is { } note)
            panel.Children.Add(Ui.Muted($"{Logic.RepeatLabel(note)}{(note.From == "completion" ? ", counted from when you finish it" : "")}. Finishing it files the next one under Scheduled; it moves into Today on its date.", 12));
        return panel;
    }

    void Subtasks(StackPanel p, ViewData v, TaskItem t, bool ro)
    {
        var kids = v.Children(t.Id);
        p.Children.Add(Ui.Label("Subtasks" + (kids.Count > 0 ? $" · {kids.Count((k) => k.Done)} of {kids.Count}" : "")));
        foreach (var k in kids)
        {
            var g = new Grid { ColumnSpacing = 4 };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.Children.Add(TaskRow.RoundCheck(k.Done, () => m.Store.ToggleDone(k.Id), k.ReadOnly, 18));
            var box = new TextBox { Text = k.Title, PlaceholderText = "Subtask", IsReadOnly = k.ReadOnly, BorderThickness = new Thickness(0), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };
            if (k.Done) box.Foreground = Ui.Brush("TextFillColorTertiaryBrush");
            Commit(box, (s) => m.Store.UpdateTask(k.Id, new JsonObject { ["title"] = s }));
            SetColumn(box, 1);
            g.Children.Add(box);
            if (k.Flag is "today" or "next")
            {
                var chip = k.Flag == "today" ? Ui.Chip("Today", "NxToday", "NxTodayBg") : Ui.Chip("Next", "NxNext", "NxNextBg");
                SetColumn(chip, 2);
                g.Children.Add(chip);
            }
            var go = new Button { Content = Ui.Icon(Ui.Chevron, 11), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0) };
            ToolTipService.SetToolTip(go, "Open subtask");
            go.Click += (_, _) => open(k.Id);
            SetColumn(go, 3);
            g.Children.Add(go);
            p.Children.Add(g);
        }
        if (ro) return;
        var add = new TextBox { PlaceholderText = "Add subtask" };
        add.KeyDown += (_, e) =>
        {
            if (e.Key != VirtualKey.Enter || add.Text.Trim().Length == 0) return;
            e.Handled = true;
            m.Store.CreateTask(new JsonObject { ["title"] = add.Text.Trim(), ["parentId"] = t.Id, ["flag"] = null, ["projectId"] = t.ProjectId });
            add.Text = "";
        };
        p.Children.Add(add);
    }

    void Dependencies(StackPanel p, ViewData v, TaskItem t, bool ro)
    {
        p.Children.Add(Ui.Label("Depends on"));
        foreach (var id in t.DependsOn)
        {
            if (v.Task(id) is not { } d) continue;
            p.Children.Add(DepRow(d, d.Done ? Ui.Chip("Done", "TextFillColorSecondaryBrush", "NxChipBg") : Ui.Chip("Open", "NxBlocked", "NxBlockedBg"),
                ro ? null : () => m.Store.RemoveDependency(t.Id, id)));
        }
        if (!ro)
        {
            var error = new TextBlock { Foreground = Ui.Brush("NxDanger"), TextWrapping = TextWrapping.Wrap, Visibility = Visibility.Collapsed };
            var box = new AutoSuggestBox { PlaceholderText = "Add a task this one waits on…" };
            box.TextChanged += (_, e) =>
            {
                if (e.Reason != AutoSuggestionBoxTextChangeReason.UserInput) return;
                var q = box.Text.Trim().ToLowerInvariant();
                box.ItemsSource = q.Length == 0 ? null : v.Tasks.Where((o) => !o.Done && o.Id != t.Id && !t.DependsOn.Contains(o.Id) && o.Title.ToLowerInvariant().Contains(q)).Take(6).Select((o) => new Option(o.Id, o.Title)).ToList();
                error.Visibility = Visibility.Collapsed;
            };
            box.SuggestionChosen += (_, e) =>
            {
                if (e.SelectedItem is not Option o) return;
                var err = m.Store.AddDependency(t.Id, o.Id);
                box.Text = "";
                if (err is not null) { error.Text = err; error.Visibility = Visibility.Visible; }
            };
            p.Children.Add(box);
            p.Children.Add(error);
        }
        var blocks = v.Blocks(t.Id);
        if (blocks.Count > 0)
        {
            p.Children.Add(Ui.Label("Blocks"));
            foreach (var b in blocks)
            {
                var waiting = v.Blockers(b).Count > 0;
                p.Children.Add(DepRow(b, b.Done ? Ui.Chip("Done", "TextFillColorSecondaryBrush", "NxChipBg")
                    : waiting ? Ui.Chip("Waiting", "NxBlocked", "NxBlockedBg") : Ui.Chip("Free", "NxNext", "NxNextBg"), null));
            }
        }
    }

    FrameworkElement DepRow(TaskItem d, FrameworkElement status, Action? remove)
    {
        var g = new Grid { ColumnSpacing = 8 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var label = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        label.Children.Add(Ui.Icon(d.Done ? Ui.Check : Ui.Lock, 12));
        label.Children.Add(new TextBlock { Text = d.Title.Length > 0 ? d.Title : "Untitled task", TextTrimming = TextTrimming.CharacterEllipsis });
        var link = new HyperlinkButton { Content = label, Padding = new Thickness(4, 2, 4, 2) };
        link.Click += (_, _) => open(d.Id);
        g.Children.Add(link);
        SetColumn(status, 1);
        g.Children.Add(status);
        if (remove is not null)
        {
            var x = new Button { Content = Ui.Icon(Ui.Close, 10), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0) };
            ToolTipService.SetToolTip(x, "Remove dependency");
            x.Click += (_, _) => remove();
            SetColumn(x, 2);
            g.Children.Add(x);
        }
        return g;
    }
}
