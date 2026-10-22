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
// Safeguards (docs/incident-iq.md): the client sends only reads and
// single-ticket changes on known paths (allowed()); each action is vetted
// live against your open tickets (vet()) and rate-limited.
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
    // It may only change the one ticket being resolved.
    if (resolve && (!/^\/(api\/v1\.0|services)\/tickets\/\{TicketId\}(\/[A-Za-z0-9-]+)+$/.test(resolve.path ?? '') || !['POST', 'PUT', undefined].includes(resolve.method))) {
      console.error('IIQ_RESOLVE_REQUEST must be a POST or PUT to /api/v1.0/tickets/{TicketId}/… or /services/tickets/{TicketId}/…; ignoring it.');
      resolve = null;
    }
  }
  return {
    url,
    siteId: env.IIQ_SITE_ID.trim(),
    token: env.IIQ_TOKEN.trim().replace(/^Bearer\s+/i, ''),
    userId: (env.IIQ_USER_ID || '').trim() || null,
    // Admins can see every ticket, so name yourself: the sync looks up this
    // user and keeps only tickets assigned to them.
    userEmail: (env.IIQ_USER_EMAIL || '').trim().toLowerCase() || null,
    // Districts can require a resolution action to close a ticket
    // (community.incidentiq.com, "closing tickets via API now requiring
    // resolution action"). Finishing a ticket task in Nextly posts this one.
    resolutionActionId: (env.IIQ_RESOLUTION_ACTION_ID || '').trim() || null,
    // Some IIQ calls also want the product (ticketing) id; optional.
    productId: (env.IIQ_PRODUCT_ID || '').trim() || null,
    pollSeconds: Math.max(30, Number(env.IIQ_POLL_SECONDS) || POLL_DEFAULT),
    project: env.IIQ_PROJECT || 'Incident IQ',
    ticketUrl: env.IIQ_TICKET_URL || `${url}/agent/tickets/{TicketId}`,
    resolve,
  };
}

const query = (page) => `?$p=${page}&$s=100&$o=TicketModifiedDate&$d=Descending`;
/** Ways to list my open tickets, most specific first. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_WAYS = [
  { name: 'POST /api/v1.0/tickets/-/-/AssignedToMe_Unassigned', request: (p) => ['POST', `/api/v1.0/tickets/-/-/AssignedToMe_Unassigned${query(p)}`, {}] },
  { name: 'POST /services/tickets/-/-/AssignedToMe_Unassigned', request: (p) => ['POST', `/services/tickets/-/-/AssignedToMe_Unassigned${query(p)}`, {}] },
  // The general search, filtered to tickets where I'm the agent (closed ones
  // are dropped later). Id facets take "Id", like the documented location
  // and asset filters; given "Value", a site can ignore the filter and
  // return everyone's tickets, which isMine() then catches.
  { name: 'POST /api/v1.0/tickets (agent = you)', needsMe: true, onlyMine: true, request: (p, me) => ['POST', `/api/v1.0/tickets${query(p)}`, { Schema: 'All', Filters: [{ Facet: 'agent', Id: me }] }] },
];

// Everything the server may send to Incident IQ. Reads are GETs plus the
// searches below, which use POST. Changes go to one ticket per request, on
// these paths only (plus a validated IIQ_RESOLVE_REQUEST), so nothing here
// can change tickets in bulk or touch anything but tickets.
const TID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const READ_POSTS = [
  /^\/(api\/v1\.0|services)\/tickets$/,
  /^\/(api\/v1\.0|services)\/tickets\/-\/-\/AssignedToMe_Unassigned$/,
  /^\/(api\/v1\.0|services)\/search\/v2$/,
  /^\/services\/users$/,
  /^\/(api\/v1\.0|services)\/filters$/,
];
const WRITES = [
  new RegExp(`^/api/v1\\.0/tickets/(${TID})/activities/new$`, 'i'), // comment, resolution action
  new RegExp(`^/(?:api/v1\\.0|services)/tickets/(${TID})/start$`, 'i'),
];

/**
 * @param {object} [opts]
 * @param {boolean} [opts.readOnly] refuse every change (the probe and iiq-options.js)
 */
