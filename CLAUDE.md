# Nextly: notes for Claude

A Things-3-style task manager (Windows, macOS, iOS) with a self-hosted sync
server and a two-way Incident IQ sync. The owner works on it from a Windows PC
and a Mac; this file is how both start with the same context. Keep it current
when something here changes.

## Layout

| Path | What |
| --- | --- |
| `app/` | Tauri 2 app: React + TypeScript (Vite) in `src/`, Rust shell in `src-tauri/` |
| `app/src/store.ts` | All data changes go through its actions (rules live here, not in components) |
| `app/src/lists.ts`, `logic.ts` | What each list shows; quick add, repeats, dates (tested in `logic.test.ts`) |
| `app/src/sync.ts`, `live.ts` | Sync with the server (one or two addresses, failover), live updates over WebSocket |
| `app/src/styles.css`, `platform.css` | Base styles; per-platform looks keyed on `html[data-platform]` (mac, win, ios, other) |
| `server/` | Sync server: Node 24, no dependencies, `node:sqlite`; Docker Compose builds it from GitHub `main` |
| `server/iiq.js` | Incident IQ sync (see below); `iiq-probe.js`, `iiq-options.js` are read-only diagnostics |
| `apple/` | Swift widget and Siri extensions (xcodegen specs, CI scripts) |
| `docs/` | Cloudflare, Apple signing, Incident IQ setup |
| `scripts/set-version.mjs` | Date-based versions (`Y.M.D.N`, New York time, Nth commit that day) |

## Working on it

- App: `cd app && npm install`, then `npm test` (logic tests), `npx tsc --noEmit -p .`,
  `npm run dev` (browser), `npx tauri dev` (desktop, needs Rust).
- Preview a platform's look in the browser with `?platform=ios|mac|win`.
- Builds and releases run on GitHub Actions (`.github/workflows/build.yml`) on
  every push to `main`; iOS and macOS signing secrets live in GitHub, not here.
- The server's `.env` lives only on the server. Never put tokens or secrets in
  the repo (it's public).
- Pull before starting and push when done; the other computer may have work.
- Commits: short imperative subject, a body saying why.

## Lessons learned

- **iPhone layout: verify on the device.** Desktop Chrome and Playwright WebKit
  both passed a fix that didn't work on the iPhone (home screen sections
  squeezed instead of scrolling). Scroll containers that hold clipped
  (`overflow: hidden`) sections use block layout on iOS, not a flex column.
  For iOS UI bugs, ask early for a screen recording, or use Safari's Web
  Inspector from the Mac.
- iOS tap targets are at least 44pt (`platform.css`).
- `rust-ini` is pinned to 0.21.1 (newer breaks the deep-link plugin).

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
