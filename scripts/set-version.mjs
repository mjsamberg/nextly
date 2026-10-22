#!/usr/bin/env node
// Date-based versions (CalVer), stamped into the app before each build.
//
// The version comes from the commit being built, not the clock, so re-running
// a build gives the same number: its date in NEXTLY_TZ (default New York) and
// how many commits were made that day up to and including it.
//
//   shown in Settings         2026.10.22.3   year.month.day.build
//   version (all platforms)   2026.10.22     must be semver, so three parts
//   iOS/macOS build number    2026102203     CFBundleVersion; always increasing
//   Windows MSI version       26.10.2203     MSI caps parts at 255.255.65535
//
// Writes app/src-tauri/tauri.conf.json, and NEXTLY_VERSION_LABEL to
// $GITHUB_ENV for the frontend build. Needs the full git history
// (actions/checkout with fetch-depth: 0).
//
//   node scripts/set-version.mjs [--print]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const confPath = path.join(root, 'app/src-tauri/tauri.conf.json');
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
  bundleVersion: `${y}${two(m)}${two(d)}${two(n)}`,
  msi: `${y % 100}.${m}.${d * 100 + n}`,
};

if (process.argv.includes('--print')) {
  console.log(JSON.stringify(v, null, 2));
  process.exit(0);
}

const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
conf.version = v.version;
conf.bundle ??= {};
conf.bundle.iOS = { ...conf.bundle.iOS, bundleVersion: v.bundleVersion };
conf.bundle.macOS = { ...conf.bundle.macOS, bundleVersion: v.bundleVersion };
conf.bundle.windows = { ...conf.bundle.windows, wix: { ...conf.bundle.windows?.wix, version: v.msi } };
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');

if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `NEXTLY_VERSION_LABEL=${v.label}\n`);
console.log(`Nextly ${v.label}  (version ${v.version}, build ${v.bundleVersion}, MSI ${v.msi})`);
