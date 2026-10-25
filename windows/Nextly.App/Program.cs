// The app's entry point, replacing the one WinUI generates, so there's one
// copy at a time: a second launch (say, Windows opening a nextly:// link)
// hands its activation to the copy already running and quits.

using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace Nextly.App;

public static partial class Program
{
    [STAThread]
    static int Main()
    {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        var main = AppInstance.FindOrRegisterForKey("Nextly-main");
        if (!main.IsCurrent)
        {
            Redirect(main, AppInstance.GetCurrent().GetActivatedEventArgs());
            return 0;
        }
        Application.Start((p) =>
        {
            SynchronizationContext.SetSynchronizationContext(new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread()));
            _ = new App();
        });
        return 0;
    }

    /// <summary>
    /// Hands this launch to the running copy. Waits without blocking COM on this
    /// (STA) thread, as the Windows App SDK's single-instance sample does.
    /// </summary>
    static void Redirect(AppInstance target, AppActivationArguments args)
    {
        var done = CreateEvent(IntPtr.Zero, true, false, null);
        Task.Run(() =>
        {
            try { target.RedirectActivationToAsync(args).AsTask().Wait(); }
            finally { SetEvent(done); }
        });
        _ = CoWaitForMultipleObjects(0, 0xFFFFFFFF, 1, [done], out _);
        CloseHandle(done);
    }

    [LibraryImport("kernel32.dll", EntryPoint = "CreateEventW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial IntPtr CreateEvent(IntPtr attributes, [MarshalAs(UnmanagedType.Bool)] bool manualReset, [MarshalAs(UnmanagedType.Bool)] bool initialState, string? name);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetEvent(IntPtr handle);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseHandle(IntPtr handle);

    [LibraryImport("ole32.dll")]
    private static partial uint CoWaitForMultipleObjects(uint flags, uint timeout, uint count, [In] IntPtr[] handles, out uint index);
}
