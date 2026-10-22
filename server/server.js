// Nextly sync server: zero dependencies (Node 24, built-in node:sqlite).
//
// Model: every record (task, project, area, note block, ...) is a row
// { id, kind, hlc, deleted, data }. Clients push changed rows and pull
// everything newer than their cursor. Conflicts resolve last-writer-wins
// per record using a hybrid logical clock string "<ms>-<counter>-<deviceId>",
// which sorts correctly as text.
//
//   POST /sync          { cursor, changes: [row] } -> { cursor, changes: [row] }
//   PUT  /files/:sha256 raw bytes (attachments, content-addressed)
//   GET  /files/:sha256 bearer token, or a signed link from:
//   POST /files/:sha256/link { name, mime } -> { url }  (valid 10 minutes, so
//                       an attachment can open in the system browser)
//   GET  /status        record and file counts, for the app's connection check
//   GET  /capture       page used by the Gmail bookmarklet / share sheet
//   GET  /health
//   WS   /events        live updates: {"type":"changed"} after another device syncs (live.js)
//   POST /events/ticket one-minute WebSocket ticket, for browsers that can't send headers
//   GET  /widget, POST /tasks, POST /tasks/:id/done   for the widget and Siri (tasks.js)
//   GET  /iiq/status    Incident IQ sync status, when IIQ_* is set (iiq.js)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createLive } from './live.js';
import { createTaskApi } from './tasks.js';
import { createIiq, iiqConfig } from './iiq.js';

const TOKEN = process.env.NEXTLY_TOKEN;
const DATA = process.env.NEXTLY_DATA || './data';
const PORT = Number(process.env.PORT || 8080);
const MAX_FILE = 50 * 1024 * 1024;

if (!TOKEN || TOKEN === 'REPLACE_ME') {
  console.error('NEXTLY_TOKEN is not set. See .env.example.');
  process.exit(1);
}

