// Small building blocks the screens share: brand colors and fonts, icons,
// chips, section headings. The screens are built in code because most of
// their content (sections, chips, groups) depends on the data.

using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Nextly.App;

public static class Ui
{
    // Segoe Fluent Icons.
    public const string Inbox = "", Doing = "", Today = "", Next = "", Scheduled = "",
        Someday = "", All = "", Logbook = "", Folder = "", Lock = "", Mail = "",
        Attach = "", Repeat = "", Subtasks = "", OpenOut = "", Add = "", Close = "",
        Delete = "", Settings = "", Search = "", Link = "", Check = "", Up = "", Chevron = "";

    public static Brush Brush(string key) => (Brush)Application.Current.Resources[key];
    public static FontFamily HeadingFont => (FontFamily)Application.Current.Resources["NxHeadingFont"];
    public static FontFamily BodyFont => (FontFamily)Application.Current.Resources["NxBodyFont"];

    public static FontIcon Icon(string glyph, double size = 14, Brush? fg = null)
    {
        var i = new FontIcon { Glyph = glyph, FontSize = size, FontFamily = new FontFamily("Segoe Fluent Icons") };
        if (fg is not null) i.Foreground = fg;
        return i;
    }

    /// <summary>A heading in the district's display face (Oswald, uppercase).</summary>
    public static TextBlock Heading(string text, double size = 28) => new()
    {
        Text = text.ToUpperInvariant(), FontFamily = HeadingFont, FontWeight = FontWeights.SemiBold, FontSize = size,
        CharacterSpacing = 10, TextTrimming = TextTrimming.CharacterEllipsis,
    };

    /// <summary>A small caps section label, like "UP NEXT · 4".</summary>
    public static TextBlock Section(string text) => new()
    {
        Text = text.ToUpperInvariant(), FontSize = 11, FontWeight = FontWeights.Bold, CharacterSpacing = 120,
        Foreground = Brush("TextFillColorTertiaryBrush"), Margin = new Thickness(12, 18, 0, 6),
    };

    public static TextBlock Muted(string text, double size = 13) => new()
    {
        Text = text, FontSize = size, Foreground = Brush("TextFillColorSecondaryBrush"), TextWrapping = TextWrapping.Wrap,
    };

    /// <summary>A small rounded label: a flag, a date, a ticket status.</summary>
    public static Border Chip(string text, string fgKey, string bgKey, string? glyph = null, string? tooltip = null)
    {
        var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
        if (glyph is not null) sp.Children.Add(Icon(glyph, 10, Brush(fgKey)));
        if (text.Length > 0) sp.Children.Add(new TextBlock { Text = text, FontSize = 11, FontWeight = FontWeights.SemiBold, Foreground = Brush(fgKey) });
        var b = new Border
        {
            Child = sp, Background = Brush(bgKey), CornerRadius = new CornerRadius(4), Padding = new Thickness(6, 2, 6, 2),
            VerticalAlignment = VerticalAlignment.Center,
        };
        if (tooltip is not null) ToolTipService.SetToolTip(b, tooltip);
        return b;
    }

    /// <summary>The district's student-information warning.</summary>
    public static InfoBar StudentInfo(string message) => new()
    {
        Title = "Student information", Message = message, Severity = InfoBarSeverity.Warning, IsOpen = true, IsClosable = false,
    };

    public static TextBlock Label(string text) => new() { Text = text, FontSize = 12, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 14, 0, 4) };
}
