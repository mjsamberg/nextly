import { useRef, useState, type PointerEvent, type RefObject } from 'react';
import * as I from './icons';
import { createTask, moveInNext, setFlag, setStartOn, toggleDone, useStore } from './store';
import { deadlineLabel, defer, parseQuickAdd, promote, repeatLabel, uid } from './logic';
import { tasksFor, viewTitle } from './lists';
import { mod, platform } from './net';
import { EDGE_SWIPE_ZONE } from './edgeSwipe';
import type { Flag, TaskItem, View } from './types';

interface Props {
  view: View;
  query: string;
  selected: string | null;
  onOpen: (id: string) => void;
  onBack: () => void;
  onGo: (v: View) => void;
  quickRef: RefObject<HTMLInputElement>;
}

/** What a task added from this list starts as. */
function defaultsFor(view: View): { flag: Flag; projectId: string | null } {
  if (view === 'today' || view === 'next' || view === 'someday' || view === 'doing') return { flag: view, projectId: null };
  if (view.startsWith('project:')) return { flag: null, projectId: view.slice(8) };
  return { flag: 'inbox', projectId: null };
}

export default function TaskList({ view, query, selected, onOpen, onBack, onGo, quickRef }: Props) {
  const v = useStore();
  const [draft, setDraft] = useState('');
  const tasks = tasksFor(v, view, query);
  const title = viewTitle(v, view);

  const add = () => {
    const q = parseQuickAdd(draft);
    if (!q.title && !q.emailUrl) return;
    const d = defaultsFor(view);
    const id = createTask({
      title: q.title || 'Email',
      flag: q.flag !== undefined ? q.flag : d.flag,
      projectId: d.projectId,
      deadline: q.deadline ?? null,
      repeat: q.repeat ?? null,
      notes: q.emailUrl ? [{ id: uid(), type: 'email', url: q.emailUrl, subject: q.title }] : [],
    });
    // @date: waits in Scheduled (or goes straight to Today if it's today or past).
    if (q.startOn) setStartOn(id, q.startOn);
    setDraft('');
  };

  const sub = view === 'today'
    ? new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ` · ${tasks.length} open`
    : view === 'next' ? `${tasks.length} · drag to reorder` : view === 'logbook' ? `${tasks.length} done` : `${tasks.length}`;

  return (
    <div className="list">
      <header className="list-h">
        <button className="back" onClick={onBack} aria-label="Back to lists"><I.Back />Lists</button>
        <h1>{title}</h1>
        <span className="sub">{sub}</span>
      </header>

      {view !== 'logbook' && view !== 'search' && (
        <form className="quick" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <I.Plus />
          <input
            id="quick-add"
            ref={quickRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={platform === 'ios' ? 'New task…  !t Today  @mon  *weekly' : `New task…  ${mod}N  ·  !t Today  !p In Progress  @mon start  *weekly`}
            autoComplete="off"
          />
        </form>
      )}

      {view === 'today' ? <TodayBody tasks={tasks} selected={selected} onOpen={onOpen} onGo={onGo} />
        : view === 'next' ? <NextBody tasks={tasks} selected={selected} onOpen={onOpen} />
        : tasks.length
          ? <div className="rows">{tasks.map((t) => <Row key={t.id} t={t} view={view} selected={selected === t.id} onOpen={onOpen} />)}</div>
          : <Empty view={view} />}

      <button className="fab" aria-label="New task" onClick={() => { quickRef.current?.focus(); quickRef.current?.scrollIntoView({ block: 'center' }); }}><I.Plus width={22} height={22} /></button>
    </div>
  );
}

function TodayBody({ tasks, selected, onOpen, onGo }: { tasks: TaskItem[]; selected: string | null; onOpen: (id: string) => void; onGo: (v: View) => void }) {
  const v = useStore();
  const groups = new Map<string, TaskItem[]>();
  for (const t of tasks) {
    const parent = t.parentId ? v.task(t.parentId) : undefined;
    const key = v.project(t.projectId ?? parent?.projectId ?? null)?.title ?? '';
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  const next = tasksFor(v, 'next');
  const doing = tasksFor(v, 'doing');

  return (
    <>
      {doing.length > 0 && (
        <section className="doing">
          <div className="sec sec-doing">In progress · {doing.length}</div>
          <div className="rows">{doing.map((t) => <Row key={t.id} t={t} view="doing" selected={selected === t.id} onOpen={onOpen} />)}</div>
        </section>
      )}
      {tasks.length === 0 && doing.length === 0 && <Empty view="today" />}
      {tasks.length > 0 && doing.length > 0 && keys[0] === '' && <div className="sec">Today</div>}
      {keys.map((k) => (
        <section key={k || 'none'}>
          {k && <div className="sec">{k}</div>}
          <div className="rows">{groups.get(k)!.map((t) => <Row key={t.id} t={t} view="today" selected={selected === t.id} onOpen={onOpen} />)}</div>
        </section>
      ))}
      {next.length > 0 && (
        <section className="upnext">
          <div className="sec">Up next · {next.length}</div>
          <div className="rows">{next.slice(0, 5).map((t) => <Row key={t.id} t={t} view="next" selected={selected === t.id} onOpen={onOpen} />)}</div>
          {next.length > 5 && <button className="more" onClick={() => onGo('next')}>Show {next.length - 5} more in Next</button>}
        </section>
      )}
    </>
  );
}

function NextBody({ tasks, selected, onOpen }: { tasks: TaskItem[]; selected: string | null; onOpen: (id: string) => void }) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  if (!tasks.length) return <Empty view="next" />;
  const drop = (beforeId: string | null) => { if (dragId && dragId !== beforeId) moveInNext(dragId, beforeId); setDragId(null); setOverId(null); };
  return (
    <div className="rows" onDragOver={(e) => e.preventDefault()} onDrop={() => drop(null)}>
      {tasks.map((t) => (
        <div
          key={t.id}
          className={`drag ${overId === t.id ? 'over' : ''} ${dragId === t.id ? 'dragging' : ''}`}
          draggable
          onDragStart={(e) => { setDragId(t.id); e.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={(e) => { e.preventDefault(); setOverId(t.id); }}
          onDragLeave={() => setOverId((o) => (o === t.id ? null : o))}
          onDrop={(e) => { e.stopPropagation(); drop(t.id); }}
          onDragEnd={() => { setDragId(null); setOverId(null); }}
        >
          <Row t={t} view="next" selected={selected === t.id} onOpen={onOpen} grip />
        </div>
      ))}
    </div>
  );
}

const EMPTY: Record<string, string> = {
  inbox: 'Nothing in your Inbox. New tasks land here until you give them a flag or a project.',
  today: 'Nothing flagged for today. Pull something up from Next, or add a task above.',
  doing: 'Nothing in progress. Swipe a Today task right, or flag it In Progress, when you start on it.',
  next: 'Next is empty. Flag tasks as Next to line up what comes after Today.',
  scheduled: 'Nothing scheduled. Tasks with a start date, a deadline or a repeat show up here.',
  someday: 'No Someday tasks.',
  logbook: 'Finished tasks show up here.',
  search: 'Type to search task titles and notes.',
};

function Empty({ view }: { view: View }) {
  return <p className="empty">{EMPTY[view] ?? 'No open tasks in this project. Add one above.'}</p>;
}

// ---------- row ----------

export function Row({ t, view, selected, onOpen, grip }: { t: TaskItem; view: View; selected: boolean; onOpen: (id: string) => void; grip?: boolean }) {
  const v = useStore();
  const kids = v.children(t.id);
  const blockers = v.blockers(t);
  const project = v.project(t.projectId);
  const parent = t.parentId ? v.task(t.parentId) : undefined;
  const hasMail = t.notes.some((b) => b.type === 'email');
  const files = t.notes.filter((b) => b.type === 'file' || b.type === 'image').length;
  const showFlag = !['doing', 'today', 'next', 'someday', 'inbox'].includes(view);
  const swipe = useSwipe(t);

  return (
    <div className={`row-wrap ${swipe.dir} ${promote(t.flag) === 'doing' ? 'to-doing' : ''}`}>
      <span className="swipe-label left">{labelFor(promote(t.flag))}</span>
      <span className="swipe-label right">{labelFor(defer(t.flag))}</span>
      <div
        className={`row ${selected ? 'sel' : ''} ${blockers.length && !t.done ? 'blocked' : ''} ${t.done ? 'done' : ''}`}
        style={swipe.style}
        onClick={() => !swipe.moved() && onOpen(t.id)}
        onKeyDown={(e) => { if (e.key === 'Enter') onOpen(t.id); }}
        tabIndex={0}
        {...swipe.handlers}
      >
        {grip && <span className="grip" aria-hidden="true"><I.Grip /></span>}
        <button
          className={`cb ${t.done ? 'checked' : ''}`}
          aria-label={t.done ? 'Mark not done' : 'Mark done'}
          onClick={(e) => { e.stopPropagation(); toggleDone(t.id); }}
        >{t.done && <I.Check />}</button>
        <span className="t">
          {t.title || <span className="muted">New task</span>}
          {parent && <span className="ctx">{parent.title}</span>}
          {!parent && project && !view.startsWith('project:') && <span className="ctx">{project.title}</span>}
        </span>
        <span className="chips">
          {kids.length > 0 && <span className="chip"><I.Sub />{kids.filter((k) => k.done).length}/{kids.length}</span>}
          {hasMail && <I.Mail />}
          {files > 0 && <span className="chip"><I.Clip />{files > 1 ? files : ''}</span>}
          {blockers.length > 0 && !t.done && <span className="flag f-blocked"><I.Lock width={11} height={11} />Waiting on {blockers.length}</span>}
          {showFlag && t.flag === 'doing' && <span className="flag f-doing"><I.Play width={10} height={10} />In Progress</span>}
          {showFlag && t.flag === 'today' && <span className="flag f-today"><I.Star width={11} height={11} />Today</span>}
          {showFlag && t.flag === 'next' && <span className="flag f-next">Next</span>}
          {t.repeat && <span className="chip" title={repeatLabel(t.repeat)}><I.Repeat /></span>}
          {t.startOn && <span className="flag f-start" title="Moves into Today on this day"><I.Star width={10} height={10} />{deadlineLabel(t.startOn)}</span>}
          {t.deadline && <span className="flag f-date">{t.startOn ? 'Due ' : ''}{deadlineLabel(t.deadline)}</span>}
        </span>
      </div>
    </div>
  );
}

const labelFor = (f: Flag) => (f === 'doing' ? '▶ In Progress' : f === 'today' ? '★ Today' : f === 'next' ? '→ Next' : f === 'someday' ? 'Someday' : 'Later');

/** Touch-only swipe: right promotes (→ Today → In Progress), left defers one step. Never sets a date. */
function useSwipe(t: TaskItem) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const moved = useRef(false);
  const [dx, setDx] = useState(0);
  const end = () => {
    if (dx > 80 && promote(t.flag) !== t.flag) setFlag(t.id, promote(t.flag));
    else if (dx < -80) setFlag(t.id, defer(t.flag));
    start.current = null; setDx(0);
    setTimeout(() => { moved.current = false; }, 0);
  };
  return {
    dir: dx > 20 ? 'swipe-r' : dx < -20 ? 'swipe-l' : '',
    style: dx ? { transform: `translateX(${dx}px)` } : undefined,
    moved: () => moved.current,
    handlers: {
      // Touches at the very edge belong to the swipe-back gesture.
      onPointerDown: (e: PointerEvent) => { if (e.pointerType === 'touch' && !t.done && e.clientX > EDGE_SWIPE_ZONE) start.current = { x: e.clientX, y: e.clientY, id: e.pointerId }; },
      onPointerMove: (e: PointerEvent) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        const x = e.clientX - s.x;
        if (!moved.current && Math.abs(e.clientY - s.y) > Math.abs(x)) { start.current = null; return; } // vertical scroll
        if (Math.abs(x) > 8) moved.current = true;
        setDx(Math.max(-140, Math.min(140, x)));
      },
      onPointerUp: end,
      onPointerCancel: () => { start.current = null; setDx(0); },
    },
  };
}

