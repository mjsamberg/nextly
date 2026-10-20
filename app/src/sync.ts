// Talks to the Nextly sync server (server/server.js).
// Push every unsent record, pull everything newer than our cursor, repeat
// while the server says there's more. Then upload any attachments not yet sent.

import { useSyncExternalStore } from 'react';
import * as db from './db';
import { http } from './net';
import { applyRemote, deviceId, localCounts, markSent, pendingChanges, requeueAll, setOnLocalChange } from './store';
import { blockedByAccess, headerObject, type HeaderRow } from './logic';
import { startLive, stopLive, type LiveState } from './live';
import { shareSettings } from './apple';
import type { Rec } from './types';

/** headers: sent with every request, e.g. a Cloudflare Access service token. */
export interface SyncSettings { url: string; token: string; headers: HeaderRow[] }
/** 'idle' (green) only ever means the last sync actually completed. */
export interface SyncStatus {
  state: 'off' | 'idle' | 'syncing' | 'error';
  message: string;
  lastSync: string | null;
  sent: number | null;
  received: number | null;
  live: LiveState;
  liveDetail: string;
}

let settings: SyncSettings = { url: '', token: '', headers: [] };
let status: SyncStatus = { state: 'off', message: 'Sync isn’t set up yet', lastSync: null, sent: null, received: null, live: 'off', liveDetail: '' };
let lastSyncAt = 0;
// With live updates connected, polling is only a safety net.
const POLL_LIVE = 5 * 60_000;
const POLL_OFFLINE = 30_000;
const listeners = new Set<() => void>();
let running = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;

const setStatus = (s: Partial<SyncStatus>) => { status = { ...status, ...s }; listeners.forEach((l) => l()); };
export const useSyncStatus = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => status);
export const getSettings = () => settings;

const base = () => settings.url.replace(/\/+$/, '');
const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: {
    ...headerObject(settings.headers),
    ...(init.headers as Record<string, string>),
    authorization: `Bearer ${settings.token}`,
  },
});

/** A request that hangs would otherwise block every later sync. */
async function request(url: string, init: RequestInit, ms = 30_000): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await http(url, { ...authed(init), signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`${new URL(url).host} didn’t answer within ${ms / 1000} seconds.`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const notReady = (): string | null =>
  !settings.url ? 'Sync isn’t set up yet' : !settings.token ? 'Add the sync token in Settings to start syncing.' : null;

const ACCESS_HELP = 'Cloudflare Access blocked the request. Check the CF-Access-Client-Id and CF-Access-Client-Secret headers in Settings.';

/** Throws a readable error for anything but a real answer from the Nextly server. */
function check(res: Response, what: string) {
  if (blockedByAccess(res.status, res.headers.get('content-type'), res.url)) throw new Error(ACCESS_HELP);
  if (res.status === 401) throw new Error('The server rejected the sync token. Check it in Settings.');
  if (!res.ok) throw new Error(`${what}: the server answered ${res.status}.`);
}

export async function initSync() {
  const saved = await db.get<Partial<SyncSettings>>('meta', 'sync');
  settings = { url: saved?.url ?? '', token: saved?.token ?? '', headers: saved?.headers ?? [] };
  shareSettings(settings);
  const last = await db.get<string>('meta', 'lastSync');
  const problem = notReady();
  setStatus({ state: problem ? (settings.url ? 'error' : 'off') : 'off', message: problem ?? 'Not synced yet', lastSync: last ?? null });
  // Push local edits shortly after they happen. Other devices' edits arrive
  // through live updates; polling covers the times that isn't connected.
  setOnLocalChange(() => { clearTimeout(timer); timer = setTimeout(syncNow, 800); });
  setInterval(() => {
    const every = status.live === 'live' ? POLL_LIVE : POLL_OFFLINE;
    if (Date.now() - lastSyncAt >= every - 1000) void syncNow();
  }, POLL_OFFLINE);
  window.addEventListener('focus', () => void syncNow());
  window.addEventListener('online', () => { void syncNow(); restartLive(); });
  restartLive();
  void syncNow();
}

function restartLive() {
  if (notReady()) { stopLive(); setStatus({ live: 'off', liveDetail: '' }); return; }
  startLive({
    url: base(),
    headers: authed().headers as Record<string, string>,
    deviceId,
    getTicket: async () => {
      const res = await request(`${base()}/events/ticket`, { method: 'POST' }, 15_000);
      check(res, 'Live updates');
      return (await res.json() as { ticket: string }).ticket;
    },
    onChanged: () => void syncNow(),
    onConnected: () => void syncNow(),
    onState: (live, liveDetail = '') => setStatus({ live, liveDetail }),
  });
}

export async function saveSettings(s: SyncSettings) {
  const changedServer = s.url !== settings.url;
  settings = {
    url: s.url.trim(),
    token: s.token.trim(),
    headers: s.headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.value.trim() })),
  };
  await db.put('meta', settings, 'sync');
  shareSettings(settings);
  if (changedServer) await db.put('meta', 0, 'cursor'); // new server: pull everything
  restartLive();
  await syncNow();
}

