// Repeat and start-date rules for tasks changed on the server (widget, Siri).
// Mirrors nextOccurrence/nextStart in app/src/logic.ts; keep the two in step.
// Dates are local YYYY-MM-DD strings.

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const VALID = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "Today" for the person using Nextly. The widget and Siri send their device's
 * date; otherwise use NEXTLY_TZ (the container itself runs on UTC).
 */
export function localToday(fromClient) {
  if (typeof fromClient === 'string' && VALID.test(fromClient)) return fromClient;
  const tz = process.env.NEXTLY_TZ || 'America/New_York';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return ymd(new Date());
  }
}

export function shiftDate(s, n) {
  const d = parse(s);
  return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

function addMonths(s, n) {
  const d = parse(s);
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return ymd(new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last)));
}

export function nextOccurrence(r, after) {
  if (r.unit === 'week' && r.weekdays?.length) {
    let d = after;
    for (let i = 1; i <= 7; i++) {
      d = shiftDate(after, i);
      if (r.weekdays.includes(parse(d).getDay())) break;
    }
    if (r.every > 1 && parse(d).getDay() <= parse(after).getDay()) d = shiftDate(d, 7 * (r.every - 1));
    return d;
  }
  if (r.unit === 'day') return shiftDate(after, r.every);
  if (r.unit === 'week') return shiftDate(after, 7 * r.every);
  if (r.unit === 'month') return addMonths(after, r.every);
  return addMonths(after, 12 * r.every);
}

export function nextStart(r, t, today) {
  const base = r.from === 'completion' ? today : (t.startOn ?? t.deadline ?? today);
  let next = nextOccurrence(r, base);
  for (let i = 0; next <= today && i < 1000; i++) next = nextOccurrence(r, next);
  return next;
}

export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);

export function validRepeat(r) {
  return !!r && ['day', 'week', 'month', 'year'].includes(r.unit) && Number(r.every) >= 1;
}
