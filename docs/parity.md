# Feature parity: Windows (Tauri) and the Swift apps

The native iOS and macOS apps (`apple/`) are built alongside the Tauri app,
which keeps shipping for Mac and iPhone until every row below is checked for
Swift. Once the Swift apps reach parity, they take over the bundle id
`com.mjsamberg.nextly`, and the Tauri `macos` and `ios` builds stop. Windows
stays on Tauri.

**Cutover gate**: every row checked; `swift test`, `npm test` and the fixture
gate green; and a week of daily use with the Swift apps and Windows on the
same server.

Key: ✅ done (for Swift: built and checked on the iPhone simulator, or against a test server) · ⬜ not yet · — not applicable.
The Swift app hasn't been checked on a real iPhone, an iPad or visually on the Mac yet.
The rules behind a row are covered by `spec/fixtures` (named in brackets).
Swift rows marked done for data and sync are in `apple/NextlyKit` and its tests;
rows about the rules (lists, quick add, repeats, dependencies) also pass the
fixtures there, but stay unchecked until the app shows them.

## Data and sync

| Feature | Windows | Swift |
| --- | --- | --- |
| Records, HLC, last writer wins (`spec/protocol.md`) | ✅ | ✅ |
| Keeps unknown fields when saving [roundtrip] | ✅ | ✅ |
| Schema version: stamps `schema: 1`; newer records read-only with a note [roundtrip, actions: promote-due] | ✅ | ✅ |
| Sync: outbox, cursor, `more`, a server that lost its data, "edited while in flight" | ✅ | ✅ |
| Two server addresses with failover; extra headers (Cloudflare Access) [network] | ✅ | ✅ |
| Live updates (WebSocket; 70 s watchdog; backoff) | ✅ | ✅ |
| Polling fallback; sync on focus and when back online | ✅ | ⬜ (polling and sync on returning to the app done; no trigger yet when the network comes back) |
| Due tasks move into Today only after a sync since launch [actions: promote-due] | ✅ | ✅ |
| Attachments: stored locally, uploaded, opened through a signed link | ✅ | ✅ |
| Check connection report | ✅ | ⬜ (built; not yet checked) |

## Lists and navigation

| Feature | Windows | Swift |
| --- | --- | --- |
| Inbox, In Progress, Today, Next, Scheduled, Someday, All, Logbook, projects [lists] | ✅ | ✅ (Scheduled, All and Logbook built; not yet checked) |
| Sidebar counts [lists] | ✅ | ✅ |
| Areas and projects in the sidebar; new project/area inline | ✅ | ✅ (adding inline built; not yet checked) |
| Search over titles and notes [lists: search] | ✅ | ⬜ (built; not yet checked) |
| Today: In Progress first, grouped by project, "Up next" (5) | ✅ | ✅ |
| All: grouped by area and project | ✅ | ⬜ (built; not yet checked) |
| Next: drag to reorder [actions: move-in-next] | ✅ | ⬜ (built; not yet checked) |
| Empty-list messages | ✅ | ✅ |
| Phone: one pane at a time, swipe from the edge to go back | ✅ | ✅ |
| Row chips: subtasks, mail, attachments, waiting, flag, ticket status, repeat, start, deadline | ✅ | ✅ |
| Row swipes: right promotes, left defers [flags] | ✅ | ✅ |

## Tasks

| Feature | Windows | Swift |
| --- | --- | --- |
| Quick add with `!flag ^deadline @start *repeat` and pasted mail links [quick-add, date-words, repeats] | ✅ | ✅ |
| Detail: title, flag, start date, deadline, repeat picker, project | ✅ | ✅ |
| Repeating tasks: next copy on finishing [repeats, actions: repeat-*] | ✅ | ✅ |
| Subtasks | ✅ | ✅ (adding built; not yet checked) |
| Dependencies, loops refused, freed tasks move to Next [actions: dependency-*, done-frees-waiting] | ✅ | ✅ (adding built; not yet checked) |
| Delete with undo [actions: delete-with-subtasks] | ✅ | ✅ |
| Notes: heading, paragraph, checklist, quote, divider; Enter splits, Backspace merges, "/" menu | ✅ | ✅ |
| Images and files in notes | ✅ | ✅ |
| Email cards (Gmail, Apple Mail `message:`) | ✅ | ✅ |
| Projects and areas: rename, move, delete [actions: delete-project, delete-area] | ✅ | ⬜ (built; not yet checked) |

## Incident IQ

