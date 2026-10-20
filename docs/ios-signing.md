# Building the iPhone app on GitHub

The `ios` job in `.github/workflows/build.yml` is skipped until these four
repository secrets exist. Add them under **Settings → Secrets and variables →
Actions → New repository secret**.

| Secret | What it is |
| --- | --- |
| `APPLE_DEVELOPMENT_TEAM` | Your 10-character Team ID, from developer.apple.com → Membership details. |
| `IOS_CERTIFICATE` | Your Apple Development (or Distribution) certificate exported from Keychain Access as a `.p12`, then base64-encoded. |
| `IOS_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12`. |
| `IOS_MOBILE_PROVISION` | A provisioning profile for the bundle ID `com.mjsamberg.nextly`, base64-encoded. |
| `IOS_EXPORT_METHOD` (optional) | `debugging` (default, for a development profile), `release-testing` (ad hoc), or `app-store-connect` (TestFlight). |

## Steps (needs a paid Apple Developer account, $99/year)

1. At developer.apple.com → Certificates, IDs & Profiles:
   - **Identifiers**: register the App ID `com.mjsamberg.nextly`.
   - **Devices**: add your iPhone's UDID (Finder shows it when the phone is plugged in; click the line under the phone's name).
   - **Profiles**: create an **iOS App Development** profile for that App ID, your certificate and your iPhone. Download it.
2. On a Mac, export the certificate: Keychain Access → My Certificates → right-click
   "Apple Development: …" → Export → `.p12`, with a password.
3. Encode both files and paste each result into its secret:

   ```bash
   base64 -i Certificates.p12 | pbcopy        # IOS_CERTIFICATE
   base64 -i Nextly_Development.mobileprovision | pbcopy   # IOS_MOBILE_PROVISION
   ```

4. Push to `main` (or re-run the workflow). The **nextly-ios** artifact contains the `.ipa`.
5. Install it: plug in the iPhone, open Xcode → Window → Devices and Simulators,
   select the phone and drag the `.ipa` onto **Installed Apps**. Or use Apple
   Configurator. With `app-store-connect`, upload to TestFlight instead.

Development-signed builds stop launching when the provisioning profile expires
(one year). Rebuild after renewing it.

## Building on a Mac instead

```bash
cd app
npm ci
npx tauri ios init
npx tauri ios dev      # runs in the simulator or a connected phone
```
