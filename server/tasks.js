// Small task API for the iOS/macOS widget and Siri, which can't run the app's
// sync engine. The server makes the change itself (as device "server") and
// stores it like any other sync, so live updates reach every app right away.
//
//   GET  /widget?today=YYYY-MM-DD   In Progress, Today and Next, ready to show
//   POST /tasks           { title, list } -> { id }
//   POST /tasks/:id/done  { today? } complete a task (and its open subtasks).
//                         As in the app: tasks only waiting on it move to Next,
//                         and a repeating task's next copy is filed for its date.
//
// "today" is the device's local date (repeat.js explains the fallback).

import crypto from 'node:crypto';
import { daysBetween, localToday, nextStart, shiftDate, validRepeat } from './repeat.js';

const LISTS = new Set(['doing', 'today', 'next', 'inbox', 'someday']);
const MAX_ITEMS = 12;

export function createTaskApi({ db, applyChanges, onChange }) {
  const allTasks = db.prepare("SELECT id, hlc, data FROM records WHERE kind = 'task' AND deleted = 0");
  const allProjects = db.prepare("SELECT id, data FROM records WHERE kind = 'project' AND deleted = 0");

  const load = () => allTasks.all().map((r) => ({ id: r.id, hlc: r.hlc, ...JSON.parse(r.data) }));

  // Always later than the record's current clock, even if this host's clock is behind.
  const hlcAfter = (prev) => {
    const ms = Math.max(Date.now(), (Number(String(prev || '').split('-')[0]) || 0) + 1);
    return `${String(ms).padStart(15, '0')}-0000-server`;
  };

  const record = (t) => {
    const { id, hlc, ...data } = t;
    return { id, kind: 'task', hlc: hlcAfter(hlc), deleted: false, data };
  };

  function widget(clientToday) {
    const today = localToday(clientToday);
    const tasks = load();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const projects = new Map(allProjects.all().map((p) => [p.id, JSON.parse(p.data).title]));
    const open = tasks.filter((t) => !t.done);
    const blocked = (t) => (t.dependsOn || []).some((d) => byId.has(d) && !byId.get(d).done);
    const view = (t) => ({
      id: t.id,
      title: t.title || 'Untitled task',
      flag: t.flag ?? null,
      deadline: t.deadline ?? null,
      blocked: blocked(t),
      project: projects.get(t.projectId) ?? (t.parentId ? byId.get(t.parentId)?.title ?? null : null),
    });
    const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
    // A start date that has arrived counts as Today even before an app moves it.
    const due = (t) => t.startOn && t.startOn <= today;
    const doing = open.filter((t) => t.flag === 'doing').sort(byOrder);
    const todayList = open.filter((t) => t.flag !== 'doing' && (t.flag === 'today' || due(t))).sort(byOrder);
    const next = open.filter((t) => t.flag === 'next' && !due(t)).sort(byOrder);
    const inbox = open.filter((t) => t.flag === 'inbox' || (!t.flag && !t.projectId && !t.parentId && !t.startOn));
    return {
      doing: doing.slice(0, MAX_ITEMS).map(view),
      today: todayList.slice(0, MAX_ITEMS).map(view),
      next: next.slice(0, MAX_ITEMS).map(view),
      counts: { doing: doing.length, today: todayList.length, next: next.length, inbox: inbox.length },
      updatedAt: new Date().toISOString(),
    };
  }

  function create({ title, list }) {
    const t = String(title ?? '').trim().slice(0, 500);
    if (!t) return { status: 400, body: { error: 'The task needs a title.' } };
    const flag = LISTS.has(list) ? list : 'inbox';
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const rec = record({
      id, title: t, flag, projectId: null, parentId: null, deadline: null,
      startOn: null, repeat: null, nextId: null,
      done: false, doneAt: null, order: Date.now(), dependsOn: [], notes: [], createdAt: now,
    });
    applyChanges([rec]);
    onChange();
    return { status: 201, body: { id, flag } };
  }

  /** The next copy of a repeating task and its subtasks, all unchecked, waiting for their date. */
  function spawn(t, children, today, now) {
    const start = nextStart(t.repeat, t, today);
    const offset = t.deadline ? daysBetween(t.startOn ?? t.deadline, t.deadline) : 0;
    const reset = (notes = []) => notes.map((b) => ({ ...b, id: crypto.randomUUID(), ...(b.type === 'checklist' ? { checked: false } : {}) }));
    const copyId = crypto.randomUUID();
    const base = { done: false, doneAt: null, nextId: null, dependsOn: [], order: Date.now(), createdAt: now };
    const copies = [{
      ...t, ...base, id: copyId, hlc: null, flag: null, startOn: start,
      deadline: t.deadline ? shiftDate(start, offset) : null, notes: reset(t.notes),
    }];
    for (const c of children) copies.push({ ...c, ...base, id: crypto.randomUUID(), hlc: null, parentId: copyId, notes: reset(c.notes) });
    return { copyId, copies };
  }

  function complete(id, { today: clientToday } = {}) {
    const today = localToday(clientToday);
    const tasks = load();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const target = byId.get(id);
    if (!target) return { status: 404, body: { error: 'That task no longer exists.' } };
    if (target.done) return { status: 200, body: { ok: true } };
    // Resolving an Incident IQ ticket needs notes, which only the app asks
    // for; the widget and Siri never change tickets.
    if (target.external?.source === 'iiq' && !target.external.closed) {
      return { status: 409, body: { error: 'This is an Incident IQ ticket. Open Nextly to resolve it with notes.' } };
    }

    const now = new Date().toISOString();
    const changed = new Map();
    const children = tasks.filter((t) => t.parentId === id);
    let nextId = null;
    if (validRepeat(target.repeat)) {
      const s = spawn(target, children, today, now);
      nextId = s.copyId;
      for (const c of s.copies) changed.set(c.id, c);
    }
    changed.set(id, { ...target, done: true, doneAt: now, nextId });
    for (const t of children) if (!t.done) changed.set(t.id, { ...t, done: true, doneAt: now });

    const isDone = (tid) => changed.get(tid)?.done ?? byId.get(tid)?.done ?? true;
    let order = Math.max(0, ...tasks.filter((t) => t.flag === 'next').map((t) => t.order ?? 0));
    for (const t of tasks) {
      if (t.done || changed.has(t.id) || t.flag === 'today' || t.flag === 'doing' || !(t.dependsOn || []).includes(id)) continue;
      if ((t.dependsOn || []).every(isDone) && t.flag !== 'next') {
        order += 1000;
        changed.set(t.id, { ...t, flag: 'next', order });
      }
    }
    const rows = [...changed.values()].map(record);
    applyChanges(rows);
    onChange();
    return { status: 200, body: { ok: true, changed: changed.size, nextId } };
  }

  return { widget, create, complete };
}