| Feature | Windows | Swift |
| --- | --- | --- |
| Ticket panel: number, status, details, open in Incident IQ | ✅ | ✅ |
| Internal comments and the action log | ✅ | ✅ (queued and shown; carrying them out is the server's job) |
| In Progress starts the ticket [actions: ticket-start] | ✅ | ✅ |
| Finishing asks for resolution notes [actions: ticket-needs-notes, ticket-resolve] | ✅ | ✅ |
| Incident IQ status in Settings | ✅ | ✅ |

## Settings and district rules

| Feature | Windows | Swift |
| --- | --- | --- |
| Server addresses, token, header rows with the Cloudflare preset | ✅ | ✅ |
| Student information warning: privacy note in Settings | ✅ | ✅ |
| Student information warning: Incident IQ ticket tasks | ✅ | ✅ |
| Student information warning when attaching files | ⬜ (built; not yet checked in the app) | ✅ |
| District branding: plum, navy, gold, mist; Oswald headings, Mulish body | ✅ | ✅ |
| Keyboard shortcuts (⌘N, ⌘K, ⌘T, ⌘⇧T, ⌘D, ⌘↩, ⌘,, Esc, Delete) | ✅ | ⬜ (built; not yet checked; ⌘K needs macOS 15 / iOS 18) |
| Quick add and shortcut help | ✅ | ✅ |

## Platform

| Feature | Windows | Swift |
| --- | --- | --- |
| `nextly://add` links (bookmarklet) [capture-links] | ✅ | ✅ (iOS too, which the Tauri app lacks) |
| App icon | ✅ | ✅ |
| Widgets: Today, Next; finish from the widget | — | ⬜ (built; the app shares settings and a snapshot with them, checked in the simulator; not yet placed on a home screen) |
| Siri: add a task, read a list | — | ⬜ (built; tasks Siri saves offline are added on launch, checked; Siri itself not yet tried) |
| Widgets open the app on tap | — | ⬜ (nextly://open and nextly://list checked in the app; tapping a placed widget not yet tried) |
| Signed and notarized Mac build; iOS build from CI | — | ⬜ (CI jobs ready; need the native identifiers registered and NATIVE_SIGNING on, docs/apple-signing.md step 4) |

## Next: a native Windows app (started)

Agreed on 2026-10-24: Windows moves off Tauri too, to a native Fluent app
built with **WinUI 3 and C#**, so each platform has a native app on the same
server. It follows the path the Swift apps took:

1. **A C# core library first**, a port of `app/src` like NextlyKit: models,
   rules, quick add, repeats, lists, local store, sync (two addresses with
   failover, Cloudflare headers), live updates. Its tests run every case in
   `spec/fixtures` and it joins `scripts/check-fixtures.mjs` as a third suite.
2. **Then the WinUI app** on top: Mica, NavigationView sidebar, Fluent icons
   and type, dark mode, keyboard shortcuts, the district branding and
   student-information warnings, `nextly://` links for the Gmail bookmarklet.
3. **Builds and an installer** on GitHub Actions' Windows runners.
4. **Parity:** these tables get a "Windows Native" column. The Tauri Windows
   build keeps shipping until every row is checked; then Tauri is retired.

Needs the .NET SDK on the Windows PC (`winget install Microsoft.DotNet.SDK.9`);
Visual Studio is optional.

**Progress**

- [x] `windows/Nextly.Core`: models, rules, lists, quick add, repeats, dates,
  capture links, headers, HLC. Passes all 123 shared cases
  (`cd windows && dotnet test`), required by the fixture gate, run in CI
  (`windows-core`).
- [x] Local store (SQLite), sync (two addresses with failover, Cloudflare
  headers, a server that lost its data, edits made while a sync is in
  flight), attachments, live updates, and the connection check. The same nine
  server scenarios as NextlyKit's `SyncTests.swift`, against the real server
  (Node 24, or Docker when Node isn't installed).
- [x] The WinUI 3 app, first pass (`windows/Nextly.App`): Fluent title bar
  and Mica, NavigationView sidebar with counts, areas and projects, search;
  every list (Today's In Progress / project / Up next sections, All by area
  and project, Next drag to reorder); rows with the round check, chips and a
  right-click flag menu; the detail pane (title, flag, start date, repeat,
  deadline, project, subtasks, dependencies, Incident IQ panel); resolve
  notes dialog; delete with Undo; Settings (two addresses, token, headers,
  status, connection check, Incident IQ, areas and projects); shortcuts;
  light and dark. Checked against a real server: sync both ways, live
  updates, and a ticket resolved with notes.
- [x] Notes editor: heading, text, checklist, quote, divider; Enter splits,
  Backspace on an empty block removes it, "/" menu; images and files (the
  student-information warning first, then Windows' file picker); email
  cards. Checked by typing into the app (Windows' file picker itself still
  needs trying by hand).
- [ ] `nextly://` links (Gmail bookmarklet) and one window at a time: built
  (`Links.cs`, `Program.cs`, Settings → Links), not yet run. It registers
  for links only when nothing else handles them, or when you ask in Settings.
- [ ] Code signing. Smart App Control (on for the Windows PC) blocks newly
  built unsigned programs, so a signed build is needed both for testing on
  that PC and for installing anywhere it's on.
- [ ] Installer from CI; the Windows Native parity column.
