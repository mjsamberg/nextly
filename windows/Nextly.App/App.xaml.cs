using Microsoft.UI.Xaml;

namespace Nextly.App;

public partial class App : Application
{
    Window? window;

    public App()
    {
        InitializeComponent();
        // Follows Windows' light or dark mode; NEXTLY_THEME=light|dark forces one (for checking both).
        var theme = Environment.GetEnvironmentVariable("NEXTLY_THEME");
        if (theme is "light") RequestedTheme = ApplicationTheme.Light;
        else if (theme is "dark") RequestedTheme = ApplicationTheme.Dark;
        UnhandledException += (_, e) => Debug.Log($"UNHANDLED: {e.Exception}");
        if (Environment.GetEnvironmentVariable("NEXTLY_DEBUG_LOG") is { Length: > 0 })
            AppDomain.CurrentDomain.FirstChanceException += (_, e) => Debug.Log($"first chance: {e.Exception.GetType().Name}: {e.Exception.Message}\n{e.Exception.StackTrace}");
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        window = new MainWindow();
        window.Activate();
    }
}
