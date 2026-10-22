import { useEffect, useRef, useState } from 'react';
import { cancelResolve, resolveWithNotes, resolvingId, useStore } from './store';

/** Asks for resolution notes before an Incident IQ ticket's task is completed. */
export default function ResolveDialog() {
  const v = useStore();
  const id = resolvingId();
  const t = id ? v.task(id) : undefined;
  const [notes, setNotes] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!t) return;
    setNotes('');
    setTimeout(() => box.current?.focus());
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); cancelResolve(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [t?.id]);

  if (!t) return null;
  const submit = () => { if (notes.trim()) resolveWithNotes(t.id, notes); };
  // Ctrl/⌘+Enter in the notes submits; it's stopped there so the app's own
  // Ctrl/⌘+Enter (complete or reopen the selected task) doesn't also run.
  return (
    <div className="dialog-scrim" onClick={(e) => { if (e.target === e.currentTarget) cancelResolve(); }}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="resolve-title"
        onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2 id="resolve-title">Resolve ticket #{t.external?.number ?? '?'}</h2>
        <p className="muted small">{t.title}</p>
        <label htmlFor="resolve-notes" className="dialog-label">Resolution notes</label>
        <textarea id="resolve-notes" ref={box} rows={5} value={notes} placeholder="What was done to fix it…"
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); submit(); } }} />
        <p className="muted small">Saved to the ticket in Incident IQ with your resolution action.</p>
        <div className="dialog-btns">
          <button type="button" className="ghost" onClick={cancelResolve}>Cancel</button>
          <button type="submit" className="pri" disabled={!notes.trim()}>Resolve</button>
        </div>
      </form>
    </div>
  );
}
