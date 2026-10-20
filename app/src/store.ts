// In-memory copy of every record, persisted to IndexedDB and queued for sync.
// Components read through useStore() and change data only through the
// actions below, so the rules (blocking, Next order, subtasks) live in one place.

import { useSyncExternalStore } from 'react';
import * as db from './db';
import * as hlc from './hlc';
import { normTask, openBlockers, orderBetween, uid, wouldCycle } from './logic';
import type { Area, AreaItem, Block, Flag, Kind, Project, ProjectItem, Rec, Task, TaskItem } from './types';

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

function write(kind: Kind, id: string, data: unknown, deleted = false) {
  const rec: Rec = { id, kind, hlc: hlc.now(), deleted, data };
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

interface ViewData {
  tasks: TaskItem[];
  projects: ProjectItem[];
  areas: AreaItem[];
  task: (id: string) => TaskItem | undefined;
  project: (id: string | null) => ProjectItem | undefined;
  children: (id: string) => TaskItem[];
  blockers: (t: TaskItem) => TaskItem[];
  blocks: (id: string) => TaskItem[];
}

let cacheVersion = -1;
let cache: ViewData;

export function view(): ViewData {
  if (cacheVersion === version) return cache;
  const tasks: TaskItem[] = [];
  const projects: ProjectItem[] = [];
  const areas: AreaItem[] = [];
  for (const r of records.values()) {
    if (r.deleted) continue;
    if (r.kind === 'task') tasks.push({ id: r.id, ...normTask(r.data) });
    else if (r.kind === 'project') projects.push({ id: r.id, ...(r.data as Project) });
    else if (r.kind === 'area') areas.push({ id: r.id, ...(r.data as Area) });
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const kids = new Map<string, TaskItem[]>();
  const blocksMap = new Map<string, TaskItem[]>();
  for (const t of tasks) {
    if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
    for (const d of t.dependsOn) blocksMap.set(d, [...(blocksMap.get(d) ?? []), t]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.order - b.order);
  projects.sort((a, b) => a.order - b.order);
  areas.sort((a, b) => a.order - b.order);
  const projById = new Map(projects.map((p) => [p.id, p]));
  const task = (id: string) => byId.get(id);
  cache = {
    tasks, projects, areas, task,
    project: (id) => (id ? projById.get(id) : undefined),
    children: (id) => kids.get(id) ?? [],
    blockers: (t) => openBlockers(t, task),
    blocks: (id) => blocksMap.get(id) ?? [],
  };
  cacheVersion = version;
  return cache;
}

// ---------- task actions ----------

function rawTask(id: string): Task | undefined {
  const r = records.get(id);
  return r && !r.deleted && r.kind === 'task' ? normTask(r.data) : undefined;
}

function saveTask(id: string, t: Task) {
  write('task', id, t);
}

const nextOrderEnd = () => Math.max(0, ...view().tasks.filter((t) => t.flag === 'next').map((t) => t.order)) + 1000;

export function createTask(p: Partial<Task>): string {
  const id = uid();
  const t: Task = {
    title: '', flag: 'inbox', projectId: null, parentId: null, deadline: null,
    done: false, doneAt: null, order: 0, dependsOn: [], notes: [],
    createdAt: new Date().toISOString(), ...p,
  };
  if (!t.order) t.order = t.flag === 'next' ? nextOrderEnd() : Date.now();
  saveTask(id, t);
  return id;
}

export function updateTask(id: string, patch: Partial<Task>) {
  const t = rawTask(id);
  if (t) saveTask(id, { ...t, ...patch });
}

export function setFlag(id: string, flag: Flag) {
  const t = rawTask(id);
  if (!t || t.flag === flag) return;
  saveTask(id, { ...t, flag, order: flag === 'next' ? nextOrderEnd() : t.order });
}

/**
 * Completing a task also completes its open subtasks. Any task that was
 * waiting on it and is now free moves to Next (unless it's already in Today).
 */
export function toggleDone(id: string) {
  const t = rawTask(id);
  if (!t) return;
  const done = !t.done;
  saveTask(id, { ...t, done, doneAt: done ? new Date().toISOString() : null });
  if (!done) return;
  for (const c of view().children(id)) if (!c.done) toggleDone(c.id);
  for (const w of view().blocks(id)) {
    if (w.done || w.flag === 'today') continue;
    if (view().blockers(w).length === 0) setFlag(w.id, 'next');
  }
}

/** Soft-deletes a task and its subtasks. Returns a function that undoes it. */
export function deleteTask(id: string): () => void {
  const ids = [id, ...collectChildren(id)];
  const saved = ids.map((i) => [i, rawTask(i)] as const);
  for (const i of ids) write('task', i, records.get(i)!.data, true);
  return () => { for (const [i, t] of saved) if (t) saveTask(i, t); };
}

function collectChildren(id: string): string[] {
  return view().children(id).flatMap((c) => [c.id, ...collectChildren(c.id)]);
}

/** Returns an error message, or null when the dependency was added. */
export function addDependency(id: string, depId: string): string | null {
  const v = view();
  if (wouldCycle(id, depId, v.task)) {
    return depId === id ? 'A task can’t depend on itself.' : `“${v.task(depId)?.title}” already waits on this task, so this would make a loop.`;
  }
  const t = rawTask(id);
  if (!t || t.dependsOn.includes(depId)) return null;
  saveTask(id, { ...t, dependsOn: [...t.dependsOn, depId] });
  return null;
}

export function removeDependency(id: string, depId: string) {
  const t = rawTask(id);
  if (t) saveTask(id, { ...t, dependsOn: t.dependsOn.filter((d) => d !== depId) });
}

/** Moves a task in Next so it sits just before `beforeId` (or last). */
export function moveInNext(id: string, beforeId: string | null) {
  const list = view().tasks.filter((t) => t.flag === 'next' && !t.done && t.id !== id).sort((a, b) => a.order - b.order);
  const idx = beforeId ? list.findIndex((t) => t.id === beforeId) : list.length;
  const order = orderBetween(list[idx - 1]?.order, list[idx]?.order);
  updateTask(id, { order });
}

export function setNotes(id: string, notes: Block[]) {
  updateTask(id, { notes });
}

// ---------- projects & areas ----------

export function createProject(title: string, areaId: string | null): string {
  const id = uid();
  write('project', id, { title, areaId, order: Date.now() } satisfies Project);
  return id;
}

export function updateProject(id: string, patch: Partial<Project>) {
  const r = records.get(id);
  if (r) write('project', id, { ...(r.data as Project), ...patch });
}

/** Tasks in a deleted project go back to the Inbox. */
export function deleteProject(id: string) {
  const r = records.get(id);
  if (!r) return;
  for (const t of view().tasks) if (t.projectId === id) updateTask(t.id, { projectId: null, flag: t.flag ?? 'inbox' });
  write('project', id, r.data, true);
}

export function createArea(title: string): string {
  const id = uid();
  write('area', id, { title, order: Date.now() } satisfies Area);
  return id;
}

export function updateArea(id: string, patch: Partial<Area>) {
  const r = records.get(id);
  if (r) write('area', id, { ...(r.data as Area), ...patch });
}

export function deleteArea(id: string) {
  const r = records.get(id);
  if (!r) return;
  for (const p of view().projects) if (p.areaId === id) updateProject(p.id, { areaId: null });
  write('area', id, r.data, true);
}
