// Run with: node --test   (from server/)
// Starts the real server on a spare port with a throwaway data folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'test-token';
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const auth = { authorization: `Bearer ${TOKEN}` };
let server;
let data;

before(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'nextly-test-'));
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: { ...process.env, NEXTLY_TOKEN: TOKEN, NEXTLY_DATA: data, PORT: String(PORT), IIQ_URL: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => server.stdout.on('data', (b) => { if (String(b).includes('listening')) resolve(); }));
});

after(() => {
  server.kill();
  fs.rmSync(data, { recursive: true, force: true });
});

/** Uploads bytes and opens them through a signed link, as the app does. */
async function open(bytes, name, mime) {
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal((await fetch(`${BASE}/files/${sha}`, { method: 'PUT', headers: auth, body: bytes })).status, 201);
  const link = await fetch(`${BASE}/files/${sha}/link`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name, mime }) });
  return fetch(BASE + (await link.json()).url);
}

test('HTML and SVG attachments download instead of opening on the server origin', async () => {
  for (const [name, mime] of [['page.html', 'text/html'], ['pic.svg', 'image/svg+xml'], ['data.xml', 'application/xml']]) {
    const res = await open(Buffer.from(`<script>alert(1)</script>${name}`), name, mime);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /^attachment;/, name);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('images, PDFs and plain text still open in the browser', async () => {
  for (const [name, mime] of [['photo.png', 'image/png'], ['form.pdf', 'application/pdf'], ['notes.txt', 'text/plain']]) {
    const res = await open(Buffer.from(`bytes of ${name}`), name, mime);
    assert.match(res.headers.get('content-disposition'), /^inline;/, name);
    assert.equal(res.headers.get('content-type'), mime);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
});
