#!/usr/bin/env bash
# CI: imports the Developer ID certificate (.p12) into a temporary keychain,
# checking each thing that commonly goes wrong and saying which one it is.
# The repository is public, so messages never include anything from the
# certificate itself (names, Team ID) or the secrets.
#
# Needs APPLE_CERTIFICATE (base64 of the .p12), APPLE_CERTIFICATE_PASSWORD,
# APPLE_SIGNING_IDENTITY.
set -uo pipefail

fail() { echo "::error title=$1::$2"; exit 1; }

[ -n "${APPLE_CERTIFICATE:-}" ] || fail "APPLE_CERTIFICATE is empty" "Add the secret as described in docs/apple-signing.md."
[ -n "${APPLE_SIGNING_IDENTITY:-}" ] || fail "APPLE_SIGNING_IDENTITY is empty" "Add the certificate's full name, for example: Developer ID Application: Your Name (TEAMID1234)."

dir="${RUNNER_TEMP:-$(mktemp -d)}"
p12="$dir/developer-id.p12"
printf '%s' "$APPLE_CERTIFICATE" | tr -d '\r\n\t ' | base64 --decode > "$p12" 2>/dev/null
[ -s "$p12" ] || fail "APPLE_CERTIFICATE isn't valid base64" "On a Mac run: base64 -i Certificates.p12 | pbcopy, then paste the whole output as the secret."

if head -c 64 "$p12" | grep -q -- '-----BEGIN'; then
  fail "APPLE_CERTIFICATE is a text certificate, not a .p12" "Export from Keychain Access as Personal Information Exchange (.p12), then base64 that file."
fi

export P12_PASS="${APPLE_CERTIFICATE_PASSWORD:-}"
pk() { openssl pkcs12 -in "$p12" -passin env:P12_PASS "$@" 2>/dev/null || openssl pkcs12 -legacy -in "$p12" -passin env:P12_PASS "$@" 2>/dev/null; }

if ! pk -noout; then
  if openssl x509 -inform DER -in "$p12" -noout 2>/dev/null; then
    fail "APPLE_CERTIFICATE is the .cer, not a .p12" "The .cer from Apple's website has no private key. Install it, then export it from Keychain Access → My Certificates as .p12 and base64 that."
  fi
  if [ "$(head -c 1 "$p12" | od -An -tx1 | tr -d ' ')" != "30" ]; then
    fail "APPLE_CERTIFICATE isn't a .p12 file" "It decoded, but not to a certificate bundle. Base64 the .p12 you exported from Keychain Access (not the .cer you downloaded)."
  fi
  fail "The .p12 password doesn't match" "APPLE_CERTIFICATE_PASSWORD must be the password you typed when exporting the .p12."
fi

pk -nocerts -nodes | grep -q 'PRIVATE KEY' || fail "The .p12 has no private key" \
  "Export it from Keychain Access → My Certificates (not Certificates), so the key is included. The .cer from Apple's website has no key."

# The key must belong to the certificate (compare public key fingerprints;
# only "match" or "no match" is ever printed).
cert_pub="$(pk -nokeys -clcerts | openssl x509 -noout -pubkey 2>/dev/null | openssl sha256 2>/dev/null)"
key_pub="$(pk -nocerts -nodes | openssl pkey -pubout 2>/dev/null | openssl sha256 2>/dev/null)"
if [ -n "$cert_pub" ] && [ -n "$key_pub" ] && [ "$cert_pub" != "$key_pub" ]; then
  fail "The private key doesn't belong to the certificate" \
    "The .p12 has a key and a Developer ID certificate, but not a matching pair. In Keychain Access → My Certificates, expand the Developer ID Application certificate, select it (its key comes along), and export that as .p12."
fi

subject="$(pk -nokeys -clcerts | openssl x509 -noout -subject 2>/dev/null)"
case "$subject" in
  *"Developer ID Application"*) ;;
  *"Apple Development"*|*"Apple Distribution"*|*"iPhone"*|*"Mac Developer"*|*"3rd Party Mac"*)
    fail "Wrong kind of certificate" "This is a development or App Store certificate. The Mac build needs a Developer ID Application certificate (see docs/apple-signing.md)." ;;
  *) fail "Wrong kind of certificate" "The .p12 doesn't contain a Developer ID Application certificate." ;;
esac

keychain="$dir/signing.keychain-db"
kc_pass="$(openssl rand -hex 16)"
security create-keychain -p "$kc_pass" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$kc_pass" "$keychain"
imported="$(security import "$p12" -k "$keychain" -P "$P12_PASS" -A -f pkcs12 2>&1)" \
  || fail "macOS couldn't import the .p12" "The file and password are fine, but the keychain refused it. Re-export it from Keychain Access and update APPLE_CERTIFICATE."
