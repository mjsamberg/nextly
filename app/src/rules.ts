// The store's rules as pure functions: given the records, an action works on a
// Draft and leaves behind the records it changed. store.ts saves them. The
// Swift apps (apple/NextlyKit) implement the same rules, and the shared cases
// in spec/fixtures hold both to them, so keep the two in step
// (spec/protocol.md).
//
// Determinism, so both apps produce the same records for the same action:
// time comes from ctx.now / ctx.today, new ids from ctx.newId (in the order
// documented at each call), and tasks are visited in id order.

import { daysBetween, nextStart, normTask, openBlockers, orderBetween, shiftDate, wouldCycle } from './logic.ts';
import type { Area, AreaItem, Block, Flag, IiqAction, Kind, Project, ProjectItem, Rec, Task, TaskItem } from './types.ts';

/** The record format this app writes. Bump only for changes older apps can't safely save over. */
export const SCHEMA = 1;

export const schemaOf = (data: unknown): number => {
  const s = (data as { schema?: unknown } | null)?.schema;
  return typeof s === 'number' ? s : 1;
};

/** A record this app may change: present, not deleted, and not from a newer format. */
export const editable = (r: Rec | undefined): r is Rec => !!r && !r.deleted && schemaOf(r.data) <= SCHEMA;

export interface Ctx {
  now: Date;
  /** The device's local date, YYYY-MM-DD. */
  today: string;
  newId: () => string;
}

export interface Change { kind: Kind; id: string; data: unknown; deleted: boolean }

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byOrder = (a: TaskItem, b: TaskItem) => a.order - b.order || byId(a, b);

/** The records as an action sees them: the stored ones plus its own changes so far. */
export class Draft {
  readonly changes = new Map<string, Change>();
  private readonly base: ReadonlyMap<string, Rec>;
  readonly ctx: Ctx;
  // Plain fields, not parameter properties: tests run with Node's type stripping.
  constructor(base: ReadonlyMap<string, Rec>, ctx: Ctx) { this.base = base; this.ctx = ctx; }

  rec(id: string): Rec | undefined {
    const c = this.changes.get(id);
    return c ? { ...c, hlc: '' } : this.base.get(id);
  }

  save(kind: Kind, id: string, data: unknown, deleted = false) {
    this.changes.set(id, { kind, id, data, deleted });
  }

  /** A task this action may change, normalized. */
  task(id: string): Task | undefined {
    const r = this.rec(id);
    return editable(r) && r.kind === 'task' ? normTask(r.data) : undefined;
  }

  saveTask(id: string, t: Task) { this.save('task', id, t); }

  /** Every record, with this action's changes. */
  *records(): Iterable<Rec> {
    for (const c of this.changes.values()) yield { ...c, hlc: '' };
    for (const r of this.base.values()) if (!this.changes.has(r.id)) yield r;
  }

  /** Every task that isn't deleted, in id order. */
  tasks(): TaskItem[] {
    const out: TaskItem[] = [];
    for (const r of this.records()) if (r.kind === 'task' && !r.deleted) out.push(item(r));
    return out.sort(byId);
  }

  taskItem = (id: string): TaskItem | undefined => {
    const r = this.rec(id);
    return r && r.kind === 'task' && !r.deleted ? item(r) : undefined;
  };

  children(id: string): TaskItem[] { return this.tasks().filter((t) => t.parentId === id).sort(byOrder); }
  blocks(id: string): TaskItem[] { return this.tasks().filter((t) => t.dependsOn.includes(id)); }
  blockers(t: TaskItem): TaskItem[] { return openBlockers(t, this.taskItem); }
}

const item = (r: Rec): TaskItem => ({ ...normTask(r.data), id: r.id, ...(schemaOf(r.data) > SCHEMA ? { readOnly: true } : {}) });

// ---------- the view every list is built from ----------

