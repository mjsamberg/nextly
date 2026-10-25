#!/usr/bin/env node
// Date-based versions (CalVer) for every build.
//
// The version comes from the commit being built, not the clock, so re-running
// a build gives the same number: its date in NEXTLY_TZ (default New York) and
// how many commits were made that day up to and including it.
//
//   shown in Settings          2026.10.22.3   year.month.day.build (also the Windows file version)
//   version (Mac and iPhone)   2026.10.22     CFBundleShortVersionString: three parts
//   build number (Apple)       2026102203     CFBundleVersion; always increasing
//
// In CI it writes NEXTLY_VERSION_LABEL, NEXTLY_VERSION and NEXTLY_BUILD to
// $GITHUB_ENV for the builds that follow (apple/scripts/build-native.sh, the
// windows-native job). Needs the full git history (actions/checkout with
// fetch-depth: 0).
//
//   node scripts/set-version.mjs [--print]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tz = process.env.NEXTLY_TZ || 'America/New_York';

const dayOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const headDate = git('log', '-1', '--format=%cI', 'HEAD');
const day = dayOf(headDate);
// Commits on HEAD's day, up to and including HEAD (its ancestors only).
const sameDay = git('log', '--format=%cI', 'HEAD').split('\n').filter((d) => d && dayOf(d) === day);
const n = sameDay.length;
if (n < 1 || n > 99) throw new Error(`Build ${n} on ${day}: the scheme allows 1–99 builds a day.`);

const [y, m, d] = day.split('-').map(Number);
const two = (x) => String(x).padStart(2, '0');
const v = {
  label: `${y}.${m}.${d}.${n}`,
  version: `${y}.${m}.${d}`,
  build: `${y}${two(m)}${two(d)}${two(n)}`,
};

if (process.argv.includes('--print')) {
  console.log(JSON.stringify(v, null, 2));
  process.exit(0);
}

if (process.env.GITHUB_ENV) {
  fs.appendFileSync(process.env.GITHUB_ENV, `NEXTLY_VERSION_LABEL=${v.label}\nNEXTLY_VERSION=${v.version}\nNEXTLY_BUILD=${v.build}\n`);
}
console.log(`Nextly ${v.label}  (version ${v.version}, build ${v.build})`);
