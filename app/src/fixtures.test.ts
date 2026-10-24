// Runs the shared cases in spec/fixtures, which the Swift apps' tests
// (apple/NextlyKit) run too. A rule change goes in the fixtures first; both
// apps must then pass them (spec/protocol.md, "Shared test cases").
//
// Every fixture file has "now" (an instant, for timestamps and new orders)
// and "today" (the local date, for date words and start dates).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { blockedByAccess, checkHeaders, daysBetween, defer, headerObject, nextOccurrence, nextStart, normRepeat, normTask, orderBetween, parseCaptureLink, parseDateWord, parseQuickAdd, parseRepeatWord, promote, repeatLabel } from './logic.ts';
import { counts, tasksFor } from './lists.ts';
import * as rules from './rules.ts';
import { buildView, Draft } from './rules.ts';
import type { Rec, View } from './types.ts';

const dir = new URL('../../spec/fixtures/', import.meta.url);
const manifest: string[] = JSON.parse(fs.readFileSync(new URL('./fixtures.manifest.json', import.meta.url), 'utf8'));

interface Fixture { about: string; now: string; today: string; cases: ({ id: string } & Record<string, any>)[] }

/** The local date `today` at 9 a.m., for the date functions. */
const localDay = (today: string) => { const [y, m, d] = today.split('-').map(Number); return new Date(y, m - 1, d, 9, 0); };

/** Records as fixtures write them: hlc and deleted are optional. */
const recs = (rows: any[]): Map<string, Rec> => new Map(rows.map((r) => [r.id, { hlc: '', deleted: false, ...r }]));

/** A fresh draft whose new ids are n1, n2, ... */
function draft(f: Fixture, rows: any[]) {
  let n = 0;
  return new Draft(recs(rows), { now: new Date(f.now), today: f.today, newId: () => `n${++n}` });
}

const ACTIONS: Record<string, (d: Draft, a: any) => unknown> = {
  createTask: (d, a) => rules.createTask(d, a.task),
  updateTask: (d, a) => rules.updateTask(d, a.id, a.patch),
  setFlag: (d, a) => rules.setFlag(d, a.id, a.flag),
  toggleDone: (d, a) => rules.toggleDone(d, a.id),
  resolveWithNotes: (d, a) => rules.resolveWithNotes(d, a.id, a.notes),
  queueIiq: (d, a) => rules.queueIiq(d, a.id, a.iiq, a.text),
  setStartOn: (d, a) => rules.setStartOn(d, a.id, a.startOn),
  promoteDue: (d) => rules.promoteDue(d),
  deleteTask: (d, a) => rules.deleteTask(d, a.id),
  addDependency: (d, a) => rules.addDependency(d, a.id, a.dependsOn),
  removeDependency: (d, a) => rules.removeDependency(d, a.id, a.dependsOn),
  moveInNext: (d, a) => rules.moveInNext(d, a.id, a.before),
  createProject: (d, a) => rules.createProject(d, a.title, a.areaId),
  updateProject: (d, a) => rules.updateProject(d, a.id, a.patch),
  deleteProject: (d, a) => rules.deleteProject(d, a.id),
  createArea: (d, a) => rules.createArea(d, a.title),
  updateArea: (d, a) => rules.updateArea(d, a.id, a.patch),
  deleteArea: (d, a) => rules.deleteArea(d, a.id),
};

/** Runs an action and returns { result, changed } in the fixtures' shape. JSON drops undefined fields. */
function act(f: Fixture, c: any) {
  const d = draft(f, c.records);
  const run = ACTIONS[c.action.type];
  assert.ok(run, `unknown action ${c.action.type}`);
  const result = run(d, c.action) ?? null;
  const changed = Object.fromEntries([...d.changes.values()].map((ch) => [ch.id, { kind: ch.kind, deleted: ch.deleted, data: ch.data }]));
  return JSON.parse(JSON.stringify({ result, changed }));
}

const RUNNERS: Record<string, (f: Fixture, c: any) => void> = {
  'quick-add.json': (f, c) => assert.deepEqual(parseQuickAdd(c.input, localDay(f.today)), c.expect),
  'date-words.json': (f, c) => assert.equal(parseDateWord(c.word, localDay(f.today)), c.expect),
  'repeats.json': (f, c) => {
    const got = {
      nextOccurrence: () => nextOccurrence(normRepeat(c.repeat)!, c.after),
      nextStart: () => nextStart(normRepeat(c.repeat)!, c.task, f.today),
      daysBetween: () => daysBetween(c.a, c.b),
      label: () => repeatLabel(normRepeat(c.repeat)!),
      normRepeat: () => normRepeat(c.input),
      parseRepeatWord: () => parseRepeatWord(c.word),
    }[c.fn as string];
    assert.ok(got, `unknown fn ${c.fn}`);
    assert.deepEqual(got(), c.expect);
  },
  'capture-links.json': (_f, c) => assert.deepEqual(parseCaptureLink(c.link), c.expect),
  'network.json': (_f, c) => {
    if (c.fn === 'checkHeaders') {
      const err = checkHeaders(c.rows);
      if (c.expect === null) assert.equal(err, null);
      else assert.ok(err?.includes(c.expect), `${err} should contain ${c.expect}`);
    } else if (c.fn === 'headerObject') assert.deepEqual(headerObject(c.rows), c.expect);
    else if (c.fn === 'blockedByAccess') assert.equal(blockedByAccess(c.status, c.contentType, c.url), c.expect);
    else assert.fail(`unknown fn ${c.fn}`);
  },
  'flags.json': (f, c) => {
    if (c.fn === 'promote') assert.equal(promote(c.flag), c.expect);
    else if (c.fn === 'defer') assert.equal(defer(c.flag), c.expect);
    else if (c.fn === 'orderBetween') assert.equal(orderBetween(c.before ?? undefined, c.after ?? undefined, Date.parse(f.now)), c.expect);
    else assert.fail(`unknown fn ${c.fn}`);
  },
  'normalize.json': (_f, c) => assert.deepEqual(JSON.parse(JSON.stringify(normTask(c.input))), c.expect),
  'lists.json': (_f, c) => {
    const v = buildView(recs(c.records).values());
    for (const [view, ids] of Object.entries(c.views as Record<string, string[]>)) {
      assert.deepEqual(tasksFor(v, view as View, c.query ?? '').map((t) => t.id), ids, view);
    }
    if (c.counts) assert.deepEqual(counts(v), c.counts);
  },
  'actions.json': (f, c) => assert.deepEqual(act(f, c), c.expect),
  'roundtrip.json': (f, c) => assert.deepEqual(act(f, c), c.expect),
};

for (const file of manifest) {
  const f: Fixture = JSON.parse(fs.readFileSync(new URL(file, dir), 'utf8'));
  const runner = RUNNERS[file];
  test(`${file} has a runner`, () => assert.ok(runner, `no runner for ${file}`));
  if (!runner) continue;
  for (const c of f.cases) test(`${file}: ${c.id}`, () => runner(f, c));
}