export function createClient(cfg, fetchImpl = fetch, { readOnly = false } = {}) {
  const writes = [...WRITES];
  if (cfg.resolve) writes.push(new RegExp(`^${cfg.resolve.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace('{TicketId}', `(${TID})`)}$`, 'i'));

  /** Throws unless the request is a read or a change to exactly one ticket. */
  function allowed(method, path, body) {
    const p = path.split('?')[0];
    if (method === 'GET') return;
    if (method === 'POST' && READ_POSTS.some((r) => r.test(p))) return;
    const refuse = (why) => { throw Object.assign(new Error(`Blocked: ${method} ${p} (${why}).`), { status: 0, blocked: true }); };
    if (readOnly) refuse('this tool only reads');
    const m = writes.map((r) => p.match(r)).find(Boolean);
    if (!m) refuse('not a change Nextly makes');
    if (path.includes('?')) refuse('changes take no query');
    if (body?.TicketId !== undefined && String(body.TicketId).toLowerCase() !== m[1].toLowerCase()) refuse('the body names a different ticket');
  }

  async function call(method, path, body) {
    allowed(method, path, body);
    const res = await fetchImpl(cfg.url + path, {
      method,
      headers: {
        SiteId: cfg.siteId,
        Authorization: `Bearer ${cfg.token}`,
        Client: 'ApiClient',
        Accept: 'application/json',
        ...(cfg.productId ? { ProductId: cfg.productId } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const fail = (message) => Object.assign(new Error(message), { status: res.status });
    if (res.status === 401 || res.status === 403) throw fail(`Incident IQ refused the request (${res.status}). Check IIQ_TOKEN and IIQ_SITE_ID.`);
    if (!res.ok) throw fail(`Incident IQ answered ${res.status} for ${method} ${path.split('?')[0]}${text ? `: ${text.slice(0, 200)}` : ''}`);
    try { return text ? JSON.parse(text) : null; } catch { throw fail(`Incident IQ sent something other than JSON for ${path.split('?')[0]}.`); }
  }
  const items = (r) => (Array.isArray(r) ? r : r?.Items ?? r?.Tickets ?? r?.Results ?? null);

  async function allPages(way, me) {
    const out = [];
    const seen = new Set();
    for (let page = 0; page < 20; page++) {
      const batch = items(await call(...way.request(page, me)));
      if (!batch) throw Object.assign(new Error(`${way.name}: the answer had no list of tickets.`), { status: 0 });
      // The search also returns closed tickets, so lists grow past one page.
      // If a site ignores $p, the same page comes back: stop there.
      const fresh = batch.filter((t) => !seen.has(t.TicketId ?? t.Id));
      if (page > 0 && fresh.length === 0) break;
      for (const t of fresh) seen.add(t.TicketId ?? t.Id);
      out.push(...fresh);
      if (batch.length < 100) break;
    }
    return out;
  }
  let workingWay = null;

  // Some calls are documented under /api/v1.0, others under /services; try
  // each path in turn when the first isn't found.
  async function either(method, paths, body) {
    for (let i = 0; i < paths.length; i++) {
      try { return await call(method, paths[i], body); } catch (e) { if (i === paths.length - 1 || ![404, 405].includes(e.status)) throw e; }
    }
  }

  return {
    call,
    /**
     * Open tickets assigned to me. Incident IQ's docs list the "assigned to
     * me" view under the web app's /services path, and a general ticket
     * search under /api/v1.0/tickets; which one a site accepts for API
     * clients varies, so try each and keep the first that works.
     */
    async myOpenTickets(me) {
      if (workingWay) return Object.assign(await allPages(workingWay, me), { onlyMine: !!workingWay.onlyMine });
      let lastError = null;
      for (const way of LIST_WAYS) {
        if (way.needsMe && !me) continue;
        try {
          const list = await allPages(way, me);
          list.onlyMine = !!way.onlyMine;
          workingWay = way;
          return list;
        } catch (e) {
          if (![0, 400, 404, 405].includes(e.status)) throw e; // e.g. a bad token: stop and say so
          lastError = e;
        }
      }
      throw lastError ?? new Error('No way to list tickets worked. Run iiq-probe.js for details.');
    },
    /** For the probe: how each way of listing tickets answers (status and count only). */
    async tryListWays(me) {
      const results = [];
      for (const way of LIST_WAYS) {
        if (way.needsMe && !me) { results.push({ name: way.name, result: 'skipped (needs your user id)' }); continue; }
        try {
          const r = items(await call(...way.request(0, me)));
          results.push({ name: way.name, result: r ? `works: ${r.length} tickets on the first page` : 'answered, but with no ticket list' });
        } catch (e) {
          results.push({ name: way.name, result: `failed (${e.status || 'no status'})` });
        }
      }
      return results;
    },
    /**
     * Filters for open tickets, from the site's own "ticketstate" facet
     * (the web app's filter list). Empty if the site doesn't offer one.
     */
    async openStateFilters() {
      const r = await either('POST', ['/services/filters', '/api/v1.0/filters'], { Facets: ['ticketstate'], Query: '', ResultsFilter: { EntityName: 'tickets' } });
      return openStates(r);
    },
    /** My tickets from the search, narrowed by extra filters (one page when they're the open ones). */
    async searchMine(me, extra) {
      const list = await allPages({
        name: 'POST /api/v1.0/tickets (agent = you, open)',
        request: (p) => ['POST', `/api/v1.0/tickets${query(p)}`, { Schema: 'All', Filters: [{ Facet: 'agent', Id: me }, ...extra] }],
      }, me);
      return Object.assign(list, { onlyMine: true });
    },
    /** The user id for an email address, or null if no user has it. */
    async findUser(email) {
      const body = { Query: email, Facets: 4, IncludeMatchedItem: true, Limit: 10 }; // facet 4 = users
      const ways = [
        ['POST', '/api/v1.0/search/v2', body],
        ['POST', '/services/search/v2', body],
        ['POST', `/services/users?$s=10&$filter=(SearchText contains '${email.replace(/'/g, "''")}')`, {}],
      ];
      for (const w of ways) {
        try {
          const id = findByEmail(await call(...w), email.toLowerCase());
          if (id) return id;
        } catch (e) {
          if (![400, 404, 405].includes(e.status)) throw e;
        }
      }
      return null;
    },
    ticket: (id) => either('GET', [`/api/v1.0/tickets/${id}`, `/services/tickets/${id}`]).then((r) => r?.Item ?? r),
    comment: (id, text) => call('POST', `/api/v1.0/tickets/${id}/activities/new`, {
      TicketId: id,
      ActivityItems: [{ $type: 'Spark.Shared.Models.TicketActivityComment, Spark.Shared', TicketActivityTypeId: 6, Comments: text }],
      IsPublic: false, WaitForResponse: false, TicketWasUpdated: false,
    }),
    start: (id, userId) => either('POST', [`/api/v1.0/tickets/${id}/start`, `/services/tickets/${id}/start`], userId ? { UserId: userId } : {}),
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
    nextSteps: (id) => either('GET', [`/services/tickets/${id}/next-steps`, `/api/v1.0/tickets/${id}/next-steps`]),
  };
}

/** Somewhere in a search answer, the id of the user whose email is `want`. */
function findByEmail(v, want, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 6) return null;
  if (!Array.isArray(v)) {
    const email = pick(v.Email, v.EmailAddress, v.PrimaryEmail);
    const id = pick(v.UserId, v.Id, v.ItemId);
    if (typeof email === 'string' && email.toLowerCase() === want && GUID.test(String(id ?? ''))) return String(id);
  }
  for (const x of Object.values(v)) { const r = findByEmail(x, want, depth + 1); if (r) return r; }
  return null;
}

/**
 * From a filter-list answer, the ticketstate filter(s) meaning open: the one
 * named "Open" if there is one, else every state that isn't a closed one.
 * Whether a site honors them is checked against the full list before use.
 */
function openStates(v) {
  const options = [];
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 6) return;
    if (!Array.isArray(o)) {
      const label = pick(o.Name, o.Text, o.Label, o.DisplayName);
      const id = pick(o.Id, o.ItemId);
      const value = pick(o.Value, o.Key);
      if (typeof label === 'string' && (id !== undefined || value !== undefined) && !/state/i.test(label)) options.push({ label, id, value });
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  })(v, 0);
  const asFilter = (o) => (o.id !== undefined ? { Facet: 'ticketstate', Id: o.id } : { Facet: 'ticketstate', Value: o.value });
  const open = options.find((o) => /^open$/i.test(o.label.trim()));
  if (open) return [asFilter(open)];
  return options.filter((o) => !/clos|cancel|resolv|delet|archiv/i.test(o.label)).map(asFilter);
}

/** Ids of the open tickets in a list that are mine, sorted, to compare lists. */
export function openMineIds(list, { me, email }) {
  const who = { me, email, onlyMine: list.onlyMine };
  return list.map((t) => readTicket(t, { ticketUrl: '' })).filter((t) => t.id && !t.closed && isMine(t, who)).map((t) => t.id).sort();
}

// ---------- reading IIQ's (undocumented) ticket shape ----------

const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
const name = (o) => (typeof o === 'string' ? o : pick(o?.Name, o?.FullName, [o?.FirstName, o?.LastName].filter(Boolean).join(' ')));

export function readTicket(t, cfg) {
  const id = pick(t.TicketId, t.Id);
  const assigned = pick(t.AssignedToUserId, t.AssignedToUser?.UserId, t.AgentId, t.Agent?.UserId, t.AssignedToUser?.Id);
  const assignedEmail = pick(t.AssignedToUser?.Email, t.Agent?.Email, t.AssignedToUserEmail, t.AgentEmail);
  const closedDate = pick(t.ClosedDate, t.TicketClosedDate);
  return {
    id: id ? String(id) : null,
    number: pick(t.TicketNumber, t.Number),
    subject: String(pick(t.Subject, t.TicketSubject, t.Issue?.Name, t.IssueName, 'Untitled ticket')).trim().slice(0, 300),
    status: pick(t.WorkflowStep?.StepName, t.WorkflowStepName, t.TicketStatusName, t.Status?.Name, typeof t.Status === 'string' ? t.Status : undefined, t.TicketState) ?? null,
    closed: Boolean(pick(t.IsClosed, closedDate ? true : undefined, false)),
    modified: pick(t.ModifiedDate, t.TicketModifiedDate, t.LastActivityDate) ?? null,
    created: pick(t.CreatedDate, t.TicketCreatedDate, t.SubmittedDate, t.OpenedDate) ?? null, // when it was submitted
    assignedTo: assigned ? String(assigned) : null,
    assignedEmail: assignedEmail ? String(assignedEmail).toLowerCase() : null,
    // Tickets IIQ marks as holding sensitive information keep the requester
    // and description in IIQ only.
    sensitive: t.HasSensitiveInformation === true,
    requester: t.HasSensitiveInformation === true ? null
      : name(pick(t.For, t.ForUser, t.Owner)) || [t.ForFirstName, t.ForLastName].filter(Boolean).join(' ') || null,
    location: [name(t.Location) ?? t.LocationName, name(t.LocationRoom) ?? t.LocationRoomName, t.LocationDetails].filter(Boolean).join(', ') || null,
    issue: pick(name(t.Issue), t.IssueName, name(t.IssueCategory)) ?? null,
    // chathamnc sends Priority as a number with a separate IsUrgent flag.
    priority: t.IsUrgent === true ? 'Urgent' : pick(t.Priority?.Name, t.PriorityName, typeof t.Priority === 'string' ? t.Priority : undefined) ?? null,
    description: t.HasSensitiveInformation === true ? '' : String(pick(t.IssueDescription, t.Description, '') ?? '').trim().slice(0, 5000),
    url: id ? cfg.ticketUrl.replace('{TicketId}', id) : null,
  };
}

/**
 * The user id inside the token (IIQ tokens are JWTs), if a claim names it.
 * Other GUIDs in the token (site, client, token ids) aren't guessed at: the
 * wrong id here would sync someone else's tickets.
 */
export function userIdFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    for (const k of ['UserId', 'userId', 'userid', 'uid', 'sub', 'nameid']) if (GUID.test(String(payload[k] ?? ''))) return String(payload[k]);
  } catch { /* not a JWT */ }
  return null;
}

