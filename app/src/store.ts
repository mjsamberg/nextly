// In-memory copy of every record, persisted to IndexedDB and queued for sync.
// Components read through useStore() and change data only through the
// actions below. The rules themselves (blocking, Next order, subtasks,
// repeats) are pure functions in rules.ts, shared in spirit with the Swift apps.

import { useSyncExternalStore } from 'react';
import * as db from './db';
import * as hlc from './hlc';
import { uid, ymd } from './logic';
import * as rules from './rules';
import { buildView, Draft, SCHEMA, type ViewData } from './rules';
import type { Area, Flag, IiqAction, Kind, Project, Rec, Task } from './types';

const records = new Map<string, Rec>();
const outbox = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let onLocalChange: () => void = () => {};

export const setOnLocalChange = (f: () => void) => { onLocalChange = f; };
export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const bump = () => { version++; listeners.forEach((l) => l()); };

export function useStore() {
  useSyncExternalStore(subscribe, () => version);
  return view();
}

// ---------- loading, writing, syncing ----------

export let deviceId = '';

export async function load() {
  deviceId = (await db.get<string>('meta', 'deviceId')) ?? uid().slice(0, 8);
  await db.put('meta', deviceId, 'deviceId');
  hlc.setDevice(deviceId);
  for (const r of await db.getAll<Rec>('records')) { records.set(r.id, r); hlc.observe(r.hlc); }
  for (const k of await db.keys('outbox')) outbox.add(String(k));
  bump();
}

/** Saves a record, stamped with the format this app writes (rules.SCHEMA). */
function write(kind: Kind, id: string, data: unknown, deleted = false) {
  const stamped = data && typeof data === 'object' && !Array.isArray(data) ? { ...data, schema: SCHEMA } : data;
  const rec: Rec = { id, kind, hlc: hlc.now(), deleted, data: stamped };
  records.set(id, rec);
  outbox.add(id);
  void db.put('records', rec);
  void db.put('outbox', true, id);
  bump();
  onLocalChange();
}

/** Applies rows from the server. Returns how many were newer than ours. */
export function applyRemote(rows: Rec[]): number {
  let changed = 0;
  for (const rec of rows) {
    hlc.observe(rec.hlc);
    const cur = records.get(rec.id);
    if (cur && cur.hlc >= rec.hlc) continue;
    records.set(rec.id, rec);
    void db.put('records', rec);
    changed++;
  }
  if (changed) bump();
  return changed;
}

/** Queues every local record to be sent again, for a server that lost its data. */
export function requeueAll() {
  for (const id of records.keys()) {
    outbox.add(id);
    void db.put('outbox', true, id);
  }
}

export function localCounts() {
  let tasks = 0;
  for (const r of records.values()) if (r.kind === 'task' && !r.deleted) tasks++;
  return { records: records.size, tasks, unsent: outbox.size };
}

export const pendingChanges = (): Rec[] => [...outbox].map((id) => records.get(id)).filter((r): r is Rec => !!r);

export function markSent(sent: Rec[]) {
  for (const r of sent) {
    if (records.get(r.id)?.hlc !== r.hlc) continue; // edited again while in flight
    outbox.delete(r.id);
    void db.del('outbox', r.id);
  }
}

// ---------- derived view, rebuilt once per change ----------

let cacheVersion = -1;
let cache: ViewData;

export function view(): ViewData {
  if (cacheVersion === version) return cache;
  cache = buildView(records.values());
  cacheVersion = version;
  return cache;
}

// ---------- actions: run a rule, then save what it changed ----------

function run<T>(rule: (d: Draft) => T): T {
  const now = new Date();
  const d = new Draft(records, { now, today: ymd(now), newId: uid });
  const result = rule(d);
  for (const c of d.changes.values()) write(c.kind, c.id, c.data, c.deleted);
  return result;
}

export const createTask = (p: Partial<Task>): string => run((d) => rules.createTask(d, p));
export const updateTask = (id: string, patch: Partial<Task>) => run((d) => rules.updateTask(d, id, patch));
export const setFlag = (id: string, flag: Flag) => run((d) => rules.setFlag(d, id, flag));
export const queueIiq = (taskId: string, type: IiqAction['type'], text?: string) => run((d) => rules.queueIiq(d, taskId, type, text));
export const setNotes = (id: string, notes: Task['notes']) => updateTask(id, { notes });
export const setStartOn = (id: string, startOn: string | null) => run((d) => rules.setStartOn(d, id, startOn));
export const promoteDue = () => run((d) => rules.promoteDue(d));
export const addDependency = (id: string, depId: string): string | null => run((d) => rules.addDependency(d, id, depId));
export const removeDependency = (id: string, depId: string) => run((d) => rules.removeDependency(d, id, depId));
export const moveInNext = (id: string, beforeId: string | null) => run((d) => rules.moveInNext(d, id, beforeId));

let resolving: string | null = null;
/** The Incident IQ task waiting for resolution notes (ResolveDialog), if any. */
export const resolvingId = () => resolving;

export function toggleDone(id: string) {
  if (run((d) => rules.toggleDone(d, id)) === 'needs-notes') { resolving = id; bump(); }
}
export function resolveWithNotes(id: string, notes: string) {
  resolving = null;
  run((d) => rules.resolveWithNotes(d, id, notes));
}
export function cancelResolve() {
  resolving = null;
  bump();
}

/** Soft-deletes a task and its subtasks. Returns a function that undoes it. */
export function deleteTask(id: string): () => void {
  const deleted = run((d) => { rules.deleteTask(d, id); return [...d.changes.values()]; });
  return () => { for (const c of deleted) write('task', c.id, c.data); };
}

// ---------- projects & areas ----------

export const createProject = (title: string, areaId: string | null): string => run((d) => rules.createProject(d, title, areaId));
export const updateProject = (id: string, patch: Partial<Project>) => run((d) => rules.updateProject(d, id, patch));
export const deleteProject = (id: string) => run((d) => rules.deleteProject(d, id));
export const createArea = (title: string): string => run((d) => rules.createArea(d, title));
export const updateArea = (id: string, patch: Partial<Area>) => run((d) => rules.updateArea(d, id, patch));
export const deleteArea = (id: string) => run((d) => rules.deleteArea(d, id));
