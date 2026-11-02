# Signing the Mac and iPhone apps

GitHub Actions builds the native app (`apple/project.yml`) on every push. On
its own that's an unsigned build, as a check. Signed builds, the only ones an
iPhone installs and the only Mac build that loads the widget and Siri, need
the secrets below and the `NATIVE_SIGNING` variable (step 4).

Everything below needs a paid Apple Developer account ($99/year). Add each
secret under **Settings → Secrets and variables → Actions → New repository secret**.

The app installs as **Nextly Native** (`com.mjsamberg.nextly.native`). The
retired Tauri app used `com.mjsamberg.nextly`; its build is on the `tauri`
branch.

## 1. Register the identifiers (once)

At developer.apple.com → **Certificates, IDs & Profiles**:

1. **Identifiers → App Groups**: register `group.com.mjsamberg.nextly.native` (iPhone).
2. **Identifiers → App IDs**: register these three, and turn on **App Groups**
   for each, choosing the group above:
   - `com.mjsamberg.nextly.native` (the app)
   - `com.mjsamberg.nextly.native.widgets` (widget)
   - `com.mjsamberg.nextly.native.intents` (Siri)
3. **Devices**: add your iPhone's UDID (Finder shows it when the phone is
   plugged in; click the line under the phone's name).

Your **Team ID** is on the Membership page. Save it as the secret
`APPLE_DEVELOPMENT_TEAM`.

## 2. iPhone app

The iPhone build signs the app and both extensions automatically using an
App Store Connect API key, which lets Xcode create the provisioning profiles
itself.

1. appstoreconnect.apple.com → **Users and Access → Integrations → App Store
   Connect API → Team Keys → +**. Give it the **Admin** role (needed for
   automatic signing). Download the `.p8` file; it can only be downloaded once.
2. Add these secrets:

| Secret | Value |
| --- | --- |
| `APPLE_API_KEY` | The key's **Key ID** |
| `APPLE_API_ISSUER` | The **Issuer ID** shown above the keys list |
| `APPLE_API_KEY_P8` | The full contents of the `.p8` file, including the BEGIN/END lines |
| `IOS_EXPORT_METHOD` (optional) | `debugging` (default, installs on your registered iPhone), `release-testing` (ad hoc), or `app-store-connect` (TestFlight) |

3. Give CI one signing certificate to reuse. Each build runs on a fresh Mac
   with an empty keychain; without a certificate there, Xcode makes Apple a
   new one every time until the account reaches its limit ("Your account has
   reached the maximum number of certificates").
   - On your Mac, Xcode → Settings → Accounts → your team → **Manage
     Certificates** → **+** → **Apple Development** (skip this if one is
     already listed with no "missing private key" note). For
     `release-testing` or `app-store-connect`, add **Apple Distribution** too.
   - Keychain Access → **My Certificates** → select "Apple Development: …"
     (and "Apple Distribution: …" if you made one) → right-click →
     **Export** as `.p12` with a password.
   - Add the secrets `IOS_CERTIFICATE` (`base64 -i Certificates.p12 | pbcopy`,
     then paste) and `IOS_CERTIFICATE_PASSWORD`.

   **If the limit was already reached:** developer.apple.com → Certificates,
   revoke the extra Apple Development certificates that CI made (their
   private keys were thrown away with the build machines, so they're
   useless). Keep the one you export above. If the app on your iPhone was
   signed with one you revoke, it may stop opening: install the next build.

**Install it:** plug in the iPhone, open Xcode → Window → Devices and
Simulators, select the phone and drag the `.ipa` onto **Installed Apps**. With
`app-store-connect`, upload to TestFlight instead.

## 3. Mac app

The Mac app is signed with a **Developer ID Application** certificate and
notarized, so it opens without warnings and can load the widget and Siri.

1. developer.apple.com → **Certificates → +** → **Developer ID Application**.
   Create it from a Mac (Keychain Access → Certificate Assistant → Request a
   Certificate From a Certificate Authority), download it and double-click to
   add it to your keychain.
2. Keychain Access → **My Certificates** → right-click
   "Developer ID Application: …" → **Export** as `.p12` with a password.
3. Create an app-specific password at appleid.apple.com → Sign-In and Security
   → App-Specific Passwords (for notarization).
4. Add these secrets:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | `base64 -i Certificates.p12 \| pbcopy`, then paste |
| `APPLE_CERTIFICATE_PASSWORD` | The `.p12` password |
| `APPLE_SIGNING_IDENTITY` | The certificate's full name, for example `Developer ID Application: Your Name (TEAMID1234)` |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_PASSWORD` | The app-specific password |

On the Mac the shared App Group is `<TEAMID>.com.mjsamberg.nextly.native`.
Developer ID apps must use the Team ID prefix; the build sets it, and it
needs no registration.

## 4. Turn on the signed builds

**Settings → Secrets and variables → Actions → Variables → New repository
variable**, `NATIVE_SIGNING` = `true`. Then each push also produces:

- `nextly-native-macos`: a signed, notarized `Nextly.app` (zip). Its widgets
  appear in the widget gallery once the app has been opened.
- `nextly-native-ios`: an IPA, exported with `IOS_EXPORT_METHOD`.

## After installing

- **Widget**: long-press the Home Screen (or right-click the Mac desktop) →
  **Edit Widgets** → search "Nextly". There's a Today and a Next widget in
  three sizes, plus Lock Screen sizes on iPhone. Tap a circle to finish a task.
- **Siri**: open Nextly once and set up sync in Settings, so the extensions
  can reach your server. Then try "Add a task in Nextly" or "What's on my
  Today list in Nextly". The same actions are in the Shortcuts app.
- **Not working?** The widget says "Open Nextly and set up sync" until the app
  has shared its sync settings. Open the app, check Settings → Check connection,
  then remove and re-add the widget.

## Building on a Mac yourself

`brew install xcodegen`, then `cd apple && xcodegen generate --spec
project.yml`, open `NextlyNative.xcodeproj`, choose your team under Signing &
Capabilities for all three targets, and set `NEXTLY_ENTITLEMENTS` to `signed`
so the Mac build gets its App Group. Without a team the Mac app still runs,
but its widgets can't see its settings. `cd apple/NextlyKit && swift test`
runs the shared cases and the sync tests.
