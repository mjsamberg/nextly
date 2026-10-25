// Settings (port of app/src/Settings.tsx): the sync server's addresses,
// token and request headers; sync and live-update status; the connection
// check; Incident IQ status; areas and projects; shortcuts; privacy.

using System.Reflection;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Nextly.Core;

namespace Nextly.App;

public sealed class SettingsPane : Grid
{
    readonly AppModel m;
    readonly ScrollViewer scroll = new() { HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    readonly StackPanel page = new() { Padding = new Thickness(24, 20, 24, 40), Spacing = 16, MaxWidth = 760, HorizontalAlignment = HorizontalAlignment.Left };
    readonly TextBlock syncLine = new() { TextWrapping = TextWrapping.Wrap };
    readonly TextBlock liveLine = new() { TextWrapping = TextWrapping.Wrap };
    readonly StackPanel diag = new() { Spacing = 4 };
    readonly StackPanel iiq = new() { Spacing = 8 };
    readonly StackPanel org = new() { Spacing = 8 };
    readonly List<(TextBox Name, PasswordBox Secret, TextBox Plain, Grid Row)> headerRows = [];
    readonly StackPanel headerList = new() { Spacing = 6 };
    readonly TextBlock headerError = new() { Foreground = Ui.Brush("NxDanger"), TextWrapping = TextWrapping.Wrap };
    TextBox url = new(), altUrl = new();
    PasswordBox token = new();

    public static string Version =>
        typeof(SettingsPane).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "dev";

    public SettingsPane(AppModel model)
    {
        m = model;
        Children.Add(scroll);
        scroll.Content = page;
    }

    static Border Card(params UIElement[] children)
    {
        var p = new StackPanel { Spacing = 8 };
        foreach (var c in children) p.Children.Add(c);
        return new Border
        {
            Child = p, Padding = new Thickness(20, 16, 20, 18), CornerRadius = new CornerRadius(8),
            Background = Ui.Brush("CardBackgroundFillColorDefaultBrush"), BorderBrush = Ui.Brush("CardStrokeColorDefaultBrush"), BorderThickness = new Thickness(1),
        };
    }

    static TextBlock H2(string text) => Ui.Heading(text, 18);

    /// <summary>Builds the page fresh (when Settings opens).</summary>
    public void Show()
    {
        page.Children.Clear();
        page.Children.Add(Ui.Heading("Settings"));
        page.Children.Add(SyncCard());
        page.Children.Add(Card(H2("Incident IQ"), iiq));
        page.Children.Add(LinksCard());
        page.Children.Add(Card(H2("Areas and projects"), Ui.Muted("Areas group projects in the sidebar, like Classroom or Tech committee."), org));
        page.Children.Add(KeysCard());
        page.Children.Add(Card(H2("Privacy"), Ui.Muted("Notes and attachments sync to your own server, not a district system. Keep student records such as grades, IEP or 504 details out of Nextly. Directory information, like a name on a conference list, is the most you should store.")));
        UpdateStatus();
        RefreshData();
        _ = LoadIiq();
        scroll.ChangeView(null, 0, null, true);
    }

    /// <summary>After data changes: the areas and projects list, unless you're typing in it.</summary>
    public void RefreshData()
    {
        if (XamlRoot is not null && Microsoft.UI.Xaml.Input.FocusManager.GetFocusedElement(XamlRoot) is TextBox tb && IsInside(tb, org)) return;
        BuildOrg();
    }

    static bool IsInside(DependencyObject? d, DependencyObject root)
    {
        for (; d is not null; d = VisualTreeHelper.GetParent(d)) if (ReferenceEquals(d, root)) return true;
        return false;
    }

    // ---------- sync ----------

    Border SyncCard()
    {
        var s = m.Sync.Settings;
        url = new TextBox { Header = "Server address", Text = s.Url, PlaceholderText = "https://nextly.example.com" };
        altUrl = new TextBox { Header = "Second address (optional)", Text = s.AltUrl, PlaceholderText = "https://nextly.your-tailnet.ts.net" };
        token = new PasswordBox { Header = "Sync token", Password = s.Token, PlaceholderText = "NEXTLY_TOKEN from the server’s .env" };
        var urlError = new TextBlock { Foreground = Ui.Brush("NxDanger"), Visibility = Visibility.Collapsed };
        headerRows.Clear();
        headerList.Children.Clear();
        foreach (var h in s.Headers) AddHeaderRow(h.Name, h.Value);

        var addHeader = new Button { Content = "Add header" };
        var addAccess = new Button { Content = "Add Cloudflare Access headers" };
        var save = new Button { Content = "Save and sync", Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
        var syncNow = new Button { Content = "Sync now" };
        var check = new Button { Content = "Check connection" };
        addHeader.Click += (_, _) => { AddHeaderRow("", ""); Validate(); };
        addAccess.Click += (_, _) => { AddHeaderRow("CF-Access-Client-Id", ""); AddHeaderRow("CF-Access-Client-Secret", ""); Validate(); };
        var headerButtons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        headerButtons.Children.Add(addHeader);
        headerButtons.Children.Add(addAccess);

        bool Validate()
        {
            static bool Ok(string u) => u.Trim().Length == 0 || System.Text.RegularExpressions.Regex.IsMatch(u.Trim(), "^https?://[^\\s/]+");
            var problem = !Ok(url.Text) || !Ok(altUrl.Text) ? "The address should start with http:// or https://."
                : altUrl.Text.Trim().Length > 0 && url.Text.Trim().Length == 0 ? "Fill in the server address first." : null;
            urlError.Text = problem ?? "";
            urlError.Visibility = problem is null ? Visibility.Collapsed : Visibility.Visible;
            var err = Logic.CheckHeaders(Rows());
            headerError.Text = err ?? "";
            headerError.Visibility = err is null ? Visibility.Collapsed : Visibility.Visible;
            addAccess.Visibility = Rows().Any((r) => r.Name.StartsWith("CF-Access-Client-", StringComparison.OrdinalIgnoreCase)) ? Visibility.Collapsed : Visibility.Visible;
            save.IsEnabled = problem is null && err is null;
            return save.IsEnabled;
        }
        url.TextChanged += (_, _) => Validate();
        altUrl.TextChanged += (_, _) => Validate();
        changed = () => Validate();
        save.Click += async (_, _) =>
        {
            if (!Validate()) return;
            await m.Sync.SaveSettings(new SyncSettings(url.Text, altUrl.Text, token.Password, Rows()));
        };
        syncNow.Click += async (_, _) => await m.Sync.SyncNow();
        check.Click += async (_, _) =>
        {
            check.IsEnabled = false;
            check.Content = "Checking…";
            var (ok, lines) = await m.Sync.CheckConnection();
            diag.Children.Clear();
            foreach (var l in lines) diag.Children.Add(new TextBlock { Text = l, TextWrapping = TextWrapping.Wrap, Foreground = ok ? Ui.Brush("TextFillColorPrimaryBrush") : Ui.Brush("NxDanger") });
            check.Content = "Check connection";
            check.IsEnabled = true;
        };
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 8, 0, 0) };
        buttons.Children.Add(save);
        buttons.Children.Add(syncNow);
        buttons.Children.Add(check);
        Validate();
        diag.Children.Clear();

        return Card(
            H2("Sync"),
            Ui.Muted("Point every device at the same Nextly server, for example https://nextly.example.com through a Cloudflare Tunnel."),
            url, altUrl,
            Ui.Muted("Another way to reach the same server, such as Tailscale. Nextly uses whichever address answers and switches if one stops working.", 12),
            urlError, token,
            Ui.Label("Request headers"),
            Ui.Muted("Sent with every sync and file request. For Cloudflare Access, add your service token’s Client ID and Client Secret.", 12),
            headerList, headerButtons, headerError, buttons, diag, syncLine, liveLine,
            Ui.Muted($"Nextly {Version} · This device: {m.Store.DeviceId}", 12));
    }

