// Shows how your Incident IQ site shapes its data, so the sync can be
// matched to it. Prints field names and value types only, plus a few
// non-personal values (status and workflow names), never ticket text,
// people or student information. Safe to paste back.
//
//   docker compose exec nextly node iiq-probe.js
//   docker compose exec nextly node iiq-probe.js --steps   (also the first ticket's next steps)

import { createClient, iiqConfig, readTicket, userIdFromToken } from './iiq.js';

const cfg = iiqConfig();
if (!cfg) {
  console.log('Incident IQ isn’t set up: set IIQ_URL, IIQ_SITE_ID and IIQ_TOKEN in .env.');
  process.exit(1);
}
const client = createClient(cfg);

// Values that are safe to show: names of statuses, steps, states and types.
const SAFE = /(Status|State|Step|Workflow|Type|Priority|Is[A-Z]|Has[A-Z]|Count|Product|Schema)/;
function shape(v, key = '', depth = 0) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return v.length ? `[${shape(v[0], key, depth)}] ×${v.length}` : '[]';
  if (typeof v === 'object') {
    if (depth >= 3) return '{…}';
    const pad = '  '.repeat(depth + 1);
    return '{\n' + Object.keys(v).sort().map((k) => `${pad}${k}: ${shape(v[k], k, depth + 1)}`).join('\n') + '\n' + '  '.repeat(depth) + '}';
  }
  const t = typeof v;
  if (t === 'boolean' || t === 'number') return `${t} (${v})`;
  if (/^[0-9a-f-]{36}$/i.test(String(v))) return 'guid';
  if (/Date$|Date[A-Z]/.test(key) || /^\d{4}-\d{2}-\d{2}T/.test(String(v))) return 'date';
  return SAFE.test(key) && String(v).length < 60 ? `string ("${v}")` : `string (${String(v).length} chars)`;
}

console.log(`Site: ${cfg.url}`);
const me = cfg.userId ?? userIdFromToken(cfg.token);
console.log(`Your user id: ${me ? 'found' + (cfg.userId ? ' (IIQ_USER_ID)' : ' in the token') : 'not found in the token; set IIQ_USER_ID'}`);
console.log('\nWays of listing your tickets (status and count only):');
for (const w of await client.tryListWays(me)) console.log(`  ${w.name}: ${w.result}`);

try {
  const list = await client.myOpenTickets(me);
  const read = list.map((t) => readTicket(t, cfg));
  const assigned = read.filter((t) => t.assignedTo);
  const open = read.filter((t) => !t.closed).length;
  console.log(`\nUsing the first that works: ${list.length} tickets (${open} open, ${list.length - open} closed), ${assigned.length} with an assignee found, ${me ? read.filter((t) => t.assignedTo?.toLowerCase() === me.toLowerCase()).length : '?'} assigned to you${list.onlyMine ? ' (this search only returns yours)' : ''}`);
  console.log(`Nextly will sync the ${open} open one${open === 1 ? '' : 's'}.`);
  if (!list.length) process.exit(0);
  // Show an open ticket if there is one: closed ones leave out fields like the assignee.
  const i = Math.max(0, read.findIndex((t) => !t.closed));
  const r = read[i];
  console.log(`\nHow Nextly reads ${r.closed ? 'the first ticket (none are open)' : 'the first open ticket'}:`);
  for (const [k, v] of Object.entries(r)) console.log(`  ${k}: ${v === null || v === '' ? 'NOT FOUND' : 'found'}`);
  console.log(`\n${r.closed ? 'That ticket' : 'That open ticket'}, shape only:`);
  console.log(shape(list[i]));
  if (r.id) {
    // Each of these on its own, so one failure doesn't hide the rest.
    try {
      console.log('\nThe same ticket from GET /tickets/{id}, shape only:');
      console.log(shape(await client.ticket(r.id)));
    } catch (e) { console.log(`  failed: ${e.message}`); }
    if (process.argv.includes('--steps')) {
      try {
        console.log('\nIts next steps (how workflows move tickets along):');
        console.log(shape(await client.nextSteps(r.id)));
      } catch (e) { console.log(`  failed: ${e.message}`); }
    }
  }
} catch (e) {
  console.log(`Error: ${e.message}`);
  process.exit(1);
}
