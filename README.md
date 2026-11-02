# Nextly

A Things-style task manager for Windows, macOS and iOS. Tasks are organized by
**In Progress**, **Today** and **Next** flags; deadlines are optional. Tasks
support subtasks, dependencies, repeats, block-based notes with attachments,
and Gmail links.

- **In Progress** is what you're working on right now. It has its own list and
  heads the Today list. Swipe a Today task right on iPhone, right-click it on
  Windows, or press Ctrl/⌘+D to start it.
- **Start dates** ("Today on") hold a task in Scheduled until that day, then it
  moves into Today by itself.
- **Repeats**: every day, weekday, week, 2 weeks, month, year, or every N
  days/weeks/months/years, counted on schedule or from when you finish it.
  Finishing a repeating task files the next copy (with its subtasks and
  checklist unchecked) under Scheduled, and it moves into Today on its date.
  This works the same when you finish it from the widget or Siri.
- **Incident IQ**: tickets assigned to you sync into an Incident IQ project;
  comments, In Progress and finishing a task go back to the ticket
  ([docs/incident-iq.md](docs/incident-iq.md)).
- **Quick add**: `!p` In Progress, `!t` Today, `!n` Next, `@mon` start date,
  `^fri` deadline, `*weekly` / `*weekdays` / `*3d` repeat.

Each platform has a native app, all on one sync server and one data format
([spec/protocol.md](spec/protocol.md)):

