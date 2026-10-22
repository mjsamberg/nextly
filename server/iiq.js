// Incident IQ ⇄ Nextly. Runs on the sync server so the IIQ token never
// leaves it. Enabled when IIQ_URL, IIQ_SITE_ID and IIQ_TOKEN are set.
//
// IIQ → Nextly, every IIQ_POLL_SECONDS (default 120): open tickets assigned to
// you become tasks (id "iiq-<TicketId>") in the "Incident IQ" project.
// Status, requester and location stay current; the title follows IIQ until
// you rename the task. Closed or reassigned in IIQ → task done; reopened →
// task back in the Inbox.
//
// Nextly → IIQ: devices write "iiq-action" records (comment, start, resolve)
// through normal sync; this module carries them out and writes back the
// result, so they work offline and retry. Resolve needs the district's resolution
// action (IIQ_RESOLUTION_ACTION_ID, plus IIQ_RESOLVE_REQUEST if your workflow
// needs a separate close step; see docs/incident-iq.md); until then it posts
// an internal note and asks you to close the ticket in IIQ.
//
// API (apihub.incidentiq.com): headers SiteId, Authorization, Client: ApiClient.
// Response shapes aren't documented, so fields are read defensively; run
// `node iiq-probe.js` to see your site's shapes.

const POLL_DEFAULT = 120;
const PROJECT_ID = 'iiq-project';

// ---------- client ----------

export function iiqConfig(env = process.env) {
  const url = (env.IIQ_URL || '').replace(/\/+$/, '');
  if (!url || !env.IIQ_SITE_ID || !env.IIQ_TOKEN) return null;
  let resolve = null;
  if (env.IIQ_RESOLVE_REQUEST) {
    // A bad setting here shouldn't stop sync; resolving just stays manual.
    try { resolve = JSON.parse(env.IIQ_RESOLVE_REQUEST); } catch { console.error('IIQ_RESOLVE_REQUEST is not valid JSON; ignoring it.'); }
  }
  return {
    url,
    siteId: env.IIQ_SITE_ID.trim(),
    token: env.IIQ_TOKEN.trim().replace(/^Bearer\s+/i, ''),
    userId: (env.IIQ_USER_ID || '').trim() || null,
    // Districts can require a resolution action to close a ticket
    // (community.incidentiq.com, "closing tickets via API now requiring
    // resolution action"). Finishing a ticket task in Nextly posts this one.
    resolutionActionId: (env.IIQ_RESOLUTION_ACTION_ID || '').trim() || null,
    pollSeconds: Math.max(30, Number(env.IIQ_POLL_SECONDS) || POLL_DEFAULT),
    project: env.IIQ_PROJECT || 'Incident IQ',
    ticketUrl: env.IIQ_TICKET_URL || `${url}/agent/tickets/{TicketId}`,
    resolve,
  };
}

