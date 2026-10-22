import { useRef, useState, type RefObject } from 'react';
import * as I from './icons';
import { createArea, createProject, useStore } from './store';
import { useSyncStatus } from './sync';
import { counts } from './lists';
import { mod, platform } from './net';
import type { View } from './types';

interface Props {
  view: View | null;
  onGo: (v: View) => void;
  query: string;
  onQuery: (q: string) => void;
  searchRef: RefObject<HTMLInputElement>;
  onSettings: () => void;
}

const MAIN: { id: View; label: string; icon: JSX.Element; cls?: string }[] = [
  { id: 'inbox', label: 'Inbox', icon: <I.Inbox /> },
  { id: 'doing', label: 'In Progress', icon: <I.Play />, cls: 'ic-doing' },
  { id: 'today', label: 'Today', icon: <I.Star />, cls: 'ic-today' },
  { id: 'next', label: 'Next', icon: <I.Next />, cls: 'ic-next' },
  { id: 'scheduled', label: 'Scheduled', icon: <I.Calendar /> },
  { id: 'someday', label: 'Someday', icon: <I.Box /> },
  { id: 'logbook', label: 'Logbook', icon: <I.Check /> },
];

export default function Sidebar({ view, onGo, query, onQuery, searchRef, onSettings }: Props) {
  const v = useStore();
  const sync = useSyncStatus();
  // Where a new project or area is being typed: an area id, NO_AREA, NEW_AREA, or null.
  const [adding, setAdding] = useState<string | null>(null);
  const c = counts(v);

  const groups = [
    ...v.areas.map((a) => ({ area: a, projects: v.projects.filter((p) => p.areaId === a.id) })),
    { area: null, projects: v.projects.filter((p) => !p.areaId || !v.areas.some((a) => a.id === p.areaId)) },
  ];

  return (
    <nav className="sidebar" aria-label="Lists">
      <label className="search">
        <I.Search />
        <input id="search" ref={searchRef} value={query} placeholder={platform === 'ios' ? 'Search' : `Search  (${mod}K)`} onChange={(e) => onQuery(e.target.value)} />
      </label>
      <div className="nav-list">
        {MAIN.map((m) => (
          <button key={m.id} className={`nav ${view === m.id ? 'on' : ''}`} onClick={() => onGo(m.id)} aria-current={view === m.id}>
            <span className={m.cls}>{m.icon}</span>{m.label}
            {c[m.id as keyof typeof c] ? <span className="ct">{c[m.id as keyof typeof c]}</span> : null}
            <I.Chevron className="chev" />
          </button>
        ))}
      </div>

      {groups.map((g) => (g.area || g.projects.length || adding === NO_AREA) ? (
        <div key={g.area?.id ?? 'none'} className="nav-group">
          {g.area && <GroupHeader title={g.area.title} onAdd={() => setAdding(g.area!.id)} />}
          {!g.area && v.areas.length > 0 && (g.projects.length > 0 || adding === NO_AREA) && <GroupHeader title="Other projects" onAdd={() => setAdding(NO_AREA)} />}
          {!g.area && v.areas.length === 0 && <GroupHeader title="Projects" onAdd={() => setAdding(NO_AREA)} />}
          {g.projects.map((p) => {
            const id: View = `project:${p.id}`;
            const n = v.tasks.filter((t) => t.projectId === p.id && !t.done && !t.parentId).length;
            return (
              <button key={p.id} className={`nav proj ${view === id ? 'on' : ''}`} onClick={() => onGo(id)}>
                <I.Folder />{p.title || 'Untitled project'}{n ? <span className="ct">{n}</span> : null}<I.Chevron className="chev" />
              </button>
            );
          })}
          {adding === (g.area?.id ?? NO_AREA) && (
            <NameForm
              id={`new-project-${g.area?.id ?? 'none'}`}
              placeholder={g.area ? `New project in ${g.area.title}` : 'Project name'}
              onDone={(name) => { setAdding(null); if (name) onGo(`project:${createProject(name, g.area?.id ?? null)}`); }}
            />
          )}
        </div>
      ) : null)}

      {adding === NEW_AREA && (
        <NameForm id="new-area-side" placeholder="Area name, like Classroom" onDone={(name) => { setAdding(null); if (name) createArea(name); }} />
      )}
      <div className="side-add">
        <button className="nav muted" onClick={() => setAdding(NO_AREA)}><I.Plus />New project</button>
        <button className="nav muted" onClick={() => setAdding(NEW_AREA)}><I.Plus />New area</button>
      </div>

      <div className="side-foot">
        <button className="nav" onClick={onSettings}><I.Gear />Settings<I.Chevron className="chev" /></button>
        <span className={`sync-dot ${sync.state}`} title={sync.message} aria-label={`Sync: ${sync.message}`} />
      </div>
    </nav>
  );
}

const NO_AREA = '__no-area__';
const NEW_AREA = '__new-area__';

/** An area heading with a "+" that starts a new project in that area. */
function GroupHeader({ title, onAdd }: { title: string; onAdd: () => void }) {
  return (
    <div className="grp">
      <span className="grp-title">{title}</span>
      <button className="grp-add" onClick={onAdd} aria-label={`New project in ${title}`} title={`New project in ${title}`}><I.Plus /></button>
    </div>
  );
}

/** Inline name field: Enter saves, Esc or leaving it empty cancels. */
function NameForm({ id, placeholder, onDone }: { id: string; placeholder: string; onDone: (name: string | null) => void }) {
  const [name, setName] = useState('');
  // Enter closes the field, and some browsers then also report a blur; finish once.
  const finished = useRef(false);
  const finish = (value: string | null) => { if (finished.current) return; finished.current = true; onDone(value); };
  return (
    <form className="new-proj" onSubmit={(e) => { e.preventDefault(); finish(name.trim() || null); }}>
      <input
        id={id}
        autoFocus
        value={name}
        placeholder={placeholder}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') finish(null); }}
        onBlur={() => finish(name.trim() || null)}
      />
    </form>
  );
}
