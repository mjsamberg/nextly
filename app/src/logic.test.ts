import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedByAccess, checkHeaders, daysBetween, defer, headerObject, nextOccurrence, nextStart, normRepeat, normTask, openBlockers, orderBetween, parseCaptureLink, parseDateWord, parseQuickAdd, parseRepeatWord, promote, repeatLabel, wouldCycle } from './logic.ts';
import type { TaskItem } from './types.ts';

// Tuesday, Oct 20 2026
const NOW = new Date(2026, 9, 20, 9, 0);

test('quick add pulls out flag, deadline and Gmail link', () => {
  const q = parseQuickAdd('Reply to Ortiz !t ^fri https://mail.google.com/mail/u/0/#all/18f2', NOW);
  assert.deepEqual(q, {
    title: 'Reply to Ortiz',
    flag: 'today',
    deadline: '2026-10-23',
    emailUrl: 'https://mail.google.com/mail/u/0/#all/18f2',
  });
});

test('quick add leaves unknown tokens in the title', () => {
  assert.equal(parseQuickAdd('Fix ^nonsense and !wow', NOW).title, 'Fix ^nonsense and !wow');
});

test('date words', () => {
  assert.equal(parseDateWord('today', NOW), '2026-10-20');
  assert.equal(parseDateWord('tom', NOW), '2026-10-21');
  assert.equal(parseDateWord('tue', NOW), '2026-10-20');
  assert.equal(parseDateWord('mon', NOW), '2026-10-26');
  assert.equal(parseDateWord('10/1', NOW), '2027-10-01');
  assert.equal(parseDateWord('2026-12-01', NOW), '2026-12-01');
  assert.equal(parseDateWord('soon', NOW), null);
});

const task = (id: string, over: Partial<TaskItem> = {}): TaskItem => ({ id, ...normTask({ title: id }), ...over });

test('blocked only by open, existing tasks', () => {
  const tasks = new Map([
    ['a', task('a', { dependsOn: ['b', 'c', 'gone'] })],
    ['b', task('b', { done: true })],
    ['c', task('c')],
  ]);
  assert.deepEqual(openBlockers(tasks.get('a')!, (id) => tasks.get(id)).map((t) => t.id), ['c']);
});

test('dependency loops are refused', () => {
  const tasks = new Map([
    ['a', task('a', { dependsOn: ['b'] })],
    ['b', task('b', { dependsOn: ['c'] })],
    ['c', task('c')],
  ]);
  const get = (id: string) => tasks.get(id);
  assert.equal(wouldCycle('c', 'a', get), true);
  assert.equal(wouldCycle('a', 'a', get), true);
  assert.equal(wouldCycle('a', 'c', get), false);
});

test('defer walks Today -> Next -> Someday', () => {
  assert.equal(defer('today'), 'next');
  assert.equal(defer('next'), 'someday');
  assert.equal(defer('inbox'), 'next');
});

test('order between neighbours', () => {
  assert.equal(orderBetween(10, 20), 15);
  assert.equal(orderBetween(undefined, 20), -980);
  assert.equal(orderBetween(10, undefined), 1010);
});

test('normTask accepts capture-page records with links', () => {
  const t = normTask({ title: 'x', list: 'inbox', notes: [{ type: 'text', text: 'hi' }], links: [{ url: 'u', subject: 's' }] });
  assert.equal(t.flag, 'inbox');
  assert.equal(t.notes[0].type, 'paragraph');
  assert.equal(t.notes[1].type, 'email');
});

test('extra headers for Cloudflare Access', () => {
  const rows = [
    { name: 'CF-Access-Client-Id', value: ' abc.access ' },
    { name: 'CF-Access-Client-Secret', value: 'xyz' },
    { name: '', value: '' },
  ];
  assert.equal(checkHeaders(rows), null);
  assert.deepEqual(headerObject(rows), { 'CF-Access-Client-Id': 'abc.access', 'CF-Access-Client-Secret': 'xyz' });
  assert.match(checkHeaders([{ name: 'Authorization', value: 'x' }])!, /sets Authorization itself/);
  assert.match(checkHeaders([{ name: 'bad name', value: 'x' }])!, /valid header name/);
  assert.match(checkHeaders([{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }])!, /twice/);
  assert.match(checkHeaders([{ name: 'X-A', value: 'a\nb' }])!, /line breaks/);
});

test('detects Cloudflare Access blocking a request', () => {
  assert.equal(blockedByAccess(200, 'text/html', 'https://team.cloudflareaccess.com/cdn-cgi/access/login'), true);
  assert.equal(blockedByAccess(403, 'text/html', 'https://nextly.example.com/sync'), true);
  assert.equal(blockedByAccess(200, 'application/json', 'https://nextly.example.com/sync'), false);
  assert.equal(blockedByAccess(401, 'application/json', 'https://nextly.example.com/sync'), false);
});

