// Talks to the Nextly sync server (server/server.js).
// Push every unsent record, pull everything newer than our cursor, repeat
// while the server says there's more. Then upload any attachments not yet sent.

import { useSyncExternalStore } from 'react';
import * as db from './db';
import { http } from './net';
import { applyRemote, markSent, pendingChanges, setOnLocalChange } from './store';
import type { Rec } from './types';

export interface SyncSettings { url: string; token: string }
export interface SyncStatus { state: 'off' | 'idle' | 'syncing' | 'error'; message: string; lastSync: string | null }

let settings: SyncSettings = { url: '', token: '' };
let status: SyncStatus = { state: 'off', message: 'Sync isn’t set up yet', lastSync: null };
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
  headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${settings.token}` },
});

export async function initSync() {
  settings = (await db.get<SyncSettings>('meta', 'sync')) ?? settings;
  const last = await db.get<string>('meta', 'lastSync');
  setStatus(settings.url ? { state: 'idle', message: 'Ready', lastSync: last ?? null } : {});
  // Push local edits shortly after they happen, and poll for others' edits.
  setOnLocalChange(() => { clearTimeout(timer); timer = setTimeout(syncNow, 1500); });
  setInterval(syncNow, 30_000);
  window.addEventListener('focus', () => void syncNow());
  window.addEventListener('online', () => void syncNow());
  void syncNow();
}

export async function saveSettings(s: SyncSettings) {
  const changedServer = s.url !== settings.url;
  settings = { url: s.url.trim(), token: s.token.trim() };
  await db.put('meta', settings, 'sync');
  if (changedServer) await db.put('meta', 0, 'cursor'); // new server: pull everything
  setStatus(settings.url ? { state: 'idle', message: 'Saved' } : { state: 'off', message: 'Sync isn’t set up yet' });
  await syncNow();
}

export async function syncNow(): Promise<void> {
  if (!settings.url || !settings.token) return;
  if (running) { again = true; return; }
  running = true;
  setStatus({ state: 'syncing', message: 'Syncing…' });
  try {
    let cursor = (await db.get<number>('meta', 'cursor')) ?? 0;
    for (;;) {
      const changes = pendingChanges();
      const res = await http(`${base()}/sync`, authed({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cursor, changes }),
      }));
      if (res.status === 401) throw new Error('The server rejected the sync token. Check it in Settings.');
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      const body = await res.json() as { cursor: number; changes: Rec[]; more: boolean };
      markSent(changes);
      applyRemote(body.changes);
      cursor = body.cursor;
      await db.put('meta', cursor, 'cursor');
      if (!body.more) break;
    }
    await uploadFiles();
    const now = new Date().toISOString();
    await db.put('meta', now, 'lastSync');
    setStatus({ state: 'idle', message: 'Up to date', lastSync: now });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus({ state: 'error', message: /fetch|network|connect|dns|refused/i.test(msg) ? `Can’t reach ${settings.url}. Is Tailscale connected?` : msg });
  } finally {
    running = false;
    if (again) { again = false; void syncNow(); }
  }
}

// ---------- attachments ----------

async function uploadFiles() {
  for (const key of await db.keys('files')) {
    const sha = String(key);
    const f = await db.get<db.StoredFile>('files', sha);
    if (!f || f.uploaded) continue;
    const res = await http(`${base()}/files/${sha}`, authed({ method: 'PUT', body: new Uint8Array(f.bytes) }));
    if (!res.ok) throw new Error(`Couldn’t upload ${f.name} (${res.status}).`);
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
  const res = await http(`${base()}/files/${sha}`, authed());
  if (!res.ok) return null;
  const bytes = await res.arrayBuffer();
  await db.put('files', { bytes, mime, name, uploaded: true } satisfies db.StoredFile, sha);
  return new Blob([bytes], { type: mime });
}

/** Short-lived link the system browser can open without the token. */
export async function fileLink(sha: string, name: string, mime: string): Promise<string> {
  await uploadFiles();
  const res = await http(`${base()}/files/${sha}/link`, authed({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, mime }),
  }));
  if (!res.ok) throw new Error('Couldn’t open the file. Check that sync is working.');
  return base() + (await res.json() as { url: string }).url;
}
