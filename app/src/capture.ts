// nextly://add links from the Gmail bookmarklet (capture/). Each one becomes
// an Inbox task with an email card, then the app opens it so you can choose
// Today or Next. Links arrive at launch (getCurrent) or while running (onOpenUrl).
// Any web page can open a nextly:// link, so all it can ever do is add a task.

import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { inTauri } from './net';
import { createTask } from './store';
import { parseCaptureLink, uid } from './logic';
import type { Block } from './types';

export interface Captured { id: string; title: string }

// A link that opens the app can arrive before the UI is listening, so keep
// captures until App takes them.
let queue: Captured[] = [];
let listener: ((c: Captured) => void) | null = null;

/** App calls this once mounted; returns an unsubscribe function. */
export function onCaptured(fn: (c: Captured) => void): () => void {
  listener = fn;
  const waiting = queue;
  queue = [];
  waiting.forEach(fn);
  return () => { if (listener === fn) listener = null; };
}

// The same link can arrive twice (launch + event); only add it once.
const handled = new Set<string>();

function handle(urls: string[] | null) {
  for (const link of urls ?? []) {
    if (handled.has(link)) continue;
    handled.add(link);
    const c = parseCaptureLink(link);
    if (!c) continue;
    const notes: Block[] = [];
    if (c.note) notes.push({ id: uid(), type: 'paragraph', text: c.note });
    if (c.emailUrl) notes.push({ id: uid(), type: 'email', url: c.emailUrl, subject: c.title });
    if (c.otherUrl) notes.push({ id: uid(), type: 'paragraph', text: c.otherUrl });
    const captured = { id: createTask({ title: c.title, flag: c.flag, notes }), title: c.title };
    if (listener) listener(captured); else queue.push(captured);
  }
}

export async function initCapture() {
  if (!inTauri) return;
  try {
    await onOpenUrl(handle);
    handle(await getCurrent());
  } catch (e) {
    console.warn('nextly:// links are unavailable:', e);
  }
}
