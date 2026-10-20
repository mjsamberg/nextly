# Signing the Mac and iPhone apps

GitHub Actions builds both apps on every push. Without signing secrets it
still compiles the widget and Siri extensions as a check, but:

- **iPhone**: no app is produced. iOS only installs signed apps.
- **Mac**: you get an unsigned app *without* the widget or Siri, because
  macOS only loads extensions from a properly signed app.

Everything below needs a paid Apple Developer account ($99/year). Add each
secret under **Settings → Secrets and variables → Actions → New repository secret**.

## 1. Register the identifiers (once)

At developer.apple.com → **Certificates, IDs & Profiles**:

1. **Identifiers → App Groups**: register `group.com.mjsamberg.nextly` (iPhone).
2. **Identifiers → App IDs**: register these three, and turn on **App Groups**
   for each, choosing the group above:
   - `com.mjsamberg.nextly` (the app)
   - `com.mjsamberg.nextly.widgets` (widget)
   - `com.mjsamberg.nextly.intents` (Siri)
3. **Devices**: add your iPhone's UDID (Finder shows it when the phone is
   plugged in; click the line under the phone's name).

Your **Team ID** is on the Membership page. Save it as the secret
`APPLE_DEVELOPMENT_TEAM`.

## 2. iPhone app

The iPhone build signs the app and both extensions automatically using an
App Store Connect API key, which lets Xcode create the three provisioning
profiles itself.

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

Push to `main` or re-run the workflow. The **nextly-ios** artifact has the `.ipa`.

**Install it:** plug in the iPhone, open Xcode → Window → Devices and
Simulators, select the phone and drag the `.ipa` onto **Installed Apps**. With
`app-store-connect`, upload to TestFlight instead.

The `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD` and `IOS_MOBILE_PROVISION`
secrets from the earlier setup aren't used anymore: a single provisioning
profile can't cover the two extensions.

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

On the Mac, the shared App Group is `<Team ID>.com.mjsamberg.nextly`;
Developer ID apps must use the Team ID prefix, and the build sets it for you.

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

```bash
cd app
npm ci
npx tauri ios init
bash ../apple/scripts/patch-ios-project.sh
npx tauri ios dev      # runs in the simulator or a connected phone
```
