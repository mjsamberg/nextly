import { useState } from 'react';
import * as I from './icons';
import { queueIiq, useStore } from './store';
import { openExternal } from './net';
import type { TaskItem } from './types';

const STATE_LABEL = { pending: 'Sending…', done: 'Done', manual: 'Needs you', failed: 'Failed' } as const;
const TYPE_LABEL = { comment: 'Comment', start: 'Start ticket', resolve: 'Resolve ticket' } as const;

/** The Incident IQ ticket behind a task: status, link, comments, and what Nextly sent. */
export default function IiqPanel({ task: t }: { task: TaskItem }) {
  const v = useStore();
  const ext = t.external!;
  const [comment, setComment] = useState('');
  const actions = v.iiqActions(t.id).slice(0, 5);
  const needsYou = actions.find((a) => a.state === 'manual' || a.state === 'failed');

  return (
    <section className="iiq">
      <div className="iiq-head">
        <span className="iiq-badge">Incident IQ</span>
        <b>#{ext.number ?? '?'}</b>
        {ext.status && <span className={`flag ${ext.closed ? 'f-date' : 'f-next'}`}>{ext.status}</span>}
        {ext.url && <button className="link iiq-open" onClick={() => openExternal(ext.url!)}>Open in Incident IQ ↗</button>}
      </div>
      <p className="muted small iiq-meta">
        {[ext.requester && `Requested by ${ext.requester}`, ext.location, ext.issue, ext.priority && `Priority ${ext.priority}`].filter(Boolean).join(' · ') || 'Ticket details appear after the next sync.'}
      </p>
      {needsYou && <p className={needsYou.state === 'failed' ? 'error' : 'iiq-note'}>{needsYou.message}</p>}

      {!ext.closed && (
        <form className="iiq-comment" onSubmit={(e) => { e.preventDefault(); if (comment.trim()) { queueIiq(t.id, 'comment', comment.trim()); setComment(''); } }}>
          <textarea id={`iiq-comment-${t.id}`} rows={2} value={comment} placeholder="Add an internal comment to the ticket…" onChange={(e) => setComment(e.target.value)} />
          <button type="submit" className="pri" disabled={!comment.trim()}>Post to Incident IQ</button>
        </form>
      )}

      {actions.length > 0 && (
        <ul className="iiq-log">
          {actions.map((a) => (
            <li key={a.id}>
              <span className={`iiq-state s-${a.state}`}>{STATE_LABEL[a.state]}</span>
              <span>{TYPE_LABEL[a.type]}{a.type === 'comment' && a.text ? `: “${a.text.length > 60 ? a.text.slice(0, 60) + '…' : a.text}”` : ''}</span>
              <span className="muted">{new Date(a.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small"><I.Lock width={10} height={10} /> Comments are internal. In Progress starts the ticket; finishing the task resolves it.</p>
    </section>
  );
}
