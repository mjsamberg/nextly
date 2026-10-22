// Lists your Incident IQ site's resolution actions and ticket statuses
// (workflow steps and states) with their ids, so you can pick the
// resolution action for IIQ_RESOLUTION_ACTION_ID. Read-only: it only looks
// things up. Prints configuration names and ids, never ticket text or people.
//
//   docker compose exec nextly node iiq-options.js
//
// Incident IQ doesn't document where these lists live, so this tries each
// likely place and shows which ones answer.

import { createClient, iiqConfig, isMine, readTicket, resolveMe } from './iiq.js';

const cfg = iiqConfig();
if (!cfg) {
  console.log('Incident IQ isn’t set up: set IIQ_URL, IIQ_SITE_ID and IIQ_TOKEN in .env.');
  process.exit(1);
}
const client = createClient(cfg);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLAGS = ['IsClosed', 'IsResolved', 'IsResolution', 'IsCanceled', 'IsDefault', 'IsActive', 'IsDeleted', 'RequiresNotes'];

/** Every { name, id } pair in an answer, with any yes/no flags beside them. */
function options(v) {
  const out = new Map();
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 8) return;
    // People (requesters, agents) are skipped: only configuration is printed.
    const person = o.Email !== undefined || o.FirstName !== undefined || o.LastName !== undefined || o.UserId !== undefined;
    if (!Array.isArray(o) && !person) {
      const name = [o.Name, o.StepName, o.ResolutionActionName, o.Text, o.Label, o.DisplayName].find((x) => typeof x === 'string' && x.trim());
      const id = [o.ResolutionActionId, o.WorkflowStepId, o.TicketStateId, o.Id, o.ItemId, o.Value, o.Key].find((x) => GUID.test(String(x ?? '')) || (typeof x === 'number'));
      if (name && id !== undefined && !out.has(String(id))) {
        const flags = FLAGS.filter((f) => o[f] === true).join(', ');
        out.set(String(id), { name: name.trim().slice(0, 80), id: String(id), flags });
      }
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  })(v, 0);
  return [...out.values()];
}

async function show(label, method, path, body) {
  try {
    const r = await client.call(method, path, body);
    const found = options(r);
    console.log(`  ${label}: answered, ${found.length} with a name and id`);
    for (const o of found.slice(0, 150)) console.log(`      ${o.name.padEnd(40)} ${o.id}${o.flags ? `  (${o.flags})` : ''}`);
    if (!found.length && r && typeof r === 'object') console.log(`      top-level fields: ${Object.keys(Array.isArray(r) ? r[0] ?? {} : r).join(', ') || '(empty)'}`);
    return found.length;
  } catch (e) {
    console.log(`  ${label}: ${e.status ? `failed (${e.status})` : e.message}`);
    return 0;
  }
}
const facet = (name) => ({ Facets: [name], Query: '', ResultsFilter: { EntityName: 'tickets' } });

console.log(`Site: ${cfg.url}`);

// One of your open tickets, for the lists that are per ticket.
let ticketId = null;
try {
  const { id: me } = await resolveMe(cfg, client);
  const list = await client.myOpenTickets(me);
  const who = { me, email: cfg.userEmail, onlyMine: list.onlyMine };
  ticketId = list.map((t) => readTicket(t, cfg)).find((t) => t.id && !t.closed && isMine(t, who))?.id ?? null;
} catch (e) {
  console.log(`(Couldn’t find one of your open tickets: ${e.message}. Skipping the per-ticket lists.)`);
}

console.log('\nResolution actions (pick one for IIQ_RESOLUTION_ACTION_ID):');
let actions = 0;
for (const [label, method, path, body] of [
  ['filter list: closereason (/services)', 'POST', '/services/filters', facet('closereason')],
  ['filter list: closereason (/api/v1.0)', 'POST', '/api/v1.0/filters', facet('closereason')],
  ['GET /api/v1.0/tickets/resolution-actions', 'GET', '/api/v1.0/tickets/resolution-actions'],
  ['GET /services/tickets/resolution-actions', 'GET', '/services/tickets/resolution-actions'],
  ['GET /api/v1.0/resolution-actions', 'GET', '/api/v1.0/resolution-actions'],
  ['GET /services/resolution-actions', 'GET', '/services/resolution-actions'],
  ...(ticketId ? [
    ['GET /api/v1.0/tickets/{one of yours}/resolution-actions', 'GET', `/api/v1.0/tickets/${ticketId}/resolution-actions`],
    ['GET /services/tickets/{one of yours}/resolution-actions', 'GET', `/services/tickets/${ticketId}/resolution-actions`],
  ] : []),
]) actions += await show(label, method, path, body);

console.log('\nTicket statuses (workflow steps and states):');
for (const [label, method, path, body] of [
  ['filter list: ticketworkflow', 'POST', '/services/filters', facet('ticketworkflow')],
  ['filter list: ticketstate', 'POST', '/services/filters', facet('ticketstate')],
  ['GET /api/v1.0/workflows', 'GET', '/api/v1.0/workflows'],
  ['GET /services/workflows', 'GET', '/services/workflows'],
  ...(ticketId ? [['next steps for one of your open tickets', 'GET', `/services/tickets/${ticketId}/next-steps`]] : []),
]) await show(label, method, path, body);

console.log(actions
  ? '\nPut the id of the resolution action you want in .env as IIQ_RESOLUTION_ACTION_ID=…, then: docker compose up -d'
  : '\nNo resolution actions found in the usual places. Paste this output back and the next places to look can be added.');
