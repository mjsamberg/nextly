# Nextly

A Things-style task manager for Windows, macOS and iOS. Tasks are organized by
**Today** and **Next** flags; deadlines are optional. Tasks support subtasks,
dependencies, block-based notes with attachments, and Gmail links.

| Folder | What's in it |
| --- | --- |
| `app/` | The app: Tauri 2 + React + TypeScript, one codebase for all three platforms |
| `server/` | Sync server (Node 24, no dependencies) and its Docker Compose file |
| `capture/` | Gmail bookmarklet for Chrome and Safari |
| `docs/` | iOS signing setup |
| `wireframes.html` | The original wireframes |

## Get the apps

Every push to `main` builds them on GitHub Actions. Open the latest run under
**Actions → Build apps** and download:

- **nextly-windows**: `.msi` and `-setup.exe` installers
- **nextly-macos**: a universal `.dmg` (Apple silicon and Intel). It isn't
  signed yet, so the first time, right-click the app → **Open**, or run
  `xattr -cr /Applications/Nextly.app`.
- **nextly-ios**: a signed `.ipa`, once the secrets in
  [docs/ios-signing.md](docs/ios-signing.md) are set.

Pushing a tag like `v0.1.0` also creates a draft GitHub release with all of them.

## Run the sync server

The host needs Docker and Tailscale. Copy `server/docker-compose.yml` and
`server/.env.example` to the host, then:

```bash
cp .env.example .env    # set NEXTLY_BIND (tailscale ip -4) and NEXTLY_TOKEN
docker compose up -d --build
```

Compose builds the image from the `server/` folder of this repo's `main` branch.
In each app, open **Settings** and enter `http://<host>.<tailnet>.ts.net:8080`
and the token.

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
  Sync runs 1.5 s after an edit, every 30 s, and when the window gets focus.
- **Attachments** are stored by SHA-256, upload once, and download on demand.
  Files open in the system browser through a link that expires after 10 minutes.
- **Requests go through Rust** (`tauri-plugin-http`), so plain `http://` on the
  tailnet works on iOS without App Transport Security exceptions.
