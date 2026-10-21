// The app is all frontend; Rust only hosts the webview and the plugins.
// Sync goes through tauri-plugin-http and live updates through
// tauri-plugin-websocket, so requests come from Rust. That avoids CORS and
// mixed-content rules in the webview and lets the app send custom headers,
// such as the Cloudflare Access service token, on both.
//
// nextly:// links (from the Gmail bookmarklet) arrive through
// tauri-plugin-deep-link; the frontend turns them into tasks (capture.ts).
// apple.rs shares settings and lists with the widget and Siri extensions.

mod apple;

#[cfg(desktop)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Must be registered first. A second launch (for example Windows opening a
    // nextly:// link) hands its link to this copy and brings the window forward.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_websocket::init())
        .invoke_handler(tauri::generate_handler![apple::apple_share, apple::apple_take_pending])
        .run(tauri::generate_context!())
        .expect("error while running Nextly");
}
