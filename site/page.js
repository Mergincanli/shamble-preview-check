// The test page's script (a module file, never inline, so the page stays ready for a strict content security policy).
// It shows what the browser and the host did: crossOriginIsolated in the page and in its worker, whether the
// WebAssembly ran, the content file it fetched, and every resource the page and the worker loaded (Resource Timing).
// When it is finished it sets data-done on <html>: "1", or "error" with the reason in #status.

const $ = (id) => document.getElementById(id);
const show = (id, value) => { $(id).textContent = String(value); };
const paths = (entries) => entries.map((e) => new URL(e.name).pathname);

function askWorker() {
  return new Promise((resolve) => {
    let worker;
    const timer = setTimeout(() => resolve({ error: 'the worker did not answer within 10 s' }), 10000);
    try {
      worker = new Worker('worker.js', { type: 'module' });
    } catch (err) {
      clearTimeout(timer);
      resolve({ error: `the worker could not start: ${err && err.message}` });
      return;
    }
    worker.addEventListener('message', (event) => { clearTimeout(timer); resolve(event.data); });
    worker.addEventListener('error', (event) => {
      clearTimeout(timer);
      resolve({ error: `worker error: ${(event && event.message) || 'its script did not load'}` });
    });
  });
}

async function main() {
  show('coi-page', self.crossOriginIsolated);
  const manifest = await (await fetch('manifest.json', { cache: 'no-store' })).json();
  show('mode', manifest.mode);
  const content = await (await fetch(manifest.bundle)).arrayBuffer();
  show('bundle', `${manifest.bundle} (${content.byteLength} bytes)`);
  const report = await askWorker();
  show('coi-worker', report.error ? `not reported (${report.error})` : report.coi);
  show('wasm', report.error ? 'not run (no worker)' : report.wasm);
  const loaded = {
    page: ['/', ...paths(performance.getEntriesByType('resource'))],
    worker: report.resources || [],
  };
  show('resources', JSON.stringify(loaded, null, 2));
  show('status', 'done');
  document.documentElement.dataset.done = '1';
}

main().catch((err) => {
  show('status', `error: ${err && err.message}`);
  document.documentElement.dataset.done = 'error';
});
