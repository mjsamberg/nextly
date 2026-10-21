// Pure rules shared by the store and the UI. No storage, no React, so they
// can be unit-tested with plain Node (see logic.test.ts).
import type { Block, Flag, Task, TaskItem } from './types';

export function uid(): string {
  // randomUUID needs a secure context; getRandomValues doesn't.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const BLOCK_TYPES = new Set(['heading', 'paragraph', 'checklist', 'quote', 'divider', 'image', 'file', 'email']);

function normBlock(b: any, i: number): Block {
  const type = b?.type === 'text' ? 'paragraph' : BLOCK_TYPES.has(b?.type) ? b.type : 'paragraph';
  return { ...b, id: String(b?.id ?? `b${i}`), type };
}

// Tolerates older or partial records (for example ones written by the capture page).
export function normTask(d: any): Task {
  const notes: Block[] = Array.isArray(d?.notes) ? d.notes.map(normBlock) : [];
  if (Array.isArray(d?.links)) {
    for (const l of d.links) notes.push({ id: uid(), type: 'email', url: l.url, subject: l.subject });
  }
  const flag: Flag = ['inbox', 'today', 'next', 'someday'].includes(d?.flag)
    ? d.flag
    : d?.list === 'inbox' ? 'inbox' : null;
  return {
    title: String(d?.title ?? ''),
    flag,
    projectId: d?.projectId ?? null,
    parentId: d?.parentId ?? null,
    deadline: typeof d?.deadline === 'string' ? d.deadline : null,
    done: !!d?.done,
    doneAt: d?.doneAt ?? null,
    order: typeof d?.order === 'number' ? d.order : Date.parse(d?.createdAt ?? '') || 0,
    dependsOn: Array.isArray(d?.dependsOn) ? d.dependsOn.map(String) : [],
    notes,
    createdAt: d?.createdAt ?? new Date(0).toISOString(),
  };
}

export type TaskLookup = (id: string) => TaskItem | undefined;

/** Open tasks this one is still waiting on. Deleted or missing tasks don't block. */
export function openBlockers(t: TaskItem, get: TaskLookup): TaskItem[] {
  return t.dependsOn.map(get).filter((d): d is TaskItem => !!d && !d.done);
}

/** True if making `taskId` depend on `depId` would create a loop. */
export function wouldCycle(taskId: string, depId: string, get: TaskLookup): boolean {
  if (taskId === depId) return true;
  const seen = new Set<string>();
  const stack = [depId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = get(id);
    if (t) stack.push(...t.dependsOn);
  }
  return false;
}

/** Order value that places a task between two neighbours in Next. */
export function orderBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return Date.now();
  if (before === undefined) return after! - 1000;
  if (after === undefined) return before + 1000;
  return (before + after) / 2;
}

/** Swipe right promotes, swipe left defers. Never touches dates. */
export function promote(_f: Flag): Flag {
  return 'today';
}
export function defer(f: Flag): Flag {
  if (f === 'today') return 'next';
  if (f === 'next') return 'someday';
  if (f === 'inbox' || f === null) return 'next';
  return 'someday';
}

// ---------- dates (local, YYYY-MM-DD) ----------

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Parses "today", "tom", "fri", "10/23", "2026-10-23". Weekdays mean the next one, counting today. */
export function parseDateWord(word: string, now = new Date()): string | null {
  const w = word.toLowerCase();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (w === 'today' || w === 'tod') return ymd(base);
  if (w === 'tom' || w === 'tomorrow') return ymd(new Date(base.getTime() + 86400000));
  const day = DAYS.findIndex((d) => w.startsWith(d) && w.length >= 3);
  if (day >= 0) {
    const diff = (day - base.getDay() + 7) % 7;
    return ymd(new Date(base.getFullYear(), base.getMonth(), base.getDate() + diff));
  }
  let m = w.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return ymd(new Date(+m[1], +m[2] - 1, +m[3]));
  m = w.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    let y = m[3] ? +m[3] : base.getFullYear();
    if (y < 100) y += 2000;
    let d = new Date(y, +m[1] - 1, +m[2]);
    if (!m[3] && d < base) d = new Date(y + 1, +m[1] - 1, +m[2]);
    return ymd(d);
  }
  return null;
}

