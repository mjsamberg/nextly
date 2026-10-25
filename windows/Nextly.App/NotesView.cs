// A task's notes (port of app/src/Notes.tsx): a list of blocks, like a blog
// post. Enter splits a block, Backspace on an empty block removes it, and "/"
// in an empty text block opens the block menu. Attaching shows the district's
// student-information warning first. Blocks keep fields this app doesn't
// know, since every save replaces the whole task.

using System.Text.Json.Nodes;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Nextly.Core;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.System;

namespace Nextly.App;

public sealed class NotesView
{
    static readonly string[] TextTypes = ["heading", "paragraph", "checklist", "quote"];
    static readonly (string Type, string Label, string Hint)[] Menu =
    [
        ("heading", "Heading", "H"), ("paragraph", "Text", "¶"), ("checklist", "Checklist", "☐"), ("quote", "Quote", "“"),
        ("divider", "Divider", "—"), ("image", "Image", "▣"), ("file", "File", "⎘"), ("email", "Email", "✉"),
    ];
    const string FileWarning = "Don’t attach files with more than directory information about students, such as grades, IEP or 504 details, or health records. Attachments are stored on your Nextly server and devices.";

    readonly AppModel m;
    readonly string taskId;
    readonly StackPanel host = new() { Spacing = 4 };
    readonly Dictionary<string, TextBox> boxes = [];
    readonly List<Action> flushes = [];
    StackPanel? form; // the attach or email form, when open
    int generation; // bumps on every rebuild; boxes from older ones never save

    public FrameworkElement View => host;

    public NotesView(AppModel model, string id) { m = model; taskId = id; }

    public string TaskId => taskId;

    /// <summary>
    /// Puts the notes into a freshly built detail pane. The same editor is kept
    /// while the same task is open, so an open form or a pending cursor move
    /// survives the pane being rebuilt.
    /// </summary>
    public void Attach(StackPanel p)
    {
        FlushAll();
        // FrameworkElement.Parent is null once the old pane is off screen, so
        // remember the panel ourselves: an element can only have one parent.
        attachedTo?.Children.Remove(host);
        attachedTo = p;
        p.Children.Add(Ui.Label("Notes"));
        p.Children.Add(host);
        Rebuild(m.FocusBlock, m.FocusBlockAtEnd);
    }

    Panel? attachedTo;

    /// <summary>Before the detail pane replaces this editor: save what's pending, then never save again.</summary>
    public void Retire()
    {
        FlushAll();
        generation++;
    }

    List<JsonObject> Blocks() => m.Store.View.Task(taskId)?.Notes.Select((b) => (JsonObject)b.DeepClone()).ToList() ?? [];

    void Save(IEnumerable<JsonObject> next)
    {
        var arr = new JsonArray(next.Select((b) => (JsonNode)b.DeepClone()).ToArray());
        Debug.Log($"notes save [{GetHashCode():x}]: {string.Join(" | ", arr.Select((b) => Js.AsString(b?["text"]) ?? Js.AsString(b?["type"])))}");
        m.Store.SetNotes(taskId, arr);
    }

    /// <summary>Saves any text still waiting to be saved, before a change to the list of blocks.</summary>
    void FlushAll() { foreach (var f in flushes.ToList()) f(); }

    static JsonObject NewBlock(string type, string text = "")
    {
        var b = new JsonObject { ["id"] = Logic.Uid(), ["type"] = type, ["text"] = text };
        if (type == "checklist") b["checked"] = false;
        return b;
    }

    void Rebuild(string? focusId = null, bool caretAtEnd = false)
    {
        Debug.Log($"notes rebuild [{GetHashCode():x}] focus={focusId}");
        generation++;
        host.Children.Clear();
        boxes.Clear();
        flushes.Clear();
        var t = m.Store.View.Task(taskId);
        if (t is null) return;
        var ro = t.ReadOnly;
        var blocks = t.Notes;
        if (blocks.Count == 0 && !ro)
        {
            var start = new Button
            {
                Content = "Write notes, paste links, or add files and emails…", HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Left, Foreground = Ui.Brush("TextFillColorSecondaryBrush"),
            };
            start.Click += (_, _) => Insert(0, NewBlock("paragraph"));
            host.Children.Add(start);
        }
        for (var i = 0; i < blocks.Count; i++) host.Children.Add(BlockView(blocks[i], i, ro));
        if (form is not null) host.Children.Add(form);
        if (blocks.Any((b) => Js.AsString(b["type"]) is "image" or "file") && form is null) host.Children.Add(Ui.StudentInfo(FileWarning));
        if (!ro) host.Children.Add(BlockBar(blocks.Count));
        // Remember the request until a box has it, in case the pane is rebuilt first.
        m.FocusBlock = focusId;
        m.FocusBlockAtEnd = caretAtEnd;
        if (focusId is not null && boxes.TryGetValue(focusId, out var box))
            box.Loaded += (_, _) =>
            {
                if (!box.Focus(FocusState.Keyboard)) return;
                box.SelectionStart = caretAtEnd ? box.Text.Length : 0;
                if (m.FocusBlock == focusId) m.FocusBlock = null;
            };
    }

