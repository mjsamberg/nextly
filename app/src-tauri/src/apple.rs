// Shares data with the widget and Siri extensions (apple/) through the App
// Group container, a folder the app and its extensions can all read:
//
//   config.json    server address, sync token and extra headers, so the
//                  extensions can talk to the sync server themselves
//   snapshot.json  Today and Next as of the app's last change, shown by the
//                  widget when the server can't be reached
//   pending.json   tasks Siri added while offline; the app imports them
//
// On other platforms these commands do nothing.

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use objc2_foundation::{NSFileManager, NSString};
    use std::path::PathBuf;

    // iOS uses "group.<bundle id>". Developer ID builds for macOS must prefix
    // the Team ID instead; CI sets NEXTLY_APP_GROUP for those.
    const APP_GROUP: &str = match option_env!("NEXTLY_APP_GROUP") {
        Some(g) => g,
        None => "group.com.mjsamberg.nextly",
    };

    pub fn group_dir() -> Option<PathBuf> {
        let id = NSString::from_str(APP_GROUP);
        let url = NSFileManager::defaultManager().containerURLForSecurityApplicationGroupIdentifier(&id)?;
        let dir = PathBuf::from(url.path()?.to_string());
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod imp {
    pub fn group_dir() -> Option<std::path::PathBuf> {
        None
    }
}

fn write_atomic(dir: &std::path::Path, name: &str, contents: &str) -> Result<(), String> {
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(name)).map_err(|e| e.to_string())
}

/// Saves the sync settings and list snapshot for the extensions.
#[tauri::command]
pub fn apple_share(config: String, snapshot: String) -> Result<bool, String> {
    let Some(dir) = imp::group_dir() else { return Ok(false) };
    write_atomic(&dir, "config.json", &config)?;
    write_atomic(&dir, "snapshot.json", &snapshot)?;
    Ok(true)
}

/// Returns tasks Siri saved while offline (a JSON array) and clears them.
#[tauri::command]
pub fn apple_take_pending() -> Result<String, String> {
    let Some(dir) = imp::group_dir() else { return Ok("[]".into()) };
    let path = dir.join("pending.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            Ok(s)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("[]".into()),
        Err(e) => Err(e.to_string()),
    }
}
