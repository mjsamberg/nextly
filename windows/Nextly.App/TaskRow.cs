// One task in a list (port of the Row in app/src/TaskList.tsx): a round
// check, the title with its project or parent, and chips for subtasks, mail,
// attachments, waiting, flag, ticket status, repeat, start date and deadline.

using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Nextly.Core;

namespace Nextly.App;

public sealed class TaskRow : Grid
{
    public string TaskId { get; }

    public TaskRow(AppModel m, ViewData v, TaskItem t, string view, Action<string> onDelete)
    {
        TaskId = t.Id;
        MinHeight = 40;
        Padding = new Thickness(0, 4, 4, 4);
        ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var check = RoundCheck(t.Done, () => m.Store.ToggleDone(t.Id), t.ReadOnly);
        Children.Add(check);

        var title = new TextBlock
        {
            Text = t.Title.Length > 0 ? t.Title : "New task",
            TextTrimming = TextTrimming.CharacterEllipsis,
            VerticalAlignment = VerticalAlignment.Center,
            FontSize = 14,
        };
        if (t.Title.Length == 0 || t.Done) title.Foreground = Ui.Brush("TextFillColorTertiaryBrush");
        if (t.Done) title.TextDecorations = Windows.UI.Text.TextDecorations.Strikethrough;
        var titles = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(8, 0, 8, 0) };
        titles.Children.Add(title);
        var parent = t.HasParent && t.ParentId is { } pid ? v.Task(pid) : null;
        var project = v.Project(t.ProjectId);
        var context = parent?.Title ?? (project is not null && !view.StartsWith("project:") ? project.Title : null);
        if (!string.IsNullOrEmpty(context))
            titles.Children.Add(new TextBlock { Text = context, FontSize = 11, Foreground = Ui.Brush("TextFillColorTertiaryBrush"), TextTrimming = TextTrimming.CharacterEllipsis });
        SetColumn(titles, 1);
        Children.Add(titles);

        var chips = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, VerticalAlignment = VerticalAlignment.Center };
        var kids = v.Children(t.Id);
        if (kids.Count > 0) chips.Children.Add(Ui.Chip($"{kids.Count((k) => k.Done)}/{kids.Count}", "TextFillColorSecondaryBrush", "NxChipBg", Ui.Subtasks, "Subtasks done"));
        if (t.Notes.Any((b) => Js.AsString(b["type"]) == "email")) chips.Children.Add(Ui.Icon(Ui.Mail, 12, Ui.Brush("TextFillColorSecondaryBrush")));
        var files = t.Notes.Count((b) => Js.AsString(b["type"]) is "file" or "image");
        if (files > 0) chips.Children.Add(Ui.Chip(files > 1 ? files.ToString() : "", "TextFillColorSecondaryBrush", "NxChipBg", Ui.Attach, "Attachments"));
        var blockers = v.Blockers(t);
        if (blockers.Count > 0 && !t.Done) chips.Children.Add(Ui.Chip($"Waiting on {blockers.Count}", "NxBlocked", "NxBlockedBg", Ui.Lock));
        var showFlag = view is not ("doing" or "today" or "next" or "someday" or "inbox");
        if (showFlag && t.Flag == "doing") chips.Children.Add(Ui.Chip("In Progress", "NxDoing", "NxDoingBg", Ui.Doing));
        if (showFlag && t.Flag == "today") chips.Children.Add(Ui.Chip("Today", "NxToday", "NxTodayBg", Ui.Today));
        if (showFlag && t.Flag == "next") chips.Children.Add(Ui.Chip("Next", "NxNext", "NxNextBg"));
        if (t.IsTicket)
        {
            var status = Js.AsString(t.External!["status"]);
            var shortStatus = status is null ? "" : status.Length > 14 ? " · " + status[..13] + "…" : " · " + status;
            chips.Children.Add(Ui.Chip("IIQ" + shortStatus, "NxNext", "NxNextBg", null, "Incident IQ ticket" + (status is null ? "" : $" · {status}")));
        }
        if (t.Repeat is { } r) chips.Children.Add(Ui.Chip("", "TextFillColorSecondaryBrush", "NxChipBg", Ui.Repeat, Logic.RepeatLabel(r)));
        var today = DateOnly.FromDateTime(DateTime.Now);
        if (t.StartOn is { Length: > 0 } s) chips.Children.Add(Ui.Chip(Logic.DeadlineLabel(s, today), "NxToday", "NxTodayBg", Ui.Today, "Moves into Today on this day"));
        if (t.Deadline is { Length: > 0 } d) chips.Children.Add(Ui.Chip((t.StartOn is { Length: > 0 } ? "Due " : "") + Logic.DeadlineLabel(d, today), "TextFillColorSecondaryBrush", "NxChipBg"));
        SetColumn(chips, 2);
        Children.Add(chips);

        AutomationProperties.SetName(this, t.Title + (t.Done ? ", done" : ""));
        if (!t.ReadOnly) ContextFlyout = Menu(m, t, onDelete);
    }

    /// <summary>The round Things-style check. Completing a ticket's task asks for notes first (the store says so).</summary>
    public static Button RoundCheck(bool done, Action toggle, bool readOnly = false, double size = 20)
    {
        var circle = new Border
        {
            Width = size, Height = size, CornerRadius = new CornerRadius(size / 2), BorderThickness = new Thickness(1.5),
            BorderBrush = done ? Ui.Brush("AccentFillColorDefaultBrush") : Ui.Brush("TextFillColorTertiaryBrush"),
            Background = done ? Ui.Brush("AccentFillColorDefaultBrush") : new SolidColorBrush(Microsoft.UI.Colors.Transparent),
        };
        if (done) circle.Child = Ui.Icon(Ui.Check, size * 0.55, Ui.Brush("TextOnAccentFillColorPrimaryBrush"));
        var b = new Button
        {
            Content = circle, Padding = new Thickness(0), Width = 36, Height = 36, Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0), VerticalAlignment = VerticalAlignment.Center, IsEnabled = !readOnly,
        };
        AutomationProperties.SetName(b, done ? "Mark not done" : "Mark done");
        b.Click += (_, _) => toggle();
        return b;
    }

    static MenuFlyout Menu(AppModel m, TaskItem t, Action<string> onDelete)
    {
        var menu = new MenuFlyout();
        void Flag(string label, string? flag, string? glyph)
        {
            var item = new MenuFlyoutItem { Text = label, Icon = glyph is null ? null : Ui.Icon(glyph) };
            item.Click += (_, _) => m.Store.SetFlag(t.Id, flag);
            if (t.Flag == flag) item.IsEnabled = false;
            menu.Items.Add(item);
        }
        Flag("In Progress", "doing", Ui.Doing);
        Flag("Today", "today", Ui.Today);
        Flag("Next", "next", Ui.Next);
        Flag("Someday", "someday", Ui.Someday);
        Flag("Inbox", "inbox", Ui.Inbox);
        menu.Items.Add(new MenuFlyoutSeparator());
        var del = new MenuFlyoutItem { Text = "Delete", Icon = Ui.Icon(Ui.Delete) };
        del.Click += (_, _) => onDelete(t.Id);
        menu.Items.Add(del);
        return menu;
    }
}
