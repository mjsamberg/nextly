// Run with: node --test   (from server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createIiq, iiqConfig } from './iiq.js';

const ME = '11111111-1111-1111-1111-111111111111';
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** An in-memory records table with the server's last-writer-wins rule. */
function store() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, hlc TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, seq INTEGER NOT NULL)');
  let seq = 0;
  const applyChanges = (changes) => {
    for (const c of changes) {
      const cur = db.prepare('SELECT hlc FROM records WHERE id = ?').get(c.id);
      if (cur && cur.hlc >= c.hlc) continue;
      db.prepare('INSERT OR REPLACE INTO records VALUES (?, ?, ?, ?, ?, ?)').run(c.id, c.kind, c.hlc, c.deleted ? 1 : 0, JSON.stringify(c.data ?? {}), ++seq);
    }
  };
  const get = (id) => JSON.parse(db.prepare('SELECT data FROM records WHERE id = ?').get(id).data);
  return { db, applyChanges, get };
}

const hlc = (ms) => `${String(ms).padStart(15, '0')}-0000-device`;
const ticket = (id, number, status, closed = false) => ({ TicketId: id, TicketNumber: number, Subject: `Ticket ${number}`, AssignedToUserId: ME, IsClosed: closed, WorkflowStep: { StepName: status } });
const task = (id, number, status) => ({
  title: `#${number} Ticket ${number}`, flag: null, projectId: 'iiq-project', done: false, notes: [],
  external: { source: 'iiq', id, number, status, closed: false, syncedTitle: `#${number} Ticket ${number}` },
});

test('a device edit made while the server waits on Incident IQ is kept', async () => {
  const s = store();
  const t0 = Date.now() - 60_000;
  s.applyChanges([
    { id: `iiq-${A}`, kind: 'task', hlc: hlc(t0), data: task(A, 1, 'New') },
    { id: `iiq-${B}`, kind: 'task', hlc: hlc(t0), data: task(B, 2, 'New') },
  ]);

  // A is still on my list with a new status; B left it and is looked up on
  // its own. During that lookup a device adds notes to both tasks.
  let interfere = true;
  const client = {
    myOpenTickets: async () => Object.assign([ticket(A, 1, 'In Progress')], { onlyMine: true }),
    openStateFilters: async () => [],
    ticket: async (id) => {
      if (interfere) {
        interfere = false;
        for (const tid of [A, B]) {
          const cur = s.get(`iiq-${tid}`);
          s.applyChanges([{ id: `iiq-${tid}`, kind: 'task', hlc: hlc(Date.now()), data: { ...cur, notes: [{ id: 'n', type: 'paragraph', text: 'typed on the phone' }] } }]);
        }
      }
      return ticket(id, 2, 'Closed', true);
    },
  };
  const cfg = iiqConfig({ IIQ_URL: 'https://iiq.test', IIQ_SITE_ID: 's', IIQ_TOKEN: 't', IIQ_USER_ID: ME });
  const iiq = createIiq({ db: s.db, applyChanges: s.applyChanges, onChange: () => {}, cfg, client });

  await iiq.syncOnce();
  assert.equal(iiq.state.lastError, null);
  for (const tid of [A, B]) assert.equal(s.get(`iiq-${tid}`).notes[0]?.text, 'typed on the phone', `notes on ${tid} kept`);

  // The next poll makes the skipped changes, on top of the device's edits.
  await iiq.syncOnce();
  const a = s.get(`iiq-${A}`);
  const b = s.get(`iiq-${B}`);
  assert.equal(a.external.status, 'In Progress');
  assert.equal(a.notes[0]?.text, 'typed on the phone');
  assert.equal(b.done, true);
  assert.equal(b.notes[0]?.text, 'typed on the phone');
});
