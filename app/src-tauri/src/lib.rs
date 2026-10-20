// The app is all frontend; Rust only hosts the webview and the plugins.
// Sync goes through tauri-plugin-http and live updates through
// tauri-plugin-websocket, so requests come from Rust. That avoids CORS and
// mixed-content rules in the webview and lets the app send custom headers,
// such as the Cloudflare Access service token, on both.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_websocket::init())
        .run(tauri::generate_context!())
        .expect("error while running Nextly");
}
