// One flag per task. null means "no list of its own": a subtask that lives
// under its parent, a task that lives only in its project, or one waiting for
// its start date (startOn). 'doing' is In Progress.
export type Flag = 'inbox' | 'doing' | 'today' | 'next' | 'someday' | null;

/**
 * How a task repeats. Finishing it creates the next copy, which waits in
 * Scheduled and moves into Today on its date. `weekdays` (0 = Sunday) picks
 * days of the week instead of a plain interval. `from`: count the interval
 * from the scheduled date, or from the day it was finished.
 */
export interface Repeat {
  every: number;
  unit: 'day' | 'week' | 'month' | 'year';
  weekdays?: number[];
  from: 'schedule' | 'completion';
}

export type BlockType =
  | 'heading' | 'paragraph' | 'checklist' | 'quote' | 'divider'
  | 'image' | 'file' | 'email';

export interface Block {
  id: string;
  type: BlockType;
  text?: string;
  checked?: boolean;
  // image / file
  sha?: string;
  name?: string;
  size?: number;
  mime?: string;
  // email
  url?: string;
  subject?: string;
  from?: string;
}

/** An Incident IQ ticket a task mirrors (server/iiq.js). */
export interface External {
  source: 'iiq';
  id: string;
  number: number | string | null;
  url: string | null;
  status: string | null;
  closed: boolean;
  requester: string | null;
  location: string | null;
  issue: string | null;
  priority: string | null;
  syncedAt: string | null;
}

/** A request for the server to carry out in Incident IQ, and its result. */
export interface IiqAction {
  type: 'comment' | 'start' | 'resolve';
  taskId: string;
  ticketId: string;
  text?: string;
  state: 'pending' | 'done' | 'manual' | 'failed';
  message?: string;
  createdAt: string;
  finishedAt?: string | null;
}

export interface Task {
  title: string;
  flag: Flag;
  projectId: string | null;
  parentId: string | null;
  deadline: string | null; // YYYY-MM-DD, optional and never used for sorting Today/Next
  startOn: string | null; // YYYY-MM-DD: waits in Scheduled, moves into Today on this day
  repeat: Repeat | null;
  nextId: string | null; // the copy created when this repeating task was finished
  external: External | null; // a linked ticket in another system (the server keeps it current)
  done: boolean;
  doneAt: string | null;
  order: number; // position in Next
  dependsOn: string[];
  notes: Block[];
  createdAt: string;
}

export interface Project {
  title: string;
  areaId: string | null;
  order: number;
}

export interface Area {
  title: string;
  order: number;
}

export type Kind = 'task' | 'project' | 'area' | 'iiq-action';

// The unit of sync. Matches the rows the server stores.
export interface Rec<T = unknown> {
  id: string;
  kind: Kind | string;
  hlc: string;
  deleted: boolean;
  data: T;
}

export type WithId<T> = T & { id: string };
export type TaskItem = WithId<Task>;
export type ProjectItem = WithId<Project>;
export type AreaItem = WithId<Area>;

export type View =
  | 'inbox' | 'doing' | 'today' | 'next' | 'scheduled' | 'someday' | 'all' | 'logbook' | 'search'
  | `project:${string}`;
