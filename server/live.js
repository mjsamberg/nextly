// Live updates: a tiny dependency-free WebSocket server (RFC 6455, text only).
//
// Devices connect to /events and never need to send anything. When a sync
// stores new changes, every other device gets {"type":"changed"} and syncs
// right away. A heartbeat every 25 s keeps Cloudflare and other proxies from
// closing an idle connection (Cloudflare closes after about 100 s) and lets
// clients notice a dead connection.
//
// Auth: the same bearer token as /sync (the apps send it as a header), or a
// one-minute ticket from POST /events/ticket for browsers, which can't set
// headers on a WebSocket.

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 64 * 1024;
const clients = new Set();

export function createLive({ token, authorized, lastSeq }) {
  const ticketSig = (exp) => crypto.createHmac('sha256', token).update(`ws|${exp}`).digest('hex');

  function ticket() {
    const exp = Date.now() + 60_000;
    return `${exp}.${ticketSig(exp)}`;
  }

  function validTicket(t) {
    const [exp, sig] = String(t || '').split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(ticketSig(exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function frame(opcode, payload = Buffer.alloc(0)) {
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([head, payload]);
  }

  const text = (msg) => frame(0x1, Buffer.from(JSON.stringify(msg)));

  function reject(socket, status) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  /** Handles the HTTP upgrade for /events. Returns false for other paths. */
  function upgrade(req, socket) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/events') return false;
    if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || !req.headers['sec-websocket-key']) {
      reject(socket, '400 Bad Request');
      return true;
    }
    if (!authorized(req) && !validTicket(url.searchParams.get('ticket'))) {
      reject(socket, '401 Unauthorized');
      return true;
    }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'));
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);

    const client = { socket, device: url.searchParams.get('device') || '' };
    clients.add(client);
    const drop = () => clients.delete(client);
    socket.on('close', drop);
    socket.on('error', drop);
    // A proxy may only half-close the connection when the device goes away.
    socket.on('end', () => { drop(); socket.end(); });

    // Clients only send control frames: answer ping and close, ignore the rest.
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = buf[1] & 0x80;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (len > MAX_FRAME) { socket.destroy(); return; }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
        if (masked) {
          const mask = buf.subarray(off, off + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        buf = buf.subarray(off + maskLen + len);
        if (opcode === 0x8) { socket.end(frame(0x8, payload.subarray(0, 2))); drop(); return; }
        if (opcode === 0x9) socket.write(frame(0xA, payload));
      }
    });

    socket.write(text({ type: 'hello', lastSeq: lastSeq() }));
    return true;
  }

  /** Tells every connected device except the one that made the change. */
  function changed(fromDevice) {
    const data = text({ type: 'changed', lastSeq: lastSeq() });
    for (const c of clients) {
      if (c.device && c.device === fromDevice) continue;
      if (!c.socket.destroyed) c.socket.write(data);
    }
  }

  setInterval(() => {
    const data = text({ type: 'ping' });
    for (const c of clients) if (!c.socket.destroyed) c.socket.write(data);
  }, 25_000).unref();

  return { upgrade, changed, ticket, count: () => clients.size };
}
