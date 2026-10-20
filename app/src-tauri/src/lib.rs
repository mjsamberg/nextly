// The app is all frontend; Rust only hosts the webview and the two plugins.
// Sync goes through tauri-plugin-http so requests come from Rust, which avoids
// CORS and mixed-content rules in the webview and iOS App Transport Security
// when the sync server is plain http on the tailnet.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Nextly");
}