/**
 * Who "me" is: IIQ_USER_ID, else the user with IIQ_USER_EMAIL, else the
 * token's user claim. Throws if the email is set but no user has it, so the
 * sync never falls back to everyone's tickets.
 */
export async function resolveMe(cfg, client) {
  if (cfg.userId) return { id: cfg.userId, how: 'IIQ_USER_ID' };
  if (cfg.userEmail) {
    const id = await client.findUser(cfg.userEmail);
    if (!id) throw new Error('No Incident IQ user has the email in IIQ_USER_EMAIL. Check it, or set IIQ_USER_ID.');
    return { id, how: 'IIQ_USER_EMAIL' };
  }
  const id = userIdFromToken(cfg.token);
  return { id, how: id ? 'the token' : null };
}

/**
 * Whether a listed ticket is mine. A ticket that names its assignee must
 * name me (by id or email). One that doesn't is trusted only from a list
 * already filtered to me: the "assigned to me + unassigned" views also hold
 * unassigned tickets.
 */
export function isMine(tk, { me, email, onlyMine }) {
  if (tk.assignedTo || tk.assignedEmail) {
    return (!!me && tk.assignedTo?.toLowerCase() === me.toLowerCase()) || (!!email && tk.assignedEmail === email);
  }
  return !!onlyMine;
}

