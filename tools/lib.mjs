// Shared helpers for the check scripts. Node 22, no dependencies.
// Every fetch is cookie-less, names itself in the User-Agent (Pages answers default script User-Agents with a 403,
// error 1010: Cloudflare's known-issues page, 2026-11-06) and never follows a redirect, so a login wall is seen as one.
// Each answer is either a reading (an HTTP status the scripts judge) or "no reading" (a transport error, a 5xx, or the
// 1010 block after every retry): a "no reading" is never judged as a pass, a failure, or "gone".
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const USER_AGENT = 'shamble-preview-check-probe/1 (+https://github.com/Mergincanli/shamble-preview-check)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every *.json record below dir (flat in the verify job, one folder deeper in the probe job).
export function readRecords(dir) {
  const found = [];
  const walk = (d) => {
    let names;
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.json')) {
        try {
          const r = JSON.parse(readFileSync(p, 'utf8'));
          if (r && typeof r.deployment_id === 'string' && typeof r.url === 'string') found.push(r);
        } catch { /* not a record */ }
      }
    }
  };
  walk(dir);
  return found;
}

// The project's own address, from a one-off link: https://<8 characters>.<project>.pages.dev -> https://<project>.pages.dev
export function projectRoot(oneOffUrl) {
  const host = new URL(oneOffUrl).host.split('.');
  return `https://${host.slice(1).join('.')}/`;
}

// The two links of an upload: its stable link (a preview's branch link, or production's project address) and its
// one-off link.
export function linksOf(record) {
  const stable = record.environment === 'production' ? projectRoot(record.url) : record.alias || null;
  return [
    ...(stable ? [{ form: 'stable', base: stable.endsWith('/') ? stable : `${stable}/` }] : []),
    { form: 'one-off', base: record.url.endsWith('/') ? record.url : `${record.url}/` },
  ];
}

export const isBlocked = (a) => a.status === 403 && /error code:?\s*1010|Error 1010/i.test(a.body || '');
export const isWall = (a) => a.status >= 300 && a.status < 400 && /\.cloudflareaccess\.com$/i.test(hostOf(a.location));
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

// The build marker the page carries. An empty marker (the tombstone's) never matches anything.
export function hasMarker(body, marker) {
  return typeof marker === 'string' && marker.length > 0 && (body || '').includes(`<meta name="build-marker" content="${marker}">`);
}

async function fetchOnce(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': USER_AGENT, accept: '*/*' } });
    const body = await res.text();
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { url, status: res.status, headers, location: res.headers.get('location') || '', body: body.slice(0, 20000) };
  } catch (err) {
    return { url, status: 0, headers: {}, location: '', body: '', error: String((err && err.cause && err.cause.code) || err) };
  }
}

// Retries a transport error, a 5xx or the 1010 block (and, when retry404 is set, a 404: an upload seconds old may not
// have reached every edge yet). Returns the last answer with noReading set when no reading was ever obtained.
export async function fetchWithRetry(url, { attempts = 5, retry404 = false } = {}) {
  let a;
  for (let i = 0; i < attempts; i += 1) {
    a = await fetchOnce(url);
    const transient = a.status === 0 || a.status >= 500 || isBlocked(a) || (retry404 && a.status === 404);
    if (!transient) return { ...a, noReading: false, tries: i + 1 };
    if (i < attempts - 1) await sleep(2000 * 2 ** i);
  }
  const noReading = a.status === 0 || a.status >= 500 || isBlocked(a);
  return { ...a, noReading, tries: attempts };
}

export const lower = (h, name) => (h[name.toLowerCase()] || '').trim();
