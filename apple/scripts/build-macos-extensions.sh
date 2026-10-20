#!/usr/bin/env bash
# Builds the macOS widget and Siri extensions.
#
#   build-macos-extensions.sh check   compile only, unsigned (CI check)
#   build-macos-extensions.sh sign    Developer ID signed, ready to embed
#
# "sign" needs APPLE_SIGNING_IDENTITY (a "Developer ID Application: …"
# identity in the keychain) and APPLE_DEVELOPMENT_TEAM. It writes
# app/src-tauri/tauri.macos-extensions.json, a config overlay that copies the
# extensions into Nextly.app and gives the app the shared App Group:
#
#   npx tauri build --config src-tauri/tauri.macos-extensions.json
set -euo pipefail

mode="${1:-check}"
here="$(cd "$(dirname "$0")" && pwd)"
apple_dir="$(cd "$here/.." && pwd)"
app_dir="$(cd "$apple_dir/../app" && pwd)"
out="$apple_dir/build/macos"

export NEXTLY_VERSION="$(node -p "require('$app_dir/src-tauri/tauri.conf.json').version")"
export APPLE_DEVELOPMENT_TEAM="${APPLE_DEVELOPMENT_TEAM:-}"
# Developer ID apps must use a Team ID prefixed App Group on macOS.
export NEXTLY_APP_GROUP="${NEXTLY_APP_GROUP:-${APPLE_DEVELOPMENT_TEAM:-UNSIGNED}.com.mjsamberg.nextly}"

(cd "$apple_dir" && xcodegen generate --spec macos.yml)

common=(-project "$apple_dir/NextlyMac.xcodeproj" -target NextlyWidgets -target NextlyIntents
        -configuration Release SYMROOT="$out/products" ONLY_ACTIVE_ARCH=NO)

if [ "$mode" = "check" ]; then
  xcodebuild "${common[@]}" CODE_SIGNING_ALLOWED=NO build
  echo "macOS extensions compile."
  exit 0
fi

: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY}"
: "${APPLE_DEVELOPMENT_TEAM:?set APPLE_DEVELOPMENT_TEAM}"

# CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO keeps Xcode from adding
# com.apple.security.get-task-allow (debugger access), which notarization rejects.
xcodebuild "${common[@]}" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$APPLE_SIGNING_IDENTITY" DEVELOPMENT_TEAM="$APPLE_DEVELOPMENT_TEAM" \
  CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO OTHER_CODE_SIGN_FLAGS="--timestamp" build

products="$out/products/Release"
for ext in NextlyWidgets NextlyIntents; do
  codesign --verify --strict --verbose=2 "$products/$ext.appex"
  # Catch it here instead of after a slow notarization round trip.
  if codesign -d --entitlements - --xml "$products/$ext.appex" 2>/dev/null | grep -q 'get-task-allow'; then
    echo "$ext.appex still has the get-task-allow entitlement, which notarization rejects." >&2
    exit 1
  fi
done

# The app's own entitlements: just the App Group it shares with the extensions.
cat > "$app_dir/src-tauri/entitlements.macos.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array><string>$NEXTLY_APP_GROUP</string></array>
</dict>
</plist>
PLIST

# Tauri signs the app itself without --deep, so these keep their own signatures.
cat > "$app_dir/src-tauri/tauri.macos-extensions.json" <<JSON
{
  "bundle": {
    "macOS": {
      "entitlements": "entitlements.macos.plist",
      "files": {
        "PlugIns/NextlyWidgets.appex": "../../apple/build/macos/products/Release/NextlyWidgets.appex",
        "Extensions/NextlyIntents.appex": "../../apple/build/macos/products/Release/NextlyIntents.appex"
      }
    }
  }
}
JSON
echo "Signed extensions ready. App Group: $NEXTLY_APP_GROUP"
