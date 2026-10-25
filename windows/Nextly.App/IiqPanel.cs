// The Incident IQ ticket behind a task (port of app/src/IiqPanel.tsx):
// status, details, a link to the ticket, internal comments, and what Nextly
// asked the server to do. The server carries the requests out (server/iiq.js).

using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Nextly.Core;
using Windows.System;

namespace Nextly.App;

public static class IiqPanel
{
    static readonly Dictionary<string, (string Label, string Fg, string Bg)> States = new()
    {
        ["pending"] = ("Sending…", "TextFillColorSecondaryBrush", "NxChipBg"),
        ["done"] = ("Done", "NxDoing", "NxDoingBg"),
        ["manual"] = ("Needs you", "NxToday", "NxTodayBg"),
        ["failed"] = ("Failed", "NxDanger", "NxBlockedBg"),
    };

    static readonly Dictionary<string, string> Types = new() { ["comment"] = "Comment", ["start"] = "Start ticket", ["resolve"] = "Resolve ticket" };

    public static FrameworkElement Build(AppModel m, TaskItem t)
    {
        var ext = t.External!;
        var closed = Js.Truthy(ext["closed"]);
        var p = new StackPanel { Spacing = 8 };
        var card = new Border
        {
            Child = p, Padding = new Thickness(14, 12, 14, 12), CornerRadius = new CornerRadius(8), Margin = new Thickness(0, 8, 0, 0),
            Background = Ui.Brush("CardBackgroundFillColorDefaultBrush"), BorderBrush = Ui.Brush("NxNavy"), BorderThickness = new Thickness(3, 1, 1, 1),
        };

        var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        head.Children.Add(new TextBlock { Text = "INCIDENT IQ", FontSize = 10, FontWeight = FontWeights.Bold, CharacterSpacing = 80, Foreground = Ui.Brush("TextFillColorTertiaryBrush"), VerticalAlignment = VerticalAlignment.Center });
        head.Children.Add(new TextBlock { Text = $"#{(ext["number"] is { } n ? Js.Str(n) : "?")}", FontWeight = FontWeights.Bold, VerticalAlignment = VerticalAlignment.Center });
        if (Js.AsString(ext["status"]) is { } status)
            head.Children.Add(closed ? Ui.Chip(status, "TextFillColorSecondaryBrush", "NxChipBg") : Ui.Chip(status, "NxNext", "NxNextBg"));
        if (Js.AsString(ext["url"]) is { Length: > 0 } url && Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            var link = new HyperlinkButton { Content = "Open in Incident IQ", Padding = new Thickness(4, 0, 4, 0) };
            link.Click += async (_, _) => await Launcher.LaunchUriAsync(uri);
            head.Children.Add(link);
        }
        p.Children.Add(head);

        var created = Js.AsString(ext["created"]) is { } c && Js.DateParse(c) is var ms && !double.IsNaN(ms)
            ? $"Submitted {DateTimeOffset.FromUnixTimeMilliseconds((long)ms).LocalDateTime:MMM d, yyyy}" : null;
        var details = new[] { created, Js.AsString(ext["requester"]) is { } r ? $"Requested by {r}" : null, Js.AsString(ext["location"]), Js.AsString(ext["issue"]),
            Js.AsString(ext["priority"]) is { } pr ? $"Priority {pr}" : null }.Where((x) => !string.IsNullOrEmpty(x)).ToList();
        p.Children.Add(Ui.Muted(details.Count > 0 ? string.Join(" · ", details) : "Ticket details appear after the next sync.", 12));

        var actions = m.Store.View.IiqActions(t.Id).Take(5).ToList();
        if (actions.FirstOrDefault((a) => a.State is "manual" or "failed") is { } needsYou && needsYou.Message is { } msg)
            p.Children.Add(new InfoBar { Message = msg, IsOpen = true, IsClosable = false, Severity = needsYou.State == "failed" ? InfoBarSeverity.Error : InfoBarSeverity.Warning });

        if (!closed && !t.ReadOnly)
        {
            var comment = new TextBox { PlaceholderText = "Add an internal comment to the ticket…", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 56 };
            var post = new Button { Content = "Post to Incident IQ", Style = (Style)Application.Current.Resources["AccentButtonStyle"], IsEnabled = false, HorizontalAlignment = HorizontalAlignment.Right };
            comment.TextChanged += (_, _) => post.IsEnabled = comment.Text.Trim().Length > 0;
            post.Click += (_, _) =>
            {
                var text = comment.Text.Trim();
                if (text.Length == 0) return;
                comment.Text = "";
                m.Store.QueueIiq(t.Id, "comment", text);
            };
            p.Children.Add(comment);
            p.Children.Add(post);
        }

        foreach (var a in actions)
        {
            var (label, fg, bg) = States.GetValueOrDefault(a.State, ("", "TextFillColorSecondaryBrush", "NxChipBg"));
            var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            line.Children.Add(Ui.Chip(label, fg, bg));
            var what = Types.GetValueOrDefault(a.Type, a.Type);
            if (a.Type == "comment" && a.Text is { } txt) what += $": “{(txt.Length > 60 ? txt[..60] + "…" : txt)}”";
            line.Children.Add(new TextBlock { Text = what, FontSize = 12, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis });
            if (Js.DateParse(a.CreatedAt) is var am && !double.IsNaN(am))
                line.Children.Add(new TextBlock { Text = DateTimeOffset.FromUnixTimeMilliseconds((long)am).LocalDateTime.ToString("MMM d, h:mm tt"), FontSize = 12, Foreground = Ui.Brush("TextFillColorTertiaryBrush"), VerticalAlignment = VerticalAlignment.Center });
            p.Children.Add(line);
        }
        p.Children.Add(Ui.Muted("Comments are internal. In Progress starts the ticket; finishing the task resolves it.", 11));
        return card;
    }
}
