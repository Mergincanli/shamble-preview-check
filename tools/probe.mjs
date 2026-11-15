#!/usr/bin/env node
// PM-0006-6 (PREV-DELETE) and PM-0006-8 (the login wall): fetches every link of every upload ever recorded, the way a
// stranger would, and sorts each answer:
//   serves     HTTP 200 with that build's marker (on a branch link: the marker of any upload of that branch)
//   gone       a 404, or any answer without that marker (the tombstone page has no marker)
//   wall       a redirect to Cloudflare Access
//   no-reading a transport error, a 5xx, or the 1010 block after every retry: never judged
//   node tools/probe.mjs --records <folder> --pulls <pulls.ndjson> --purpose <deletion|wall> --out <file.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { USER_AGENT, fetchWithRetry, hasMarker, isWall, linksOf, readRecords } from './lib.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!args.records || !args.pulls || !args.out || !['deletion', 'wall'].includes(args.purpose)) {
  console.error('probe: --records <folder> --pulls <file> --purpose <deletion|wall> --out <file> are needed');
  process.exit(2);
}

const CASES = { 'cs/pd-one': '(a)', 'cs/pd-three': '(b)', 'cs/pd-open': '(c) control', 'cs/pd-off': '(d) bite',
  'cs/pdt-one': "(a') tombstone", 'cs/pdt-three': "(b') tombstone", setup: 'rehearsal' };

const pulls = new Map();
for (const line of readFileSync(args.pulls, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const p = JSON.parse(line);
  const seen = pulls.get(p.head);
  if (!seen || p.number > seen.number) pulls.set(p.head, p); // the newest pull request of each branch
}

const now = Date.now();
const records = readRecords(args.records);
const markersOfBranch = new Map();
for (const r of records) {
  if (!markersOfBranch.has(r.branch)) markersOfBranch.set(r.branch, new Set());
  if (r.marker) markersOfBranch.get(r.branch).add(r.marker);
}

function outcome(answer, markers) {
  if (answer.noReading) return 'no-reading';
  if (isWall(answer)) return 'wall';
  if (answer.status === 200 && [...markers].some((m) => hasMarker(answer.body, m))) return 'serves';
  return 'gone';
}

const rows = [];
const seenUrls = new Set();
for (const r of records) {
  const pr = pulls.get(r.branch);
  for (const link of linksOf(r)) {
    if (seenUrls.has(link.base)) continue; // a branch link is shared by every upload of its branch: probe it once
    seenUrls.add(link.base);
    const markers = link.form === 'stable' ? markersOfBranch.get(r.branch) || new Set() : new Set(r.marker ? [r.marker] : []);
    const answer = await fetchWithRetry(link.base);
    const closedAt = pr && pr.closed_at ? Date.parse(pr.closed_at) : null;
    rows.push({
      branch: r.branch,
      case: CASES[r.branch] || (r.environment === 'production' ? 'production' : 'by-hand preview'),
      pr: pr ? { number: pr.number, state: pr.state, closed_at: pr.closed_at, merged_at: pr.merged_at } : null,
      hours_since_close: closedAt ? Math.round(((now - closedAt) / 36e5) * 100) / 100 : null,
      form: link.form,
      url: link.base,
      deployment_id: r.deployment_id,
      mode: r.mode,
      status: answer.status,
      ...(answer.location ? { location: answer.location } : {}),
      ...(answer.error ? { error: answer.error } : {}),
      outcome: outcome(answer, markers),
    });
  }
}

// What each purpose expects, written beside each row (the results log makes the verdicts, from these rows).
// The wall: production's own address must serve; every other link must give a stranger no build (the wall, or gone);
// production's one-off links are recorded with no expectation (the mark names "the production URL" only).
for (const row of rows) {
  if (args.purpose === 'wall') {
    if (row.case === 'production') row.expected = row.form === 'stable' ? 'serves' : null;
    else row.expected = 'no build';
  } else if (row.pr && row.pr.state === 'closed') row.expected = row.case === '(d) bite' ? 'serves' : 'gone';
  else if (row.pr) row.expected = 'serves';
  else row.expected = null; // a by-hand preview or production: no deletion expectation
  // "Gone" and "no build" both accept the wall: PM-0006-6 counts "the access wall" as gone.
  if (row.expected === null || row.outcome === 'no-reading') row.as_expected = null;
  else if (row.expected === 'no build' || row.expected === 'gone') row.as_expected = row.outcome === 'wall' || row.outcome === 'gone';
  else row.as_expected = row.outcome === row.expected;
}

const out = { probed_at: new Date(now).toISOString(), purpose: args.purpose, user_agent: USER_AGENT, rows };
writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
for (const row of rows) {
  const since = row.hours_since_close === null ? '' : ` ${row.hours_since_close} h after close`;
  console.log(`${row.outcome.padEnd(10)} ${String(row.status).padEnd(4)} ${row.case.padEnd(16)} ${row.form.padEnd(8)} ${row.url}${since}${row.expected ? ` (expected ${row.expected})` : ''}`);
}
console.log(`probed ${rows.length} links for ${args.purpose}; unexpected: ${rows.filter((r) => r.as_expected === false).length}; no reading: ${rows.filter((r) => r.outcome === 'no-reading').length}`);
