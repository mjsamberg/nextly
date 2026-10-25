# Nextly: notes for Claude

A Things-3-style task manager (Windows, macOS, iOS) with a self-hosted sync
server and a two-way Incident IQ sync. The owner works on it from a Windows PC
and a Mac; this file is how both start with the same context. Keep it current
when something here changes.

## Layout

| Path | What |
| --- | --- |
| `app/` | Tauri 2 app: React + TypeScript (Vite) in `src/`, Rust shell in `src-tauri/` |
| `app/src/store.ts` | All data changes go through its actions; it saves what `rules.ts` decides |
| `app/src/rules.ts` | The store's rules as pure functions (finish, repeats, unblocking, Next order, schema) |
| `app/src/lists.ts`, `logic.ts` | What each list shows; quick add, repeats, dates |
| `spec/` | The contract between apps: `protocol.md` and shared test cases in `fixtures/` |
| `docs/parity.md` | Windows vs Swift feature checklist; the gate for retiring the Tauri Mac/iOS builds |
| `app/src/sync.ts`, `live.ts` | Sync with the server (one or two addresses, failover), live updates over WebSocket |
| `app/src/styles.css`, `platform.css` | Base styles; per-platform looks keyed on `html[data-platform]` (mac, win, ios, other) |
| `server/` | Sync server: Node 24, no dependencies, `node:sqlite`; Docker Compose builds it from GitHub `main` |
| `server/iiq.js` | Incident IQ sync (see below); `iiq-probe.js`, `iiq-options.js` are read-only diagnostics |
| `apple/` | Native SwiftUI app (`App/`, `project.yml`) on `NextlyKit/` (data, rules, sync); widget and Siri extensions; CI scripts |
| `apple/NextlyKit/` | Swift package for the native apps: models, rules, lists, SQLite store, sync, live updates (ports of the `app/src` files above). `swift test` runs the fixtures and syncs against `server/` |
| `docs/` | Cloudflare, Apple signing, Incident IQ setup |
| `scripts/set-version.mjs` | Date-based versions (`Y.M.D.N`, New York time, Nth commit that day) |

## Working on it

- App: `cd app && npm install`, then `npm test` (the shared fixtures), `npx tsc --noEmit -p .`,
  `npm run dev` (browser), `npx tauri dev` (desktop, needs Rust).
- Server: `cd server && npm test` (Node 24; starts a throwaway server for
  the file tests). On the Mac, Node 24 is from Homebrew (`node@24`, keg-only:
  add `/opt/homebrew/opt/node@24/bin` to PATH).
- NextlyKit: `cd apple/NextlyKit && swift test` (needs Node 24 for the sync tests).
- Preview a platform's look in the browser with `?platform=ios|mac|win`.
- Native app (Mac only): `brew install xcodegen`, then `cd apple && xcodegen
  generate --spec project.yml && open NextlyNative.xcodeproj` (scheme Nextly,
  iOS and macOS). `cd apple/NextlyKit && swift test` runs the shared fixtures
  and sync tests. It installs as "Nextly Native" beside the Tauri app.
  Mac builds without a signing team use entitlements with no App Group
  (`NEXTLY_ENTITLEMENTS=local`), so the app runs but its widgets can't see
  its settings. Signed builds: `apple/scripts/build-native.sh`, run by CI
  once `NATIVE_SIGNING` is on (`docs/apple-signing.md`, step 4).
- The widget and Siri code in `apple/Shared`, `Widgets` and `Intents` is
  built into both the Tauri and the native apps; check both when changing it.
- Builds and releases run on GitHub Actions (`.github/workflows/build.yml`) on
  every push to `main`; iOS and macOS signing secrets live in GitHub, not here.
- The server's `.env` lives only on the server. Never put tokens or secrets in
  the repo (it's public).
- Pull before starting and push when done; the other computer may have work.
- Commits: short imperative subject, a body saying why.

## Two apps, one data format

Windows runs the Tauri app; iOS and macOS are moving to native Swift
(`docs/parity.md`). A native WinUI 3 / C# Windows app is planned next, not
started (end of `docs/parity.md`). They must not drift apart:

- A rule change starts in `spec/fixtures` (and `spec/protocol.md`), then
  goes into `app/src/rules.ts`/`logic.ts` and the Swift package. `node
  scripts/check-fixtures.mjs` fails CI if a suite doesn't run every fixture.
- Saving keeps fields the app doesn't know (sync replaces whole records).
- Records carry `schema`; raise it only for changes older apps can't save
  over, and they will show such records read-only.

## Lessons learned

- **iPhone layout: verify on the device.** Desktop Chrome and Playwright WebKit
  both passed a fix that didn't work on the iPhone (home screen sections
  squeezed instead of scrolling). Scroll containers that hold clipped
  (`overflow: hidden`) sections use block layout on iOS, not a flex column.
  For iOS UI bugs, ask early for a screen recording, or use Safari's Web
  Inspector from the Mac.
- iOS tap targets are at least 44pt (`platform.css`).
- In NextlyKit the task model is `TaskData`, not `Task`: a public `Task` type
  hides Swift's `Task { }` in every file that imports the package.
- `rust-ini` is held at 0.21.1 by `app/src-tauri/Cargo.lock` (newer breaks the
  deep-link plugin); keep it there when updating Rust crates.

## Incident IQ (server/iiq.js, docs/incident-iq.md)

- Only tickets assigned to `IIQ_USER_EMAIL` sync (the owner is an IIQ admin
  and can see every ticket). Ticket tasks live in the Incident IQ project,
  never the Inbox, newest submitted first.
- **Safeguards against changing tickets beyond your own; keep them.** The
  client allows only reads and three single-ticket changes (comment, start,
  resolve) on known paths; each action is checked live (open, assigned to
  you, linked to its task), rate-limited, and logged. Devices can't choose the
  resolution action; the widget and Siri never change tickets. Resolving asks
  for notes in the app.
- Tickets marked sensitive keep their requester and description in IIQ only.

## District rules (Chatham County Schools)

- Branding: plum `#7a3c59` (122/60/89), navy `#134169` (19/65/105), gold
  `#ffb600`, mist `#d2d8e6`; headers Zing Rust (Oswald fallback), body
  Muli/Mulish or Arial. Brand guide: https://www.chatham.k12.nc.us/page/brand-guide
- Show a warning wherever more than simple directory information about
  students could be uploaded or stored (ticket tasks can hold student names).
- Never use AI-manipulated photos of children.