export function createClient(cfg, fetchImpl = fetch) {
  async function call(method, path, body) {
    const res = await fetchImpl(cfg.url + path, {
      method,
      headers: {
        SiteId: cfg.siteId,
        Authorization: `Bearer ${cfg.token}`,
        Client: 'ApiClient',
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error(`Incident IQ refused the request (${res.status}). Check IIQ_TOKEN and IIQ_SITE_ID.`);
    if (!res.ok) throw new Error(`Incident IQ answered ${res.status} for ${method} ${path}${text ? `: ${text.slice(0, 200)}` : ''}`);
    try { return text ? JSON.parse(text) : null; } catch { throw new Error(`Incident IQ sent something other than JSON for ${path}.`); }
  }
  const items = (r) => (Array.isArray(r) ? r : r?.Items ?? r?.Tickets ?? r?.Results ?? []);

  return {
    call,
    /** Open tickets assigned to the token's user (the list also has unassigned ones). */
    async myOpenTickets() {
      const out = [];
      for (let page = 0; page < 20; page++) {
        const r = await call('POST', `/api/v1.0/tickets/-/-/AssignedToMe_Unassigned?$p=${page}&$s=100&$o=TicketModifiedDate&$d=Descending`, {});
        const batch = items(r);
        out.push(...batch);
        if (batch.length < 100) break;
      }
      return out;
    },
    ticket: (id) => call('GET', `/api/v1.0/tickets/${id}`).then((r) => r?.Item ?? r),
    comment: (id, text) => call('POST', `/api/v1.0/tickets/${id}/activities/new`, {
      TicketId: id,
      ActivityItems: [{ $type: 'Spark.Shared.Models.TicketActivityComment, Spark.Shared', TicketActivityTypeId: 6, Comments: text }],
      IsPublic: false, WaitForResponse: false, TicketWasUpdated: false,
    }),
    start: (id, userId) => call('POST', `/api/v1.0/tickets/${id}/start`, userId ? { UserId: userId } : {}),
    /** A resolution action (activity type 8), which is how tickets get resolved. */
    resolution: (id, actionId, notes) => call('POST', `/api/v1.0/tickets/${id}/activities/new`, {
      TicketId: id,
      IsPublic: true,
      ActivityItems: [{
        $type: 'Spark.Shared.Models.TicketActivityAction, Spark.Shared',
        TicketActivityTypeId: 8,
        ResolutionActionId: actionId,
        Notes: notes || null,
        IsPublic: false,
        Meta: null,
      }],
    }),
    nextSteps: (id) => call('GET', `/api/v1.0/tickets/${id}/next-steps`),
  };
}

// ---------- reading IIQ's (undocumented) ticket shape ----------

const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
const name = (o) => (typeof o === 'string' ? o : pick(o?.Name, o?.FullName, [o?.FirstName, o?.LastName].filter(Boolean).join(' ')));

export function readTicket(t, cfg) {
  const id = pick(t.TicketId, t.Id);
  const assigned = pick(t.AssignedToUserId, t.AssignedToUser?.UserId, t.AgentId, t.AssignedToUser?.Id);
  const closedDate = pick(t.ClosedDate, t.TicketClosedDate);
  return {
    id: id ? String(id) : null,
    number: pick(t.TicketNumber, t.Number),
    subject: String(pick(t.Subject, t.TicketSubject, t.Issue?.Name, t.IssueName, 'Untitled ticket')).trim().slice(0, 300),
    status: pick(t.WorkflowStep?.StepName, t.WorkflowStepName, t.TicketStatusName, t.Status?.Name, typeof t.Status === 'string' ? t.Status : undefined, t.TicketState) ?? null,
    closed: Boolean(pick(t.IsClosed, closedDate ? true : undefined, false)),
    modified: pick(t.ModifiedDate, t.TicketModifiedDate, t.LastActivityDate) ?? null,
    assignedTo: assigned ? String(assigned) : null,
    requester: name(pick(t.For, t.ForUser, t.Owner)) || [t.ForFirstName, t.ForLastName].filter(Boolean).join(' ') || null,
    location: [name(t.Location) ?? t.LocationName, name(t.LocationRoom) ?? t.LocationRoomName].filter(Boolean).join(', ') || null,
    issue: pick(name(t.Issue), t.IssueName, name(t.IssueCategory)) ?? null,
    priority: pick(t.Priority?.Name, t.PriorityName, typeof t.Priority === 'string' ? t.Priority : undefined) ?? null,
    description: String(pick(t.IssueDescription, t.Description, '') ?? '').trim().slice(0, 5000),
    url: id ? cfg.ticketUrl.replace('{TicketId}', id) : null,
  };
}

/** The user id inside the token (IIQ tokens are JWTs), if it's there. */
export function userIdFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const k of ['UserId', 'userId', 'userid', 'uid', 'sub', 'nameid']) if (guid.test(String(payload[k] ?? ''))) return String(payload[k]);
    for (const v of Object.values(payload)) if (guid.test(String(v))) return String(v);
  } catch { /* not a JWT */ }
  return null;
}

// ---------- sync ----------