    Action changed = () => { };

    List<Logic.HeaderRow> Rows() => headerRows
        .Select((r) => new Logic.HeaderRow(r.Name.Text, r.Secret.Visibility == Visibility.Visible ? r.Secret.Password : r.Plain.Text)).ToList();

    void AddHeaderRow(string name, string value)
    {
        var g = new Grid { ColumnSpacing = 8 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var n = new TextBox { Text = name, PlaceholderText = "Header name" };
        // Secrets are hidden as you type, like the other apps.
        var secret = new PasswordBox { Password = value, PlaceholderText = "Value" };
        var plain = new TextBox { Text = value, PlaceholderText = "Value" };
        void Kind()
        {
            var hide = System.Text.RegularExpressions.Regex.IsMatch(n.Text, "secret|token|key|password", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (hide && secret.Visibility != Visibility.Visible) secret.Password = plain.Text;
            if (!hide && plain.Visibility != Visibility.Visible) plain.Text = secret.Password;
            secret.Visibility = hide ? Visibility.Visible : Visibility.Collapsed;
            plain.Visibility = hide ? Visibility.Collapsed : Visibility.Visible;
        }
        plain.Visibility = Visibility.Visible;
        secret.Visibility = Visibility.Collapsed;
        Kind();
        n.TextChanged += (_, _) => { Kind(); changed(); };
        Grid.SetColumn(secret, 1);
        Grid.SetColumn(plain, 1);
        var x = new Button { Content = Ui.Icon(Ui.Close, 10) };
        ToolTipService.SetToolTip(x, "Remove this header");
        Grid.SetColumn(x, 2);
        g.Children.Add(n);
        g.Children.Add(secret);
        g.Children.Add(plain);
        g.Children.Add(x);
        var entry = (n, secret, plain, g);
        headerRows.Add(entry);
        headerList.Children.Add(g);
        x.Click += (_, _) => { headerRows.Remove(entry); headerList.Children.Remove(g); changed(); };
    }

    static readonly Dictionary<LiveState, string> LiveLabel = new()
    {
        [LiveState.Off] = "Live updates off",
        [LiveState.Connecting] = "Connecting live updates…",
        [LiveState.Live] = "Live updates on: changes from other devices appear right away",
        [LiveState.Retrying] = "Live updates disconnected",
    };

    public void UpdateStatus()
    {
        var s = m.Sync.Status;
        var last = s.LastSync is { } l && Js.DateParse(l) is var ms && !double.IsNaN(ms) ? $" · last synced {DateTimeOffset.FromUnixTimeMilliseconds((long)ms).LocalDateTime:g}" : "";
        syncLine.Text = $"● {s.Message}{last}{(s.Via is { } via ? $" · through {via}" : "")}";
        syncLine.Foreground = s.State switch { SyncState.Error => Ui.Brush("NxDanger"), SyncState.Idle => Ui.Brush("NxOk"), _ => Ui.Brush("TextFillColorSecondaryBrush") };
        liveLine.Text = $"● {LiveLabel[s.Live]}{(s.LiveDetail.Length > 0 ? $" · {s.LiveDetail}" : "")}";
        liveLine.Foreground = s.Live switch { LiveState.Live => Ui.Brush("NxOk"), LiveState.Retrying => Ui.Brush("NxDanger"), _ => Ui.Brush("TextFillColorSecondaryBrush") };
    }

    // ---------- Incident IQ ----------

    async Task LoadIiq()
    {
        iiq.Children.Clear();
        iiq.Children.Add(Ui.Muted("Checking…"));
        var s = await m.Sync.IiqStatus();
        iiq.Children.Clear();
        if (s is null || !Js.Truthy(s["enabled"]))
            iiq.Children.Add(Ui.Muted("Not set up. Tickets assigned to you can sync into an “Incident IQ” project once the server has your district’s Incident IQ details. See docs/incident-iq.md."));
        else
        {
            var error = Js.AsString(s["lastError"]);
            var last = Js.AsString(s["lastSync"]);
            var tickets = Js.Number(s["tickets"]);
            var minutes = Math.Round((Js.IsNumber(s["pollSeconds"], out var ps) ? ps : 120) / 60);
            var line = new TextBlock { TextWrapping = TextWrapping.Wrap };
            line.Text = error ?? (last is not null && Js.DateParse(last) is var ms && !double.IsNaN(ms)
                ? $"● {Js.Num(tickets)} open ticket{(tickets == 1 ? "" : "s")} assigned to you · checked {DateTimeOffset.FromUnixTimeMilliseconds((long)ms).LocalDateTime:t} · every {Js.Num(minutes)} min"
                : "● First sync in progress…");
            line.Foreground = error is not null ? Ui.Brush("NxDanger") : Ui.Brush("NxOk");
            iiq.Children.Add(line);
            if (!Js.Truthy(s["knowsUser"]))
                iiq.Children.Add(Ui.Muted("The server doesn’t know which Incident IQ user you are, so it can’t pick out your tickets. Set IIQ_USER_EMAIL on the server.", 12));
            iiq.Children.Add(Ui.Muted(Js.Truthy(s["canResolve"])
                ? "Finishing a ticket’s task resolves the ticket in Incident IQ."
                : "Finishing a ticket’s task adds an internal note; close the ticket in Incident IQ. Set IIQ_RESOLUTION_ACTION_ID on the server to resolve tickets from Nextly.", 12));
        }
        iiq.Children.Add(Ui.StudentInfo("Ticket tasks can include more than directory information about students, such as names with device problems and ticket descriptions. They’re stored on your Nextly server and devices. Follow district guidance on where student information may be kept."));
    }

    // ---------- areas and projects ----------

    void BuildOrg()
    {
        org.Children.Clear();
        var v = m.Store.View;
        foreach (var a in v.Areas)
        {
            var row = Row(a.Title, "Area name", (s) => m.Store.UpdateArea(a.Id, new System.Text.Json.Nodes.JsonObject { ["title"] = s }), () => m.Store.DeleteArea(a.Id), $"Delete area {a.Title}", a.ReadOnly);
            org.Children.Add(row);
        }
        var newArea = new TextBox { PlaceholderText = "New area" };
        var add = new Button { Content = "Add area" };
        void AddArea() { if (newArea.Text.Trim().Length > 0) { m.Store.CreateArea(newArea.Text.Trim()); newArea.Text = ""; } }
        add.Click += (_, _) => AddArea();
        newArea.KeyDown += (_, e) => { if (e.Key == Windows.System.VirtualKey.Enter) { e.Handled = true; AddArea(); } };
        var addRow = new Grid { ColumnSpacing = 8 };
        addRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        addRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(add, 1);
        addRow.Children.Add(newArea);
        addRow.Children.Add(add);
        org.Children.Add(addRow);

        if (v.Projects.Count > 0) org.Children.Add(Ui.Label("Projects"));
        foreach (var p in v.Projects)
        {
            var row = Row(p.Title, "Project name", (s) => m.Store.UpdateProject(p.Id, new System.Text.Json.Nodes.JsonObject { ["title"] = s }), () => m.Store.DeleteProject(p.Id),
                "Delete project (its tasks move to Inbox)", p.ReadOnly);
            var area = new ComboBox { MinWidth = 150, IsEnabled = !p.ReadOnly };
            area.Items.Add(new ComboBoxItem { Content = "No area", Tag = "" });
            foreach (var a in v.Areas) area.Items.Add(new ComboBoxItem { Content = a.Title, Tag = a.Id });
            area.SelectedItem = area.Items.OfType<ComboBoxItem>().FirstOrDefault((i) => (string)i.Tag == (p.AreaId ?? "")) ?? area.Items[0];
            area.SelectionChanged += (_, _) =>
            {
                var id = (string)((ComboBoxItem)area.SelectedItem).Tag;
                if (id != (p.AreaId ?? "")) m.Store.UpdateProject(p.Id, new System.Text.Json.Nodes.JsonObject { ["areaId"] = id.Length > 0 ? id : null });
            };
            row.ColumnDefinitions.Insert(1, new ColumnDefinition { Width = GridLength.Auto });
            Grid.SetColumn((FrameworkElement)row.Children[1], 2);
            Grid.SetColumn(area, 1);
            row.Children.Add(area);
            org.Children.Add(row);
        }
    }

    /// <summary>A name you can edit (saved when you leave the field or press Enter) and a delete button.</summary>
    static Grid Row(string value, string label, Action<string> rename, Action remove, string removeTip, bool ro)
    {
        var g = new Grid { ColumnSpacing = 8 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var box = new TextBox { Text = value, PlaceholderText = label, IsReadOnly = ro };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(box, label);
        void Save() { if (box.Text != value && box.Text.Trim().Length > 0) rename(box.Text.Trim()); }
        box.LostFocus += (_, _) => Save();
        box.KeyDown += (_, e) => { if (e.Key == Windows.System.VirtualKey.Enter) { e.Handled = true; Save(); } };
        var x = new Button { Content = Ui.Icon(Ui.Delete, 12), IsEnabled = !ro };
        ToolTipService.SetToolTip(x, removeTip);
        x.Click += (_, _) => remove();
        Grid.SetColumn(x, 1);
        g.Children.Add(box);
        g.Children.Add(x);
        return g;
    }

    // ---------- nextly:// links ----------

    /// <summary>Which app opens nextly:// links (the Gmail bookmarklet), with a switch.</summary>
    Border LinksCard()
    {
        var status = new TextBlock { TextWrapping = TextWrapping.Wrap };
        var take = new Button { Content = "Open them in this app" };
        var giveBack = new Button { Content = "Give them back to the other Nextly app" };
        void Update()
        {
            var handler = Links.Handler();
            status.Text = Links.HandledHere ? "nextly:// links (the Gmail bookmarklet) open in this app."
                : handler is null ? "Nothing opens nextly:// links yet."
                : $"nextly:// links open in another Nextly app ({handler.Split('"', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()}).";
            take.Visibility = Links.HandledHere ? Visibility.Collapsed : Visibility.Visible;
            giveBack.Visibility = Links.RegisteredForUser() && Links.HandledHere && Links.Handler() is not null ? Visibility.Visible : Visibility.Collapsed;
        }
        take.Click += (_, _) => { try { Links.Register(); } catch (Exception e) { status.Text = $"Couldn’t change it: {e.Message}"; return; } Update(); };
        giveBack.Click += (_, _) =>
        {
            try { Links.Unregister(); } catch (Exception e) { status.Text = $"Couldn’t change it: {e.Message}"; return; }
            Update();
        };
        Update();
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        buttons.Children.Add(take);
        buttons.Children.Add(giveBack);
        return Card(H2("Links"), status, buttons,
            Ui.Muted("A link from a web page can only ever add a task to your Inbox. Switching only changes it for your Windows account.", 12));
    }

    static Border KeysCard()
    {
        var g = new Grid { ColumnSpacing = 24, RowSpacing = 6 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var keys = new (string, string)[]
        {
            ("Ctrl+N", "New task"), ("Ctrl+K", "Search"), ("Ctrl+D", "Mark selected task In Progress"), ("Ctrl+T", "Flag selected task Today"),
            ("Ctrl+Shift+T", "Flag selected task Next"), ("Ctrl+Enter", "Complete selected task"), ("Delete", "Delete selected task (with Undo)"),
            ("Esc", "Close details"), ("Ctrl+,", "Settings"),
        };
        for (var i = 0; i < keys.Length; i++)
        {
            g.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var k = new TextBlock { Text = keys[i].Item1, FontWeight = FontWeights.SemiBold };
            var d = new TextBlock { Text = keys[i].Item2 };
            Grid.SetRow(k, i);
            Grid.SetRow(d, i);
            Grid.SetColumn(d, 1);
            g.Children.Add(k);
            g.Children.Add(d);
        }
        return Card(H2("Keyboard"), g,
            Ui.Muted("In quick add, !t !p !n !s !i set Today, In Progress, Next, Someday or Inbox. @mon holds a task in Scheduled until that day, ^fri sets a deadline, and *daily, *weekdays, *weekly, *monthly or *3d / *2w make it repeat. A pasted Gmail link becomes an email card.", 12));
    }
}
