// Pure rules shared by the store and the UI. No storage, no React, so they
// can be unit-tested with plain Node (see logic.test.ts).
import type { Block, Flag, Repeat, Task, TaskItem } from './types';

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

const FLAGS = ['inbox', 'doing', 'today', 'next', 'someday'];
const UNITS = ['day', 'week', 'month', 'year'];

export function normRepeat(r: any): Repeat | null {
  if (!r || !UNITS.includes(r.unit)) return null;
  const every = Math.min(365, Math.max(1, Math.round(Number(r.every) || 1)));
  const weekdays = Array.isArray(r.weekdays)
    ? [...new Set(r.weekdays.map(Number).filter((n: number) => n >= 0 && n <= 6))].sort() as number[]
    : [];
  return {
    every,
    unit: r.unit,
    ...(r.unit === 'week' && weekdays.length ? { weekdays } : {}),
    from: r.from === 'completion' ? 'completion' : 'schedule',
  };
}

// Tolerates older or partial records (for example ones written by the capture page).
export function normTask(d: any): Task {
  const notes: Block[] = Array.isArray(d?.notes) ? d.notes.map(normBlock) : [];
  if (Array.isArray(d?.links)) {
    for (const l of d.links) notes.push({ id: uid(), type: 'email', url: l.url, subject: l.subject });
  }
  const flag: Flag = FLAGS.includes(d?.flag)
    ? d.flag
    : d?.list === 'inbox' ? 'inbox' : null;
  return {
    title: String(d?.title ?? ''),
    flag,
    projectId: d?.projectId ?? null,
    parentId: d?.parentId ?? null,
    deadline: typeof d?.deadline === 'string' ? d.deadline : null,
    startOn: typeof d?.startOn === 'string' ? d.startOn : null,
    repeat: normRepeat(d?.repeat),
    nextId: typeof d?.nextId === 'string' ? d.nextId : null,
    external: d?.external?.source === 'iiq' && d.external.id ? { number: null, url: null, status: null, closed: false, requester: null, location: null, issue: null, priority: null, syncedAt: null, ...d.external } : null,
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

/** Swipe right promotes (… → Today → In Progress), swipe left defers. Never touches dates. */
export function promote(f: Flag): Flag {
  return f === 'today' || f === 'doing' ? 'doing' : 'today';
}
export function defer(f: Flag): Flag {
  if (f === 'doing') return 'today';
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

// ---------- repeating tasks ----------

const DAY_MS = 86400000;

/** Moves a YYYY-MM-DD date by n days. */
export function shiftDate(s: string, n: number): string {
  const d = parseYmd(s);
  return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

/** Adds months, keeping the day but clamping to the month's end (Jan 31 + 1 month = Feb 28/29). */
function addMonths(s: string, n: number): string {
  const d = parseYmd(s);
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return ymd(new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last)));
}

/** The first date after `after` that the rule lands on. */
export function nextOccurrence(r: Repeat, after: string): string {
  if (r.unit === 'week' && r.weekdays?.length) {
    // Next chosen weekday; with every > 1, skip whole weeks once the week's days are used.
    let d = after;
    for (let i = 1; i <= 7; i++) {
      d = shiftDate(after, i);
      if (r.weekdays.includes(parseYmd(d).getDay())) break;
    }
    if (r.every > 1 && parseYmd(d).getDay() <= parseYmd(after).getDay()) d = shiftDate(d, 7 * (r.every - 1));
    return d;
  }
  if (r.unit === 'day') return shiftDate(after, r.every);
  if (r.unit === 'week') return shiftDate(after, 7 * r.every);
  if (r.unit === 'month') return addMonths(after, r.every);
  return addMonths(after, 12 * r.every);
}

/**
 * When the next copy of a finished repeating task should move into Today.
 * "schedule" counts from where this one was scheduled (start date, else
 * deadline) and skips any dates already past; "completion" counts from today.
 */
export function nextStart(r: Repeat, t: { startOn: string | null; deadline: string | null }, today: string): string {
  const base = r.from === 'completion' ? today : (t.startOn ?? t.deadline ?? today);
  let next = nextOccurrence(r, base);
  for (let i = 0; next <= today && i < 1000; i++) next = nextOccurrence(r, next);
  return next;
}

/** Days between two YYYY-MM-DD dates. */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / DAY_MS);
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function repeatLabel(r: Repeat): string {
  if (r.unit === 'week' && r.weekdays?.length) {
    const days = r.weekdays.join(',');
    const what = days === '1,2,3,4,5' ? 'weekday' : r.weekdays.map((d) => WEEKDAY_NAMES[d]).join(', ');
    return r.every === 1 ? `Every ${what}` : `Every ${r.every} weeks on ${what === 'weekday' ? 'weekdays' : what}`;
  }
  const unit = r.every === 1 ? r.unit : `${r.every} ${r.unit}s`;
  return `Every ${unit}`;
}

const REPEAT_WORDS: Record<string, Omit<Repeat, 'from'>> = {
  daily: { every: 1, unit: 'day' },
  weekdays: { every: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] },
  weekly: { every: 1, unit: 'week' },
  biweekly: { every: 2, unit: 'week' },
  monthly: { every: 1, unit: 'month' },
  yearly: { every: 1, unit: 'year' },
};

/** "*daily", "*weekdays", "*weekly", "*monthly", "*yearly", "*3d", "*2w", "*6m", "*1y". */
export function parseRepeatWord(word: string): Repeat | null {
  const w = word.toLowerCase();
  if (REPEAT_WORDS[w]) return { ...REPEAT_WORDS[w], from: 'schedule' };
  const m = w.match(/^(\d{1,3})([dwmy])$/);
  if (!m || +m[1] < 1) return null;
  const unit = ({ d: 'day', w: 'week', m: 'month', y: 'year' } as const)[m[2] as 'd' | 'w' | 'm' | 'y'];
  return { every: +m[1], unit, from: 'schedule' };
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
  startOn?: string;
  repeat?: Repeat;
  emailUrl?: string;
}

const FLAG_TOKENS: Record<string, Flag> = {
  t: 'today', today: 'today', n: 'next', next: 'next',
  s: 'someday', someday: 'someday', i: 'inbox', inbox: 'inbox',
  p: 'doing', progress: 'doing', doing: 'doing',
};

/**
 * "Reply to Ortiz !t ^fri" -> { title: "Reply to Ortiz", flag: "today", deadline: <friday> }
 *   !t !n !p !s !i   flag (Today, Next, In Progress, Someday, Inbox)
 *   ^fri             deadline
 *   @mon             start date: waits in Scheduled, moves into Today that day
 *   *weekly *3d      repeat
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
    if (w.startsWith('@')) {
      const d = parseDateWord(w.slice(1), now);
      if (d) { out.startOn = d; continue; }
    }
    if (w.startsWith('*')) {
      const r = parseRepeatWord(w.slice(1));
      if (r) { out.repeat = r; continue; }
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
