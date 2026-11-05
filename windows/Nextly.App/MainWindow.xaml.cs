// The window (port of app/src/App.tsx and Sidebar.tsx): a Fluent title bar,
// the NavigationView sidebar (lists with counts, areas and their projects,
// search, Settings), the list, and the open task beside it (over it on a
// narrow window). Keyboard shortcuts match the other apps.

using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Nextly.Core;
using Windows.System;

namespace Nextly.App;

public sealed partial class MainWindow : Window
{
    readonly AppModel m;
    readonly TaskListPane list;
    readonly DetailPane detail;
    readonly SettingsPane settings;
    readonly DispatcherQueueTimerHolder toastTimer;
    string navShape = "";
    bool navigating;
    bool resolving;

    static readonly (string View, string Label, string Glyph, string? Brush)[] Main =
    [
        ("inbox", "Inbox", Ui.Inbox, null),
        ("doing", "In Progress", Ui.Doing, "NxDoing"),
        ("today", "Today", Ui.Today, "NxGold"),
        ("next", "Next", Ui.Next, "NxNext"),
        ("scheduled", "Scheduled", Ui.Scheduled, null),
        ("someday", "Someday", Ui.Someday, null),
        ("all", "All", Ui.All, null),
        ("logbook", "Logbook", Ui.Logbook, null),
    ];

