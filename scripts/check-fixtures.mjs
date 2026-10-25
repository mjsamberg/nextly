#!/usr/bin/env node
// The parity gate (spec/protocol.md): every shared case in spec/fixtures must
// be run by every app's tests. Each suite lists the fixture files it runs in
// a manifest; this fails when a file is missing from one, when a manifest
// names a file that doesn't exist, or when a fixture is malformed.
//
// Both apps run every file: the Swift apps (apple/NextlyKit) and the
// Windows app (windows/Nextly.Core).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'spec/fixtures');
const suites = [
  { name: 'Swift (NextlyKit)', manifest: 'apple/NextlyKit/Tests/fixtures.manifest.json', required: true },
  { name: 'C# (Nextly.Core)', manifest: 'windows/Nextly.Core.Tests/fixtures.manifest.json', required: true },
];

const problems = [];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

for (const file of files) {
  let f;
  try { f = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch (e) { problems.push(`${file}: not valid JSON (${e.message})`); continue; }
  for (const key of ['about', 'now', 'today']) if (typeof f[key] !== 'string') problems.push(`${file}: needs "${key}"`);
  if (!Array.isArray(f.cases) || !f.cases.length) { problems.push(`${file}: needs a non-empty "cases" list`); continue; }
  const ids = new Set();
  for (const [i, c] of f.cases.entries()) {
    if (typeof c.id !== 'string' || !c.id) problems.push(`${file}: case ${i} needs an "id"`);
    else if (ids.has(c.id)) problems.push(`${file}: the id "${c.id}" is used twice`);
    else ids.add(c.id);
  }
}

for (const s of suites) {
  const p = path.join(root, s.manifest);
  if (!fs.existsSync(p)) {
    if (s.required) problems.push(`${s.name}: ${s.manifest} is missing`);
    else console.log(`${s.name}: not built yet, skipped.`);
    continue;
  }
  const listed = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const file of files) if (!listed.includes(file)) problems.push(`${s.name} doesn't run spec/fixtures/${file} (add it to ${s.manifest} and its test runner)`);
  for (const file of listed) if (!files.includes(file)) problems.push(`${s.name} lists ${file}, which isn't in spec/fixtures`);
}

if (problems.length) {
  console.error(`Fixture gate failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Fixture gate passed: ${files.length} fixture files, run by every app that exists.`);
