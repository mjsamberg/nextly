import { useState } from 'react';
import * as I from './icons';
import Notes from './Notes';
import {
  addDependency, createTask, removeDependency, setFlag, toggleDone, updateTask, useStore,
} from './store';
import { deadlineLabel } from './logic';
import type { Flag, TaskItem } from './types';

interface Props {
  task: TaskItem;
  onOpen: (id: string) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
}

const FLAGS: { f: Flag; label: string; cls: string }[] = [
  { f: 'inbox', label: 'Inbox', cls: '' },
  { f: 'today', label: '★ Today', cls: 'on-today' },
  { f: 'next', label: 'Next', cls: 'on-next' },
  { f: 'someday', label: 'Someday', cls: 'on-someday' },
];

export default function Detail({ task: t, onOpen, onClose, onDelete }: Props) {
  const v = useStore();
  const kids = v.children(t.id);
  const parent = t.parentId ? v.task(t.parentId) : undefined;
  const blocks = v.blocks(t.id);
  const [newSub, setNewSub] = useState('');
  const [depQuery, setDepQuery] = useState('');
  const [depError, setDepError] = useState<string | null>(null);

  const depOptions = depQuery.trim()
    ? v.tasks.filter((o) => !o.done && o.id !== t.id && !t.dependsOn.includes(o.id) && o.title.toLowerCase().includes(depQuery.toLowerCase())).slice(0, 6)
    : [];

  const pickDep = (id: string) => {
    setDepError(addDependency(t.id, id));
    setDepQuery('');
  };

  return (
    <div className="detail">
      <div className="detail-top">
        <button className="back" onClick={onClose} aria-label="Close"><I.Back /><span>Back</span></button>
        <button className="icon-btn close-x" onClick={onClose} aria-label="Close details"><I.X /></button>
      </div>

      {parent && (
        <button className="parent-link" onClick={() => onOpen(parent.id)}><I.Up width={12} height={12} />Subtask of {parent.title || 'untitled task'}</button>
      )}

      <div className="d-title-row">
        <button className={`cb big ${t.done ? 'checked' : ''}`} aria-label={t.done ? 'Mark not done' : 'Mark done'} onClick={() => toggleDone(t.id)}>{t.done && <I.Check />}</button>
        <textarea
          id={`title-${t.id}`}
          className="d-title"
          rows={1}
          value={t.title}
          placeholder="New task"
          onChange={(e) => updateTask(t.id, { title: e.target.value.replace(/\n/g, ' ') })}
          autoFocus={!t.title}
        />
      </div>

      <div className="seg" role="radiogroup" aria-label="When">
        {FLAGS.map(({ f, label, cls }) => (
          <button key={f} role="radio" aria-checked={t.flag === f} className={t.flag === f ? cls || 'on' : ''} onClick={() => setFlag(t.id, f)}>{label}</button>
        ))}
      </div>

      <div className="fields">
        <label className="field">
          <I.Calendar />
          <span>Deadline</span>
          <input id={`deadline-${t.id}`} type="date" value={t.deadline ?? ''} onChange={(e) => updateTask(t.id, { deadline: e.target.value || null })} />
          {t.deadline
            ? <><span className="muted">{deadlineLabel(t.deadline)}</span><button className="link" onClick={() => updateTask(t.id, { deadline: null })}>Clear</button></>
            : <span className="muted">optional</span>}
        </label>
        {!t.parentId && (
          <label className="field">
            <I.Folder />
            <span>Project</span>
            <select id={`project-${t.id}`} value={t.projectId ?? ''} onChange={(e) => updateTask(t.id, { projectId: e.target.value || null })}>
              <option value="">None</option>
              {v.projects.map((p) => <option key={p.id} value={p.id}>{p.title || 'Untitled project'}</option>)}
            </select>
          </label>
        )}
      </div>

      <section>
        <div className="lbl">Subtasks{kids.length ? ` · ${kids.filter((k) => k.done).length} of ${kids.length}` : ''}</div>
        {kids.map((k) => (
          <div key={k.id} className={`sub-row ${k.done ? 'done' : ''}`}>
            <button className={`cb small ${k.done ? 'checked' : ''}`} aria-label="Toggle subtask" onClick={() => toggleDone(k.id)}>{k.done && <I.Check />}</button>
            <input id={`sub-${k.id}`} value={k.title} placeholder="Subtask" onChange={(e) => updateTask(k.id, { title: e.target.value })} />
            {k.flag === 'today' && <span className="flag f-today">Today</span>}
            {k.flag === 'next' && <span className="flag f-next">Next</span>}
            <button className="icon-btn" aria-label="Open subtask" onClick={() => onOpen(k.id)}><I.Next /></button>
          </div>
        ))}
        <form className="sub-row add" onSubmit={(e) => { e.preventDefault(); if (newSub.trim()) createTask({ title: newSub.trim(), parentId: t.id, flag: null, projectId: t.projectId }); setNewSub(''); }}>
          <I.Plus />
          <input id={`new-sub-${t.id}`} value={newSub} placeholder="Add subtask" onChange={(e) => setNewSub(e.target.value)} />
        </form>
      </section>

      <section>
        <div className="lbl">Depends on</div>
        {t.dependsOn.map((id) => {
          const d = v.task(id);
          if (!d) return null;
          return (
            <div key={id} className="dep">
              <button className="dep-title" onClick={() => onOpen(id)}>{d.done ? <I.Check /> : <I.Lock />}{d.title || 'Untitled task'}</button>
              <span className={`flag ${d.done ? 'f-date' : 'f-blocked'}`}>{d.done ? 'Done' : 'Open'}</span>
              <button className="icon-btn" aria-label="Remove dependency" onClick={() => removeDependency(t.id, id)}><I.X /></button>
            </div>
          );
        })}
        <div className="dep-add">
          <input id={`dep-${t.id}`} value={depQuery} placeholder="Add a task this one waits on…" onChange={(e) => { setDepQuery(e.target.value); setDepError(null); }} />
          {depOptions.length > 0 && (
            <ul className="dep-menu">
              {depOptions.map((o) => <li key={o.id}><button onClick={() => pickDep(o.id)}>{o.title}</button></li>)}
            </ul>
          )}
        </div>
        {depError && <p className="error">{depError}</p>}
        {blocks.length > 0 && (
          <>
            <div className="lbl" style={{ marginTop: 12 }}>Blocks</div>
            {blocks.map((b) => (
              <div key={b.id} className="dep">
                <button className="dep-title" onClick={() => onOpen(b.id)}><I.Lock />{b.title || 'Untitled task'}</button>
                <span className={`flag ${b.done ? 'f-date' : v.blockers(b).length ? 'f-blocked' : 'f-next'}`}>{b.done ? 'Done' : v.blockers(b).length ? 'Waiting' : 'Free'}</span>
              </div>
            ))}
          </>
        )}
      </section>

      <Notes task={t} />

      <footer className="d-foot">
        <span className="muted">Added {new Date(t.createdAt).toLocaleDateString()}{t.doneAt ? ` · Done ${new Date(t.doneAt).toLocaleDateString()}` : ''}</span>
        <button className="danger" onClick={() => onDelete(t.id)}>Delete</button>
      </footer>
    </div>
  );
}
