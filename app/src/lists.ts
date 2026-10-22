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
    case 'logbook': return ts.filter((t) => t.done).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
    case 'search': {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      return ts.filter((t) => (t.title + ' ' + noteText(t)).toLowerCase().includes(q))
        .sort((a, b) => Number(a.done) - Number(b.done) || byCreated(a, b));
    }
    default: {
      const pid = view.slice('project:'.length);
      return ts.filter((t) => open(t) && t.projectId === pid && !t.parentId).sort(byOrder);
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
    inbox: 'Inbox', doing: 'In Progress', today: 'Today', next: 'Next', scheduled: 'Scheduled',
    someday: 'Someday', logbook: 'Logbook', search: 'Search',
  };
  if (names[view]) return names[view];
  return v.project(view.slice('project:'.length))?.title || 'Untitled project';
}
