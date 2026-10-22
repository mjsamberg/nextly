import { useState } from 'react';
import * as I from './icons';
import { createArea, deleteArea, deleteProject, deviceId, updateArea, updateProject, useStore } from './store';
import { checkConnection, getSettings, saveSettings, syncNow, useSyncStatus } from './sync';
import { checkHeaders, type HeaderRow } from './logic';
import { mod } from './net';
import { useShareStatus, widgetSharingEnabled } from './apple';

/** Whether the widget and Siri can see the sync settings (Mac and iPhone). */
function WidgetShareLine() {
  const s = useShareStatus();
  const dot = s.state === 'ok' ? 'idle' : s.state === 'off' ? 'off' : 'error';
  const text = s.state === 'ok'
    ? `Widget and Siri: settings shared at ${new Date(s.at!).toLocaleTimeString()}. A widget showing “set up sync” picks them up within a few minutes, or remove and re-add it.`
    : s.state === 'off'
      ? 'Widget and Siri: waiting to share settings…'
      : `Widget and Siri can’t see your settings: ${s.message}`;
  return <p className={`sync-line ${s.state === 'ok' || s.state === 'off' ? '' : 'error'}`}><span className={`sync-dot ${dot}`} />{text}</p>;
}

const LIVE_LABEL = {
  off: 'Live updates off',
  connecting: 'Connecting live updates…',
  live: 'Live updates on: changes from other devices appear right away',
  retrying: 'Live updates disconnected',
} as const;

