import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defer, normTask, openBlockers, orderBetween, parseDateWord, parseQuickAdd, wouldCycle } from './logic.ts';
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