    void Insert(int at, JsonObject b)
    {
        FlushAll();
        var list = Blocks();
        list.Insert(Math.Clamp(at, 0, list.Count), b);
        Save(list);
        Rebuild(Js.AsString(b["id"]));
    }

    void Patch(string id, Action<JsonObject> change, string? focus = null)
    {
        var list = Blocks();
        if (list.FirstOrDefault((b) => Js.AsString(b["id"]) == id) is not { } b) return;
        change(b);
        Save(list);
        if (focus is not null) Rebuild(focus);
    }

    void Remove(string id, string? focus = null)
    {
        FlushAll();
        Save(Blocks().Where((b) => Js.AsString(b["id"]) != id));
        Rebuild(focus, caretAtEnd: true);
    }

    FrameworkElement BlockView(JsonObject b, int i, bool ro)
    {
        var id = Js.AsString(b["id"]) ?? "";
        var type = Js.AsString(b["type"]) ?? "paragraph";
        if (TextTypes.Contains(type)) return TextBlockView(b, id, type, i, ro);

        var g = new Grid { ColumnSpacing = 8 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        FrameworkElement body = type switch
        {
            "divider" => new Border { Height = 1, Background = Ui.Brush("DividerStrokeColorDefaultBrush"), Margin = new Thickness(0, 10, 0, 10), VerticalAlignment = VerticalAlignment.Center },
            "image" => ImageView(b),
            "file" => FileView(b),
            "email" => EmailView(b, id, ro),
            _ => new TextBlock { Text = type },
        };
        g.Children.Add(body);
        if (!ro)
        {
            var x = new Button { Content = Ui.Icon(Ui.Close, 10), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), VerticalAlignment = VerticalAlignment.Top };
            ToolTipService.SetToolTip(x, "Remove block");
            x.Click += (_, _) => Remove(id);
            Grid.SetColumn(x, 1);
            g.Children.Add(x);
        }
        return g;
    }

    FrameworkElement TextBlockView(JsonObject b, string id, string type, int i, bool ro)
    {
        var text = Js.AsString(b["text"]) ?? "";
        var box = new TextBox
        {
            Text = text, TextWrapping = TextWrapping.Wrap, AcceptsReturn = type == "quote", IsReadOnly = ro,
            BorderThickness = new Thickness(0), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), Padding = new Thickness(6, 4, 6, 4),
            PlaceholderText = type == "heading" ? "Heading" : type == "paragraph" && i == 0 ? "Type / for blocks" : "",
        };
        if (type == "heading") { box.FontSize = 18; box.FontWeight = FontWeights.SemiBold; }
        if (type == "quote") box.FontStyle = Windows.UI.Text.FontStyle.Italic;
        boxes[id] = box;

