// Which tasks appear in which list. One place, so counts and lists agree.
import { noteText } from './logic';
import type { view } from './store';
import type { TaskItem, View } from './types';

type V = ReturnType<typeof view>;

const open = (t: TaskItem) => !t.done;
const byOrder = (a: TaskItem, b: TaskItem) => a.order - b.order;
const byCreated = (a: TaskItem, b: TaskItem) => a.createdAt.localeCompare(b.createdAt);

/**
 * A task with no flag, project or parent would otherwise be lost, so it shows
 * in Inbox, unless it's waiting for a start date (then it's in Scheduled).
 */
const inInbox = (t: TaskItem) => t.flag === 'inbox' || (t.flag === null && !t.projectId && !t.parentId && !t.startOn);

/** In the All list, what you're doing comes first and Someday last. */
const FLAG_RANK: Record<string, number> = { doing: 0, today: 1, next: 2, inbox: 3, null: 4, someday: 5 };
const flagRank = (t: TaskItem) => FLAG_RANK[String(t.flag)] ?? 4;

/**
 * All open tasks (not subtasks, which stay with their parent), grouped by
 * area, then project. Projects without an area come after the areas, and
 * tasks without a project come last.
 */
export interface AllGroup { areaId: string | null; title: string; projects: { projectId: string | null; title: string; tasks: TaskItem[] }[] }

export function allGrouped(v: V): AllGroup[] {
  const tasks = tasksFor(v, 'all');
  const inProject = (pid: string) => newestTicketsFirst(tasks.filter((t) => t.projectId === pid));
  const knownArea = (id: string | null) => !!id && v.areas.some((a) => a.id === id);
  const projectsIn = (areaId: string | null) => v.projects
    .filter((p) => (areaId ? p.areaId === areaId : !knownArea(p.areaId)))
    .map((p) => ({ projectId: p.id, title: p.title || 'Untitled project', tasks: inProject(p.id) }))
    .filter((p) => p.tasks.length > 0);
  const groups: AllGroup[] = v.areas
    .map((a) => ({ areaId: a.id, title: a.title || 'Untitled area', projects: projectsIn(a.id) }))
    .filter((g) => g.projects.length > 0);
  const loose = projectsIn(null);
  if (loose.length) groups.push({ areaId: null, title: v.areas.length ? 'Other projects' : 'Projects', projects: loose });
  const known = new Set(v.projects.map((p) => p.id));
  const noProject = tasks.filter((t) => !t.projectId || !known.has(t.projectId));
  if (noProject.length) groups.push({ areaId: null, title: 'No project', projects: [{ projectId: null, title: '', tasks: noProject }] });
  return groups;
}

/**
 * A list of Incident IQ tickets (every task has a submitted date) goes newest
 * submitted first; any other list keeps its order.
 */
function newestTicketsFirst(tasks: TaskItem[]): TaskItem[] {
  if (!tasks.length || !tasks.every((t) => t.external?.created)) return tasks;
  const when = (t: TaskItem) => Date.parse(t.external!.created!) || 0;
  return [...tasks].sort((a, b) => when(b) - when(a));
}

/** The date a task is filed under in Scheduled: its start date, else its deadline. */
export const scheduledDate = (t: TaskItem) => t.startOn ?? t.deadline;

export function tasksFor(v: V, view: View, query = ''): TaskItem[] {
  const ts = v.tasks;
  switch (view) {
    case 'inbox': return ts.filter((t) => open(t) && inInbox(t)).sort(byCreated);
    case 'doing': return ts.filter((t) => open(t) && t.flag === 'doing').sort(byOrder);
    case 'today': return ts.filter((t) => open(t) && t.flag === 'today').sort(byOrder);
    case 'next': return ts.filter((t) => open(t) && t.flag === 'next').sort(byOrder);
    case 'someday': return ts.filter((t) => open(t) && t.flag === 'someday').sort(byCreated);
    case 'scheduled': return ts.filter((t) => open(t) && scheduledDate(t)).sort((a, b) => scheduledDate(a)!.localeCompare(scheduledDate(b)!));
    case 'all': return ts.filter((t) => open(t) && !t.parentId).sort((a, b) => flagRank(a) - flagRank(b) || byOrder(a, b));
    case 'logbook': return ts.filter((t) => t.done).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
    case 'search': {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      return ts.filter((t) => (t.title + ' ' + noteText(t)).toLowerCase().includes(q))
        .sort((a, b) => Number(a.done) - Number(b.done) || byCreated(a, b));
    }
    default: {
      const pid = view.slice('project:'.length);
      return newestTicketsFirst(ts.filter((t) => open(t) && t.projectId === pid && !t.parentId).sort(byOrder));
    }
  }
}

export function counts(v: V) {
  return {
    inbox: tasksFor(v, 'inbox').length,
    doing: tasksFor(v, 'doing').length,
    today: tasksFor(v, 'today').length,
    next: tasksFor(v, 'next').length,
  };
}

export function viewTitle(v: V, view: View): string {
  const names: Record<string, string> = {
    inbox: 'Inbox', doing: 'In Progress', today: 'Today', next: 'Next', scheduled: 'Scheduled', all: 'All',
    someday: 'Someday', logbook: 'Logbook', search: 'Search',
  };
  if (names[view]) return names[view];
  return v.project(view.slice('project:'.length))?.title || 'Untitled project';
}
