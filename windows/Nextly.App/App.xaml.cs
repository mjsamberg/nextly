using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace Nextly.App;

public partial class App : Application
{
    MainWindow? window;

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
        Links.AutoRegister();
        window = new MainWindow();
        window.Activate();
        // A nextly:// link that started the app, and any that later launches hand over.
        HandleActivation(AppInstance.GetCurrent().GetActivatedEventArgs());
        AppInstance.GetCurrent().Activated += (_, e) => window.DispatcherQueue.TryEnqueue(() =>
        {
            window.BringToFront();
            HandleActivation(e);
        });
    }

    void HandleActivation(AppActivationArguments e)
    {
        var arguments = e.Data switch
        {
            Windows.ApplicationModel.Activation.ILaunchActivatedEventArgs l => l.Arguments,
            Windows.ApplicationModel.Activation.IProtocolActivatedEventArgs p => p.Uri.ToString(),
            _ => null,
        };
        if (Links.FromArguments(arguments) is { } link) window?.HandleLink(link);
    }
}
