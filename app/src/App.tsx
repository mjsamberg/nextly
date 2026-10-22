import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './Sidebar';
import TaskList from './TaskList';
import Detail from './Detail';
import Settings from './Settings';
import ResolveDialog from './ResolveDialog';
import { deleteTask, setFlag, toggleDone, useStore } from './store';
import { onCaptured } from './capture';
import { useEdgeSwipeBack } from './edgeSwipe';
import type { View } from './types';

type Pane = 'nav' | 'list' | 'detail';
// Compact width (a phone, or a foldable folded): one screen at a time.
// Wider (unfolded, or a phone held sideways): panes side by side.
const narrow = () => window.matchMedia('(max-width: 599px)').matches;

export default function App() {
  const v = useStore();
  const [view, setView] = useState<View>('today');
  const [selected, setSelected] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>(() => (narrow() ? 'nav' : 'list'));
  const [query, setQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const quickRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const task = selected ? v.task(selected) : undefined;
  useEffect(() => { if (selected && !task) setSelected(null); }, [selected, task]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const go = useCallback((next: View) => {
    setView(next); setSelected(null); setSettingsOpen(false); setPane('list');
  }, []);
  const open = useCallback((id: string) => { setSelected(id); setSettingsOpen(false); setPane('detail'); }, []);
  const close = useCallback(() => { setSelected(null); setPane('list'); }, []);

  // A task from the Gmail bookmarklet: show the Inbox with it open, so you can
  // pick Today or Next right away.
  useEffect(() => onCaptured(({ id, title }) => {
    setView('inbox'); setSettingsOpen(false); setSelected(id); setPane('detail');
    setToast({ text: `Added “${title}” to the Inbox` });
  }), []);

  // Phone layout: swipe from the left edge goes back one screen, like the Back buttons.
  useEdgeSwipeBack(
    pane === 'detail' ? close
      : pane === 'list' ? () => { setSettingsOpen(false); setPane('nav'); }
      : null,
    narrow,
  );

  const remove = useCallback((id: string) => {
    const title = v.task(id)?.title || 'task';
    const undo = deleteTask(id);
    close();
    setToast({ text: `Deleted “${title}”`, undo });
  }, [v, close]);

  // Desktop shortcuts. Ctrl on Windows, ⌘ on Mac.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]');
      const k = e.key.toLowerCase();
      if (mod && k === 'n') { e.preventDefault(); if (settingsOpen || pane !== 'list') { setSettingsOpen(false); setPane('list'); } setTimeout(() => quickRef.current?.focus()); }
      else if (mod && k === 'k') { e.preventDefault(); setPane(narrow() ? 'nav' : pane); setTimeout(() => searchRef.current?.focus()); }
      else if (mod && k === 't' && selected) { e.preventDefault(); setFlag(selected, e.shiftKey ? 'next' : 'today'); }
      else if (mod && k === 'd' && selected) { e.preventDefault(); setFlag(selected, 'doing'); }
      else if (mod && k === 'enter' && selected) { e.preventDefault(); toggleDone(selected); }
      else if (mod && k === ',') { e.preventDefault(); setSettingsOpen(true); setPane('list'); }
      else if (k === 'escape' && !typing) { if (selected) close(); }
      else if ((k === 'delete' || (mod && k === 'backspace')) && selected && !typing) { e.preventDefault(); remove(selected); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, pane, settingsOpen, close, remove]);

  return (
    <div className="app" data-pane={pane} data-detail={task ? 'open' : 'closed'}>
      {/* macOS: the title bar is hidden; this strip lets you drag the window. */}
      <div className="drag-strip" data-tauri-drag-region aria-hidden="true" />
      <Sidebar
        view={settingsOpen ? null : view}
        onGo={go}
        query={query}
        onQuery={(q) => { setQuery(q); if (q) go('search'); }}
        searchRef={searchRef}
        onSettings={() => { setSettingsOpen(true); setSelected(null); setPane('list'); }}
      />
      <main className="list-pane">
        {settingsOpen
          ? <Settings onBack={() => { setSettingsOpen(false); setPane(narrow() ? 'nav' : 'list'); }} />
          : <TaskList view={view} query={query} selected={selected} onOpen={open} onBack={() => setPane('nav')} onGo={go} quickRef={quickRef} />}
      </main>
      <aside className="detail-pane">
        {task
          ? <Detail key={task.id} task={task} onOpen={open} onClose={close} onDelete={remove} />
          : <div className="empty-detail">Select a task to see its details.</div>}
      </aside>
      <ResolveDialog />
      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button onClick={() => { toast.undo!(); setToast(null); }}>Undo</button>}
        </div>
      )}
    </div>
  );
}
