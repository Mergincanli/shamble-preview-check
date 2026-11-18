#!/usr/bin/env node
// PM-0006-6 (PREV-DELETE) and PM-0006-8 (the login wall): fetches every link of every upload ever recorded, the way a
// stranger would, and sorts each answer:
//   serves     HTTP 200 with that build's marker (on a branch link: the marker of any upload of that branch)
//   gone       a 404, or a 200 without that marker (the tombstone page has no marker)
//   wall       a redirect to Cloudflare Access
//   other      any other status (it counts as gone by PM-0006-6's words, but stays visible for the results log)
//   no-reading a transport error, a 5xx, a 429, a Cloudflare challenge or the 1010 block after every retry: never judged
// Exit 0: every link gave a reading; 3: a link gave no reading, or there was nothing to probe. (A link not as expected
// is no exit code: before an approved cleanup, and with the wall off, such rows are rightly unexpected.)
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
  if (answer.status === 404 || answer.status === 200) return 'gone';
  return 'other';
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
      tries: answer.tries,
      ...(answer.location ? { location: answer.location } : {}),
      ...(answer.error ? { error: answer.error } : {}),
      outcome: outcome(answer, markers),
    });
  }
}

// What each purpose expects, written beside each row (the results log makes the verdicts, from these rows).
// The wall: production's own address must serve; every other link must give a stranger no build (the wall, gone or
// other); production's one-off links are recorded with no expectation (the mark names "the production URL" only).
// Deletion: a closed pull request's links gone (the bite (d) still serving); an open pull request's, a by-hand
// preview's and production's own address serving (with the wall off, that is PM-0006-8's control).
for (const row of rows) {
  const productionOneOff = row.case === 'production' && row.form === 'one-off';
  if (args.purpose === 'wall') row.expected = productionOneOff ? null : row.case === 'production' ? 'serves' : 'no build';
  else if (row.pr && row.pr.state === 'closed') row.expected = row.case === '(d) bite' ? 'serves' : 'gone';
  else row.expected = productionOneOff ? null : 'serves';
  // "Gone" and "no build" accept the wall and "other": PM-0006-6 counts "any other response without the marker, or
  // the access wall" as gone.
  if (row.expected === null || row.outcome === 'no-reading') row.as_expected = null;
  else if (row.expected === 'no build' || row.expected === 'gone') row.as_expected = ['gone', 'wall', 'other'].includes(row.outcome);
  else row.as_expected = row.outcome === row.expected;
}

const out = { probed_at: new Date(now).toISOString(), purpose: args.purpose, user_agent: USER_AGENT, rows };
writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
for (const row of rows) {
  const since = row.hours_since_close === null ? '' : ` ${row.hours_since_close} h after close`;
  console.log(`${row.outcome.padEnd(10)} ${String(row.status).padEnd(4)} ${row.case.padEnd(16)} ${row.form.padEnd(8)} ${row.url}${since}${row.expected ? ` (expected ${row.expected})` : ''}`);
}
const unread = rows.filter((r) => r.outcome === 'no-reading').length;
if (args.purpose === 'wall') {
  const walled = new Set(rows.filter((r) => r.form === 'stable' && r.case !== 'production' && r.outcome === 'wall' && (!r.pr || r.pr.state === 'open')).map((r) => r.branch));
  console.log(`the wall seen on the stable links of ${walled.size} open branches (PM-0006-8 needs at least 2): ${[...walled].join(', ')}`);
}
console.log(`probed ${rows.length} links for ${args.purpose}; unexpected: ${rows.filter((r) => r.as_expected === false).length}; no reading: ${unread}`);
process.exit(unread || !rows.length ? 3 : 0);
