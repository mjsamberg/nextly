# Nextly: notes for Claude

A Things-3-style task manager (Windows, macOS, iOS) with a self-hosted sync
server and a two-way Incident IQ sync. The owner works on it from a Windows PC
and a Mac; this file is how both start with the same context. Keep it current
when something here changes.

Each platform has a native app: WinUI 3 (C#) on Windows, SwiftUI on the Mac,
iPhone and iPad. The first app, one Tauri 2 + React codebase for all three, is
kept on the `tauri` branch and no longer built or used. Comments that say a
file is a "port of `app/src/…`" point there.

## Layout

| Path | What |
| --- | --- |
| `spec/` | The contract between apps: `protocol.md` and shared test cases in `fixtures/` |
| `windows/Nextly.Core/` | C# library for the Windows app: models, rules, lists, SQLite store, sync, live updates (record data stays `System.Text.Json` nodes so unknown fields survive). `cd windows && dotnet test` runs the fixtures and syncs against `server/` (Node 24, or Docker) |
| `windows/Nextly.App/` | The Windows app (WinUI 3, unpackaged, self-contained) on Nextly.Core. Screens are built in code (`TaskListPane`, `DetailPane`, `NotesView`, `SettingsPane`); `NEXTLY_DATA_DIR` points it at another data folder, `NEXTLY_THEME=light\|dark` forces a theme, `NEXTLY_DEBUG_LOG=<file>` traces saves, rebuilds and exceptions |
| `windows/installer/` | The per-user Inno Setup installer ("Nextly Native"), built by CI |
| `apple/` | The SwiftUI app (`App/`, `project.yml`) on `NextlyKit/`; widget and Siri extensions (`Shared`, `Widgets`, `Intents`); CI scripts |
| `apple/NextlyKit/` | Swift package: models, rules, lists, SQLite store, sync, live updates. `swift test` runs the fixtures and syncs against `server/` |
| `server/` | Sync server: Node 24, no dependencies, `node:sqlite`; GitHub Actions publishes its image (private, `ghcr.io/mjsamberg/nextly-server`) from each push to `main`; the server pulls it |
| `server/iiq.js` | Incident IQ sync (see below); `iiq-probe.js`, `iiq-options.js` are read-only diagnostics |
| `capture/` | The Gmail bookmarklet (`nextly://add` links) |
| `brand/icon.svg` | The app icon's source (`apple/scripts/render-icons.swift` renders it) |
| `docs/` | Cloudflare, Apple signing, Incident IQ setup; `parity.md` is the feature checklist for both apps |
| `scripts/set-version.mjs` | Date-based versions (`Y.M.D.N`, New York time, Nth commit that day), passed to builds as `NEXTLY_VERSION_LABEL`, `NEXTLY_VERSION`, `NEXTLY_BUILD` |

## Working on it

- Windows: `cd windows && dotnet test` (.NET 9 SDK; on the Windows PC it's in
  `C:\Program Files\dotnet` if `dotnet` isn't on PATH). This also builds the
  WinUI app (Windows only); run it from
  `windows/Nextly.App/bin/x64/Debug/.../Nextly.exe`. A published build
  (`dotnet publish … -r win-x64 -p:Platform=x64`) needs `EnableMsixTooling`
  (kept on in the project) or it can't load its XAML.
- Mac and iPhone (Mac only): `brew install xcodegen`, then `cd apple && xcodegen
  generate --spec project.yml && open NextlyNative.xcodeproj` (scheme Nextly,
  iOS and macOS). `cd apple/NextlyKit && swift test` runs the shared fixtures
  and sync tests. Mac builds without a signing team use entitlements with no
  App Group (`NEXTLY_ENTITLEMENTS=local`), so the app runs but its widgets
  can't see its settings. Signed builds: `apple/scripts/build-native.sh`, run
  by CI once `NATIVE_SIGNING` is on (`docs/apple-signing.md`, step 4).
- Server: `cd server && npm test` (Node 24; starts a throwaway server for
  the file tests). On the Mac, Node 24 is from Homebrew (`node@24`, keg-only:
  add `/opt/homebrew/opt/node@24/bin` to PATH).
- Screenshots of the Windows app: capture only its own window (PrintWindow),
  never the screen, so other apps' content can't end up in an image. Drive it
  with UI Automation; send keys only after checking Nextly is the foreground
  window.
- Builds and releases run on GitHub Actions (`.github/workflows/build.yml`) on
  every push to `main`; signing secrets live in GitHub, not here. The Windows
  installer isn't code-signed yet: SmartScreen warns, and Smart App Control
  blocks it.
- The server's `.env` lives only on the server. Never put tokens or secrets in
  the repo, even though it's private now (it was public, and history would
  show them if it's made public again).
- The server runs the image CI publishes on each push to `main`
  (`server-image` job, private on ghcr.io, with a build attestation); it logs
  in with a read-only `read:packages` token. That job can publish, so its
  third-party actions are pinned to commits: keep them pinned when updating.
- Pull before starting and push when done; the other computer may have work.
- Commits: short imperative subject, a body saying why.

## Two apps, one data format

The Windows and Apple apps must not drift apart (`docs/parity.md` tracks the
features):

- A rule change starts in `spec/fixtures` (and `spec/protocol.md`), then
  goes into both `Rules.swift`/`Logic.swift` and `Rules.cs`/`Logic.cs`. `node
  scripts/check-fixtures.mjs` fails CI if a suite doesn't run every fixture.
- Saving keeps fields the app doesn't know (sync replaces whole records).
- Records carry `schema`; raise it only for changes older apps can't save
  over, and they will show such records read-only.

## Lessons learned

- **The Mac is low on resources.** Run one iOS simulator at a time at most;
  even one simulator running XCUITests pushed the load past 200 and made the
  results meaningless. Check UI changes in the Mac app, or on a real device.

- **iPhone layout: verify on the device.** Desktop browsers and emulators
  passed a fix that didn't work on the iPhone. For iOS UI bugs, ask early for
  a screen recording.
- iOS tap targets are at least 44pt.
- In NextlyKit the task model is `TaskData`, not `Task`: a public `Task` type
  hides Swift's `Task { }` in every file that imports the package.
- WinUI: never rebuild UI inside a focus event (crashes); `FrameworkElement.Parent`
  is null once an element's old container is off screen, so track containers
  yourself before re-adding an element; a text box replaced by a rebuild can
  still fire LostFocus, so don't let it save stale text.

## Incident IQ (server/iiq.js, docs/incident-iq.md)

- Only tickets assigned to `IIQ_USER_EMAIL` sync (the owner is an IIQ admin
  and can see every ticket). Ticket tasks live in the Incident IQ project,
  never the Inbox, newest submitted first.
- **Safeguards against changing tickets beyond your own; keep them.** The
  client allows only reads and three single-ticket changes (comment, start,
  resolve) on known paths; each action is checked live (open, assigned to
  you, linked to its task), rate-limited, and logged. A device can choose a
  resolution action only from the list the server read from IIQ (refused
  otherwise); the close request comes only from `.env`. The widget and Siri
  never change tickets. Resolving asks for notes in the app
  (required only with the default resolution action, as in IIQ).
- Tickets marked sensitive keep their requester and description in IIQ only.

## District rules (Chatham County Schools)

- Branding: plum `#7a3c59` (122/60/89), navy `#134169` (19/65/105), gold
  `#ffb600`, mist `#d2d8e6`; headers Zing Rust (Oswald fallback), body
  Muli/Mulish or Arial. Brand guide: https://www.chatham.k12.nc.us/page/brand-guide
- Show a warning wherever more than simple directory information about
  students could be uploaded or stored (ticket tasks can hold student names).
- Never use AI-manipulated photos of children.
