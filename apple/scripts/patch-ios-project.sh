#!/usr/bin/env bash
# Adds the widget and Siri extensions to the Xcode project that
# `tauri ios init` generates, embeds them in the app, and gives the app the
# App Group they share. Run after `tauri ios init`, from anywhere.
# Needs xcodegen and yq (brew install xcodegen yq).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
apple_dir="$(cd "$here/.." && pwd)"
app_dir="$(cd "$apple_dir/../app" && pwd)"
gen="$app_dir/src-tauri/gen/apple"
spec="$gen/project.yml"
group="group.com.mjsamberg.nextly"

[ -f "$spec" ] || { echo "No $spec. Run 'npx tauri ios init' in app/ first." >&2; exit 1; }

target="$(yq '.targets | keys | .[] | select(test("_iOS$"))' "$spec")"
[ -n "$target" ] || { echo "Couldn't find the *_iOS app target in $spec." >&2; exit 1; }
echo "App target: $target"

include="$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$apple_dir/ios-extensions.yml" "$gen")"
yq -i ".include = ((.include // []) + [\"$include\"] | unique)" "$spec"
yq -i ".targets.\"$target\".dependencies = ((.targets.\"$target\".dependencies // []) + [{\"target\": \"NextlyWidgets\"}, {\"target\": \"NextlyIntents\"}] | unique_by(.target // .framework // .sdk))" "$spec"

entitlements="$gen/$target/$target.entitlements"
if [ ! -f "$entitlements" ]; then
  mkdir -p "$(dirname "$entitlements")"
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict/></plist>\n' > "$entitlements"
fi
/usr/libexec/PlistBuddy -c "Delete :com.apple.security.application-groups" "$entitlements" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :com.apple.security.application-groups array" -c "Add :com.apple.security.application-groups:0 string $group" "$entitlements"

# `tauri icon` writes iPhone icons into the Xcode project only if it already
# exists; on a fresh `tauri ios init` the project starts with Tauri's default
# icon. Regenerate now. iOS rounds icons itself and shows transparency as
# black, so fill the background with the tile's plum.
(cd "$app_dir" && npx tauri icon icon.svg --ios-color "#7a3c59" >/dev/null)

export NEXTLY_VERSION="$(node -p "require('$app_dir/src-tauri/tauri.conf.json').version")"
export APPLE_DEVELOPMENT_TEAM="${APPLE_DEVELOPMENT_TEAM:-}"
(cd "$gen" && xcodegen generate --spec project.yml)
echo "Added NextlyWidgets and NextlyIntents to $target (version $NEXTLY_VERSION)."