/** Short label for a deadline chip: "Today", "Fri", "Oct 23". */
export function deadlineLabel(s: string, now = new Date()): string {
  const d = parseYmd(s);
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((d.getTime() - base.getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

// ---------- quick add ----------

export interface QuickAdd {
  title: string;
  flag?: Flag;
  deadline?: string;
  emailUrl?: string;
}

const FLAG_TOKENS: Record<string, Flag> = {
  t: 'today', today: 'today', n: 'next', next: 'next',
  s: 'someday', someday: 'someday', i: 'inbox', inbox: 'inbox',
};

/**
 * "Reply to Ortiz !t ^fri" -> { title: "Reply to Ortiz", flag: "today", deadline: <friday> }
 * A pasted Gmail link becomes an email block instead of part of the title.
 */
export function parseQuickAdd(input: string, now = new Date()): QuickAdd {
  const out: QuickAdd = { title: '' };
  const words: string[] = [];
  for (const w of input.trim().split(/\s+/)) {
    if (!w) continue;
    const flag = w.startsWith('!') ? FLAG_TOKENS[w.slice(1).toLowerCase()] : undefined;
    if (flag !== undefined) { out.flag = flag; continue; }
    if (w.startsWith('^')) {
      const d = parseDateWord(w.slice(1), now);
      if (d) { out.deadline = d; continue; }
    }
    if (/^https:\/\/mail\.google\.com\//.test(w) || /^message:/.test(w)) { out.emailUrl = w; continue; }
    words.push(w);
  }
  out.title = words.join(' ');
  return out;
}

// ---------- extra request headers (Cloudflare Access and similar) ----------

export interface HeaderRow { name: string; value: string }

// Header names the app sets itself, or that the HTTP stack won't let us set.
const RESERVED = new Set(['authorization', 'content-type', 'content-length', 'host', 'connection', 'transfer-encoding']);

/** Checks the rows from Settings. Blank rows are ignored. */
export function checkHeaders(rows: HeaderRow[]): string | null {
  const seen = new Set<string>();
  for (const { name, value } of rows) {
    const n = name.trim();
    if (!n && !value.trim()) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(n)) return `“${n || '(blank)'}” isn’t a valid header name. Use letters, numbers and dashes, like CF-Access-Client-Id.`;
    if (RESERVED.has(n.toLowerCase())) return `Nextly sets ${n} itself, so it can’t be added here.`;
    if (seen.has(n.toLowerCase())) return `${n} is listed twice.`;
    if (/[\r\n]/.test(value)) return `The value for ${n} can’t contain line breaks.`;
    seen.add(n.toLowerCase());
  }
  return null;
}

export function headerObject(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of rows) if (name.trim()) out[name.trim()] = value.trim();
  return out;
}

/**
 * Cloudflare Access answers a request without a valid service token with a
 * 403 or a redirect to its login page instead of reaching the server.
 */
export function blockedByAccess(status: number, contentType: string | null, finalUrl: string): boolean {
  if (/cloudflareaccess\.com|\/cdn-cgi\/access\//.test(finalUrl)) return true;
  return (status === 403 || status === 302 || (status === 200 && !!contentType && contentType.includes('text/html')));
}

// ---------- nextly:// capture links ----------

export interface Capture {
  title: string;
  flag: Flag;
  emailUrl: string | null; // only Gmail or Apple Mail links become email cards
  otherUrl: string | null; // anything else is kept as a plain link in the notes
  note: string;
}

/**
 * Reads nextly://add?title=…&url=…&list=…&note=… from the bookmarklet.
 * Any web page can open a nextly:// link, so this only ever adds a task, caps
 * every field, and defaults to the Inbox. Returns null for anything else.
 */
export function parseCaptureLink(link: string): Capture | null {
  let u: URL;
  try { u = new URL(link); } catch { return null; }
  if (u.protocol !== 'nextly:') return null;
  // Browsers and Windows may hand it over as nextly://add, nextly://add/ or nextly:add.
  const action = (u.host || u.pathname).replace(/^\/+|\/+$/g, '').toLowerCase();
  if (action !== 'add') return null;
  const q = u.searchParams;
  const clip = (s: string | null, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const url = clip(q.get('url'), 2000);
  const isEmail = /^https:\/\/mail\.google\.com\//.test(url) || /^message:/.test(url);
  const isWeb = /^https?:\/\//.test(url);
  const list = q.get('list');
  const title = clip(q.get('title'), 500) || (isEmail ? 'Email' : '');
  if (!title) return null;
  return {
    title,
    flag: list === 'today' || list === 'next' || list === 'someday' ? list : 'inbox',
    emailUrl: isEmail ? url : null,
    otherUrl: !isEmail && isWeb ? url : null,
    note: (q.get('note') ?? '').trim().slice(0, 5000),
  };
}

export function noteText(t: Task): string {
  return t.notes.map((b) => [b.text, b.subject, b.name].filter(Boolean).join(' ')).join(' ');
}
