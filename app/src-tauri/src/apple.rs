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

    /// The shared folder, or a description of which step failed (shown in Settings).
    pub fn group_dir() -> Result<Option<PathBuf>, String> {
        let id = NSString::from_str(APP_GROUP);
        let url = NSFileManager::defaultManager()
            .containerURLForSecurityApplicationGroupIdentifier(&id)
            .ok_or_else(|| format!(
                "iOS returned no folder for App Group “{APP_GROUP}”. The app must be signed with this group and its provisioning profile must allow it."
            ))?;
        let path = url
            .path()
            .ok_or_else(|| format!("The App Group “{APP_GROUP}” folder has no file path."))?;
        let dir = PathBuf::from(path.to_string());
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Couldn’t open the App Group “{APP_GROUP}” folder: {e}"))?;
        Ok(Some(dir))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod imp {
    pub fn group_dir() -> Result<Option<std::path::PathBuf>, String> {
        Ok(None)
    }
}

fn write_atomic(dir: &std::path::Path, name: &str, contents: &str) -> Result<(), String> {
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, contents).map_err(|e| format!("Couldn’t write {name} to the App Group folder: {e}"))?;
    std::fs::rename(&tmp, dir.join(name)).map_err(|e| format!("Couldn’t save {name} in the App Group folder: {e}"))
}

/// Saves the sync settings and list snapshot for the extensions.
/// Ok(false) on platforms without App Groups; Err explains what failed.
#[tauri::command]
pub fn apple_share(config: String, snapshot: String) -> Result<bool, String> {
    let Some(dir) = imp::group_dir()? else { return Ok(false) };
    write_atomic(&dir, "config.json", &config)?;
    write_atomic(&dir, "snapshot.json", &snapshot)?;
    Ok(true)
}

/// Returns tasks Siri saved while offline (a JSON array) and clears them.
#[tauri::command]
pub fn apple_take_pending() -> Result<String, String> {
    let Some(dir) = imp::group_dir()? else { return Ok("[]".into()) };
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