    public MainWindow()
    {
        InitializeComponent();
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "nextly.ico"));
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1280, 820));

        m = new AppModel(DispatcherQueue) { WindowHandle = WinRT.Interop.WindowNative.GetWindowHandle(this) };
        list = new TaskListPane(m, Open, Delete, Go);
        detail = new DetailPane(m, Open, CloseDetail, Delete);
        settings = new SettingsPane(m);
        DetailHost.Child = detail;
        toastTimer = new DispatcherQueueTimerHolder(DispatcherQueue, TimeSpan.FromSeconds(6), () => Toast.IsOpen = false);

        Nav.SelectionChanged += (_, e) =>
        {
            if (navigating) return;
            if (e.IsSettingsSelected) Go("settings");
            else if (e.SelectedItem is NavigationViewItem { Tag: string view }) Go(view);
        };
        Nav.ItemInvoked += (sender, e) =>
        {
            if (e.InvokedItemContainer?.Tag is "new-project") _ = NewProject(null);
            else if (e.InvokedItemContainer?.Tag is "new-area") _ = NewArea();
            else if (e.InvokedItemContainer?.Tag is string s && s.StartsWith("new-project:")) _ = NewProject(s["new-project:".Length..]);
        };
        SearchBox.TextChanged += (_, e) =>
        {
            if (e.Reason != AutoSuggestionBoxTextChangeReason.UserInput) return;
            m.Query = SearchBox.Text;
            if (SearchBox.Text.Length > 0 && m.View != "search") Go("search");
            else if (m.View == "search") list.Refresh();
        };
        Body.SizeChanged += (_, _) => Layout();
        // Screens are built in code with brushes looked up for the current theme,
        // so when Windows switches between light and dark, build them again.
        CaptionButtons();
        Root.ActualThemeChanged += (_, _) =>
        {
            CaptionButtons();
            navShape = "";
            Refresh();
            if (m.Selected is { } id) detail.Show(id);
            if (m.View == "settings") settings.Show();
        };

        m.Changed += Refresh;
        m.SyncChanged += () => { UpdateSyncLine(); settings.UpdateStatus(); };
        Shortcuts();
        BuildNav();
        UpdateSyncLine();
        Go("today");
        Closed += (_, _) => m.Dispose();
        // Coming back to the window: catch up with other devices, and move
        // tasks whose day has come into Today (like the other apps).
        Activated += (_, e) =>
        {
            if (e.WindowActivationState == WindowActivationState.Deactivated) return;
            _ = m.Sync.SyncNow();
            m.PromoteDue();
        };
    }

    // ---------- navigation ----------

    void Go(string view)
    {
        m.View = view;
        m.Selected = null;
        SelectNav(view);
        if (view == "settings")
        {
            settings.Show();
            ListHost.Content = settings;
        }
        else
        {
            if (view != "search") { m.Query = ""; SearchBox.Text = ""; }
            ListHost.Content = list;
            list.Show();
        }
        Layout();
    }

    void SelectNav(string view)
    {
        navigating = true;
        Nav.SelectedItem = view == "settings" ? Nav.SettingsItem
            : Nav.MenuItems.OfType<NavigationViewItem>().FirstOrDefault((i) => i.Tag as string == view);
        navigating = false;
    }

    /// <summary>The sidebar: rebuilt when areas or projects change, otherwise only its counts update.</summary>
    void BuildNav()
    {
        var v = m.Store.View;
        var shape = string.Join("|", v.Areas.Select((a) => a.Id + a.Title)) + "#" + string.Join("|", v.Projects.Select((p) => p.Id + p.Title + p.AreaId));
        if (shape != navShape)
        {
            navShape = shape;
            navigating = true;
            Nav.MenuItems.Clear();
            foreach (var (view, label, glyph, brush) in Main)
                Nav.MenuItems.Add(new NavigationViewItem { Content = label, Tag = view, Icon = Ui.Icon(glyph, 16, brush is null ? null : Ui.Brush(brush)) });
            bool KnownArea(ProjectItem p) => p.HasArea && v.Areas.Any((a) => a.Id == p.AreaId);
            foreach (var a in v.Areas)
            {
                Nav.MenuItems.Add(new NavigationViewItemSeparator());
                Nav.MenuItems.Add(new NavigationViewItemHeader { Content = a.Title.Length > 0 ? a.Title : "Untitled area" });
                foreach (var p in v.Projects.Where((p) => p.AreaId == a.Id)) Nav.MenuItems.Add(ProjectItem(p));
                Nav.MenuItems.Add(new NavigationViewItem { Content = $"New project in {a.Title}", Tag = $"new-project:{a.Id}", Icon = Ui.Icon(Ui.Add, 12), SelectsOnInvoked = false, Opacity = 0.75 });
            }
            var loose = v.Projects.Where((p) => !KnownArea(p)).ToList();
            if (loose.Count > 0)
            {
                Nav.MenuItems.Add(new NavigationViewItemSeparator());
                Nav.MenuItems.Add(new NavigationViewItemHeader { Content = v.Areas.Count > 0 ? "Other projects" : "Projects" });
                foreach (var p in loose) Nav.MenuItems.Add(ProjectItem(p));
            }
            Nav.MenuItems.Add(new NavigationViewItemSeparator());
            Nav.MenuItems.Add(new NavigationViewItem { Content = "New project", Tag = "new-project", Icon = Ui.Icon(Ui.Add, 14), SelectsOnInvoked = false });
            Nav.MenuItems.Add(new NavigationViewItem { Content = "New area", Tag = "new-area", Icon = Ui.Icon(Ui.Add, 14), SelectsOnInvoked = false });
            foreach (var item in Nav.MenuItems.OfType<NavigationViewItem>()) Droppable(item);
            navigating = false;
            SelectNav(m.View);
        }
        // Counts: the four flagged lists, and each project's open top-level tasks.
        var counts = Lists.Counts(v);
        foreach (var item in Nav.MenuItems.OfType<NavigationViewItem>())
        {
            var tag = item.Tag as string ?? "";
            var n = counts.ContainsKey(tag) ? (int)Js.Number(counts[tag])
                : tag.StartsWith("project:") ? v.Tasks.Count((t) => t.ProjectId == tag["project:".Length..] && !t.Done && !t.HasParent) : 0;
            item.InfoBadge = n > 0 ? new InfoBadge { Value = n } : null;
        }
    }

    /// <summary>
    /// Lets a task dragged from a list drop on a flagged list (as its menu
    /// would flag it) or a project (as the detail pane's picker would move it).
    /// Finished tasks, Incident IQ tickets leaving their project or going to
    /// the Inbox, and subtasks changing project aren't accepted.
    /// </summary>
    void Droppable(NavigationViewItem item)
    {
        if (item.Tag is not string tag || !(tag is "inbox" or "doing" or "today" or "next" or "someday" || tag.StartsWith("project:"))) return;
        item.AllowDrop = true;
        TaskItem? Dragged(DragEventArgs e) =>
            e.DataView.Properties.TryGetValue(TaskListPane.DragKey, out var id) && id is string s && m.Store.View.Task(s) is { ReadOnly: false, Done: false } t ? t : null;
        bool Accepts(TaskItem t) => tag.StartsWith("project:")
            ? !t.HasParent && !t.IsTicket && t.ProjectId != tag["project:".Length..]
            : t.Flag != tag && !(tag == "inbox" && t.IsTicket);
        item.DragOver += (_, e) =>
        {
            if (Dragged(e) is not { } t || !Accepts(t)) { e.AcceptedOperation = Windows.ApplicationModel.DataTransfer.DataPackageOperation.None; return; }
            e.AcceptedOperation = Windows.ApplicationModel.DataTransfer.DataPackageOperation.Move;
            e.DragUIOverride.Caption = $"Move to {item.Content}";
        };
        item.Drop += (_, e) =>
        {
            if (Dragged(e) is not { } t || !Accepts(t)) return;
            // After the drag finishes: the save rebuilds the list the drag came from.
            DispatcherQueue.TryEnqueue(() =>
            {
                if (tag.StartsWith("project:")) m.Store.UpdateTask(t.Id, new System.Text.Json.Nodes.JsonObject { ["projectId"] = tag["project:".Length..] });
                else m.Store.SetFlag(t.Id, tag);
            });
        };
    }

    static NavigationViewItem ProjectItem(ProjectItem p) =>
        new() { Content = p.Title.Length > 0 ? p.Title : "Untitled project", Tag = $"project:{p.Id}", Icon = Ui.Icon(Ui.Folder, 16) };

    async Task<string?> Ask(string title, string placeholder)
    {
        var box = new TextBox { PlaceholderText = placeholder };
        var dlg = new ContentDialog
        {
            XamlRoot = Content.XamlRoot, Title = title, Content = box, PrimaryButtonText = "Add", CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary, IsPrimaryButtonEnabled = false,
        };
        box.TextChanged += (_, _) => dlg.IsPrimaryButtonEnabled = box.Text.Trim().Length > 0;
        return await dlg.ShowAsync() == ContentDialogResult.Primary ? box.Text.Trim() : null;
    }

    async Task NewProject(string? areaId)
    {
        var area = areaId is null ? null : m.Store.View.Areas.FirstOrDefault((a) => a.Id == areaId);
        if (await Ask(area is null ? "New project" : $"New project in {area.Title}", "Project name") is { } name) Go($"project:{m.Store.CreateProject(name, areaId)}");
    }

    async Task NewArea()
    {
        if (await Ask("New area", "Area name, like Classroom") is { } name) m.Store.CreateArea(name);
    }

    /// <summary>A nextly:// link: add its task to the Inbox and open it, so you can choose Today or Next.</summary>
    public void HandleLink(string link)
    {
        if (Links.Capture(m.Store, link) is not { } id) return;
        Go("inbox");
        Open(id);
    }

    /// <summary>Brings the window forward (a second launch handed us a link).</summary>
    public void BringToFront()
    {
        if (AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized } p) p.Restore();
        AppWindow.Show();
        Activate();
    }

    // ---------- the open task ----------

    void Open(string id)
    {
        m.Selected = id;
        detail.Show(id);
        list.Select(id);
        Layout();
    }

    void CloseDetail()
    {
        m.Selected = null;
        list.Select(null);
        Layout();
    }

    /// <summary>The list beside the open task; on a narrow window the task covers the list.</summary>
    void Layout()
    {
        var open = m.Selected is not null && m.View != "settings";
        var narrow = Body.ActualWidth > 0 && Body.ActualWidth < 760;
        DetailHost.Visibility = open ? Visibility.Visible : Visibility.Collapsed;
        detail.Narrow = narrow;
        if (!open) { ListColumn.Width = new GridLength(1, GridUnitType.Star); DetailColumn.Width = new GridLength(0); }
        else if (narrow) { ListColumn.Width = new GridLength(0); DetailColumn.Width = new GridLength(1, GridUnitType.Star); }
        else { ListColumn.Width = new GridLength(1, GridUnitType.Star); DetailColumn.Width = new GridLength(Math.Clamp(Body.ActualWidth * 0.42, 380, 520)); }
    }

    void Delete(string id)
    {
        var title = m.Store.View.Task(id)?.Title ?? "";
        var undo = m.Store.DeleteTask(id);
        if (m.Selected == id) CloseDetail();
        var button = new Button { Content = "Undo" };
        button.Click += (_, _) => { undo(); Toast.IsOpen = false; };
        Toast.Message = $"Deleted “{(title.Length > 40 ? title[..40] + "…" : title)}”";
        Toast.ActionButton = button;
        Toast.IsOpen = true;
        toastTimer.Restart();
    }

    // ---------- refresh ----------

    void Refresh()
    {
        BuildNav();
        if (m.View == "settings") settings.RefreshData();
        else if (m.View.StartsWith("project:") && m.Store.View.Project(m.View["project:".Length..]) is null) Go("inbox"); // its project was deleted
        else list.Refresh();
        if (m.Selected is { } id)
        {
            if (m.Store.View.Task(id) is null) CloseDetail();
            else detail.Refresh();
        }
        if (m.Store.ResolvingId is { } rid && !resolving) _ = Resolve(rid);
    }

    /// <summary>The server's resolution actions and its default, as last heard (for the resolve prompt's picker).</summary>
    (List<(string Id, string Name)> Actions, string? Default)? resolutionActions;

    /// <summary>
    /// Finishing an open Incident IQ ticket's task asks for resolution notes
    /// first, and offers the server's resolution actions (its default
    /// selected). Only a choice other than the default is sent; the server
    /// accepts it only if it's on its own list.
    /// </summary>
    async Task Resolve(string id)
    {
        resolving = true;
        var t = m.Store.View.Task(id);
        var notes = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 120, PlaceholderText = "What was done to fix it…", Header = "Resolution notes" };
        var actions = new ComboBox { Header = "Resolution action", MinWidth = 260, Visibility = Visibility.Collapsed };
        var note = Ui.Muted("Saved to the ticket in Incident IQ with your default resolution action.", 12);
        void ShowActions()
        {
            if (resolutionActions is not { Actions.Count: > 1 } ra) return;
            var picked = (actions.SelectedItem as ComboBoxItem)?.Tag as string ?? ra.Default;
            actions.Items.Clear();
            foreach (var (aid, name) in ra.Actions) actions.Items.Add(new ComboBoxItem { Content = name, Tag = aid });
            actions.SelectedItem = actions.Items.OfType<ComboBoxItem>().FirstOrDefault((i) => string.Equals((string)i.Tag, picked, StringComparison.OrdinalIgnoreCase))
                ?? actions.Items.OfType<ComboBoxItem>().FirstOrDefault((i) => string.Equals((string)i.Tag, ra.Default, StringComparison.OrdinalIgnoreCase));
            actions.Visibility = Visibility.Visible;
            note.Text = "Saved to the ticket in Incident IQ with this resolution action.";
        }
        var p = new StackPanel { Spacing = 8 };
        p.Children.Add(Ui.Muted(t?.Title ?? ""));
        p.Children.Add(actions);
        p.Children.Add(notes);
        p.Children.Add(note);
        ShowActions();
        // Refresh the list while the prompt is open (offline: the last list, or the default).
        _ = RefreshResolutionActions(ShowActions);
        var dlg = new ContentDialog
        {
            XamlRoot = Content.XamlRoot, Title = $"Resolve ticket #{(t?.External?["number"] is { } n ? Js.Str(n) : "?")}", Content = p,
            PrimaryButtonText = "Resolve", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Primary, IsPrimaryButtonEnabled = false,
        };
        notes.TextChanged += (_, _) => dlg.IsPrimaryButtonEnabled = notes.Text.Trim().Length > 0;
        var result = await dlg.ShowAsync();
        resolving = false;
        var chosen = (actions.SelectedItem as ComboBoxItem)?.Tag as string;
        if (string.Equals(chosen, resolutionActions?.Default, StringComparison.OrdinalIgnoreCase)) chosen = null;
        if (result == ContentDialogResult.Primary) m.Store.ResolveWithNotes(id, notes.Text, chosen);
        else m.Store.CancelResolve();
    }

    async Task RefreshResolutionActions(Action then)
    {
        if (await m.Sync.IiqStatus() is not { } s) return;
        var list = (s["resolutionActions"] as System.Text.Json.Nodes.JsonArray ?? [])
            .Select((a) => (Id: Js.AsString(a?["id"]) ?? "", Name: Js.AsString(a?["name"]) ?? ""))
            .Where((a) => a.Id.Length > 0 && a.Name.Length > 0).ToList();
        resolutionActions = (list, Js.AsString(s["defaultResolutionActionId"]));
        then();
    }

    void UpdateSyncLine()
    {
        var s = m.Sync.Status;
        SyncDot.Fill = s.State switch
        {
            SyncState.Idle => Ui.Brush("NxOk"),
            SyncState.Error => Ui.Brush("NxDanger"),
            SyncState.Syncing => Ui.Brush("AccentFillColorDefaultBrush"),
            _ => Ui.Brush("TextFillColorTertiaryBrush"),
        };
        SyncText.Text = s.State == SyncState.Error ? s.Message : s.State == SyncState.Off ? s.Message : "";
        ToolTipService.SetToolTip(SyncDot, s.Message);
    }

    /// <summary>Minimize, maximize and close drawn over our title bar, in colors that suit the theme.</summary>
    void CaptionButtons()
    {
        var light = Root.ActualTheme == ElementTheme.Light;
        var tb = AppWindow.TitleBar;
        tb.ButtonBackgroundColor = Colors.Transparent;
        tb.ButtonInactiveBackgroundColor = Colors.Transparent;
        tb.ButtonForegroundColor = light ? Colors.Black : Colors.White;
        tb.ButtonInactiveForegroundColor = light ? Windows.UI.Color.FromArgb(0x80, 0, 0, 0) : Windows.UI.Color.FromArgb(0x80, 0xFF, 0xFF, 0xFF);
        tb.ButtonHoverBackgroundColor = light ? Windows.UI.Color.FromArgb(0x14, 0, 0, 0) : Windows.UI.Color.FromArgb(0x14, 0xFF, 0xFF, 0xFF);
        tb.ButtonHoverForegroundColor = tb.ButtonForegroundColor;
    }

    // ---------- keyboard ----------

    bool Typing() => FocusManager.GetFocusedElement(Content.XamlRoot) is TextBox or PasswordBox or AutoSuggestBox;

    void Shortcuts()
    {
        void Add(VirtualKey key, VirtualKeyModifiers mods, Action run, bool whileTyping = true)
        {
            var a = new KeyboardAccelerator { Key = key, Modifiers = mods };
            a.Invoked += (_, e) =>
            {
                if (!whileTyping && Typing()) return;
                e.Handled = true;
                run();
            };
            Root.KeyboardAccelerators.Add(a);
        }
        var ctrl = VirtualKeyModifiers.Control;
        Add(VirtualKey.N, ctrl, () => { if (m.View is "settings" or "logbook" or "search") Go("inbox"); list.FocusQuickAdd(); });
        Add(VirtualKey.K, ctrl, () => SearchBox.Focus(FocusState.Keyboard));
        Add(VirtualKey.T, ctrl, () => { if (m.Selected is { } id) m.Store.SetFlag(id, "today"); });
        Add(VirtualKey.T, ctrl | VirtualKeyModifiers.Shift, () => { if (m.Selected is { } id) m.Store.SetFlag(id, "next"); });
        Add(VirtualKey.D, ctrl, () => { if (m.Selected is { } id) m.Store.SetFlag(id, "doing"); });
        Add(VirtualKey.Enter, ctrl, () => { if (m.Selected is { } id) m.Store.ToggleDone(id); });
        Add((VirtualKey)188, ctrl, () => Go("settings")); // Ctrl+, (the comma key)
        Add(VirtualKey.Escape, VirtualKeyModifiers.None, () => { if (m.Selected is not null) CloseDetail(); }, whileTyping: false);
        Add(VirtualKey.Delete, VirtualKeyModifiers.None, () => { if (m.Selected is { } id) Delete(id); }, whileTyping: false);
        Root.KeyboardAcceleratorPlacementMode = KeyboardAcceleratorPlacementMode.Hidden;
    }
}

/// <summary>A one-shot timer that can be restarted (for the undo toast).</summary>
sealed class DispatcherQueueTimerHolder
{
    readonly Microsoft.UI.Dispatching.DispatcherQueueTimer timer;

    public DispatcherQueueTimerHolder(Microsoft.UI.Dispatching.DispatcherQueue q, TimeSpan after, Action run)
    {
        timer = q.CreateTimer();
        timer.Interval = after;
        timer.IsRepeating = false;
        timer.Tick += (_, _) => run();
    }

    public void Restart() { timer.Stop(); timer.Start(); }
}
