// A task's notes. For now they're shown, not edited, here: the block editor
// (Enter splits, Backspace merges, "/" menu, attachments, email cards) comes
// next (docs/parity.md). Links and files open from here already.

using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Nextly.Core;
using Windows.System;

namespace Nextly.App;

public static class NotesView
{
    public static void Build(StackPanel p, AppModel m, TaskItem t)
    {
        p.Children.Add(Ui.Label("Notes"));
        if (t.Notes.Count == 0)
        {
            p.Children.Add(Ui.Muted("No notes. Editing notes on Windows is coming next; add them in another Nextly app for now.", 12));
            return;
        }
        var hasFiles = false;
        foreach (var b in t.Notes)
        {
            var type = Js.AsString(b["type"]) ?? "paragraph";
            var text = Js.AsString(b["text"]) ?? "";
            switch (type)
            {
                case "heading":
                    p.Children.Add(new TextBlock { Text = text, FontSize = 17, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 6, 0, 0) });
                    break;
                case "checklist":
                    p.Children.Add(new CheckBox { Content = text, IsChecked = Js.Truthy(b["checked"]), IsEnabled = false });
                    break;
                case "quote":
                    p.Children.Add(new Border
                    {
                        BorderBrush = Ui.Brush("NxPlum"), BorderThickness = new Thickness(3, 0, 0, 0), Padding = new Thickness(10, 2, 0, 2),
                        Child = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, FontStyle = Windows.UI.Text.FontStyle.Italic },
                    });
                    break;
                case "divider":
                    p.Children.Add(new Border { Height = 1, Background = Ui.Brush("DividerStrokeColorDefaultBrush"), Margin = new Thickness(0, 8, 0, 8) });
                    break;
                case "email":
                    if (Js.AsString(b["url"]) is { } url && Uri.TryCreate(url, UriKind.Absolute, out var uri))
                    {
                        var mail = new HyperlinkButton { Content = $"✉ {Js.AsString(b["subject"]) ?? "Email"}" };
                        mail.Click += async (_, _) => await Launcher.LaunchUriAsync(uri);
                        p.Children.Add(mail);
                    }
                    break;
                case "image" or "file":
                    hasFiles = true;
                    var name = Js.AsString(b["name"]) ?? "file";
                    var sha = Js.AsString(b["sha"]);
                    var open = new HyperlinkButton { Content = $"📎 {name}", IsEnabled = sha is not null };
                    open.Click += async (_, _) =>
                    {
                        try { await Launcher.LaunchUriAsync(new Uri(await m.Sync.FileLink(sha!, name, Js.AsString(b["mime"]) ?? "application/octet-stream"))); }
                        catch (Exception e) { open.Content = $"📎 {name} (couldn’t open: {e.Message})"; }
                    };
                    p.Children.Add(open);
                    break;
                default:
                    if (text.Length > 0) p.Children.Add(new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true });
                    break;
            }
        }
        if (hasFiles)
            p.Children.Add(Ui.StudentInfo("Don’t attach files with more than directory information about students, such as grades, IEP or 504 details, or health records. Attachments are stored on your Nextly server and devices."));
    }
}
