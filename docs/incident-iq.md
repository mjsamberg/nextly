# Incident IQ ⇄ Nextly

Open tickets assigned to you in Incident IQ (IIQ) show up as tasks in an
**Incident IQ** project, and what you do in Nextly goes back to IIQ:

| In Nextly | In Incident IQ |
| --- | --- |
| New ticket assigned to you | Task in the Inbox, with requester, location, issue and description in its notes |
| Ticket's status or subject changes | Task's status chip and title update (the title stops following IIQ once you rename it) |
| Ticket closed, or reassigned to someone else | Task is completed |
| Ticket reopened | Task comes back to the Inbox |
| **Post to Incident IQ** (in the task's Incident IQ panel) | Internal comment on the ticket |
| Mark the task **In Progress** | Ticket is started |
| Finish the task | Ticket is resolved with your resolution action (or, until that's set, gets an internal note and you close it in IIQ) |

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
```

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

## 4. Turn on resolving from Nextly

Many districts require a **resolution action** to close a ticket, so Nextly
needs the ID of the one to use (for example "Resolved" or "Repaired"). To find
it:

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

## Other settings

| Setting | Default | What it does |
| --- | --- | --- |
| `IIQ_USER_ID` | from the token | Your IIQ user ID, if the probe says it can't find it in the token |
| `IIQ_POLL_SECONDS` | `120` | How often to check IIQ (minimum 30) |
| `IIQ_PROJECT` | `Incident IQ` | Name of the project tickets go into |
| `IIQ_TICKET_URL` | `<IIQ_URL>/agent/tickets/{TicketId}` | Where **Open in Incident IQ** goes |

## Notes

- Deleting a ticket's task in Nextly stops it from coming back; the ticket
  itself is untouched.
- Comments are posted as internal (not visible to the requester).
- Built from Incident IQ's API reference (apihub.incidentiq.com) and the
  community thread on closing tickets with resolution actions. Where IIQ's
  formats weren't documented, the probe is how to confirm them.
