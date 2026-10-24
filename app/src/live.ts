// Live updates from the server's /events WebSocket (server/live.js).
// The server says {"type":"changed"} after another device syncs, and we sync.
//
// In the app the socket is opened from Rust (tauri-plugin-websocket) so it can
// carry the sync token and the Cloudflare Access headers. A plain browser can't
// set headers on a WebSocket, so there we fetch a one-minute ticket first.
//
// The server sends a heartbeat every 25 s; if nothing arrives for 70 s the
// connection is treated as dead and reopened, with backoff up to 30 s.

import TauriWebSocket from '@tauri-apps/plugin-websocket';
import { inTauri } from './net';

export type LiveState = 'off' | 'connecting' | 'live' | 'retrying';

export interface LiveOptions {
  url: (retrying: boolean) => Promise<string>; // server base URL, http(s)://…, asked on each (re)connect
  headers: Record<string, string>;      // includes authorization
  deviceId: string;
  getTicket: () => Promise<string>;     // browser only
  onChanged: () => void;
  onConnected: () => void;
  onState: (s: LiveState, detail?: string) => void;
}

const HEARTBEAT_TIMEOUT = 70_000;

let generation = 0; // bumps on every start/stop so stale callbacks do nothing
let close: (() => void) | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;

export function stopLive() {
  generation++;
  clearTimeout(retryTimer);
  clearTimeout(watchdog);
  close?.();
  close = null;
}

export function startLive(o: LiveOptions) {
  stopLive();
  const gen = generation;
  let attempt = 0;

  const wsUrl = (base: string, extra: string) => {
    const u = new URL(base.replace(/\/+$/, '') + '/events');
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('device', o.deviceId);
    return u.toString() + extra;
  };

  const retry = (why: string) => {
    if (gen !== generation) return;
    clearTimeout(watchdog);
    close?.();
    close = null;
    const delay = Math.min(30_000, 1000 * 2 ** attempt++);
    o.onState('retrying', `${why} Retrying in ${Math.round(delay / 1000)} s.`);
    retryTimer = setTimeout(connect, delay);
  };

  const alive = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => retry('Live updates went quiet.'), HEARTBEAT_TIMEOUT);
  };

  const onText = (raw: string) => {
    if (gen !== generation) return;
    alive();
    let msg: { type?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'hello') {
      attempt = 0;
      o.onState('live');
      o.onConnected(); // catch up on anything missed while disconnected
    } else if (msg.type === 'changed') {
      o.onChanged();
    }
  };

  async function connect() {
    if (gen !== generation) return;
    o.onState(attempt ? 'retrying' : 'connecting');
    try {
      const base = await o.url(attempt > 0);
      if (gen !== generation) return;
      if (inTauri) {
        const ws = await TauriWebSocket.connect(wsUrl(base, ''), { headers: o.headers });
        if (gen !== generation) { void ws.disconnect(); return; }
        const unlisten = ws.addListener((m) => {
          if (m.type === 'Text') onText(m.data);
          else if (m.type === 'Close') retry('The server closed live updates.');
        });
        close = () => { unlisten(); void ws.disconnect().catch(() => {}); };
      } else {
        const ticket = await o.getTicket();
        if (gen !== generation) return;
        const ws = new window.WebSocket(wsUrl(base, `&ticket=${encodeURIComponent(ticket)}`));
        ws.onmessage = (e) => onText(String(e.data));
        ws.onclose = () => retry('Live updates disconnected.');
        close = () => { ws.onclose = null; ws.close(); };
      }
      alive();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      retry(/401/.test(msg) ? 'The server rejected the sync token.' : /403/.test(msg) ? 'Cloudflare Access blocked live updates.' : 'Couldn’t open live updates.');
    }
  }

  void connect();
}
