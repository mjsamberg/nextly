import { useState, type RefObject } from 'react';
import * as I from './icons';
import { createProject, useStore } from './store';
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
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
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

      {groups.map((g) => (g.area || g.projects.length) ? (
        <div key={g.area?.id ?? 'none'} className="nav-group">
          {g.area && <div className="grp">{g.area.title}</div>}
          {!g.area && v.areas.length > 0 && g.projects.length > 0 && <div className="grp">Other projects</div>}
          {!g.area && v.areas.length === 0 && <div className="grp">Projects</div>}
          {g.projects.map((p) => {
            const id: View = `project:${p.id}`;
            const n = v.tasks.filter((t) => t.projectId === p.id && !t.done && !t.parentId).length;
            return (
              <button key={p.id} className={`nav proj ${view === id ? 'on' : ''}`} onClick={() => onGo(id)}>
                <I.Folder />{p.title || 'Untitled project'}{n ? <span className="ct">{n}</span> : null}<I.Chevron className="chev" />
              </button>
            );
          })}
        </div>
      ) : null)}

      {adding ? (
        <form className="new-proj" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onGo(`project:${createProject(name.trim(), null)}`); setName(''); setAdding(false); }}>
          <input id="new-project" autoFocus value={name} placeholder="Project name" onChange={(e) => setName(e.target.value)} onBlur={() => !name && setAdding(false)} />
        </form>
      ) : (
        <button className="nav muted" onClick={() => setAdding(true)}><I.Plus />New project</button>
      )}

      <div className="side-foot">
        <button className="nav" onClick={onSettings}><I.Gear />Settings<I.Chevron className="chev" /></button>
        <span className={`sync-dot ${sync.state}`} title={sync.message} aria-label={`Sync: ${sync.message}`} />
      </div>
    </nav>
  );
}
