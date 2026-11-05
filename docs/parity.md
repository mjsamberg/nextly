# Feature checklist: the Windows and Swift apps

Each platform now has a native app on the same server and data format: the
Windows app (`windows/`, WinUI 3) and the Swift app for Mac, iPhone and iPad
(`apple/`). The first app, Tauri + React for all three, was retired on
2026-10-24 and is kept on the `tauri` branch; its column below is the list of
features it had, which the native apps are measured against.

Key: ✅ done (for Swift: built and checked on the iPhone simulator, in the Mac app, or against a test server; for Windows: built and checked in the app on the Windows PC, or by `dotnet test` against the real server) · ⬜ not yet · — not applicable.
The Swift app hasn't been checked on a real iPhone, an iPad or visually on the Mac yet.
The rules behind a row are covered by `spec/fixtures` (named in brackets).
Swift rows marked done for data and sync are in `apple/NextlyKit` and its tests;
rows about the rules (lists, quick add, repeats, dependencies) also pass the
fixtures there, but stay unchecked until the app shows them.

## Data and sync

| Feature | Tauri (retired) | Swift | Windows |
| --- | --- | --- | --- |
| Records, HLC, last writer wins (`spec/protocol.md`) | ✅ | ✅ | ✅ |
| Keeps unknown fields when saving [roundtrip] | ✅ | ✅ | ✅ |
| Schema version: stamps `schema: 1`; newer records read-only with a note [roundtrip, actions: promote-due] | ✅ | ✅ | ✅ |
| Sync: outbox, cursor, `more`, a server that lost its data, "edited while in flight" | ✅ | ✅ | ✅ |
| Two server addresses with failover; extra headers (Cloudflare Access) [network] | ✅ | ✅ | ✅ |
| Live updates (WebSocket; 70 s watchdog; backoff) | ✅ | ✅ | ✅ |
| Polling fallback; sync on focus and when back online | ✅ | ⬜ (polling and sync on returning to the app done; no trigger yet when the network comes back) | ⬜ (all three built; not yet checked) |
| Due tasks move into Today only after a sync since launch [actions: promote-due] | ✅ | ✅ | ✅ |
| Attachments: stored locally, uploaded, opened through a signed link | ✅ | ✅ | ✅ |
| Check connection report | ✅ | ⬜ (built; not yet checked) | ✅ |

## Lists and navigation