// ---------- sync ----------

export function createIiq({ db, applyChanges, onChange, cfg, client = cfg && createClient(cfg), now = () => new Date() }) {
  const state = { enabled: !!cfg, lastSync: null, lastError: null, tickets: 0, running: false };
  if (!cfg) return { state, start() {}, processActions() {}, status: () => ({ enabled: false }) };

  let me = null; // resolved on the first sync (resolveMe)
  // The search also returns closed tickets (years of them), so once an
  // open-only filter is shown to find the same open tickets as the full
  // list, use it, and check it against the full list again every few hours.
  const RECHECK_MS = 6 * 3600_000;
  let quick = null; // { filters, checkedAt }

  async function listMine(who) {
    if (quick && Date.now() - quick.checkedAt < RECHECK_MS) {
      try { return await client.searchMine(me, quick.filters); } catch { quick = null; } // fall back to the full list
    }
    const full = await client.myOpenTickets(me);
    quick = null;
    if (full.onlyMine) {
      try {
        const filters = await client.openStateFilters();
        if (filters.length) {
          const narrow = await client.searchMine(me, filters);
          if (openMineIds(narrow, who).join() === openMineIds(full, who).join()) quick = { filters, checkedAt: Date.now() };
        }
      } catch { /* no usable filter: keep the full list */ }
    }
    return full;
  }
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
    if (tk.sensitive) notes.push({ id: `iiq-${tk.id}-sens`, type: 'paragraph', text: 'Incident IQ marks this ticket as holding sensitive information, so its requester and description stay in Incident IQ.' });
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
    modified: tk.modified, created: tk.created, requester: tk.requester, location: tk.location, issue: tk.issue, priority: tk.priority,
    syncedTitle, syncedAt: now().toISOString(),
  });

  /** One pass: bring IIQ's view of my open tickets into Nextly. */
  async function syncOnce() {
    if (state.running) return;
    state.running = true;
    try {
      me ??= (await resolveMe(cfg, client)).id;
      if (!me) throw new Error('Nextly can’t tell which tickets are yours. Set IIQ_USER_EMAIL in .env.');
      const usedQuick = !!quick && Date.now() - quick.checkedAt < RECHECK_MS;
      const raw = await listMine({ me, email: cfg.userEmail });
      const who = { me, email: cfg.userEmail, onlyMine: raw.onlyMine };
      const mine = raw.map((t) => readTicket(t, cfg)).filter((t) => t.id && !t.closed && isMine(t, who));
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
        const changed = ext.status !== tk.status || ext.modified !== tk.modified || (ext.created ?? null) !== tk.created || ext.requester !== tk.requester || ext.location !== tk.location
          || (titleFollowsIiq && d.title !== titleOf(tk)) || reopened;
        if (!changed) continue;
        rows.push(record(cur.id, 'task', {
          ...d,
          title: titleFollowsIiq ? titleOf(tk) : d.title,
          ...(reopened ? { done: false, doneAt: null, flag: 'inbox' } : {}),
          external: external(tk, titleFollowsIiq ? titleOf(tk) : ext.syncedTitle),
        }, cur.hlc));
      }
      // Tasks whose tickets left my open list: closed or reassigned. Each is
      // looked up on its own; one that's still open and mine stays as it is.
      for (const cur of iiqTasks.all()) {
        if (cur.deleted || open.has(cur.id)) continue;
        const d = JSON.parse(cur.data);
        if (d.external?.source !== 'iiq' || (d.done && d.external.closed)) continue;
        let status = 'Closed';
        try {
          const tk = readTicket(await client.ticket(d.external.id), cfg);
          const named = !!(tk.assignedTo || tk.assignedEmail);
          if (!tk.closed && named && isMine(tk, { me, email: cfg.userEmail })) continue; // the list missed it
          if (!tk.closed && !named && usedQuick) { quick = null; continue; } // can't tell: let the full list decide next time
          if (!tk.closed && named) status = 'Reassigned';
          else if (!tk.closed) status = 'Unassigned';
          else status = tk.status ?? 'Closed';
        } catch (e) {
          if (e.status !== 404) continue; // unreadable for now: try again next time
          // gone: treat as closed
        }
        rows.push(record(cur.id, 'task', {
          ...d, done: true, doneAt: d.done ? d.doneAt : now().toISOString(),
          external: { ...d.external, status, closed: true, syncedAt: now().toISOString() },
        }, cur.hlc));
      }
      write(rows);
      lastMine = new Set(mine.map((t) => t.id));
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

  // Limits on changes to Incident IQ, so a bad device, a bug or a replayed
  // backlog can't touch many tickets: each action is one of yours, checked
  // live just before it's sent, and only so many go out per hour.
  const MAX_CHANGES_PER_HOUR = 30;
  const MAX_ACTION_AGE_MS = 3 * 24 * 3600_000;
  const sent = []; // times of recent changes
  let lastMine = null; // ticket ids from the last sync's list (all yours)

  /** Why an action mustn't be sent, or null if it may. */
  async function vet(d, done) {
    if (!['comment', 'start', 'resolve'].includes(d.type)) return `Unknown action “${d.type}”.`;
    if (!GUID.test(String(d.ticketId ?? ''))) return 'Not a ticket id.';
    // It must belong to a ticket task this server created, for that ticket.
    const task = getRec.get(String(d.taskId ?? ''));
    const ext = task && !task.deleted ? JSON.parse(task.data).external : null;
    if (task?.id !== `iiq-${d.ticketId}` || ext?.source !== 'iiq' || ext.id !== d.ticketId) return 'That task isn’t linked to this ticket.';
    if (!(Date.parse(d.createdAt) > Date.now() - MAX_ACTION_AGE_MS)) return 'Too old to send (more than 3 days). Do it again if it’s still needed.';
    if (d.type !== 'comment' && done.has(`${d.type}:${d.ticketId}`)) return 'Already sent.';
    if (!me) return 'Nextly can’t tell which Incident IQ user you are, so it changes nothing.';
    // Live check: still open and still assigned to you.
    const tk = readTicket(await client.ticket(d.ticketId), cfg);
    if (tk.closed) return 'The ticket is already closed in Incident IQ.';
    const named = !!(tk.assignedTo || tk.assignedEmail);
    // If the ticket's details don't name the assignee, go by the last
    // ticket list, which is filtered to you.
    if (!named && !lastMine) return { wait: 'Waiting for the first ticket sync.' };
    if (named ? !isMine(tk, { me, email: cfg.userEmail }) : !lastMine.has(d.ticketId)) return 'The ticket isn’t assigned to you in Incident IQ, so Nextly won’t change it.';
    return null;
  }

  const getNumber = (d) => { const r = getRec.get(String(d.taskId ?? '')); try { return JSON.parse(r.data).external.number ?? '?'; } catch { return '?'; } };

  let acting = false;
  /** Carries out pending comment / start / resolve requests from devices. */
  async function processActions() {
    if (acting) return;
    acting = true;
    try {
      const pending = pendingActions.all();
      if (pending.length) me ??= (await resolveMe(cfg, client).catch(() => ({ id: null }))).id; // "start" needs it
      const done = new Set();
      for (const a of pending) {
        const d = JSON.parse(a.data);
        while (sent.length && sent[0] < Date.now() - 3600_000) sent.shift();
        if (sent.length >= MAX_CHANGES_PER_HOUR) {
          // Held, not dropped: they go out as the hour frees up.
          const message = `Waiting: Nextly sends at most ${MAX_CHANGES_PER_HOUR} changes an hour to Incident IQ.`;
          if (d.message !== message) write([record(a.id, 'iiq-action', { ...d, message }, a.hlc)]);
          continue;
        }
        let result;
        try {
          const refusal = await vet(d, done);
          if (refusal?.wait) {
            write([record(a.id, 'iiq-action', { ...d, message: refusal.wait }, a.hlc)]);
            continue;
          }
          if (refusal) {
            console.log(`Incident IQ: refused ${d.type} on ticket #${getNumber(d)}: ${refusal}`);
            write([record(a.id, 'iiq-action', { ...d, state: 'failed', message: refusal, finishedAt: now().toISOString() }, a.hlc)]);
            continue;
          }
          done.add(`${d.type}:${d.ticketId}`);
          sent.push(Date.now());
          console.log(`Incident IQ: ${d.type} on ticket #${getNumber(d)}`); // what, not the text
          if (d.type === 'comment') {
            await client.comment(d.ticketId, String(d.text ?? '').slice(0, 10000));
            result = { state: 'done', message: 'Posted to Incident IQ as an internal comment.' };
          } else if (d.type === 'start') {
            await client.start(d.ticketId, me);
            result = { state: 'done', message: 'Started in Incident IQ.' };
          } else if (d.type === 'resolve') {
            // Resolution action first (required by many districts), then the
            // district's own close request if it needs one.
            const actionId = cfg.resolutionActionId; // set on the server only, never by a device
            if (actionId) await client.resolution(d.ticketId, actionId, d.text || 'Resolved in Nextly.');
            if (cfg.resolve) await client.call(cfg.resolve.method ?? 'POST', fill(cfg.resolve.path, d), fill(cfg.resolve.body ?? {}, d));
            if (actionId || cfg.resolve) {
              result = { state: 'done', message: 'Resolved in Incident IQ.' };
            } else {
              await client.comment(d.ticketId, d.text ? `Marked done in Nextly: ${d.text}` : 'Marked done in Nextly.');
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
      pollSeconds: cfg.pollSeconds, canResolve: !!(cfg.resolutionActionId || cfg.resolve), knowsUser: !!(me || cfg.userId || cfg.userEmail), openOnly: !!quick,
    }),
  };
}