# Only counts, e.g. "1 identity imported." or "1 key imported. 1 certificate imported."
echo "security import: $(printf '%s' "$imported" | grep -Eo '[0-9]+ (identit(y|ies)|keys?|certificates?) imported' | tr '\n' ' ')"
if ! printf '%s' "$imported" | grep -Eq '[1-9][0-9]* (identit|key)'; then
  # macOS can't read some .p12 encryptions (e.g. OpenSSL 3's default AES).
  # Re-pack it with the widely supported legacy algorithms and try again.
  repacked="$dir/repacked.p12"
  pk -nodes | openssl pkcs12 -export -out "$repacked" -passout env:P12_PASS \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES 2>/dev/null \
    || pk -nodes | openssl pkcs12 -export -out "$repacked" -passout env:P12_PASS 2>/dev/null
  imported="$(security import "$repacked" -k "$keychain" -P "$P12_PASS" -A -f pkcs12 2>&1)" || true
  rm -f "$repacked"
  echo "security import (re-packed): $(printf '%s' "$imported" | grep -Eo '[0-9]+ (identit(y|ies)|keys?|certificates?) imported' | tr '\n' ' ')"
  printf '%s' "$imported" | grep -Eq '[1-9][0-9]* (identit|key)' \
    || fail "macOS imported the certificate but not its private key" \
      "Re-export from Keychain Access → My Certificates on a Mac (not with openssl), select the Developer ID Application certificate, and export as .p12."
fi
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kc_pass" "$keychain" >/dev/null

# Without Apple's Developer ID intermediate certificates the identity isn't
# trusted, so codesign and find-identity -v won't use it. CI machines don't
# always have them.
for ca in DeveloperIDG2CA DeveloperIDCA; do
  if curl -fsSL "https://www.apple.com/certificateauthority/$ca.cer" -o "$dir/$ca.cer"; then
    security import "$dir/$ca.cer" -k "$keychain" >/dev/null 2>&1 || true
  else
    echo "::warning title=Couldn't download Apple's $ca certificate::Signing may fail if this machine doesn't already have it."
  fi
done
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
rm -f "$p12"

# Pick the identity to sign with. Lines look like:  1) <SHA-1> "Developer ID Application: Name (TEAMID)"
identities="$(security find-identity -v -p codesigning "$keychain" | grep '"Developer ID Application: ')"
wanted="$(printf '%s' "$APPLE_SIGNING_IDENTITY" | tr -d '\r\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
line="$(printf '%s\n' "$identities" | grep -F "\"$wanted\"" | head -1)"
count="$(printf '%s\n' "$identities" | grep -c .)"
if [ "$count" -eq 0 ]; then
  untrusted="$(security find-identity -p codesigning "$keychain" | grep -c '"Developer ID Application: ' || true)"
  if [ "$untrusted" -gt 0 ]; then
    fail "The Developer ID certificate isn't trusted" \
      "It imported, but macOS doesn't consider it valid (expired, revoked, or missing Apple's intermediate certificate). Check it in Keychain Access; if it shows as expired or revoked, create a new Developer ID Application certificate."
  fi
  fail "No signing identity in the .p12" "The certificate imported but isn't usable for signing with its key. Re-export it from Keychain Access → My Certificates, with the private key."
fi
if [ -z "$line" ]; then
  if [ "$count" -eq 1 ]; then
    line="$identities"
    echo "::warning title=APPLE_SIGNING_IDENTITY doesn't exactly match::Signing with the one Developer ID certificate in the .p12. To silence this, set the secret to the exact name shown in Keychain Access."
  else
    fail "APPLE_SIGNING_IDENTITY doesn't match any of the certificates" \
      "The .p12 holds $count Developer ID certificates. Set the secret to the exact name of the one to use, as shown in Keychain Access."
  fi
fi
hash="$(printf '%s' "$line" | awk '{print $2}')"
team="$(printf '%s' "$line" | sed -E 's/.*\(([A-Z0-9]{10})\)"$/\1/')"

# The Mac App Group is "<Team ID>.com.mjsamberg.nextly", so these must agree.
if [ -n "${APPLE_DEVELOPMENT_TEAM:-}" ] && [ "$team" != "$(printf '%s' "$APPLE_DEVELOPMENT_TEAM" | tr -d '[:space:]')" ]; then
  fail "Team ID mismatch" "The certificate belongs to a different team than APPLE_DEVELOPMENT_TEAM. Use the Team ID from the certificate's name (the 10 characters in parentheses)."
fi

# Later steps sign with the certificate's SHA-1, which codesign accepts.
[ -n "${GITHUB_ENV:-}" ] && echo "NEXTLY_SIGNING_IDENTITY=$hash" >> "$GITHUB_ENV"
echo "Developer ID certificate imported."
