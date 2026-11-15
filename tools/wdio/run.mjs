#!/usr/bin/env node
// PM-0006-3 and PM-0006-4 in the branded browsers of GitHub's own machines, through WebdriverIO (pinned 10.1.0, run as
// classic WebDriver). Every load is a fresh session, so a fresh profile; every result names the browser's version,
// WebdriverIO's version and the runner image.
//   node tools/wdio/run.mjs --browsers chrome,MicrosoftEdge,firefox --links tools/links.json --out browser-results.json
// PM-0006-3: crossOriginIsolated in the page and in its worker, 3 loads per browser and link: true on iso-on, false on
// iso-off and production; on bite-coep (COEP taken off the worker) anything but true/true is the bite caught.
// PM-0006-4 (Chrome): first visit, tab closed, second visit in the same profile: the content file's transferSize must
// be 0 on production, 3 times; on bite-nocache (Cache-Control: no-cache) above 0 is the bite caught.
// Exit 0: everything as expected; 1: something not as expected; 3: nothing unexpected, but some load gave no reading.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { remote } from 'webdriverio';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!args.browsers || !args.links || !args.out) { console.error('run: --browsers, --links and --out are needed'); process.exit(2); }

const LOADS = 3;
const { links } = JSON.parse(readFileSync(args.links, 'utf8'));
const EXPECT = { production: 'false/false', 'iso-off': 'false/false', 'iso-on': 'true/true', 'bite-nocache': 'false/false' };
const wdioVersion = JSON.parse(readFileSync(new URL('./node_modules/webdriverio/package.json', import.meta.url), 'utf8')).version;

function capabilitiesFor(browser) {
  const caps = { browserName: browser, 'wdio:enforceWebDriverClassic': true };
  const exe = process.platform === 'win32' ? '.exe' : '';
  const env = process.env;
  if (browser === 'chrome') {
    caps['goog:chromeOptions'] = { args: ['--headless=new'] };
    if (env.CHROMEWEBDRIVER) caps['wdio:chromedriverOptions'] = { binary: join(env.CHROMEWEBDRIVER, `chromedriver${exe}`) };
  } else if (browser === 'MicrosoftEdge') {
    caps['ms:edgeOptions'] = { args: ['--headless=new'] };
    if (env.EDGEWEBDRIVER) caps['wdio:edgedriverOptions'] = { binary: join(env.EDGEWEBDRIVER, `msedgedriver${exe}`) };
  } else if (browser === 'firefox') {
    caps['moz:firefoxOptions'] = { args: ['-headless'] };
    if (env.GECKOWEBDRIVER) caps['wdio:geckodriverOptions'] = { binary: join(env.GECKOWEBDRIVER, `geckodriver${exe}`) };
  }
  return caps;
}

async function withSession(browser, work) {
  const session = await remote({ capabilities: capabilitiesFor(browser), logLevel: 'warn' });
  try {
    return await work(session, session.capabilities.browserVersion || session.capabilities.version || null);
  } finally {
    await session.deleteSession().catch(() => {});
  }
}

async function openAndWait(session, url) {
  await session.url(url);
  await session.waitUntil(async () => (await session.execute(() => document.documentElement.dataset.done || '')) !== '',
    { timeout: 30000, interval: 250, timeoutMsg: 'the page did not finish within 30 s' });
}

const readPage = (session) => session.execute(() => {
  const t = (id) => document.getElementById(id).textContent;
  return { done: document.documentElement.dataset.done, marker: t('marker'), page: t('coi-page'), worker: t('coi-worker'),
    wasm: t('wasm'), status: t('status'), resources: t('resources') };
});

const contentTransferSize = (session) => session.execute(() => {
  const e = performance.getEntriesByType('resource').find((r) => /\/content\.[0-9a-f]{8}\.bin$/.test(new URL(r.name).pathname));
  return e ? e.transferSize : null;
});

const rows = [];
const browsers = args.browsers.split(',').map((b) => b.trim()).filter(Boolean);
for (const browser of browsers) {
  for (const [name, url] of Object.entries(links)) {
    for (let load = 1; load <= LOADS; load += 1) {
      const row = { mark: 'PM-0006-3', browser, link: name, url, load };
      try {
        Object.assign(row, await withSession(browser, async (session, version) => {
          await openAndWait(session, url);
          return { version, ...(await readPage(session)) };
        }));
        const seen = `${row.page}/${row.worker}`;
        if (name === 'bite-coep') row.outcome = seen === 'true/true' ? 'bite missed' : 'bite caught';
        else row.outcome = row.done === '1' && seen === EXPECT[name] ? 'as expected' : 'not as expected';
        row.seen = seen;
      } catch (err) {
        row.outcome = 'no reading';
        row.error = String((err && err.message) || err).slice(0, 300);
      }
      rows.push(row);
      console.log(`${row.outcome.padEnd(16)} ${browser} ${row.version ?? ''} ${name} load ${load}: ${row.seen ?? row.error}`);
    }
  }
  if (browser === 'chrome') {
    for (const [name, wantZero] of [['production', true], ['bite-nocache', false]]) {
      for (let repeat = 1; repeat <= LOADS; repeat += 1) {
        const row = { mark: 'PM-0006-4', browser, link: name, url: links[name], repeat };
        try {
          Object.assign(row, await withSession(browser, async (session, version) => {
            await openAndWait(session, links[name]);
            const first = await session.getWindowHandle();
            const created = await session.createWindow('tab');
            await session.switchToWindow(first);
            await session.closeWindow();
            await session.switchToWindow(created.handle);
            await openAndWait(session, links[name]);
            return { version, transferSize: await contentTransferSize(session) };
          }));
          if (typeof row.transferSize !== 'number') row.outcome = 'no reading';
          else if (wantZero) row.outcome = row.transferSize === 0 ? 'as expected' : 'not as expected';
          else row.outcome = row.transferSize > 0 ? 'bite caught' : 'bite missed';
        } catch (err) {
          row.outcome = 'no reading';
          row.error = String((err && err.message) || err).slice(0, 300);
        }
        rows.push(row);
        console.log(`${row.outcome.padEnd(16)} ${browser} cache ${name} repeat ${repeat}: transferSize ${row.transferSize ?? row.error}`);
      }
    }
  }
}

const unexpected = rows.filter((r) => r.outcome === 'not as expected' || r.outcome === 'bite missed').length;
const unread = rows.filter((r) => r.outcome === 'no reading').length;
const out = {
  ran_at: new Date().toISOString(),
  runner: { os: process.platform, image: process.env.ImageOS || null, image_version: process.env.ImageVersion || null },
  webdriverio: wdioVersion,
  rows,
  summary: { rows: rows.length, unexpected, no_reading: unread },
};
writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
console.log(`summary: ${JSON.stringify(out.summary)}`);
process.exit(unexpected ? 1 : unread ? 3 : 0);
