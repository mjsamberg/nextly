// One flag per task. null means "no list of its own": a subtask that lives
// under its parent, or a task that lives only in its project.
export type Flag = 'inbox' | 'today' | 'next' | 'someday' | null;

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

export interface Task {
  title: string;
  flag: Flag;
  projectId: string | null;
  parentId: string | null;
  deadline: string | null; // YYYY-MM-DD, optional and never used for sorting Today/Next
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

export type Kind = 'task' | 'project' | 'area';

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
  | 'inbox' | 'today' | 'next' | 'scheduled' | 'someday' | 'logbook' | 'search'
  | `project:${string}`;