export function createIiq({ db, applyChanges, onChange, cfg, client = cfg && createClient(cfg), now = () => new Date() }) {
  const state = { enabled: !!cfg, lastSync: null, lastError: null, tickets: 0, running: false };
  if (!cfg) return { state, start() {}, processActions() {}, status: () => ({ enabled: false }) };

  const me = cfg.userId ?? userIdFromToken(cfg.token);
  const getRec = db.prepare('SELECT id, kind, hlc, deleted, data FROM records WHERE id = ?');
  const iiqTasks = db.prepare("SELECT id, hlc, deleted, data FROM records WHERE kind = 'task' AND id LIKE 'iiq-%'");
  const pendingActions = db.prepare("SELECT id, hlc, data FROM records WHERE kind = 'iiq-action' AND deleted = 0 AND json_extract(data, '$.state') = 'pending'");

  const hlcAfter = (prev) => {
    const ms = Math.max(Date.now(), (Number(String(prev || '').split('-')[0]) || 0) + 1);
    return `${String(ms).padStart(15, '0')}-0000-iiq`;
  };
  const write = (rows) => { if (rows.length) { applyChanges(rows); onChange(); } };
  const record = (id, kind, data, prevHlc, deleted = false) => ({ id, kind, hlc: hlcAfter(prevHlc), deleted, data });

  function ensureProject(rows) {
    const p = getRec.get(PROJECT_ID);
    if (!p || p.deleted) rows.push(record(PROJECT_ID, 'project', { title: cfg.project, areaId: null, order: 0 }, p?.hlc));
  }

  function newTask(tk) {
    const details = [tk.requester && `Requested by ${tk.requester}`, tk.location, tk.issue, tk.priority && `Priority: ${tk.priority}`].filter(Boolean).join(' · ');
    const notes = [];
    if (details) notes.push({ id: `iiq-${tk.id}-d`, type: 'paragraph', text: details });
    if (tk.description) notes.push({ id: `iiq-${tk.id}-desc`, type: 'quote', text: tk.description });
    return {
      title: titleOf(tk), flag: 'inbox', projectId: PROJECT_ID, parentId: null, deadline: null,
      startOn: null, repeat: null, nextId: null, done: false, doneAt: null,
      order: Date.now(), dependsOn: [], notes, createdAt: now().toISOString(),
      external: external(tk, titleOf(tk)),
    };
  }
  const titleOf = (tk) => `#${tk.number ?? '?'} ${tk.subject}`;
  const external = (tk, syncedTitle) => ({
    source: 'iiq', id: tk.id, number: tk.number ?? null, url: tk.url, status: tk.status, closed: tk.closed,
    modified: tk.modified, requester: tk.requester, location: tk.location, issue: tk.issue, priority: tk.priority,
    syncedTitle, syncedAt: now().toISOString(),
  });

  /** One pass: bring IIQ's view of my open tickets into Nextly. */
  async function syncOnce() {
    if (state.running) return;
    state.running = true;
    try {
      const raw = await client.myOpenTickets();
      // The list also holds unassigned tickets; keep mine (or any assigned
      // one if the token doesn't say who "me" is).
      const mine = raw.map((t) => readTicket(t, cfg)).filter((t) => t.id && !t.closed && t.assignedTo && (!me || t.assignedTo.toLowerCase() === me.toLowerCase()));
      const rows = [];
      ensureProject(rows);
      const open = new Set();
      for (const tk of mine) {
        open.add(`iiq-${tk.id}`);
        const cur = getRec.get(`iiq-${tk.id}`);
        if (!cur || cur.deleted) {
          if (!cur) rows.push(record(`iiq-${tk.id}`, 'task', newTask(tk)));
          continue; // deleted in Nextly: leave it deleted
        }
        const d = JSON.parse(cur.data);
        const ext = d.external ?? {};
        const titleFollowsIiq = d.title === ext.syncedTitle;
        // Reopen only if IIQ had closed it. A task you finished in Nextly
        // while the ticket is still open in IIQ stays done.
        const reopened = d.done && ext.closed === true;
        const changed = ext.status !== tk.status || ext.modified !== tk.modified || ext.requester !== tk.requester || ext.location !== tk.location
          || (titleFollowsIiq && d.title !== titleOf(tk)) || reopened;
        if (!changed) continue;
        rows.push(record(cur.id, 'task', {
          ...d,
          title: titleFollowsIiq ? titleOf(tk) : d.title,
          ...(reopened ? { done: false, doneAt: null, flag: 'inbox' } : {}),
          external: external(tk, titleFollowsIiq ? titleOf(tk) : ext.syncedTitle),
        }, cur.hlc));
      }
      // Tasks whose tickets left my open list: closed or reassigned.
      for (const cur of iiqTasks.all()) {
        if (cur.deleted || open.has(cur.id)) continue;
        const d = JSON.parse(cur.data);
        if (d.external?.source !== 'iiq' || (d.done && d.external.closed)) continue;
        let status = 'Closed';
        try {
          const tk = readTicket(await client.ticket(d.external.id), cfg);
          if (!tk.closed && tk.assignedTo && me && tk.assignedTo.toLowerCase() !== me.toLowerCase()) status = 'Reassigned';
          else if (!tk.closed && !tk.assignedTo) status = 'Unassigned';
          else status = tk.status ?? 'Closed';
        } catch { /* gone or unreadable: treat as closed */ }
        rows.push(record(cur.id, 'task', {
          ...d, done: true, doneAt: d.done ? d.doneAt : now().toISOString(),
          external: { ...d.external, status, closed: true, syncedAt: now().toISOString() },
        }, cur.hlc));
      }
      write(rows);
      state.tickets = mine.length;
      state.lastSync = now().toISOString();
      state.lastError = null;
      await processActions();
    } catch (e) {
      state.lastError = e.message;
    } finally {
      state.running = false;
    }
  }

  let acting = false;
  /** Carries out pending comment / start / resolve requests from devices. */
  async function processActions() {
    if (acting) return;
    acting = true;
    try {
      for (const a of pendingActions.all()) {
        const d = JSON.parse(a.data);
        let result;
        try {
          if (d.type === 'comment') {
            await client.comment(d.ticketId, String(d.text ?? '').slice(0, 10000));
            result = { state: 'done', message: 'Posted to Incident IQ as an internal comment.' };
          } else if (d.type === 'start') {
            await client.start(d.ticketId, me);
            result = { state: 'done', message: 'Started in Incident IQ.' };
          } else if (d.type === 'resolve') {
            // Resolution action first (required by many districts), then the
            // district's own close request if it needs one.
            const actionId = d.resolutionActionId || cfg.resolutionActionId;
            if (actionId) await client.resolution(d.ticketId, actionId, d.text || 'Resolved in Nextly.');
            if (cfg.resolve) await client.call(cfg.resolve.method ?? 'POST', fill(cfg.resolve.path, d), fill(cfg.resolve.body ?? {}, d));
            if (actionId || cfg.resolve) {
              result = { state: 'done', message: 'Resolved in Incident IQ.' };
            } else {
              await client.comment(d.ticketId, 'Marked done in Nextly.');
              result = { state: 'manual', message: 'Close this ticket in Incident IQ. Nextly can’t close tickets until IIQ_RESOLUTION_ACTION_ID is set (docs/incident-iq.md).' };
            }
          } else {
            result = { state: 'failed', message: `Unknown action “${d.type}”.` };
          }
        } catch (e) {
          // Keep retrying failures that look temporary; give up on the rest.
          const temporary = /fetch failed|timeout|ECONN|5\d\d/.test(e.message);
          const tries = (d.tries ?? 0) + 1;
          result = temporary && tries < 10 ? { state: 'pending', tries, message: e.message } : { state: 'failed', message: e.message };
        }
        write([record(a.id, 'iiq-action', { ...d, ...result, finishedAt: result.state === 'pending' ? null : now().toISOString() }, a.hlc)]);
      }
    } finally {
      acting = false;
    }
  }

  const fill = (v, d) => {
    const map = { TicketId: d.ticketId, UserId: me ?? '', Now: now().toISOString() };
    const sub = (s) => s.replace(/\{(TicketId|UserId|Now)\}/g, (_, k) => map[k]);
    return typeof v === 'string' ? sub(v) : JSON.parse(sub(JSON.stringify(v)));
  };

  let timer = null;
  return {
    state,
    start() {
      void syncOnce();
      timer = setInterval(() => void syncOnce(), cfg.pollSeconds * 1000);
      timer.unref?.();
    },
    stop() { clearInterval(timer); },
    syncOnce,
    processActions,
    status: () => ({
      enabled: true, lastSync: state.lastSync, lastError: state.lastError, tickets: state.tickets,
      pollSeconds: cfg.pollSeconds, canResolve: !!(cfg.resolutionActionId || cfg.resolve), knowsUser: !!me,
    }),
  };
}
