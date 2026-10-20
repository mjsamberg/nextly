import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import * as I from './icons';
import { setNotes } from './store';
import { uid } from './logic';
import { addFile, fileLink, loadFile } from './sync';
import { openExternal } from './net';
import type { Block, BlockType, TaskItem } from './types';

// Block editor: a note is a list of blocks, like a blog post.
// Enter makes a new block, Backspace on an empty block removes it,
// and "/" in an empty text block opens the block menu.

const TEXT_TYPES: BlockType[] = ['heading', 'paragraph', 'checklist', 'quote'];

const MENU: { type: BlockType; label: string; hint: string }[] = [
  { type: 'heading', label: 'Heading', hint: 'H' },
  { type: 'paragraph', label: 'Text', hint: '¶' },
  { type: 'checklist', label: 'Checklist', hint: '☐' },
  { type: 'quote', label: 'Quote', hint: '“' },
  { type: 'divider', label: 'Divider', hint: '—' },
  { type: 'image', label: 'Image', hint: '▣' },
  { type: 'file', label: 'File', hint: '⎘' },
  { type: 'email', label: 'Email', hint: '✉' },
];

export default function Notes({ task }: { task: TaskItem }) {
  const blocks = task.notes;
  const [focusId, setFocusId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [emailForm, setEmailForm] = useState<{ at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingKind = useRef<{ type: 'image' | 'file'; at: number }>({ type: 'file', at: 0 });

  const save = (next: Block[]) => setNotes(task.id, next);
  const patch = (id: string, p: Partial<Block>) => save(blocks.map((b) => (b.id === id ? { ...b, ...p } : b)));
  const insertAt = (at: number, b: Block) => { save([...blocks.slice(0, at), b, ...blocks.slice(at)]); setFocusId(b.id); };
  const remove = (id: string) => save(blocks.filter((b) => b.id !== id));

  const choose = (type: BlockType, at: number, replaceId?: string) => {
    setMenuFor(null);
    const rest = replaceId ? blocks.filter((b) => b.id !== replaceId) : blocks;
    const pos = replaceId ? blocks.findIndex((b) => b.id === replaceId) : at;
    if (type === 'image' || type === 'file') {
      if (replaceId) save(rest);
      pendingKind.current = { type, at: pos };
      fileInput.current?.click();
      return;
    }
    if (type === 'email') {
      if (replaceId) save(rest);
      setEmailForm({ at: pos });
      return;
    }
    const b: Block = { id: uid(), type, text: '', ...(type === 'checklist' ? { checked: false } : {}) };
    if (replaceId) { save([...rest.slice(0, pos), b, ...rest.slice(pos)]); setFocusId(b.id); }
    else insertAt(at, b);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    try {
      const added: Block[] = [];
      for (const f of Array.from(files)) {
        const meta = await addFile(f);
        const isImage = pendingKind.current.type === 'image' || meta.mime.startsWith('image/');
        added.push({ id: uid(), type: isImage ? 'image' : 'file', ...meta });
      }
      const at = Math.min(pendingKind.current.at, task.notes.length);
      setNotes(task.id, [...task.notes.slice(0, at), ...added, ...task.notes.slice(at)]);
    } catch (e) {
      setError(`Couldn’t add the file: ${e instanceof Error ? e.message : e}`);
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>, b: Block, i: number) => {
    const el = e.currentTarget;
    if (e.key === 'Enter' && !e.shiftKey && b.type !== 'quote') {
      e.preventDefault();
      if (menuFor === b.id) return;
      // Enter on an empty checklist item ends the list.
      if (b.type === 'checklist' && !b.text) { patch(b.id, { type: 'paragraph', checked: undefined }); return; }
      const before = (b.text ?? '').slice(0, el.selectionStart ?? 0);
      const after = (b.text ?? '').slice(el.selectionStart ?? 0);
      const nb: Block = { id: uid(), type: b.type === 'checklist' ? 'checklist' : 'paragraph', text: after, ...(b.type === 'checklist' ? { checked: false } : {}) };
      save([...blocks.slice(0, i), { ...b, text: before }, nb, ...blocks.slice(i + 1)]);
      setFocusId(nb.id);
    } else if (e.key === 'Backspace' && !b.text && blocks.length > 0) {
      e.preventDefault();
      remove(b.id);
      const prev = blocks[i - 1];
      if (prev) setFocusId(prev.id);
    } else if (e.key === 'Escape') {
      setMenuFor(null);
    }
  };

  return (
    <section className="notes">
      <div className="lbl">Notes</div>

      {blocks.length === 0 && (
        <button className="notes-empty" onClick={() => choose('paragraph', 0)}>Write notes, paste links, or add files and emails…</button>
      )}

      {blocks.map((b, i) => (
        <div key={b.id} className={`blk blk-${b.type}`}>
          {TEXT_TYPES.includes(b.type) && (
            <div className="blk-text">
              {b.type === 'checklist' && (
                <button className={`cb small ${b.checked ? 'checked' : ''}`} aria-label="Toggle item" onClick={() => patch(b.id, { checked: !b.checked })}>{b.checked && <I.Check />}</button>
              )}
              <AutoText
                id={`blk-${b.id}`}
                value={b.text ?? ''}
                focus={focusId === b.id}
                onFocused={() => setFocusId(null)}
                placeholder={b.type === 'heading' ? 'Heading' : b.type === 'paragraph' && blocks.length === 1 ? 'Type / for blocks' : ''}
                onChange={(text) => { patch(b.id, { text }); setMenuFor(text === '/' && b.type === 'paragraph' ? b.id : null); }}
                onKeyDown={(e) => keyDown(e, b, i)}
              />
              {menuFor === b.id && (
                <ul className="slash-menu" role="menu">
                  {MENU.map((m) => (
                    <li key={m.type}><button role="menuitem" onMouseDown={(e) => { e.preventDefault(); choose(m.type, i, b.id); }}><span className="hint">{m.hint}</span>{m.label}</button></li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {b.type === 'divider' && <hr />}
          {b.type === 'image' && b.sha && <ImageBlock b={b} />}
          {b.type === 'file' && b.sha && <FileBlock b={b} onError={setError} />}
          {b.type === 'email' && (
            <div className="mailcard">
              <I.Mail />
              <div className="m">
                <input id={`subj-${b.id}`} value={b.subject ?? ''} placeholder="Email subject" onChange={(e) => patch(b.id, { subject: e.target.value })} />
                <button className="link" onClick={() => b.url && openExternal(b.url)}>{b.url?.startsWith('message:') ? 'Open in Mail' : 'Open in Gmail'} ↗</button>
              </div>
            </div>
          )}
          {!TEXT_TYPES.includes(b.type) && (
            <button className="icon-btn blk-x" aria-label="Remove block" onClick={() => remove(b.id)}><I.X /></button>
          )}
        </div>
      ))}

      {emailForm && <EmailForm onCancel={() => setEmailForm(null)} onAdd={(url, subject) => { insertAt(emailForm.at, { id: uid(), type: 'email', url, subject }); setEmailForm(null); }} />}
      {error && <p className="error">{error}</p>}

      <div className="blk-bar" aria-label="Add block">
        {MENU.map((m) => (
          <button key={m.type} title={m.label} onClick={() => choose(m.type, blocks.length)}>
            {m.type === 'file' ? <I.Clip /> : m.type === 'email' ? <I.Mail /> : m.type === 'image' ? <I.File /> : m.hint}
            <span className="blk-bar-label">{m.label}</span>
          </button>
        ))}
      </div>
      <input ref={fileInput} id={`file-${task.id}`} type="file" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
    </section>
  );
}

function AutoText({ id, value, onChange, onKeyDown, placeholder, focus, onFocused }: {
  id: string; value: string; placeholder: string; focus: boolean; onFocused: () => void;
  onChange: (v: string) => void; onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = '0'; el.style.height = `${el.scrollHeight}px`; }
  }, [value]);
  useEffect(() => {
    if (focus && ref.current) { ref.current.focus(); ref.current.setSelectionRange(0, 0); onFocused(); }
  }, [focus, onFocused]);
  return <textarea id={id} ref={ref} rows={1} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />;
}

function useBlobUrl(b: Block) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let u: string | null = null;
    let live = true;
    loadFile(b.sha!, b.name, b.mime).then((blob) => {
      if (!live) return;
      if (blob) { u = URL.createObjectURL(blob); setUrl(u); } else setMissing(true);
    }).catch(() => live && setMissing(true));
    return () => { live = false; if (u) URL.revokeObjectURL(u); };
  }, [b.sha, b.name, b.mime]);
  return { url, missing };
}

function ImageBlock({ b }: { b: Block }) {
  const { url, missing } = useBlobUrl(b);
  if (missing) return <div className="img-missing">{b.name}: not downloaded yet. It will appear once this device syncs.</div>;
  return url ? <img src={url} alt={b.name ?? ''} /> : <div className="img-missing">Loading {b.name}…</div>;
}

function FileBlock({ b, onError }: { b: Block; onError: (m: string) => void }) {
  const open = async () => {
    try { openExternal(await fileLink(b.sha!, b.name ?? 'file', b.mime ?? 'application/octet-stream')); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <button className="filecard" onClick={open}>
      <I.File />
      <span className="fname">{b.name}</span>
      <span className="muted">{formatSize(b.size ?? 0)}</span>
    </button>
  );
}

function EmailForm({ onAdd, onCancel }: { onAdd: (url: string, subject: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState('');
  const [subject, setSubject] = useState('');
  const valid = /^(https:\/\/mail\.google\.com\/|message:)/.test(url.trim());
  return (
    <form className="email-form" onSubmit={(e) => { e.preventDefault(); if (valid) onAdd(url.trim(), subject.trim()); }}>
      <label htmlFor="email-url">Gmail link</label>
      <input id="email-url" autoFocus value={url} placeholder="https://mail.google.com/mail/u/0/#inbox/…" onChange={(e) => setUrl(e.target.value)} />
      <label htmlFor="email-subject">Subject</label>
      <input id="email-subject" value={subject} placeholder="What the email is about" onChange={(e) => setSubject(e.target.value)} />
      {url && !valid && <p className="error">Paste the address of an open Gmail message. It starts with https://mail.google.com/.</p>}
      <div className="row-btns">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="pri" disabled={!valid}>Add email</button>
      </div>
    </form>
  );
}

const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
