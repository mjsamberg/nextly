# Incident IQ ⇄ Nextly

Open tickets assigned to you in Incident IQ (IIQ) show up as tasks in an
**Incident IQ** project, and what you do in Nextly goes back to IIQ:

| In Nextly | In Incident IQ |
| --- | --- |
| New ticket assigned to you | Task in the Incident IQ project (never the Inbox), with requester, location, issue and description in its notes |
| Ticket's status or subject changes | Task's status chip and title update (the title stops following IIQ once you rename it) |
| Ticket closed, or reassigned to someone else | Task is completed |
| Ticket reopened | Task is open again in the Incident IQ project |
| **Post to Incident IQ** (in the task's Incident IQ panel) | Internal comment on the ticket |
| Mark the task **In Progress** | Ticket is started |
| Finish the task (Nextly asks for resolution notes) | Ticket is resolved with your resolution action and those notes (or, until that's set, gets an internal note and you close it in IIQ) |

The widget and Siri never change tickets: completing a ticket's task there
is refused, so you resolve it in the app with notes.

It runs on the Nextly server, which checks IIQ every 2 minutes. Your IIQ
token stays on the server; devices only send "post this comment / start /
resolve" requests through normal sync, so those work offline and retry.
Each request's result shows in the task's Incident IQ panel.

> **Student information.** Ticket tasks can hold more than directory
> information about students (names tied to device problems, ticket
> descriptions). They're stored on your Nextly server and devices. Follow
> district guidance on where student information may be kept.

## 1. Get your IIQ details

In Incident IQ: **Administration → Developer Tools**. Copy your **Site ID**
and create (or copy) your **API token**. Use your own token, because
"assigned to me" means the token's user.

## 2. Add them to the server's `.env`

```bash
IIQ_URL=https://chathamnc.incidentiq.com
IIQ_SITE_ID=…
IIQ_TOKEN=…
IIQ_USER_EMAIL=you@chatham.k12.nc.us
```

`IIQ_USER_EMAIL` is your Incident IQ login email. Nextly looks up that user
and keeps only tickets assigned to them, which matters for admins, who can
see every ticket. If the lookup fails, sync stops with an error rather than
pulling everyone's tickets; set `IIQ_USER_ID` instead.

Then restart:

```bash
docker compose up -d --build
```

The server log says `Incident IQ sync on.` In any Nextly app, **Settings →
Incident IQ** shows how many tickets it found and when it last checked.

## 3. Check the fit with the probe

Incident IQ doesn't document its response formats, so Nextly reads several
likely field names. The probe shows which ones your site uses. It prints
field names and types only (plus status and workflow names), never ticket
text or people, so it's safe to share:

```bash
docker compose exec nextly node iiq-probe.js --steps
```

Look for `NOT FOUND` under "How Nextly reads the first ticket". If anything
important is missing, send the output and the reading can be adjusted.

The "Open-only filter" line says whether Nextly can ask Incident IQ for just
your open tickets (one request) instead of all of them, closed included. It
uses the filter only when it finds exactly the same open tickets as the full
list, and checks that again every 6 hours. Either way, a task is marked done
only after its own ticket is looked up and found closed or reassigned.

## 4. Turn on resolving from Nextly

Many districts require a **resolution action** to close a ticket, so Nextly
needs the ID of the one to use (for example "Resolved" or "Repaired"). The
quickest way to find it is to list your site's resolution actions and ticket
statuses with their IDs (read-only; prints configuration names, not tickets
or people):

```bash
docker compose exec nextly node iiq-options.js
```

If that doesn't find them, use the browser instead:

1. In Incident IQ, open a test ticket assigned to you, with your browser's
   developer tools open on the **Network** tab.
2. Resolve it the way you normally would, choosing the resolution action you
   want Nextly to use.
3. Find the request to `.../activities/new`. In its payload, copy the
   `ResolutionActionId` value (a long ID like `ab026d86-…`).
4. Add it to `.env` and restart:

   ```bash
   IIQ_RESOLUTION_ACTION_ID=ab026d86-…
   ```

If resolving that way leaves tickets open (some workflows need a separate
close step), look in the same Network tab for the request your browser sent
right after it, and put it in `IIQ_RESOLVE_REQUEST`. `{TicketId}`, `{UserId}`
and `{Now}` are filled in:

```bash
IIQ_RESOLVE_REQUEST={"method":"POST","path":"/api/v1.0/tickets/{TicketId}/…","body":{…}}
```

It must be a POST or PUT to `/api/v1.0/tickets/{TicketId}/…` or
`/services/tickets/{TicketId}/…`; anything else is ignored (see Safeguards).

## Safeguards

Your IIQ token carries your full IIQ rights (an admin's, in your case), so
the server limits what it will do with it, to keep a bug, a lost device or a
leaked sync token from reaching beyond your own tickets:

- **Reads on their own never change anything.** Syncing only reads. Changes
  happen only when you post a comment, mark a task In Progress, or finish
  one with notes, and each shows in the task's Incident IQ panel.
- **One ticket per change, on a short list of paths.** The server refuses to
  send IIQ anything but reads, the ticket searches, and three single-ticket
  changes (comment, start, resolve). Bulk paths, other records (users,
  assets), deletes, and a change whose body names a different ticket are
  blocked before they leave the server.
- **Only your open tickets, checked live.** Before each change the server
  looks the ticket up and refuses if it's closed or no longer assigned to
  you. The request must also match the ticket task the server itself
  created.
- **No replays or repeats.** Requests older than 3 days are refused, and a
  ticket is started or resolved at most once per batch.
- **Rate limit.** At most 30 changes an hour; the rest wait their turn.
- **Settings stay on the server.** Devices can't choose the resolution
  action or the close request; those come only from `.env`.
- **Read-only tools.** `iiq-probe.js` and `iiq-options.js` can't send any
  change at all.
- **A log.** The server log records each change (ticket number and kind,
  not the text) and each refusal: `docker compose logs nextly | grep "Incident IQ"`.

The token is still your own, with your rights in IIQ itself. Keep `.env`
readable only by you on the server.

## Other settings

| Setting | Default | What it does |
| --- | --- | --- |
| `IIQ_USER_EMAIL` | none | Your IIQ email; only tickets assigned to this user sync |
| `IIQ_USER_ID` | from the email | Your IIQ user ID, if the email lookup doesn't find you (wins over the email) |
| `IIQ_POLL_SECONDS` | `120` | How often to check IIQ (minimum 30) |
| `IIQ_PROJECT` | `Incident IQ` | Name of the project tickets go into |
| `IIQ_TICKET_URL` | `<IIQ_URL>/agent/tickets/{TicketId}` | Where **Open in Incident IQ** goes |
| `IIQ_PRODUCT_ID` | (none) | Sent as a `ProductId` header, if your site wants one (Developer Tools shows it) |

## Notes

- Deleting a ticket's task in Nextly stops it from coming back; the ticket
  itself is untouched.
- Comments are posted as internal (not visible to the requester).
- Built from Incident IQ's API reference (apihub.incidentiq.com) and the
  community thread on closing tickets with resolution actions. Where IIQ's
  formats weren't documented, the probe is how to confirm them.