export interface ViewData {
  tasks: TaskItem[];
  projects: ProjectItem[];
  areas: AreaItem[];
  task: (id: string) => TaskItem | undefined;
  project: (id: string | null) => ProjectItem | undefined;
  children: (id: string) => TaskItem[];
  blockers: (t: TaskItem) => TaskItem[];
  blocks: (id: string) => TaskItem[];
  /** Incident IQ requests for a task, newest first. */
  iiqActions: (taskId: string) => (IiqAction & { id: string })[];
  /** How many records came from a newer Nextly and can't be changed here. */
  newer: number;
}

export function buildView(records: Iterable<Rec>): ViewData {
  const tasks: TaskItem[] = [];
  const projects: ProjectItem[] = [];
  const areas: AreaItem[] = [];
  const actionsMap = new Map<string, (IiqAction & { id: string })[]>();
  let newer = 0;
  for (const r of records) {
    if (r.deleted) continue;
    const ro = schemaOf(r.data) > SCHEMA ? { readOnly: true } : {};
    if ('readOnly' in ro) newer++;
    if (r.kind === 'task') tasks.push(item(r));
    else if (r.kind === 'project') projects.push({ ...(r.data as Project), id: r.id, ...ro });
    else if (r.kind === 'area') areas.push({ ...(r.data as Area), id: r.id, ...ro });
    else if (r.kind === 'iiq-action') { const a = { ...(r.data as IiqAction), id: r.id }; actionsMap.set(a.taskId, [...(actionsMap.get(a.taskId) ?? []), a]); }
  }
  tasks.sort(byId);
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const kids = new Map<string, TaskItem[]>();
  const blocksMap = new Map<string, TaskItem[]>();
  for (const t of tasks) {
    if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
    for (const d of t.dependsOn) blocksMap.set(d, [...(blocksMap.get(d) ?? []), t]);
  }
  for (const list of kids.values()) list.sort(byOrder);
  projects.sort((a, b) => a.order - b.order);
  areas.sort((a, b) => a.order - b.order);
  const projById = new Map(projects.map((p) => [p.id, p]));
  const task = (id: string) => tasksById.get(id);
  return {
    tasks, projects, areas, task, newer,
    project: (id) => (id ? projById.get(id) : undefined),
    children: (id) => kids.get(id) ?? [],
    blockers: (t) => openBlockers(t, task),
    blocks: (id) => blocksMap.get(id) ?? [],
    iiqActions: (id) => (actionsMap.get(id) ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

// ---------- tasks ----------

const nextOrderEnd = (d: Draft) => Math.max(0, ...d.tasks().filter((t) => t.flag === 'next').map((t) => t.order)) + 1000;
const openTicket = (t: Task) => t.external?.source === 'iiq' && !t.external.closed;

/** New ids: the task's. */
export function createTask(d: Draft, p: Partial<Task>): string {
  const id = d.ctx.newId();
  const t: Task = {
    title: '', flag: 'inbox', projectId: null, parentId: null, deadline: null,
    startOn: null, repeat: null, nextId: null, external: null,
    done: false, doneAt: null, order: 0, dependsOn: [], notes: [],
    createdAt: d.ctx.now.toISOString(), ...p,
  };
  if (!t.order) t.order = t.flag === 'next' ? nextOrderEnd(d) : d.ctx.now.getTime();
  d.saveTask(id, t);
  return id;
}

export function updateTask(d: Draft, id: string, patch: Partial<Task>) {
  const t = d.task(id);
  if (t) d.saveTask(id, { ...t, ...patch });
}

/** Starting an Incident IQ ticket's task (In Progress) starts the ticket too. */
export function setFlag(d: Draft, id: string, flag: Flag) {
  const t = d.task(id);
  if (!t || t.flag === flag) return;
  d.saveTask(id, { ...t, flag, order: flag === 'next' ? nextOrderEnd(d) : t.order });
  if (flag === 'doing' && openTicket(t)) queueIiq(d, id, 'start');
}

/** Asks the server to do something in Incident IQ (server/iiq.js). New ids: the action's. */
export function queueIiq(d: Draft, taskId: string, type: IiqAction['type'], text?: string) {
  const t = d.task(taskId);
  if (t?.external?.source !== 'iiq') return;
  const action: IiqAction = { type, taskId, ticketId: t.external.id, state: 'pending', createdAt: d.ctx.now.toISOString(), ...(text ? { text } : {}) };
  d.save('iiq-action', d.ctx.newId(), action);
}

/**
 * Completing a task also completes its open subtasks. Any task that was
 * waiting on it and is now free moves to Next (unless it's already in Today
 * or In Progress). Completing a repeating task files its next copy under
 * Scheduled; un-completing it removes that copy again if it's still open.
 *
 * Completing an open Incident IQ ticket's task resolves the ticket, which
 * needs notes: then nothing changes and this returns 'needs-notes'; the app
 * asks, and finishes with resolveWithNotes.
 */
export function toggleDone(d: Draft, id: string): 'needs-notes' | null {
  const t = d.task(id);
  if (t && !t.done && openTicket(t)) return 'needs-notes';
  finish(d, id, false);
  return null;
}

export function resolveWithNotes(d: Draft, id: string, notes: string) {
  finish(d, id, false, notes.trim() || undefined);
}

function finish(d: Draft, id: string, viaParent: boolean, notes?: string) {
  const t = d.task(id);
  if (!t) return;
  if (t.done) {
    const copy = t.nextId ? d.task(t.nextId) : undefined;
    if (copy && !copy.done) deleteTask(d, t.nextId!);
    d.saveTask(id, { ...t, done: false, doneAt: null, nextId: null });
    return;
  }
  // Subtasks finished along with a repeating parent come back with its copy.
  const nextId = t.repeat && !viaParent ? spawnNext(d, id, t) : null;
  if (openTicket(t) && !viaParent) queueIiq(d, id, 'resolve', notes);
  d.saveTask(id, { ...t, done: true, doneAt: d.ctx.now.toISOString(), nextId });
  for (const c of d.children(id)) if (!c.done) finish(d, c.id, true);
  for (const w of d.blocks(id)) {
    if (w.done || w.flag === 'today' || w.flag === 'doing') continue;
    if (d.blockers(w).length === 0) setFlag(d, w.id, 'next');
  }
}

/**
 * The next copy of a repeating task: same title, notes and subtasks, all
 * unchecked, waiting for its date. New ids, in this order: the copy, its note
 * blocks, then for each subtask (by order) the subtask and its note blocks.
 */
function spawnNext(d: Draft, id: string, t: Task): string {
  const start = nextStart(t.repeat!, t, d.ctx.today);
  // Keep the deadline the same distance from the start as before.
  const offset = t.deadline ? daysBetween(t.startOn ?? t.deadline, t.deadline) : 0;
  const reset = (notes: Block[]) => notes.map((b) => ({ ...b, id: d.ctx.newId(), ...(b.type === 'checklist' ? { checked: false } : {}) }));
  const now = d.ctx.now.toISOString();
  const copyId = d.ctx.newId();
  d.saveTask(copyId, {
    ...t,
    flag: null,
    startOn: start,
    deadline: t.deadline ? shiftDate(start, offset) : null,
    done: false, doneAt: null, nextId: null, external: null, dependsOn: [],
    order: d.ctx.now.getTime(),
    notes: reset(t.notes),
    createdAt: now,
  });
  for (const c of d.children(id)) {
    const raw = d.task(c.id);
    if (!raw) continue;
    const childId = d.ctx.newId();
    d.saveTask(childId, { ...raw, parentId: copyId, done: false, doneAt: null, nextId: null, dependsOn: [], order: d.ctx.now.getTime(), notes: reset(raw.notes), createdAt: now });
  }
  return copyId;
}

/**
 * Moves tasks whose start date has arrived into Today (In Progress stays put).
 * Every device does this; the app runs it only once it's in step with the
 * server (sync.ts inStep), so it never saves over newer edits.
 */
export function promoteDue(d: Draft) {
  for (const t of d.tasks()) {
    if (t.done || !t.startOn || t.startOn > d.ctx.today) continue;
    updateTask(d, t.id, { flag: t.flag === 'doing' ? 'doing' : 'today', startOn: null });
  }
}

/** Sets or clears a start date. A future date takes the task off its list until then. */
export function setStartOn(d: Draft, id: string, startOn: string | null) {
  const t = d.task(id);
  if (!t) return;
  if (!startOn) { d.saveTask(id, { ...t, startOn: null, flag: t.flag ?? (t.parentId || t.projectId ? null : 'inbox') }); return; }
  if (startOn <= d.ctx.today) { d.saveTask(id, { ...t, startOn: null, flag: t.flag === 'doing' ? 'doing' : 'today' }); return; }
  d.saveTask(id, { ...t, startOn, flag: t.parentId ? t.flag : null });
}

/** Soft-deletes a task and its subtasks, keeping their data so undo can bring them back. */
export function deleteTask(d: Draft, id: string) {
  const collect = (pid: string): string[] => d.children(pid).flatMap((c) => [c.id, ...collect(c.id)]);
  for (const i of [id, ...collect(id)]) {
    const r = d.rec(i);
    if (editable(r)) d.save('task', i, r.data, true);
  }
}

/** Returns an error message, or null when the dependency was added (or already there). */
export function addDependency(d: Draft, id: string, depId: string): string | null {
  if (wouldCycle(id, depId, d.taskItem)) {
    return depId === id ? 'A task can’t depend on itself.' : `“${d.taskItem(depId)?.title}” already waits on this task, so this would make a loop.`;
  }
  const t = d.task(id);
  if (!t || t.dependsOn.includes(depId)) return null;
  d.saveTask(id, { ...t, dependsOn: [...t.dependsOn, depId] });
  return null;
}

export function removeDependency(d: Draft, id: string, depId: string) {
  const t = d.task(id);
  if (t) d.saveTask(id, { ...t, dependsOn: t.dependsOn.filter((x) => x !== depId) });
}

/** Moves a task in Next so it sits just before `beforeId` (or last). */
export function moveInNext(d: Draft, id: string, beforeId: string | null) {
  const list = d.tasks().filter((t) => t.flag === 'next' && !t.done && t.id !== id).sort(byOrder);
  const idx = beforeId ? list.findIndex((t) => t.id === beforeId) : list.length;
  updateTask(d, id, { order: orderBetween(list[idx - 1]?.order, list[idx]?.order, d.ctx.now.getTime()) });
}

// ---------- projects & areas ----------

/** New ids: the project's. */
export function createProject(d: Draft, title: string, areaId: string | null): string {
  const id = d.ctx.newId();
  d.save('project', id, { title, areaId, order: d.ctx.now.getTime() } satisfies Project);
  return id;
}

export function updateProject(d: Draft, id: string, patch: Partial<Project>) {
  const r = d.rec(id);
  if (editable(r)) d.save('project', id, { ...(r.data as Project), ...patch });
}

/** Tasks in a deleted project go back to the Inbox. */
export function deleteProject(d: Draft, id: string) {
  const r = d.rec(id);
  if (!editable(r)) return;
  for (const t of d.tasks()) if (t.projectId === id) updateTask(d, t.id, { projectId: null, flag: t.flag ?? 'inbox' });
  d.save('project', id, r.data, true);
}

/** New ids: the area's. */
export function createArea(d: Draft, title: string): string {
  const id = d.ctx.newId();
  d.save('area', id, { title, order: d.ctx.now.getTime() } satisfies Area);
  return id;
}

export function updateArea(d: Draft, id: string, patch: Partial<Area>) {
  const r = d.rec(id);
  if (editable(r)) d.save('area', id, { ...(r.data as Area), ...patch });
}

/** Projects in a deleted area stay, without an area. */
export function deleteArea(d: Draft, id: string) {
  const r = d.rec(id);
  if (!editable(r)) return;
  for (const p of buildView(d.records()).projects) if (p.areaId === id) updateProject(d, p.id, { areaId: null });
  d.save('area', id, r.data, true);
}
