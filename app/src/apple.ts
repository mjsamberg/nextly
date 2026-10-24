// Keeps the widget and Siri extensions (apple/) supplied on macOS and iOS.
// They read the sync settings from the App Group folder and talk to the
// server themselves; the snapshot here is only their fallback when the server
// can't be reached. Tasks Siri saved while offline come back through
// pending.json and are added here.

import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { inTauri, platform } from './net';
import { createTask, subscribe, view } from './store';
import { tasksFor } from './lists';
import { headerObject } from './logic';
import type { Flag } from './types';

const enabled = inTauri && (platform === 'mac' || platform === 'ios');

/** urls: every address for the server, primary first (the extensions fail over between them). */
interface SharedSettings { url: string; urls: string[]; token: string; headers: { name: string; value: string }[] }

let settings: SharedSettings = { url: '', urls: [], token: '', headers: [] };
let timer: ReturnType<typeof setTimeout> | undefined;

function snapshot() {
  const v = view();
  const item = (t: ReturnType<typeof tasksFor>[number]) => ({
    id: t.id,
    title: t.title || 'Untitled task',
    flag: t.flag,
    deadline: t.deadline,
    blocked: v.blockers(t).length > 0,
    project: v.project(t.projectId)?.title ?? (t.parentId ? v.task(t.parentId)?.title ?? null : null),
  });
  const doing = tasksFor(v, 'doing');
  const today = tasksFor(v, 'today');
  const next = tasksFor(v, 'next');
  return {
    doing: doing.slice(0, 12).map(item),
    today: today.slice(0, 12).map(item),
    next: next.slice(0, 12).map(item),
    counts: { doing: doing.length, today: today.length, next: next.length, inbox: tasksFor(v, 'inbox').length },
    updatedAt: new Date().toISOString(),
  };
}

/** What happened the last time we shared with the extensions, for Settings. */
export interface ShareStatus { state: 'off' | 'ok' | 'no-group' | 'error'; at: string | null; message: string }

let status: ShareStatus = { state: 'off', at: null, message: '' };
const listeners = new Set<() => void>();
const setShareStatus = (s: ShareStatus) => { status = s; listeners.forEach((l) => l()); };
export const widgetSharingEnabled = enabled;
export const useShareStatus = () =>
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => status);

async function share() {
  if (!enabled) return;
  // "url" stays for extensions built before "urls".
  const config = { url: settings.url.replace(/\/+$/, ''), urls: settings.urls, token: settings.token, headers: headerObject(settings.headers) };
  try {
    const wrote = await invoke<boolean>('apple_share', { config: JSON.stringify(config), snapshot: JSON.stringify(snapshot()) });
    setShareStatus(wrote
      ? { state: 'ok', at: new Date().toISOString(), message: '' }
      : { state: 'no-group', at: null, message: 'This platform has no App Group folder.' });
  } catch (e) {
    // The Rust side says which step failed and which group it asked for.
    setShareStatus({ state: 'error', at: null, message: String(e) });
  }
}

const shareSoon = () => { clearTimeout(timer); timer = setTimeout(share, 1500); };

/** Called whenever sync settings load or change. */
export function shareSettings(s: SharedSettings) {
  settings = s;
  shareSoon();
}

async function importPending() {
  if (!enabled) return;
  try {
    const raw = await invoke<string>('apple_take_pending');
    const items = JSON.parse(raw) as { title?: string; list?: string; createdAt?: string }[];
    for (const p of items) {
      const title = String(p.title ?? '').trim();
      if (!title) continue;
      const flag: Flag = p.list === 'doing' || p.list === 'today' || p.list === 'next' || p.list === 'someday' ? p.list : 'inbox';
      createTask({ title, flag, createdAt: p.createdAt ?? new Date().toISOString() });
    }
  } catch (e) {
    console.warn('Couldn’t import tasks saved by Siri:', e);
  }
}

export function initApple() {
  if (!enabled) return;
  subscribe(shareSoon);
  void importPending();
  window.addEventListener('focus', () => void importPending());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void importPending(); });
}
