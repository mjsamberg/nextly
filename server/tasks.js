// Small task API for the iOS/macOS widget and Siri, which can't run the app's
// sync engine. The server makes the change itself (as device "server") and
// stores it like any other sync, so live updates reach every app right away.
//
//   GET  /widget          Today and Next, ready to show
//   POST /tasks           { title, list } -> { id }
//   POST /tasks/:id/done  complete a task (and its open subtasks); tasks that
//                         were only waiting on it move to Next, as in the app

import crypto from 'node:crypto';

const LISTS = new Set(['today', 'next', 'inbox', 'someday']);
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

  function widget() {
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
    const today = open.filter((t) => t.flag === 'today').sort(byOrder);
    const next = open.filter((t) => t.flag === 'next').sort(byOrder);
    const inbox = open.filter((t) => t.flag === 'inbox' || (!t.flag && !t.projectId && !t.parentId));
    return {
      today: today.slice(0, MAX_ITEMS).map(view),
      next: next.slice(0, MAX_ITEMS).map(view),
      counts: { today: today.length, next: next.length, inbox: inbox.length },
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
      done: false, doneAt: null, order: Date.now(), dependsOn: [], notes: [], createdAt: now,
    });
    applyChanges([rec]);
    onChange();
    return { status: 201, body: { id, flag } };
  }

  function complete(id) {
    const tasks = load();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const target = byId.get(id);
    if (!target) return { status: 404, body: { error: 'That task no longer exists.' } };
    if (target.done) return { status: 200, body: { ok: true } };

    const now = new Date().toISOString();
    const changed = new Map();
    const finish = (t) => { changed.set(t.id, { ...t, done: true, doneAt: now }); };
    finish(target);
    for (const t of tasks) if (t.parentId === id && !t.done) finish(t);

    const isDone = (tid) => changed.get(tid)?.done ?? byId.get(tid)?.done ?? true;
    let order = Math.max(0, ...tasks.filter((t) => t.flag === 'next').map((t) => t.order ?? 0));
    for (const t of tasks) {
      if (t.done || changed.has(t.id) || t.flag === 'today' || !(t.dependsOn || []).includes(id)) continue;
      if ((t.dependsOn || []).every(isDone) && t.flag !== 'next') {
        order += 1000;
        changed.set(t.id, { ...t, flag: 'next', order });
      }
    }
    applyChanges([...changed.values()].map(record));
    onChange();
    return { status: 200, body: { ok: true, changed: changed.size } };
  }

  return { widget, create, complete };
}
