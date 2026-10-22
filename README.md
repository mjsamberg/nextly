# Nextly

A Things-style task manager for Windows, macOS and iOS. Tasks are organized by
**In Progress**, **Today** and **Next** flags; deadlines are optional. Tasks
support subtasks, dependencies, repeats, block-based notes with attachments,
and Gmail links.

- **In Progress** is what you're working on right now. It has its own list and
  heads the Today list. Swipe a Today task right (or press Ctrl/⌘+D) to start
  it; swipe left to put it back in Today.
- **Start dates** ("Today on") hold a task in Scheduled until that day, then it
  moves into Today by itself.
- **Repeats**: every day, weekday, week, 2 weeks, month, year, or every N
  days/weeks/months/years, counted on schedule or from when you finish it.
  Finishing a repeating task files the next copy (with its subtasks and
  checklist unchecked) under Scheduled, and it moves into Today on its date.
  This works the same when you finish it from the widget or Siri.
- **Quick add**: `!p` In Progress, `!t` Today, `!n` Next, `@mon` start date,
  `^fri` deadline, `*weekly` / `*weekdays` / `*3d` repeat.

| Folder | What's in it |
| --- | --- |
| `app/` | The app: Tauri 2 + React + TypeScript, one codebase for all three platforms |
| `server/` | Sync server (Node 24, no dependencies) and its Docker Compose file |
| `capture/` | Gmail bookmarklet for Chrome and Safari (hands emails to the app) |
| `apple/` | Widget and Siri extensions (Swift) for macOS and iOS |
| `docs/` | Cloudflare and Apple signing setup |
| `wireframes.html` | The original wireframes |

## Get the apps

Every push to `main` builds them on GitHub Actions. Open the latest run under
**Actions → Build apps** and download:

- **nextly-windows**: `.msi` and `-setup.exe` installers
- **nextly-macos**: a universal `.dmg` (Apple silicon and Intel). Until the
  signing secrets are set it's unsigned and has no widget or Siri; the first
  time, right-click the app → **Open**, or run `xattr -cr /Applications/Nextly.app`.
- **nextly-ios**: a signed `.ipa` with the widget and Siri, once the secrets
  are set.

Signing setup for both: [docs/apple-signing.md](docs/apple-signing.md).

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

Pushing a tag like `v0.1.0` also creates a draft GitHub release with all of them.

## Email to task

**Gmail bookmarklet (Chrome and Safari, Windows and Mac).** Create a bookmark
and paste the single line from [capture/bookmarklet.txt](capture/bookmarklet.txt)
as its URL. With a Gmail message open, click it: the browser hands the email to
the Nextly app through a `nextly://add` link (the first time it asks to open
Nextly; tick "Always allow"). The app adds an Inbox task with an email card and
opens it so you can choose Today or Next. It needs the app installed on that
computer, and works offline.

**iPhone and Mac:** Siri ("Add a task in Nextly"), or paste a Gmail link into
quick add.

## Run the sync server

The server is reached through a Cloudflare Tunnel protected by Cloudflare
Access, so the host needs Docker but no open ports. Set up the tunnel and
Access first: [docs/cloudflare.md](docs/cloudflare.md). Then copy
`server/docker-compose.yml` and `server/.env.example` to the host:

```bash
cp .env.example .env    # set NEXTLY_TOKEN and CLOUDFLARE_TUNNEL_TOKEN
docker compose up -d --build
```

Compose builds the server from the `server/` folder of this repo's `main`
branch and runs `cloudflared` next to it. In each app, open **Settings** and
enter `https://nextly.example.com` (your hostname), the sync token, and the
Access service token under **Request headers** → **Add Cloudflare Access headers**.

## Develop

```bash
cd app
npm install
npm test            # rules: quick add, dates, dependencies
npx tauri dev       # desktop app with hot reload (needs Rust)
npm run dev         # frontend only, in a browser
```

## How it works

- **Local first.** Each device keeps everything in the webview's IndexedDB and
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
- **Requests go through Rust** (`tauri-plugin-http`), so they aren't limited by
  CORS in the webview.
