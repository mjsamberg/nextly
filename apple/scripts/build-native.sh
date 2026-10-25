#!/usr/bin/env bash
# Builds the native app (apple/project.yml) for release, with its widget and
# Siri extensions. CI runs it; see docs/apple-signing.md for the secrets.
#
#   build-native.sh mac   Developer ID signed, notarized and stapled: apple/build/native/Nextly-Native-mac.zip
#                         Needs APPLE_SIGNING_IDENTITY (in the keychain, from import-cert.sh),
#                         APPLE_DEVELOPMENT_TEAM, APPLE_ID, APPLE_PASSWORD (app-specific).
#   build-native.sh ios   Signed IPA: apple/build/native/ios/*.ipa
#                         Needs APPLE_DEVELOPMENT_TEAM and the App Store Connect API key:
#                         APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH (the .p8 file).
#                         EXPORT_METHOD: debugging (default), release-testing or app-store-connect.
#
# Versions are the date-based ones from scripts/set-version.mjs: CI sets
# NEXTLY_VERSION and NEXTLY_BUILD; run by hand, it asks the script.
set -euo pipefail

mode="${1:?mac or ios}"
here="$(cd "$(dirname "$0")" && pwd)"
apple_dir="$(cd "$here/.." && pwd)"
out="$apple_dir/build/native"
mkdir -p "$out"

if [ -z "${NEXTLY_VERSION:-}" ] || [ -z "${NEXTLY_BUILD:-}" ]; then
  v="$(node "$apple_dir/../scripts/set-version.mjs" --print)"
  NEXTLY_VERSION="$(node -p "JSON.parse(process.argv[1]).version" "$v")"
  NEXTLY_BUILD="$(node -p "JSON.parse(process.argv[1]).build" "$v")"
fi
version="$NEXTLY_VERSION"
build="$NEXTLY_BUILD"
: "${APPLE_DEVELOPMENT_TEAM:?set APPLE_DEVELOPMENT_TEAM}"

(cd "$apple_dir" && xcodegen generate --spec project.yml)
project="$apple_dir/NextlyNative.xcodeproj"
versions=(MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build")

if [ "$mode" = "mac" ]; then
  : "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY}"
  : "${APPLE_ID:?set APPLE_ID}"
  : "${APPLE_PASSWORD:?set APPLE_PASSWORD}"
  archive="$out/Nextly-mac.xcarchive"
  # Developer ID needs no provisioning profile: the App Group is the
  # team-prefixed one (NEXTLY_ENTITLEMENTS=signed). CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO
  # keeps get-task-allow (debugger access) out, which notarization rejects.
  xcodebuild -project "$project" -scheme Nextly -configuration Release \
    -destination 'generic/platform=macOS' -archivePath "$archive" \
    CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$APPLE_SIGNING_IDENTITY" DEVELOPMENT_TEAM="$APPLE_DEVELOPMENT_TEAM" \
    NEXTLY_ENTITLEMENTS=signed CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO OTHER_CODE_SIGN_FLAGS="--timestamp" \
    "${versions[@]}" archive

  app="$archive/Products/Applications/Nextly.app"
  codesign --verify --deep --strict --verbose=2 "$app"
  for bundle in "$app" "$app/Contents/PlugIns/NextlyWidgets.appex" "$app/Contents/Extensions/NextlyIntents.appex"; do
    # Catch these here instead of after a slow notarization round trip.
    ents="$(codesign -d --entitlements - --xml "$bundle" 2>/dev/null)"
    if grep -q 'get-task-allow' <<<"$ents"; then
      echo "::error::$(basename "$bundle") has the get-task-allow entitlement, which notarization rejects."; exit 1
    fi
    if ! grep -q "$APPLE_DEVELOPMENT_TEAM.com.mjsamberg.nextly.native" <<<"$ents"; then
      echo "::error::$(basename "$bundle") is missing the App Group the widgets and Siri share."; exit 1
    fi
  done

  zip="$out/Nextly-Native-mac.zip"
  ditto -c -k --keepParent "$app" "$zip"
  xcrun notarytool submit "$zip" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_DEVELOPMENT_TEAM" --wait
  xcrun stapler staple "$app"
  rm "$zip" && ditto -c -k --keepParent "$app" "$zip"
  echo "Signed, notarized Mac app: $zip"

elif [ "$mode" = "ios" ]; then
  : "${APPLE_API_KEY:?set APPLE_API_KEY}"
  : "${APPLE_API_ISSUER:?set APPLE_API_ISSUER}"
  : "${APPLE_API_KEY_PATH:?set APPLE_API_KEY_PATH}"
  method="${EXPORT_METHOD:-debugging}"
  archive="$out/Nextly-ios.xcarchive"
  # Automatic signing through the API key lets Xcode register the app's
  # identifiers and App Group and make the profiles it needs, as the Tauri
  # iOS build does for its own.
  auth=(-allowProvisioningUpdates -authenticationKeyPath "$APPLE_API_KEY_PATH"
        -authenticationKeyID "$APPLE_API_KEY" -authenticationKeyIssuerID "$APPLE_API_ISSUER")
  xcodebuild -project "$project" -scheme Nextly -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$archive" \
    CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$APPLE_DEVELOPMENT_TEAM" \
    "${versions[@]}" "${auth[@]}" archive

  cat > "$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>$method</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$APPLE_DEVELOPMENT_TEAM</string>
</dict>
</plist>
PLIST
  xcodebuild -exportArchive -archivePath "$archive" -exportPath "$out/ios" -exportOptionsPlist "$out/ExportOptions.plist" "${auth[@]}"
  ls "$out/ios"/*.ipa
else
  echo "Usage: build-native.sh mac|ios" >&2
  exit 2
fi