fs.mkdirSync(path.join(DATA, 'files'), { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'nextly.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS records (
    id      TEXT PRIMARY KEY,
    kind    TEXT NOT NULL,
    hlc     TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    data    TEXT NOT NULL,
    seq     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// Created once per database. If the data volume is ever recreated, clients see
// a new id, start over from the beginning and re-send what they have.
db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('serverId', crypto.randomUUID());
const SERVER_ID = db.prepare("SELECT value FROM meta WHERE key = 'serverId'").get().value;

const nextSeq = () => (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM records').get().s);
const getRow = db.prepare('SELECT hlc FROM records WHERE id = ?');
const upsert = db.prepare(`
  INSERT INTO records (id, kind, hlc, deleted, data, seq) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, hlc = excluded.hlc,
    deleted = excluded.deleted, data = excluded.data, seq = excluded.seq
`);
const since = db.prepare('SELECT id, kind, hlc, deleted, data, seq FROM records WHERE seq > ? ORDER BY seq LIMIT 5000');

function authorized(req) {
  const given = Buffer.from(req.headers.authorization || '');
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// Auth is a bearer token, not a cookie, so allowing any origin is safe and
// lets the app's frontend run in a plain browser during development.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, cf-access-client-id, cf-access-client-secret',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, ...CORS });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const sign = (sha, exp, name, mime) =>
  crypto.createHmac('sha256', TOKEN).update(`${sha}|${exp}|${name}|${mime}`).digest('hex');

function validLink(sha, q) {
  const exp = Number(q.get('exp'));
  const sig = Buffer.from(q.get('sig') || '');
  const want = Buffer.from(sign(sha, exp, q.get('name') || '', q.get('mime') || ''));
  return exp > Date.now() && sig.length === want.length && crypto.timingSafeEqual(sig, want);
}

const safeMime = (m) => (/^[\w.+-]+\/[\w.+-]+$/.test(m || '') ? m : 'application/octet-stream');

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const lastSeq = () => db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM records').get().s;
const live = createLive({ token: TOKEN, authorized, lastSeq });
const taskApi = createTaskApi({ db, applyChanges, onChange: () => live.changed('server'), onIiqAction: () => void iiq.processActions() });
const iiq = createIiq({ db, applyChanges, onChange: () => live.changed('iiq'), cfg: iiqConfig() });

/** Returns how many changes were newer than what the server had. */
function applyChanges(changes) {
  let stored = 0;
  db.exec('BEGIN');
  try {
    for (const c of changes) {
      if (!c.id || !c.kind || !c.hlc) continue;
      const existing = getRow.get(c.id);
      if (existing && existing.hlc >= c.hlc) continue; // older write loses
      upsert.run(c.id, c.kind, c.hlc, c.deleted ? 1 : 0, JSON.stringify(c.data ?? {}), nextSeq());
      stored++;
    }
    db.exec('COMMIT');
    return stored;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (url.pathname === '/health') return send(res, 200, { ok: true });

    const signed = url.pathname.match(/^\/files\/([a-f0-9]{64})$/);
    if (signed && req.method === 'GET' && url.searchParams.has('sig')) {
      const p = path.join(DATA, 'files', signed[1]);
      if (!validLink(signed[1], url.searchParams)) return send(res, 403, { error: 'This link has expired. Open the file from Nextly again.' });
      if (!fs.existsSync(p)) return send(res, 404, { error: 'No such file' });
      const name = url.searchParams.get('name') || 'file';
      res.writeHead(200, {
        'content-type': safeMime(url.searchParams.get('mime')),
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
        ...CORS,
      });
      return fs.createReadStream(p).pipe(res);
    }

    if (url.pathname === '/capture' && req.method === 'GET') {
      return send(res, 200, fs.readFileSync(new URL('./capture.html', import.meta.url)), 'text/html; charset=utf-8');
    }

    if (!authorized(req)) return send(res, 401, { error: 'Missing or wrong token' });

    // What the server holds, so a device can tell whether its changes arrived.
    if (url.pathname === '/status' && req.method === 'GET') {
      const r = db.prepare(`SELECT COUNT(*) AS records, COALESCE(SUM(deleted), 0) AS deleted, COALESCE(MAX(seq), 0) AS lastSeq,
        COALESCE(SUM(kind = 'task' AND deleted = 0), 0) AS tasks FROM records`).get();
      const files = fs.readdirSync(path.join(DATA, 'files')).length;
      return send(res, 200, { ok: true, serverId: SERVER_ID, ...r, files, liveDevices: live.count() });
    }

    if (url.pathname === '/widget' && req.method === 'GET') return send(res, 200, taskApi.widget(url.searchParams.get('today')));
    if (url.pathname === '/iiq/status' && req.method === 'GET') return send(res, 200, iiq.status());

    if (url.pathname === '/tasks' && req.method === 'POST') {
      const r = taskApi.create(JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}'));
      return send(res, r.status, r.body);
    }

    const done = url.pathname.match(/^\/tasks\/([\w-]{1,64})\/done$/);
    if (done && req.method === 'POST') {
      const r = taskApi.complete(done[1], JSON.parse((await readBody(req, 4096)).toString() || '{}'));
      return send(res, r.status, r.body);
    }

    if (url.pathname === '/events/ticket' && req.method === 'POST') {
      return send(res, 200, { ticket: live.ticket() });
    }

    if (url.pathname === '/sync' && req.method === 'POST') {
      const { cursor = 0, changes = [], deviceId = '' } = JSON.parse((await readBody(req, 10 * 1024 * 1024)).toString() || '{}');
      if (applyChanges(changes) > 0) live.changed(String(deviceId));
      // A device asked for something in Incident IQ (comment, start, resolve).
      if (changes.some((c) => c.kind === 'iiq-action')) void iiq.processActions();
      const rows = since.all(Number(cursor)).map((r) => ({ ...r, deleted: !!r.deleted, data: JSON.parse(r.data) }));
      const newCursor = rows.length ? rows[rows.length - 1].seq : Number(cursor);
      return send(res, 200, { serverId: SERVER_ID, lastSeq: lastSeq(), cursor: newCursor, changes: rows, more: rows.length === 5000 });
    }

    const link = url.pathname.match(/^\/files\/([a-f0-9]{64})\/link$/);
    if (link && req.method === 'POST') {
      const { name = '', mime = '' } = JSON.parse((await readBody(req, 4096)).toString() || '{}');
      const exp = Date.now() + 10 * 60 * 1000;
      const q = new URLSearchParams({ exp: String(exp), name, mime, sig: sign(link[1], exp, name, mime) });
      return send(res, 200, { url: `/files/${link[1]}?${q}` });
    }

    const file = url.pathname.match(/^\/files\/([a-f0-9]{64})$/);
    if (file) {
      const p = path.join(DATA, 'files', file[1]);
      if (req.method === 'PUT') {
        const buf = await readBody(req, MAX_FILE);
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        if (hash !== file[1]) return send(res, 400, { error: 'Hash does not match file contents' });
        fs.writeFileSync(p, buf);
        return send(res, 201, { ok: true });
      }
      if (req.method === 'GET') {
        if (!fs.existsSync(p)) return send(res, 404, { error: 'No such file' });
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return fs.createReadStream(p).pipe(res);
      }
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, e.message === 'too large' ? 413 : 400, { error: e.message });
  }
});

server.on('upgrade', (req, socket) => {
  socket.on('error', () => socket.destroy());
  if (!live.upgrade(req, socket)) socket.destroy();
});

server.listen(PORT, () => {
  console.log(`Nextly sync listening on :${PORT}`);
  if (iiq.state.enabled) { console.log('Incident IQ sync on.'); iiq.start(); }
});