export async function syncNow(): Promise<void> {
  const problem = notReady();
  if (problem) { setStatus({ state: settings.url ? 'error' : 'off', message: problem }); return; }
  if (running) { again = true; return; }
  running = true;
  setStatus({ state: 'syncing', message: 'Syncing…' });
  try {
    let cursor = (await db.get<number>('meta', 'cursor')) ?? 0;
    let sent = 0;
    let received = 0;
    let resets = 0;
    for (;;) {
      const changes = pendingChanges();
      const res = await request(`${base()}/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cursor, changes, deviceId }), // so the server doesn't wake us for our own change
      });
      check(res, 'Sync failed');
      const body = await res.json().catch(() => ({})) as { serverId?: string; lastSeq?: number; cursor?: number; changes?: Rec[]; more?: boolean };
      if (typeof body.cursor !== 'number' || !Array.isArray(body.changes)) {
        throw new Error(`${base()} answered, but not like a Nextly server. Check the server address.`);
      }
      markSent(changes);
      sent += changes.length;

      // A different server, or one that's behind us, has lost or never had our
      // data: start from the beginning and send everything again.
      const knownId = await db.get<string>('meta', 'serverId');
      const isNewServer = !!body.serverId && body.serverId !== knownId;
      const isBehind = typeof body.lastSeq === 'number' && body.lastSeq < cursor;
      if (body.serverId) await db.put('meta', body.serverId, 'serverId');
      if ((isNewServer && (knownId || cursor > 0)) || isBehind) {
        await resetForNewServer();
        cursor = 0;
        resets++;
        if (resets > 2) throw new Error('The server keeps starting over. Check that its data volume is kept between restarts.');
        continue;
      }

      // The server echoes our own changes back; count only ones that were new here.
      received += applyRemote(body.changes);
      cursor = body.cursor;
      await db.put('meta', cursor, 'cursor');
      if (!body.more) break;
    }
    await uploadFiles();
    const now = new Date().toISOString();
    lastSyncAt = Date.now();
    await db.put('meta', now, 'lastSync');
    setStatus({
      state: 'idle',
      message: sent || received ? `Synced · sent ${sent}, received ${received}` : 'Up to date · nothing new',
      lastSync: now, sent, received,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus({ state: 'error', message: /fetch|network|connect|dns|refused|timed out/i.test(msg) ? `Can’t reach ${settings.url}. Check your internet connection and that the tunnel is running.` : msg });
  } finally {
    running = false;
    if (again) { again = false; void syncNow(); }
  }
}

async function resetForNewServer() {
  requeueAll();
  await db.put('meta', 0, 'cursor');
  for (const key of await db.keys('files')) {
    const f = await db.get<db.StoredFile>('files', String(key));
    if (f?.uploaded) await db.put('files', { ...f, uploaded: false }, String(key));
  }
}

/**
 * Compares what the server holds with this device, in plain words.
 * If two devices agree with each other but not with the server, their
 * changes aren't arriving; if the server count grows but a device's
 * doesn't, that device isn't pulling.
 */
export async function checkConnection(): Promise<{ ok: boolean; lines: string[] }> {
  const problem = notReady();
  if (problem) return { ok: false, lines: [problem] };
  const here = localCounts();
  const cursor = (await db.get<number>('meta', 'cursor')) ?? 0;
  try {
    const res = await request(`${base()}/status`, {}, 15_000);
    if (res.status === 404) {
      return { ok: false, lines: ['The server answered but is an older version without the connection check. Rebuild it with docker compose build --pull --no-cache && docker compose up -d.'] };
    }
    check(res, 'Connection check failed');
    const s = await res.json().catch(() => null) as { serverId?: string; tasks: number; records: number; lastSeq: number; files: number; liveDevices?: number } | null;
    const knownId = await db.get<string>('meta', 'serverId');
    const startedOver = (!!s?.serverId && !!knownId && s.serverId !== knownId) || (!!s && cursor > s.lastSeq);
    if (!s || typeof s.records !== 'number') return { ok: false, lines: [`${base()} answered, but not like a Nextly server. Check the server address.`] };
    const lines = [
      `Connected to ${new URL(base()).host}.`,
      `Server: ${s.tasks} tasks (${s.records} records, latest change #${s.lastSeq}, ${s.files} files).`,
      `This device: ${here.tasks} tasks (${here.records} records), has seen up to change #${cursor}, ${here.unsent} not sent yet.`,
    ];
    if (typeof s.liveDevices === 'number') {
      lines.push(`Live updates: ${s.liveDevices} device${s.liveDevices === 1 ? '' : 's'} connected to the server${status.live === 'live' ? ', including this one' : '; this one isn’t'}.`);
    }
    if (startedOver) lines.push('The server has started over since this device last synced (for example, its data volume was recreated). Tap Sync now and this device will send everything it has again.');
    else if (here.unsent > 0) lines.push('Some changes here haven’t reached the server yet. Tap Sync now.');
    else if (cursor < s.lastSeq) lines.push('The server has changes this device hasn’t pulled yet. Tap Sync now.');
    else lines.push('This device is fully in step with the server.');
    return { ok: true, lines };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, lines: [/fetch|network|connect|dns|refused/i.test(msg) ? `Can’t reach ${settings.url}. ${msg}` : msg] };
  }
}

// ---------- attachments ----------

async function uploadFiles() {
  for (const key of await db.keys('files')) {
    const sha = String(key);
    const f = await db.get<db.StoredFile>('files', sha);
    if (!f || f.uploaded) continue;
    const res = await request(`${base()}/files/${sha}`, { method: 'PUT', body: new Uint8Array(f.bytes) }, 120_000);
    check(res, `Couldn’t upload ${f.name}`);
    await db.put('files', { ...f, uploaded: true }, sha);
  }
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stores a picked file locally and queues it for upload. */
export async function addFile(file: File): Promise<{ sha: string; name: string; size: number; mime: string }> {
  const bytes = await file.arrayBuffer();
  const sha = await sha256(bytes);
  const mime = file.type || 'application/octet-stream';
  if (!(await db.get('files', sha))) await db.put('files', { bytes, mime, name: file.name, uploaded: false } satisfies db.StoredFile, sha);
  void syncNow();
  return { sha, name: file.name, size: file.size, mime };
}

/** Local copy if we have it, otherwise download it from the server and keep it. */
export async function loadFile(sha: string, name = '', mime = 'application/octet-stream'): Promise<Blob | null> {
  const f = await db.get<db.StoredFile>('files', sha);
  if (f) return new Blob([f.bytes], { type: f.mime });
  if (!settings.url) return null;
  const res = await request(`${base()}/files/${sha}`, {}, 120_000);
  // Never cache an Access login page as the file.
  if (!res.ok || blockedByAccess(res.status, res.headers.get('content-type'), res.url)) return null;
  const bytes = await res.arrayBuffer();
  await db.put('files', { bytes, mime, name, uploaded: true } satisfies db.StoredFile, sha);
  return new Blob([bytes], { type: mime });
}

/** Short-lived link the system browser can open without the token. */
export async function fileLink(sha: string, name: string, mime: string): Promise<string> {
  await uploadFiles();
  const res = await request(`${base()}/files/${sha}/link`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, mime }),
  });
  check(res, 'Couldn’t open the file');
  return base() + (await res.json() as { url: string }).url;
}