export default function Settings({ onBack }: { onBack: () => void }) {
  const v = useStore();
  const sync = useSyncStatus();
  const [url, setUrl] = useState(getSettings().url);
  const [token, setToken] = useState(getSettings().token);
  const [headers, setHeaders] = useState<HeaderRow[]>(getSettings().headers);
  const [area, setArea] = useState('');
  const [diag, setDiag] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const runCheck = async () => { setChecking(true); setDiag(await checkConnection()); setChecking(false); };
  const urlOk = !url || /^https?:\/\/[^\s/]+/.test(url.trim());
  const headerError = checkHeaders(headers);
  const hasAccess = headers.some((h) => /^cf-access-client-/i.test(h.name));
  const setRow = (i: number, p: Partial<HeaderRow>) => setHeaders(headers.map((h, j) => (j === i ? { ...h, ...p } : h)));

  return (
    <div className="list settings">
      <header className="list-h">
        <button className="back" onClick={onBack} aria-label="Back to lists"><I.Back />Lists</button>
        <h1>Settings</h1>
      </header>

      <section className="panel">
        <h2>Sync</h2>
        <p className="muted">Point every device at the same Nextly server, for example <code>https://nextly.example.com</code> through a Cloudflare Tunnel.</p>
        <form className="form" onSubmit={(e) => { e.preventDefault(); if (urlOk && !headerError) void saveSettings({ url, token, headers }); }}>
          <label htmlFor="sync-url">Server address</label>
          <input id="sync-url" value={url} placeholder="https://nextly.example.com" onChange={(e) => setUrl(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          {!urlOk && <p className="error">The address should start with http:// or https://.</p>}
          <label htmlFor="sync-token">Sync token</label>
          <input id="sync-token" type="password" value={token} placeholder="NEXTLY_TOKEN from the server’s .env" onChange={(e) => setToken(e.target.value)} autoComplete="off" />

          <label>Request headers</label>
          <p className="muted small">Sent with every sync and file request. For Cloudflare Access, add your service token’s Client ID and Client Secret.</p>
          {headers.map((h, i) => (
            <div key={i} className="header-row">
              <input id={`hdr-name-${i}`} value={h.name} placeholder="Header name" aria-label="Header name" onChange={(e) => setRow(i, { name: e.target.value })} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              <input id={`hdr-value-${i}`} value={h.value} placeholder="Value" aria-label={`Value for ${h.name || 'header'}`} type={/secret|token|key|password/i.test(h.name) ? 'password' : 'text'} onChange={(e) => setRow(i, { value: e.target.value })} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" />
              <button type="button" className="icon-btn" aria-label={`Remove ${h.name || 'header'}`} onClick={() => setHeaders(headers.filter((_, j) => j !== i))}><I.X /></button>
            </div>
          ))}
          <div className="row-btns left">
            <button type="button" onClick={() => setHeaders([...headers, { name: '', value: '' }])}>Add header</button>
            {!hasAccess && (
              <button type="button" onClick={() => setHeaders([...headers, { name: 'CF-Access-Client-Id', value: '' }, { name: 'CF-Access-Client-Secret', value: '' }])}>Add Cloudflare Access headers</button>
            )}
          </div>
          {headerError && <p className="error">{headerError}</p>}

          <div className="row-btns">
            <button type="submit" className="pri" disabled={!urlOk || !!headerError}>Save and sync</button>
            <button type="button" onClick={() => void syncNow()} disabled={!getSettings().url}>Sync now</button>
            <button type="button" onClick={() => void runCheck()} disabled={!getSettings().url || checking}>{checking ? 'Checking…' : 'Check connection'}</button>
          </div>
        </form>
        {diag && (
          <div className={`diag ${diag.ok ? 'ok' : 'bad'}`} role="status">
            {diag.lines.map((l, i) => <p key={i}>{l}</p>)}
          </div>
        )}
        <p className={`sync-line ${sync.state}`}><span className={`sync-dot ${sync.state}`} />{sync.message}{sync.lastSync ? ` · last synced ${new Date(sync.lastSync).toLocaleString()}` : ''}</p>
        <p className={`sync-line live-${sync.live}`}>
          <span className={`sync-dot ${sync.live === 'live' ? 'idle' : sync.live === 'retrying' ? 'error' : sync.live === 'connecting' ? 'syncing' : 'off'}`} />
          {LIVE_LABEL[sync.live]}{sync.liveDetail ? ` · ${sync.liveDetail}` : ''}
        </p>
        {widgetSharingEnabled && <WidgetShareLine />}
        <p className="muted small">Nextly <code>{__APP_VERSION__}</code> · This device: <code>{deviceId}</code></p>
      </section>

      <section className="panel">
        <h2>Areas and projects</h2>
        <p className="muted">Areas group projects in the sidebar, like Classroom or Tech committee.</p>
        {v.areas.map((a) => (
          <div key={a.id} className="org">
            <div className="org-row">
              <input id={`area-${a.id}`} value={a.title} onChange={(e) => updateArea(a.id, { title: e.target.value })} aria-label="Area name" />
              <button className="icon-btn" aria-label={`Delete area ${a.title}`} onClick={() => deleteArea(a.id)}><I.X /></button>
            </div>
          </div>
        ))}
        <form className="org-row" onSubmit={(e) => { e.preventDefault(); if (area.trim()) createArea(area.trim()); setArea(''); }}>
          <input id="new-area" value={area} placeholder="New area" onChange={(e) => setArea(e.target.value)} />
          <button type="submit">Add area</button>
        </form>

        {v.projects.length > 0 && <div className="lbl" style={{ marginTop: 16 }}>Projects</div>}
        {v.projects.map((p) => (
          <div key={p.id} className="org-row">
            <input id={`proj-${p.id}`} value={p.title} onChange={(e) => updateProject(p.id, { title: e.target.value })} aria-label="Project name" />
            <select id={`proj-area-${p.id}`} value={p.areaId ?? ''} onChange={(e) => updateProject(p.id, { areaId: e.target.value || null })} aria-label="Area">
              <option value="">No area</option>
              {v.areas.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
            </select>
            <button className="icon-btn" aria-label={`Delete project ${p.title}`} title="Delete project (its tasks move to Inbox)" onClick={() => deleteProject(p.id)}><I.X /></button>
          </div>
        ))}
      </section>

      <section className="panel">
        <h2>Keyboard</h2>
        <dl className="keys">
          <dt>{mod}N</dt><dd>New task</dd>
          <dt>{mod}K</dt><dd>Search</dd>
          <dt>{mod}D</dt><dd>Mark selected task In Progress</dd>
          <dt>{mod}T</dt><dd>Flag selected task Today</dd>
          <dt>{mod}Shift+T</dt><dd>Flag selected task Next</dd>
          <dt>{mod}Enter</dt><dd>Complete selected task</dd>
          <dt>Delete</dt><dd>Delete selected task (with Undo)</dd>
          <dt>Esc</dt><dd>Close details</dd>
          <dt>{mod},</dt><dd>Settings</dd>
        </dl>
        <p className="muted small">In quick add, <code>!t</code> <code>!p</code> <code>!n</code> <code>!s</code> <code>!i</code> set Today, In Progress, Next, Someday or Inbox. <code>@mon</code> holds a task in Scheduled until that day, <code>^fri</code> sets a deadline, and <code>*daily</code>, <code>*weekdays</code>, <code>*weekly</code>, <code>*monthly</code> or <code>*3d</code> / <code>*2w</code> make it repeat. A pasted Gmail link becomes an email card.</p>
      </section>

      <section className="panel">
        <h2>Privacy</h2>
        <p className="muted">Notes and attachments sync to your own server, not a district system. Keep student records such as grades, IEP or 504 details out of Nextly. Directory information, like a name on a conference list, is the most you should store.</p>
      </section>
    </div>
  );
}
