// Hybrid logical clock: "<ms, 15 digits>-<counter, 4 digits>-<deviceId>".
// Sorts correctly as plain text, keeps moving forward even if this device's
// clock is behind another's, and breaks exact ties by device id.

let last = 0;
let counter = 0;
let device = 'unknown';

export function setDevice(id: string) {
  device = id;
}

const fmt = (ms: number, c: number) => `${String(ms).padStart(15, '0')}-${String(c).padStart(4, '0')}-${device}`;

export function now(): string {
  const t = Date.now();
  if (t > last) { last = t; counter = 0; } else counter++;
  return fmt(last, counter);
}

/** Move the clock past a timestamp seen from another device. */
export function observe(h: string) {
  const [ms, c] = h.split('-').map(Number);
  if (!Number.isFinite(ms)) return;
  if (ms > last) { last = ms; counter = c || 0; }
  else if (ms === last && c > counter) counter = c;
}
