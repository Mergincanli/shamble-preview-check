#!/usr/bin/env node
// Turns a run's event into the list of deploys ("legs") the deploy workflow makes, printed as one line of JSON.
//   node tools/sets.mjs --event <pull_request|workflow_dispatch> --set <name> --branch <head branch>
// A pull request: one preview of its own branch. Started by hand: one named set from tools/sets.json.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) { console.error(`sets: ${message}`); process.exit(2); }

const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (!['--event', '--set', '--branch'].includes(argv[i])) fail(`unknown option: ${argv[i]}`);
  opts[argv[i].slice(2)] = argv[i + 1] ?? '';
}

let legs;
if (opts.event === 'pull_request') {
  const branch = opts.branch || '';
  if (!branch || /[\s\u0000-\u001f]/.test(branch)) fail('a pull request needs its head branch name');
  legs = [{ leg: 'pr', mode: 'preview', branch, expect: 'preview', count: 1 }];
} else if (opts.event === 'workflow_dispatch') {
  const sets = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sets.json'), 'utf8'));
  if (!Object.hasOwn(sets, opts.set)) fail(`no set named ${JSON.stringify(opts.set)}; sets: ${Object.keys(sets).join(', ')}`);
  legs = sets[opts.set];
} else {
  fail(`unknown event ${JSON.stringify(opts.event)}`);
}
process.stdout.write(JSON.stringify(legs));