        // Text saves when you pause, leave the block, or change the blocks around it.
        var last = text;
        var timer = host.DispatcherQueue.CreateTimer();
        timer.Interval = TimeSpan.FromMilliseconds(500);
        timer.IsRepeating = false;
        var gen = generation;
        void Flush()
        {
            timer.Stop();
            // A box from before a rebuild (say, the one Enter just split) is gone:
            // saving its old text would undo the change that replaced it.
            if (gen != generation || box.Text == last) return;
            last = box.Text;
            Debug.Log($"flush {id}: {box.Text}");
            Patch(id, (blk) => blk["text"] = box.Text);
        }
        flushes.Add(Flush);
        timer.Tick += (_, _) => Flush();
        box.LostFocus += (_, _) => Flush();
        box.TextChanged += (_, _) =>
        {
            timer.Stop();
            timer.Start();
            if (box.Text == "/" && type == "paragraph" && !ro) SlashMenu(box, id);
        };
        box.PreviewKeyDown += (_, e) =>
        {
            var shift = Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
            if (ro) return;
            if (e.Key == VirtualKey.Enter && !shift && type != "quote")
            {
                e.Handled = true;
                // Enter on an empty checklist item ends the list.
                if (type == "checklist" && box.Text.Length == 0)
                {
                    FlushAll();
                    Patch(id, (blk) => { blk["type"] = "paragraph"; blk.Remove("checked"); }, focus: id);
                    return;
                }
                FlushAll();
                var at = Math.Clamp(box.SelectionStart, 0, box.Text.Length);
                Debug.Log($"enter in {id} at {at} of {box.Text.Length}: {box.Text}");
                var before = box.Text[..at];
                var after = box.Text[at..];
                var nb = NewBlock(type == "checklist" ? "checklist" : "paragraph", after);
                var list = Blocks();
                var idx = list.FindIndex((x) => Js.AsString(x["id"]) == id);
                if (idx < 0) return;
                list[idx]["text"] = before;
                list.Insert(idx + 1, nb);
                last = before;
                Save(list);
                Rebuild(Js.AsString(nb["id"]));
            }
            else if (e.Key == VirtualKey.Back && box.Text.Length == 0)
            {
                e.Handled = true;
                var list = Blocks();
                var idx = list.FindIndex((x) => Js.AsString(x["id"]) == id);
                var prev = idx > 0 ? Js.AsString(list[idx - 1]["id"]) : null;
                Remove(id, prev);
            }
        };