| Folder | What's in it |
| --- | --- |
| `windows/` | The Windows app: WinUI 3 (C#), on `Nextly.Core` (rules, lists, store, sync) |
| `apple/` | The iPhone, iPad and Mac app: SwiftUI, on `NextlyKit`, with its widget and Siri extensions |
| `spec/` | The data and sync contract, and the test cases every app must pass |
| `server/` | Sync server (Node 24, no dependencies) and its Docker Compose file |
| `capture/` | Gmail bookmarklet for Chrome and Safari (hands emails to the app) |
| `brand/` | The app icon's source |
| `docs/` | Cloudflare, Apple signing, Incident IQ setup, and the feature checklist (`parity.md`) |
| `wireframes.html` | The original wireframes |

The first version, one Tauri + React app for all three platforms, is kept on
the [`tauri` branch](https://github.com/mjsamberg/nextly/tree/tauri). It isn't
built or used any more.

## Get the apps

Every push to `main` builds them on GitHub Actions. Open the latest run under
**Actions → Build apps** and download:

- **nextly-windows-native**: a setup `.exe` that installs "Nextly Native" for
  you (no administrator rights needed). It isn't code-signed yet, so Windows
  SmartScreen warns the first time (**More info → Run anyway**), and PCs with
  Smart App Control on won't run it.
- **nextly-native-macos**: the Mac app, signed and notarized, with its widget
  and Siri.
- **nextly-native-ios**: a signed `.ipa` with the widget and Siri.

The Apple builds need the signing secrets and the `NATIVE_SIGNING` variable:
[docs/apple-signing.md](docs/apple-signing.md).

### Widget and Siri (Mac and iPhone)

- **Widgets** for Today and Next in small, medium and large, plus Lock Screen
  sizes on iPhone. Tap a circle to complete a task from the widget.
- **Siri and Shortcuts**: "Add a task in Nextly", "Add a task to Next in
  Nextly", "What's on my Today list in Nextly".
- They live in `apple/` as two Swift extensions. They read the app's sync
  settings from a shared App Group folder and talk to the server's task API
  directly, so they work while the app is closed. If Siri can't reach the
  server, the task is saved and the app adds it the next time it opens.
- Changes made in the app reach the widget on its next refresh (about every
  15 minutes, or sooner when you use the widget). Changes from Siri and the
  widget reach your other devices right away through live updates.

Pushing a tag like `v2026.10.22.3` also creates a draft GitHub release with all of them.

### Versions

Versions are date-based and stamped automatically by
[scripts/set-version.mjs](scripts/set-version.mjs) on every build: the
commit's date (New York time) plus how many commits were made that day.
Settings shows it, for example **2026.10.22.3** for the third build on
October 22, 2026. Re-running a build gives the same number. Each platform
gets a form it accepts, and every one always increases, so updates install
over older builds:

| Where | Example |
| --- | --- |
| Shown in Settings, and the Windows app's file version | `2026.10.22.3` |
| Mac and iPhone version | `2026.10.22` |
| Mac and iPhone build number (app and extensions) | `2026102203` |

Builds made on your own computer show a placeholder version.

## Email to task

**Gmail bookmarklet (Chrome and Safari, Windows and Mac).** Create a bookmark
and paste the single line from [capture/bookmarklet.txt](capture/bookmarklet.txt)
as its URL. With a Gmail message open, click it: the browser hands the email to
the Nextly app through a `nextly://add` link (the first time it asks to open
Nextly; tick "Always allow"). The app adds an Inbox task with an email card and
opens it so you can choose Today or Next. It needs the app installed on that
computer, and works offline. On Windows the app takes `nextly://` links when
nothing else handles them; otherwise switch them in **Settings → Links**.

**iPhone and Mac:** Siri ("Add a task in Nextly"), or paste a Gmail link into
quick add.

## Run the sync server

The server is reached through a Cloudflare Tunnel protected by Cloudflare
Access, so the host needs Docker but no open ports. Set up the tunnel and
Access first: [docs/cloudflare.md](docs/cloudflare.md). Then copy
`server/docker-compose.yml` and `server/.env.example` to the host:

```bash
cp .env.example .env    # set NEXTLY_TOKEN and CLOUDFLARE_TUNNEL_TOKEN
docker login ghcr.io -u mjsamberg
docker compose up -d
```

GitHub Actions builds the server's image from the `server/` folder of each
push to `main` and publishes it as a private package,
`ghcr.io/mjsamberg/nextly-server`. Compose runs it with `cloudflared` next to
it. For `docker login`, make a classic personal access token (GitHub →
Settings → Developer settings) with only the `read:packages` scope and an
expiry date, and paste it as the password. It can download images but not
read or change the code. Classic tokens can't be limited to one package, so a
separate GitHub account with read access to just this package isolates it
further.

To update: `docker compose pull && docker compose up -d`. To check first
that the image was built by this repo's workflow (needs the `gh` CLI):

```bash
gh attestation verify oci://ghcr.io/mjsamberg/nextly-server:main --owner mjsamberg
```

In each app, open **Settings** and
enter `https://nextly.example.com` (your hostname), the sync token, and the
Access service token under **Request headers** → **Add Cloudflare Access headers**.

**A second address.** If the server is also reachable another way, such as
Tailscale, put that under **Second address**. Each app, plus the widget and
Siri, uses whichever address answers: after a quiet spell (the phone woke, the
network changed) it checks both and takes the first to answer, and if the one
in use stops working (no connection, or Cloudflare's tunnel or Access errors)
it switches and retries. Settings shows which address is in use, and **Check
connection** tests each one. Both must reach the same server; the Cloudflare
Access headers are sent to both, which is harmless for the Tailscale one.

## Develop

```bash
cd windows && dotnet test                # Windows: shared cases and sync tests (.NET 9)
cd apple/NextlyKit && swift test         # Mac and iPhone: the same (Mac only)
cd server && npm test                    # the sync server (Node 24)
node scripts/check-fixtures.mjs          # every app runs every shared case
```

The Windows app builds with `dotnet build windows/Nextly.sln`; the Apple app
with Xcode (`cd apple && xcodegen generate --spec project.yml`). A rule change
starts in `spec/fixtures`, then goes into both apps.

## How it works

- **Local first.** Each device keeps everything in a local SQLite database and
  works offline. Edits queue up and sync when the server is reachable.
- **Sync.** Every task, project and area is one record with a hybrid logical
  clock timestamp. If two devices edit the same record, the newer edit wins.
  Sync runs right after an edit and when the window gets focus.
- **Live updates.** Each device keeps a WebSocket open to `/events`. When one
  device syncs a change, the server tells the others and they sync at once, so
  edits show up on other devices in a second or two. If live updates are
  disconnected, devices check every 30 s instead (every 5 minutes while
  connected, as a safety net). Settings shows whether live updates are on.
- **Attachments** are stored by SHA-256, upload once, and download on demand.
  Files open in the system browser through a link that expires after 10 minutes.
- **Request headers.** Any headers set in Settings (such as
  `CF-Access-Client-Id` and `CF-Access-Client-Secret`) go with every sync and
  file request. If Cloudflare Access turns a request away, the app says so
  instead of showing a generic error.