| Feature | Tauri (retired) | Swift | Windows |
| --- | --- | --- | --- |
| Inbox, In Progress, Today, Next, Scheduled, Someday, All, Logbook, projects [lists] | ✅ | ✅ (Scheduled, All and Logbook built; not yet checked) | ✅ (Scheduled, Someday, All and Logbook built; not yet checked) |
| Sidebar counts [lists] | ✅ | ✅ | ✅ |
| Areas and projects in the sidebar; new project/area inline | ✅ | ✅ (adding inline built; not yet checked) | ✅ (adding is a dialog; built, not yet checked) |
| Search over titles and notes [lists: search] | ✅ | ⬜ (built; not yet checked) | ⬜ (built; not yet checked) |
| Today: In Progress first, grouped by project, "Up next" (5) | ✅ | ✅ | ✅ |
| All: grouped by area and project | ✅ | ⬜ (built; not yet checked) | ⬜ (built; not yet checked) |
| Next: drag to reorder [actions: move-in-next] | ✅ | ✅ (checked in the Mac app; not yet on iPad or iPhone) | ✅ |
| Drag a task onto a sidebar list (flags it) or project (moves it) | — | ✅ (checked in the Mac app; iPad not yet; on iPhone the sidebar isn't beside the list) | ✅ |
| Empty-list messages | ✅ | ✅ | ⬜ (built; not yet checked) |
| Phone: one pane at a time, swipe from the edge to go back | ✅ | ✅ | — (a narrow window shows the task over the list, with Back) |
| Row chips: subtasks, mail, attachments, waiting, flag, ticket status, repeat, start, deadline | ✅ | ✅ | ✅ |
| Row swipes: right promotes, left defers [flags] | ✅ | ✅ | — (right-click menu for flags; touch swipes not built) |

## Tasks

| Feature | Tauri (retired) | Swift | Windows |
| --- | --- | --- | --- |
| Quick add with `!flag ^deadline @start *repeat` and pasted mail links [quick-add, date-words, repeats] | ✅ | ✅ | ⬜ (rules pass the fixtures; the quick-add box not yet typed into) |
| Detail: title, flag, start date, deadline, repeat picker, project | ✅ | ✅ | ✅ (the date and repeat pickers not yet tried) |
| Repeating tasks: next copy on finishing [repeats, actions: repeat-*] | ✅ | ✅ | ✅ |
| Subtasks | ✅ | ✅ (adding built; not yet checked) | ✅ (adding built; not yet checked) |
| Dependencies, loops refused, freed tasks move to Next [actions: dependency-*, done-frees-waiting] | ✅ | ✅ (adding built; not yet checked) | ✅ (adding built; not yet checked) |
| Delete with undo [actions: delete-with-subtasks] | ✅ | ✅ | ✅ |
| Notes: heading, paragraph, checklist, quote, divider; Enter splits, Backspace merges, "/" menu | ✅ | ✅ | ✅ (Backspace on an empty block removes it; the "/" menu not yet tried) |
| Images and files in notes | ✅ | ✅ | ⬜ (built; Windows' file picker not yet tried) |
| Email cards (Gmail, Apple Mail `message:`) | ✅ | ✅ | ✅ |
| Projects and areas: rename, move, delete [actions: delete-project, delete-area] | ✅ | ⬜ (built; not yet checked) | ⬜ (built; not yet checked) |

## Incident IQ

| Feature | Tauri (retired) | Swift | Windows |
| --- | --- | --- | --- |
| Ticket panel: number, status, details, open in Incident IQ | ✅ | ✅ | ✅ |
| Internal comments and the action log | ✅ | ✅ (queued and shown; carrying them out is the server's job) | ⬜ (built; posting a comment not yet tried) |
| In Progress starts the ticket [actions: ticket-start] | ✅ | ✅ | ✅ |
| Finishing asks for resolution notes [actions: ticket-needs-notes, ticket-resolve] | ✅ | ✅ | ✅ (checked against a real server) |
| Choosing the resolution action when resolving [actions: ticket-resolve-chosen-action] | — | ⬜ (built; not yet checked) | ⬜ (built; not yet checked) |
| Incident IQ status in Settings | ✅ | ✅ | ⬜ (built; checked only with Incident IQ off) |

## Settings and district rules

| Feature | Tauri (retired) | Swift | Windows |
| --- | --- | --- | --- |
| Server addresses, token, header rows with the Cloudflare preset | ✅ | ✅ | ✅ |
| Student information warning: privacy note in Settings | ✅ | ✅ | ✅ |
| Student information warning: Incident IQ ticket tasks | ✅ | ✅ | ✅ |
| Student information warning when attaching files | ⬜ (built; not yet checked in the app) | ✅ | ✅ |
| District branding: plum, navy, gold, mist; Oswald headings, Mulish body | ✅ | ✅ | ✅ (light and dark) |
| Keyboard shortcuts (⌘N, ⌘K, ⌘T, ⌘⇧T, ⌘D, ⌘↩, ⌘,, Esc, Delete) | ✅ | ⬜ (built; not yet checked; ⌘K needs macOS 15 / iOS 18) | ⬜ (Ctrl versions built; not yet checked) |
| Quick add and shortcut help | ✅ | ✅ | ✅ |

## Platform

| Feature | Tauri (retired) | Swift | Windows |
| --- | --- | --- | --- |
| `nextly://add` links (bookmarklet) [capture-links] | ✅ | ✅ (iOS too, which the Tauri app lacks) | ✅ (a second launch hands its link to the running copy) |
| App icon | ✅ | ✅ | ✅ |
| Widgets: Today, Next; finish from the widget | — | ⬜ (built; the app shares settings and a snapshot with them, checked in the simulator; not yet placed on a home screen) | — |
| Siri: add a task, read a list | — | ⬜ (built; tasks Siri saves offline are added on launch, checked; Siri itself not yet tried) | — |
| Widgets open the app on tap | — | ⬜ (nextly://open and nextly://list checked in the app; tapping a placed widget not yet tried) | — |
| Signed and notarized Mac build; iOS build from CI | — | ⬜ (CI jobs ready; need the identifiers registered and NATIVE_SIGNING on, docs/apple-signing.md) | — |
| Installer from CI (Windows) | ✅ (MSI and setup.exe) | — | ⬜ (per-user installer built in CI; unsigned) |

## What's left

- **Windows code signing.** The installer (`nextly-windows-native`, built by
  CI) isn't signed: SmartScreen warns on first run, and PCs with Smart App
  Control on won't run it.
- **Every ⬜ row above checked**, for both apps, and then a week of daily use
  with both on the same server.

How the Windows app was built and checked (a C# core passing every shared
case and the sync tests, then the WinUI app, then the installer) is in the
commit history from 2026-10-24.
