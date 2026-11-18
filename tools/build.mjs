#!/usr/bin/env node
// Builds the test site for one mode into an output folder. Node 22, no dependencies.
//   node tools/build.mjs --mode <mode> --marker <commit> --out <folder>
// It copies site/, writes the build marker into the HTML, writes tiny.wasm from its bytes, writes the content file
// under its own hash, writes manifest.json (every file, its size and hash) and _headers for the mode (the plan's Part 2).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODES = ['production', 'preview', 'preview-isolated', 'bite-coep', 'bite-noindex', 'bite-nocache', 'bite-oversize'];
const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const COPIED = ['index.html', '404.html', 'page.js', 'page.css', 'worker.js'];

// A module that exports add(i32, i32) -> i32 (41 bytes).
const TINY_WASM = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x03, 0x02,
  0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20,
  0x01, 0x6a, 0x0b,
]);
const CONTENT_BYTES = 64 * 1024; // the content-bundle stand-in
const OVERSIZE_BYTES = 26 * 1024 * 1024; // 27,262,976 bytes: one MiB over Pages' 25 MiB limit (PM-0006-5's bite)

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--mode', '--marker', '--out'].includes(key) || value === undefined) fail(`unknown or incomplete option: ${key}`);
    opts[key.slice(2)] = value;
  }
  if (!MODES.includes(opts.mode)) fail(`--mode must be one of ${MODES.join(', ')}`);
  if (!/^[0-9A-Za-z._-]{1,64}$/.test(opts.marker || '')) fail('--marker must be 1 to 64 letters, digits, dots, dashes or underscores');
  const out = normalize(opts.out || '');
  if (!out || isAbsolute(out) || out.split(/[\\/]/).includes('..')) fail('--out must be a folder below the current one');
  return opts;
}

// The _headers file for a mode. Rules apply in file order, all matching rules apply, and a header set twice in the
// file is joined with a comma (Pages' headers page, 2026-11-12), so each header is set once per path, and the one
// detach line (bite-coep) comes after the rule it undoes.
function headersFor(mode) {
  const preview = mode !== 'production' && mode !== 'bite-noindex';
  const isolated = mode === 'preview-isolated' || mode === 'bite-coep';
  const cacheControl = mode === 'bite-nocache' ? 'no-cache' : 'public, max-age=31536000, immutable';
  const everyPath = [];
  if (preview || mode === 'bite-noindex') everyPath.push('X-Robots-Tag: noindex');
  if (isolated) everyPath.push('Cross-Origin-Opener-Policy: same-origin', 'Cross-Origin-Embedder-Policy: require-corp');
  const lines = [
    `# The preview hosting check, mode ${mode}: written by tools/build.mjs`,
    '/content.*',
    `  Cache-Control: ${cacheControl}`,
    '',
    '# Test-only rules for R5-PREV-OQ6: which host rule reaches which link',
    'https://:project.pages.dev/*',
    '  X-Check-Rule: project-host',
    '',
    'https://:version.:project.pages.dev/*',
    '  X-Check-Rule: version-host',
  ];
  if (everyPath.length) lines.push('', '/*', ...everyPath.map((h) => `  ${h}`));
  if (mode === 'bite-coep') lines.push('', '# The bite: COEP taken off the worker only', '/worker.js', '  ! Cross-Origin-Embedder-Policy');
  return `${lines.join('\n')}\n`;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function build({ mode, marker, out }) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const files = new Map();
  const put = (name, bytes) => { writeFileSync(join(out, name), bytes); files.set(name, bytes); };

  for (const name of COPIED) {
    let bytes = readFileSync(join(SITE, name));
    if (name === 'index.html') bytes = Buffer.from(bytes.toString('utf8').replaceAll('__BUILD_MARKER__', marker));
    put(name, bytes);
  }
  put('tiny.wasm', TINY_WASM);
  const content = Buffer.alloc(CONTENT_BYTES);
  for (let i = 0; i < content.length; i += 1) content[i] = (i * 31 + 7) & 0xff;
  const bundle = `content.${sha256(content).slice(0, 8)}.bin`;
  put(bundle, content);
  if (mode === 'bite-oversize') put('oversize.bin', Buffer.alloc(OVERSIZE_BYTES));

  const manifest = {
    marker,
    mode,
    bundle,
    files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256(bytes) })),
    config: ['_headers'],
  };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const headers = headersFor(mode);
  writeFileSync(join(out, '_headers'), headers);

  console.log(`built mode ${mode} with marker ${marker} into ${out}`);
  for (const f of manifest.files) console.log(`  ${f.path}  ${f.size} bytes`);
  console.log('  manifest.json');
  console.log('_headers:');
  process.stdout.write(headers.replace(/^/gm, '  | '));
}

build(parseArgs(process.argv.slice(2)));
