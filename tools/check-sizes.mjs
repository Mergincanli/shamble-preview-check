#!/usr/bin/env node
// PM-0006-5: every built file's size, the largest, and a flag on any file of 25 MiB or more. It never fails the build,
// so a planted big file still reaches Wrangler, whose answer is then recorded.
//   node tools/check-sizes.mjs <folder>
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const LIMIT = 25 * 1024 * 1024; // 26,214,400 bytes, Pages' per-file limit
const root = process.argv[2];
if (!root) { console.error('check-sizes: name the built folder'); process.exit(2); }

const files = [];
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else files.push({ path: relative(root, p), size: s.size });
  }
};
walk(root);
files.sort((a, b) => b.size - a.size);
const flagged = files.filter((f) => f.size >= LIMIT);
for (const f of files) console.log(`${String(f.size).padStart(12)}  ${f.path}${f.size >= LIMIT ? '  FLAGGED (25 MiB or more)' : ''}`);
const largest = files[0] || { path: '(none)', size: 0 };
console.log(`largest: ${largest.path}, ${largest.size} bytes; limit ${LIMIT} bytes; flagged: ${flagged.length}`);
console.log(`SIZES ${JSON.stringify({ largest, limit: LIMIT, flagged, count: files.length })}`);
