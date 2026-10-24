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
| Notes: heading, paragraph, checklist, quote, divider; Enter splits, Backspace merges, "/" menu | ✅ | ⬜ (shown read-only; editor is Phase 3) |
| Images and files in notes | ✅ | ⬜ (names shown; Phase 3) |
| Email cards (Gmail, Apple Mail `message:`) | ✅ | ⬜ (open as links; editing is Phase 3) |
| Projects and areas: rename, move, delete [actions: delete-project, delete-area] | ✅ | ⬜ (built; not yet checked) |

## Incident IQ

| Feature | Windows | Swift |
| --- | --- | --- |
| Ticket panel: number, status, details, open in Incident IQ | ✅ | ⬜ (number, status, details and link; full panel is Phase 3) |
| Internal comments and the action log | ✅ | ⬜ |
| In Progress starts the ticket [actions: ticket-start] | ✅ | ✅ |
| Finishing asks for resolution notes [actions: ticket-needs-notes, ticket-resolve] | ✅ | ⬜ (built; not yet checked) |
| Incident IQ status in Settings | ✅ | ✅ |

## Settings and district rules

| Feature | Windows | Swift |
| --- | --- | --- |
| Server addresses, token, header rows with the Cloudflare preset | ✅ | ✅ |
| Student information warning: privacy note in Settings | ✅ | ✅ |
| Student information warning: Incident IQ ticket tasks | ✅ | ✅ |
| Student information warning when attaching files | ⬜ | ⬜ |
| District branding: plum, navy, gold, mist; Oswald headings, Mulish body | ✅ | ✅ |
| Keyboard shortcuts (⌘N, ⌘K, ⌘T, ⌘⇧T, ⌘D, ⌘↩, ⌘,, Esc, Delete) | ✅ | ⬜ (built; not yet checked; ⌘K needs macOS 15 / iOS 18) |
| Quick add and shortcut help | ✅ | ✅ |

## Platform

| Feature | Windows | Swift |
| --- | --- | --- |
| `nextly://add` links (bookmarklet) [capture-links] | ✅ | ⬜ (also iOS, new) |
| Widgets: Today, Next; finish from the widget | — | ⬜ |
| Siri: add a task, read a list | — | ⬜ |
| Widgets open the app on tap | — | ⬜ (new) |
| Signed and notarized Mac build; iOS build from CI | — | ⬜ |
