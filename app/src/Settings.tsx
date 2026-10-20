import { useState } from 'react';
import * as I from './icons';
import { createArea, deleteArea, deleteProject, deviceId, updateArea, updateProject, useStore } from './store';
import { getSettings, saveSettings, syncNow, useSyncStatus } from './sync';
import { mod } from './net';

export default function Settings({ onBack }: { onBack: () => void }) {
  const v = useStore();
  const sync = useSyncStatus();
  const [url, setUrl] = useState(getSettings().url);
  const [token, setToken] = useState(getSettings().token);
  const [area, setArea] = useState('');
  const urlOk = !url || /^https?:\/\/[^\s/]+/.test(url.trim());

  return (
    <div className="list settings">
      <header className="list-h">
        <button className="back" onClick={onBack} aria-label="Back to lists"><I.Back />Lists</button>
        <h1>Settings</h1>
      </header>

      <section className="panel">
        <h2>Sync</h2>
        <p className="muted">Point every device at the same Nextly server on your tailnet, for example <code>http://homeserver.your-tailnet.ts.net:8080</code>.</p>
        <form className="form" onSubmit={(e) => { e.preventDefault(); if (urlOk) void saveSettings({ url, token }); }}>
          <label htmlFor="sync-url">Server address</label>
          <input id="sync-url" value={url} placeholder="http://machine.tailnet.ts.net:8080" onChange={(e) => setUrl(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          {!urlOk && <p className="error">The address should start with http:// or https://.</p>}
          <label htmlFor="sync-token">Sync token</label>
          <input id="sync-token" type="password" value={token} placeholder="NEXTLY_TOKEN from the server’s .env" onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          <div className="row-btns">
            <button type="submit" className="pri" disabled={!urlOk}>Save and sync</button>
            <button type="button" onClick={() => void syncNow()} disabled={!getSettings().url}>Sync now</button>
          </div>
        </form>
        <p className={`sync-line ${sync.state}`}><span className={`sync-dot ${sync.state}`} />{sync.message}{sync.lastSync ? ` · last synced ${new Date(sync.lastSync).toLocaleString()}` : ''}</p>
        <p className="muted small">This device: <code>{deviceId}</code></p>
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
          <dt>{mod}T</dt><dd>Flag selected task Today</dd>
          <dt>{mod}Shift+T</dt><dd>Flag selected task Next</dd>
          <dt>{mod}Enter</dt><dd>Complete selected task</dd>
          <dt>Delete</dt><dd>Delete selected task (with Undo)</dd>
          <dt>Esc</dt><dd>Close details</dd>
          <dt>{mod},</dt><dd>Settings</dd>
        </dl>
        <p className="muted small">In quick add, <code>!t</code> <code>!n</code> <code>!s</code> <code>!i</code> set the flag and <code>^fri</code>, <code>^tom</code> or <code>^10/23</code> set a deadline. A pasted Gmail link becomes an email card.</p>
      </section>

      <section className="panel">
        <h2>Privacy</h2>
        <p className="muted">Notes and attachments sync to your own server, not a district system. Keep student records such as grades, IEP or 504 details out of Nextly. Directory information, like a name on a conference list, is the most you should store.</p>
      </section>
    </div>
  );
}