        if (type == "checklist")
        {
            var g = new Grid();
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var check = TaskRow.RoundCheck(Js.Truthy(b["checked"]), () => { FlushAll(); Patch(id, (blk) => blk["checked"] = !Js.Truthy(blk["checked"]), focus: ""); }, ro, 16);
            check.VerticalAlignment = VerticalAlignment.Top;
            if (Js.Truthy(b["checked"])) box.Foreground = Ui.Brush("TextFillColorTertiaryBrush");
            g.Children.Add(check);
            Grid.SetColumn(box, 1);
            g.Children.Add(box);
            return g;
        }
        if (type == "quote")
            return new Border { BorderBrush = Ui.Brush("NxPlum"), BorderThickness = new Thickness(3, 0, 0, 0), Child = box };
        return box;
    }

    void SlashMenu(TextBox box, string id)
    {
        var menu = new MenuFlyout();
        foreach (var (type, label, hint) in Menu)
        {
            var item = new MenuFlyoutItem { Text = $"{hint}   {label}" };
            item.Click += (_, _) => Choose(type, id);
            menu.Items.Add(item);
        }
        menu.ShowAt(box, new FlyoutShowOptions { Placement = FlyoutPlacementMode.BottomEdgeAlignedLeft });
    }

    /// <summary>A block type from the "/" menu (replacing the block) or the bar (at the end).</summary>
    void Choose(string type, string? replaceId)
    {
        FlushAll();
        var list = Blocks();
        var at = replaceId is null ? list.Count : list.FindIndex((x) => Js.AsString(x["id"]) == replaceId);
        if (replaceId is not null && at >= 0) { list.RemoveAt(at); Save(list); }
        if (at < 0) at = list.Count;
        if (type is "image" or "file") { OpenAttach(type, at); return; }
        if (type == "email") { OpenEmailForm(at); return; }
        list = Blocks();
        var nb = type == "divider" ? new JsonObject { ["id"] = Logic.Uid(), ["type"] = "divider" } : NewBlock(type);
        list.Insert(Math.Clamp(at, 0, list.Count), nb);
        Save(list);
        Rebuild(type == "divider" ? null : Js.AsString(nb["id"]));
    }

    FrameworkElement BlockBar(int count)
    {
        var bar = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2, Margin = new Thickness(0, 6, 0, 0) };
        foreach (var (type, label, hint) in Menu)
        {
            var content = type switch
            {
                "file" => (UIElement)Ui.Icon(Ui.Attach, 12),
                "email" => Ui.Icon(Ui.Mail, 12),
                "image" => Ui.Icon("", 12), // Photo
                _ => new TextBlock { Text = hint, FontSize = 13 },
            };
            var b = new Button { Content = content, Padding = new Thickness(8, 4, 8, 4), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0) };
            ToolTipService.SetToolTip(b, $"Add {label.ToLowerInvariant()}");
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(b, $"Add {label.ToLowerInvariant()}");
            b.Click += (_, _) => Choose(type, null);
            bar.Children.Add(b);
        }
        return new ScrollViewer { Content = bar, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, HorizontalScrollMode = ScrollMode.Enabled };
    }

    // ---------- attachments ----------

    /// <summary>The district's warning, then Windows' file picker.</summary>
    void OpenAttach(string type, int at)
    {
        form = new StackPanel { Spacing = 8, Margin = new Thickness(0, 6, 0, 0) };
        form.Children.Add(Ui.StudentInfo(FileWarning));
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var cancel = new Button { Content = "Cancel" };
        var pick = new Button { Content = type == "image" ? "Choose an image…" : "Choose files…", Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
        var error = new TextBlock { Foreground = Ui.Brush("NxDanger"), TextWrapping = TextWrapping.Wrap };
        cancel.Click += (_, _) => { form = null; Rebuild(); };
        pick.Click += async (_, _) =>
        {
            try
            {
                var picker = new Windows.Storage.Pickers.FileOpenPicker();
                WinRT.Interop.InitializeWithWindow.Initialize(picker, m.WindowHandle);
                if (type == "image") foreach (var ext in new[] { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".bmp" }) picker.FileTypeFilter.Add(ext);
                else picker.FileTypeFilter.Add("*");
                var files = await picker.PickMultipleFilesAsync();
                if (files is null || files.Count == 0) return;
                var added = new List<JsonObject>();
                foreach (var f in files)
                {
                    var buf = await Windows.Storage.FileIO.ReadBufferAsync(f);
                    var bytes = new byte[buf.Length];
                    using (var reader = Windows.Storage.Streams.DataReader.FromBuffer(buf)) reader.ReadBytes(bytes);
                    var mime = string.IsNullOrEmpty(f.ContentType) ? "application/octet-stream" : f.ContentType;
                    var meta = m.Sync.AddFile(bytes, f.Name, mime);
                    var isImage = type == "image" || meta.Mime.StartsWith("image/");
                    added.Add(new JsonObject { ["id"] = Logic.Uid(), ["type"] = isImage ? "image" : "file", ["sha"] = meta.Sha, ["name"] = meta.Name, ["size"] = meta.Size, ["mime"] = meta.Mime });
                }
                var list = Blocks();
                list.InsertRange(Math.Clamp(at, 0, list.Count), added);
                form = null;
                Save(list);
                _ = m.Sync.SyncNow();
                Rebuild();
            }
            catch (Exception e) { error.Text = $"Couldn’t add the file: {e.Message}"; }
        };
        buttons.Children.Add(cancel);
        buttons.Children.Add(pick);
        form.Children.Add(buttons);
        form.Children.Add(error);
        Rebuild();
    }

    FrameworkElement ImageView(JsonObject b)
    {
        var name = Js.AsString(b["name"]) ?? "";
        var status = Ui.Muted($"Loading {name}…", 12);
        var holder = new StackPanel();
        holder.Children.Add(status);
        if (Js.AsString(b["sha"]) is not { } sha) return holder;
        _ = Load();
        return holder;

        async Task Load()
        {
            try
            {
                var bytes = await m.Sync.LoadFile(sha, name, Js.AsString(b["mime"]) ?? "application/octet-stream");
                if (bytes is null) { status.Text = $"{name}: not downloaded yet. It will appear once this device syncs."; return; }
                var bmp = new BitmapImage();
                using var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
                await stream.WriteAsync(bytes.AsBuffer());
                stream.Seek(0);
                await bmp.SetSourceAsync(stream);
                holder.Children.Clear();
                holder.Children.Add(new Image { Source = bmp, MaxHeight = 360, Stretch = Stretch.Uniform, HorizontalAlignment = HorizontalAlignment.Left });
            }
            catch (Exception e) { status.Text = $"{name}: couldn’t show it ({e.Message})."; }
        }
    }

    FrameworkElement FileView(JsonObject b)
    {
        var name = Js.AsString(b["name"]) ?? "file";
        var size = Js.Number(b["size"]);
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        row.Children.Add(Ui.Icon("", 16)); // Document
        row.Children.Add(new TextBlock { Text = name, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis });
        if (!double.IsNaN(size)) row.Children.Add(Ui.Muted(Size(size), 12));
        var card = new Button { Content = row, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Left, Padding = new Thickness(12, 8, 12, 8) };
        ToolTipService.SetToolTip(card, "Open");
        card.Click += async (_, _) =>
        {
            try { await Launcher.LaunchUriAsync(new Uri(await m.Sync.FileLink(Js.AsString(b["sha"])!, name, Js.AsString(b["mime"]) ?? "application/octet-stream"))); }
            catch (Exception e) { ToolTipService.SetToolTip(card, $"Couldn’t open it: {e.Message}"); }
        };
        return card;
    }

    static string Size(double n) => n < 1024 ? $"{n} B" : n < 1048576 ? $"{Math.Round(n / 1024)} KB" : $"{n / 1048576:0.0} MB";

    // ---------- email cards ----------

    FrameworkElement EmailView(JsonObject b, string id, bool ro)
    {
        var url = Js.AsString(b["url"]) ?? "";
        var p = new StackPanel { Spacing = 2 };
        var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        head.Children.Add(Ui.Icon(Ui.Mail, 14));
        var subject = new TextBox { Text = Js.AsString(b["subject"]) ?? "", PlaceholderText = "Email subject", IsReadOnly = ro, MinWidth = 240, BorderThickness = new Thickness(0), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };
        var last = subject.Text;
        var gen = generation;
        void Flush() { if (gen == generation && subject.Text != last) { last = subject.Text; Patch(id, (blk) => blk["subject"] = subject.Text); } }
        flushes.Add(Flush);
        subject.LostFocus += (_, _) => Flush();
        head.Children.Add(subject);
        p.Children.Add(head);
        if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            var open = new HyperlinkButton { Content = url.StartsWith("message:") ? "Open in Mail" : "Open in Gmail", Padding = new Thickness(22, 0, 0, 0) };
            open.Click += async (_, _) => await Launcher.LaunchUriAsync(uri);
            p.Children.Add(open);
        }
        return new Border
        {
            Child = p, Padding = new Thickness(10, 8, 10, 8), CornerRadius = new CornerRadius(6),
            Background = Ui.Brush("CardBackgroundFillColorDefaultBrush"), BorderBrush = Ui.Brush("CardStrokeColorDefaultBrush"), BorderThickness = new Thickness(1),
        };
    }

    void OpenEmailForm(int at)
    {
        form = new StackPanel { Spacing = 8, Margin = new Thickness(0, 6, 0, 0) };
        var url = new TextBox { Header = "Gmail link", PlaceholderText = "https://mail.google.com/mail/u/0/#inbox/…" };
        var subject = new TextBox { Header = "Subject", PlaceholderText = "What the email is about" };
        var error = new TextBlock { Foreground = Ui.Brush("NxDanger"), TextWrapping = TextWrapping.Wrap, Text = "Paste the address of an open Gmail message. It starts with https://mail.google.com/.", Visibility = Visibility.Collapsed };
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var cancel = new Button { Content = "Cancel" };
        var add = new Button { Content = "Add email", Style = (Style)Application.Current.Resources["AccentButtonStyle"], IsEnabled = false };
        bool Valid() => System.Text.RegularExpressions.Regex.IsMatch(url.Text.Trim(), "^(https://mail\\.google\\.com/|message:)");
        url.TextChanged += (_, _) => { add.IsEnabled = Valid(); error.Visibility = url.Text.Length > 0 && !Valid() ? Visibility.Visible : Visibility.Collapsed; };
        cancel.Click += (_, _) => { form = null; Rebuild(); };
        add.Click += (_, _) =>
        {
            if (!Valid()) return;
            form = null;
            var list = Blocks();
            list.Insert(Math.Clamp(at, 0, list.Count), new JsonObject { ["id"] = Logic.Uid(), ["type"] = "email", ["url"] = url.Text.Trim(), ["subject"] = subject.Text.Trim() });
            Save(list);
            Rebuild();
        };
        buttons.Children.Add(cancel);
        buttons.Children.Add(add);
        form.Children.Add(url);
        form.Children.Add(subject);
        form.Children.Add(error);
        form.Children.Add(buttons);
        Rebuild();
        url.Loaded += (_, _) => url.Focus(FocusState.Programmatic);
    }
}
