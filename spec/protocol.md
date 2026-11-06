# Nextly data and sync protocol

The contract every Nextly app keeps: the Windows app (`windows/`), the Swift
apps for iOS and macOS (`apple/`), and the sync server (`server/`). The first
app, in Tauri and TypeScript, is kept on the `tauri` branch; its `app/src` is
where these rules were first written.

When a rule changes, change it here and in `spec/fixtures` first, then in
each app. CI fails until every app passes the fixtures (`scripts/check-fixtures.mjs`).

## Records

Everything syncs as records:

```json
{ "id": "…", "kind": "task", "hlc": "001792501200000-0000-a1b2c3d4", "deleted": false, "data": { … } }
```

- `id`: a UUID made by the app that created the record. Incident IQ tasks
  are `iiq-<ticket id>`; their project is `iiq-project`.
- `kind`: `task`, `project`, `area` or `iiq-action`. Apps keep records of a
  kind they don't know, and send them back unchanged.
- `deleted`: a soft delete. The data stays, so undo can restore it.
- `data`: the fields below.

### Conflicts: last writer wins, per record

Each save stamps a hybrid logical clock (`HLC.swift`, `Hlc.cs`):
`<ms since 1970, 15 digits>-<counter, 4 digits>-<device id>`. It is compared
as plain text, and the higher one wins, on the server and on every device.
A device moves its clock past every clock it sees. The server writes as
device `server` (widget and Siri changes) and `iiq` (Incident IQ sync).

A save replaces the whole record. So:

- **Unknown fields.** When an app saves a record, it keeps every field it
  didn't recognize, at every level: task, note block, repeat, `external`,
  project, area. Without this, an app would erase a field that another app
  (or a newer version) wrote. `roundtrip.json` checks this.
- **Automatic edits** (moving due tasks into Today) wait until the device has
  synced since it opened. Changing a stale copy would undo newer edits from
  elsewhere.
- **Read before you write, then write at once.** The server's Incident IQ
  sync skips a task that changed while it was waiting on Incident IQ, and
  tries again on the next poll.

### Schema version

Apps add `"schema": 1` to the data of every record they save. A record with no
`schema` counts as 1.

An app that finds a record with a higher `schema` than it supports:

- keeps it and still syncs it
- shows it, with a note that it was saved by a newer Nextly
- doesn't change it, either by hand or automatically

Raise the schema only for changes an older app can't safely save over, such
as a field whose meaning changes. **A new optional field doesn't need a new
schema**, because older apps keep unknown fields.

Supported now: **1**, in `apple/NextlyKit` (`Schema.current`) and `windows/Nextly.Core` (`Schema.Current`).

## Task data

| Field | Type | Meaning |
| --- | --- | --- |
| `title` | string | |
| `flag` | `inbox` `doing` `today` `next` `someday` or null | Which list it's in. `doing` is In Progress. null means none of its own: a subtask, a project task, or one waiting for its start date |
| `projectId` | id or null | |
| `parentId` | id or null | Set on a subtask |
| `deadline` | `YYYY-MM-DD` or null | Shown only; never used to sort |
| `startOn` | `YYYY-MM-DD` or null | Waits in Scheduled, then moves into Today on that day |
| `repeat` | object or null | `{every 1-365, unit day/week/month/year, weekdays? [0=Sun…6], from schedule/completion}` |
| `nextId` | id or null | The copy made when this repeating task was finished |
| `external` | object or null | A linked Incident IQ ticket, kept current by the server (`source: "iiq"`, `id`, `number`, `url`, `status`, `closed`, `requester`, `location`, `issue`, `priority`, `created`, `syncedAt`, `syncedTitle`) |
| `done`, `doneAt` | bool, ISO time or null | |
| `order` | number | Position in Next (and the order in other lists) |
| `dependsOn` | ids | Tasks it waits on. Deleted or missing ones don't block |
| `notes` | blocks | `{id, type, …}`; types `heading` `paragraph` `checklist` (`checked`) `quote` `divider` `image` `file` (`sha`, `name`, `size`, `mime`) `email` (`url`, `subject`, `from`) |
| `createdAt` | ISO time | |

Older forms that readers must still accept (`normalize.json`):

- `list: "inbox"` means `flag: "inbox"`.
- A `links` array becomes email blocks with ids `link0`, `link1`, …
- A block of type `text` is a paragraph.

`id` is never part of the data.

**Project**: `{title, areaId, order}`. **Area**: `{title, order}`.

**iiq-action**: `{type comment/start/resolve, taskId, ticketId, text?, resolutionActionId?, state pending/done/manual/failed, message?, createdAt, finishedAt?}`.
`resolutionActionId` is on a `resolve` only when the user picked an action
other than the server's default from the list in `GET /iiq/status`
(`resolutionActions: [{id, name}]`, `defaultResolutionActionId`); the server
refuses one that isn't on its list.
Apps create these with `state: pending`; only the server carries them out and
sets their result. The widgets and Siri never create them.

## Lists

These are defined in each app (`Lists.swift`, `Lists.cs`) and checked by `lists.json`:

- **Inbox**: open tasks with `flag: inbox`, plus loose ones (no flag, project, parent or start date). Never Incident IQ tasks. Oldest first.
- **In Progress, Today, Next, Someday**: open tasks with that flag, by `order` (Someday oldest first).
- **Scheduled**: open tasks with a start date or deadline, by that date.
- **All**: open top-level tasks, In Progress first and Someday last.
- **Logbook**: done tasks, newest first.
- **A project**: its open top-level tasks. A project made only of tickets lists the newest submitted first.

## Rules

Each app holds the rules as pure functions over records (`Rules.swift`,
`Rules.cs`), and
`actions.json` gives the cases. In short:

- **Finishing a task** finishes its open subtasks. A task that waited only on
  it moves to the end of Next, unless it's in Today or In Progress.
- **Finishing a repeating task** files a copy, with its subtasks and its
  checklists unchecked. The copy's start date comes from `nextStart`, and its
  deadline keeps the same distance from the start as before. Un-finishing
  deletes the copy if it's still open.
- **Finishing an open ticket's task** asks for notes first, then queues a
  `resolve` action. As in IIQ, the apps require notes only with the
  default resolution action; with another they're optional. Moving the task to In Progress queues `start`.
- **New ids**, in the order the rules files document. Fixtures name them `n1`,
  `n2`, …, so both apps must make them in the same order. Rules visit tasks
  in id order.

## Server API

Every request sends `Authorization: Bearer <token>`, plus any extra headers set
in Settings (Cloudflare Access). The server's own header comment
(`server/server.js`) is the full list. The apps use:

- `POST /sync {cursor, changes, deviceId}` → `{serverId, lastSeq, cursor, changes, more}`
  - Push the outbox and pull everything after `cursor`.
  - Repeat while `more` is true.
  - A new `serverId`, or `lastSeq` lower than your cursor, means the server
    lost its data. Start again from 0 and send everything.
- `PUT /files/:sha256` and `POST /files/:sha256/link`: attachments, which
  are content-addressed.
- `WS /events` (auth header, or `?ticket=` from `POST /events/ticket`):
  - `hello`, then `changed` after another device syncs, and `ping` every 25 s.
  - Reconnect after 70 s of silence.
- `GET /status`, `GET /iiq/status`: the connection check and Incident IQ status.
- The widgets and Siri use `GET /widget`, `POST /tasks` and `POST /tasks/:id/done`.
