#!/usr/bin/env bash
# CI: imports the iPhone signing certificate (.p12) into a temporary keychain
# before build-native.sh ios. Without one, automatic signing makes Apple a new
# certificate on every run (each runner starts with an empty keychain) until
# the account hits Apple's limit. With one, Xcode reuses it and only makes
# provisioning profiles. As in import-cert.sh, messages never include anything
# from the certificate itself or the secrets.
#
# Needs IOS_CERTIFICATE (base64 of the .p12) and IOS_CERTIFICATE_PASSWORD.
# The .p12 holds an Apple Development identity (EXPORT_METHOD debugging), an
# Apple Distribution one (release-testing, app-store-connect), or both.
set -uo pipefail

fail() { echo "::error title=$1::$2"; exit 1; }

[ -n "${IOS_CERTIFICATE:-}" ] || fail "IOS_CERTIFICATE is empty" \
  "Without it, every build makes Apple a new certificate until the account's limit. Add it as described in docs/apple-signing.md (step 2)."

dir="${RUNNER_TEMP:-$(mktemp -d)}"
p12="$dir/ios-signing.p12"
printf '%s' "$IOS_CERTIFICATE" | tr -d '\r\n\t ' | base64 --decode > "$p12" 2>/dev/null
[ -s "$p12" ] || fail "IOS_CERTIFICATE isn't valid base64" "On a Mac run: base64 -i Certificates.p12 | pbcopy, then paste the whole output as the secret."

export P12_PASS="${IOS_CERTIFICATE_PASSWORD:-}"
pk() { openssl pkcs12 -in "$p12" -passin env:P12_PASS "$@" 2>/dev/null || openssl pkcs12 -legacy -in "$p12" -passin env:P12_PASS "$@" 2>/dev/null; }
pk -noout || fail "IOS_CERTIFICATE can't be opened" "Check that it's a .p12 exported from Keychain Access and that IOS_CERTIFICATE_PASSWORD is its password."
pk -nocerts -nodes | grep -q 'PRIVATE KEY' || fail "The .p12 has no private key" \
  "Export it from Keychain Access → My Certificates (not Certificates), so the key is included."

keychain="$dir/ios-signing.keychain-db"
kc_pass="$(openssl rand -hex 16)"
security create-keychain -p "$kc_pass" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$kc_pass" "$keychain"
import() { security import "$1" -k "$keychain" -P "$P12_PASS" -A -f pkcs12 >/dev/null 2>&1; }
ios_identities() { security find-identity -p codesigning "$keychain" | grep -cE '"(Apple Development|Apple Distribution|iPhone Developer|iPhone Distribution): ' || true; }

import "$p12" || fail "macOS couldn't import the .p12" "Re-export it from Keychain Access and update IOS_CERTIFICATE."
if [ "$(ios_identities)" -eq 0 ]; then
  # Some .p12 encryptions (OpenSSL 3's default AES) import without the key; re-pack and retry.
  repacked="$dir/ios-repacked.p12"
  pk -nodes | openssl pkcs12 -export -out "$repacked" -passout env:P12_PASS -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES 2>/dev/null || true
  [ -s "$repacked" ] && import "$repacked"
  rm -f "$repacked"
fi
[ "$(ios_identities)" -gt 0 ] || fail "No iPhone signing identity in the .p12" \
  "It needs an Apple Development certificate (or Apple Distribution, for release-testing or app-store-connect) with its private key."
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kc_pass" "$keychain" >/dev/null

# Apple's intermediate certificate, so the identity is trusted.
if curl -fsSL "https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer" -o "$dir/AppleWWDRCAG3.cer"; then
  security import "$dir/AppleWWDRCAG3.cer" -k "$keychain" >/dev/null 2>&1 || true
else
  echo "::warning title=Couldn't download Apple's WWDR G3 certificate::Signing may fail if this machine doesn't already have it."
fi
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
rm -f "$p12"
echo "::notice title=iPhone certificate::$(ios_identities) signing identity(ies) imported."