test('nextly:// capture links from the bookmarklet', () => {
  const gmail = 'https://mail.google.com/mail/u/0/#all/18f2a';
  const c = parseCaptureLink(`nextly://add?title=${encodeURIComponent('Re: Conference times')}&url=${encodeURIComponent(gmail)}`);
  assert.deepEqual(c, { title: 'Re: Conference times', flag: 'inbox', emailUrl: gmail, otherUrl: null, note: '' });
  // Forms Windows and browsers use.
  assert.equal(parseCaptureLink('nextly://add/?title=x')?.title, 'x');
  assert.equal(parseCaptureLink('nextly:add?title=x')?.title, 'x');
  assert.equal(parseCaptureLink('nextly://add?title=x&list=next')?.flag, 'next');
  assert.equal(parseCaptureLink('nextly://add?title=x&list=delete-everything')?.flag, 'inbox');
  // An email link with no subject still makes a task.
  assert.equal(parseCaptureLink(`nextly://add?url=${encodeURIComponent(gmail)}`)?.title, 'Email');
  // Non-email links are kept, but not as email cards; other schemes are dropped.
  assert.equal(parseCaptureLink('nextly://add?title=x&url=https%3A%2F%2Fexample.com')?.otherUrl, 'https://example.com');
  assert.equal(parseCaptureLink('nextly://add?title=x&url=javascript%3Aalert(1)')?.otherUrl, null);
  // Anything that isn't an add link is ignored.
  assert.equal(parseCaptureLink('nextly://delete?id=1'), null);
  assert.equal(parseCaptureLink('https://add?title=x'), null);
  assert.equal(parseCaptureLink('nextly://add'), null);
  assert.equal(parseCaptureLink('nextly://add?title=' + 'a'.repeat(900))?.title.length, 500);
});

test('In Progress in quick add and swipes', () => {
  assert.equal(parseQuickAdd('Write report !p', NOW).flag, 'doing');
  assert.equal(promote('next'), 'today');
  assert.equal(promote('today'), 'doing');
  assert.equal(defer('doing'), 'today');
});

test('quick add start dates and repeats', () => {
  const q = parseQuickAdd('Water plants @mon *weekly', NOW);
  assert.equal(q.title, 'Water plants');
  assert.equal(q.startOn, '2026-10-26');
  assert.deepEqual(q.repeat, { every: 1, unit: 'week', from: 'schedule' });
  assert.deepEqual(parseRepeatWord('3d'), { every: 3, unit: 'day', from: 'schedule' });
  assert.deepEqual(parseRepeatWord('weekdays'), { every: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5], from: 'schedule' });
  assert.equal(parseRepeatWord('0d'), null);
  assert.equal(parseQuickAdd('Email *nonsense', NOW).title, 'Email *nonsense');
});

test('next occurrence', () => {
  const r = (x: object) => normRepeat({ every: 1, from: 'schedule', ...x })!;
  assert.equal(nextOccurrence(r({ unit: 'day' }), '2026-10-20'), '2026-10-21');
  assert.equal(nextOccurrence(r({ unit: 'week', every: 2 }), '2026-10-20'), '2026-11-03');
  // Month end clamps: Jan 31 -> Feb 28 (2027 isn't a leap year), Mar 31 -> Apr 30.
  assert.equal(nextOccurrence(r({ unit: 'month' }), '2027-01-31'), '2027-02-28');
  assert.equal(nextOccurrence(r({ unit: 'month' }), '2026-03-31'), '2026-04-30');
  assert.equal(nextOccurrence(r({ unit: 'year' }), '2028-02-29'), '2029-02-28');
  // Weekdays: Fri Oct 23 -> Mon Oct 26; Tue -> Wed.
  const wk = r({ unit: 'week', weekdays: [1, 2, 3, 4, 5] });
  assert.equal(nextOccurrence(wk, '2026-10-23'), '2026-10-26');
  assert.equal(nextOccurrence(wk, '2026-10-20'), '2026-10-21');
  // Mon/Thu every 2 weeks: Mon -> Thu same week; Thu -> Mon two weeks later.
  const mt = r({ unit: 'week', every: 2, weekdays: [1, 4] });
  assert.equal(nextOccurrence(mt, '2026-10-19'), '2026-10-22');
  assert.equal(nextOccurrence(mt, '2026-10-22'), '2026-11-02');
});

test('next start: from schedule skips missed dates; from completion counts from today', () => {
  const today = '2026-10-20';
  const weekly = normRepeat({ every: 1, unit: 'week', from: 'schedule' })!;
  // Was due Oct 5, finished late on Oct 20: next is the first Monday-cadence date after today.
  assert.equal(nextStart(weekly, { startOn: '2026-10-05', deadline: null }, today), '2026-10-26');
  assert.equal(nextStart(weekly, { startOn: null, deadline: '2026-10-19' }, today), '2026-10-26');
  const after = normRepeat({ every: 3, unit: 'day', from: 'completion' })!;
  assert.equal(nextStart(after, { startOn: '2026-10-01', deadline: null }, today), '2026-10-23');
  assert.equal(daysBetween('2026-10-20', '2026-10-26'), 6);
});

test('repeat labels and cleanup', () => {
  assert.equal(repeatLabel(normRepeat({ every: 1, unit: 'day' })!), 'Every day');
  assert.equal(repeatLabel(normRepeat({ every: 2, unit: 'week' })!), 'Every 2 weeks');
  assert.equal(repeatLabel(normRepeat({ every: 1, unit: 'week', weekdays: [5, 1, 2, 3, 4] })!), 'Every weekday');
  assert.equal(repeatLabel(normRepeat({ every: 1, unit: 'week', weekdays: [1, 4] })!), 'Every Mon, Thu');
  assert.equal(normRepeat({ unit: 'fortnight' }), null);
  assert.equal(normRepeat({ every: 9999, unit: 'day' })!.every, 365);
  assert.equal(normTask({ title: 'x', flag: 'doing' }).flag, 'doing');
});
