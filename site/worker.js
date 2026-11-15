// The test page's module worker. It loads the WebAssembly the way the game will (streaming, which refuses a .wasm not
// served as application/wasm), runs it, and reports crossOriginIsolated and the resources it loaded.

async function run() {
  let wasm;
  try {
    const { instance } = await WebAssembly.instantiateStreaming(fetch('tiny.wasm'));
    wasm = instance.exports.add(2, 3) === 5 ? 'ran (2 + 3 = 5)' : 'ran, but gave a wrong answer';
  } catch (err) {
    wasm = `failed: ${err && err.message}`;
  }
  const resources = performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname);
  // The worker's own script is not in its own Resource Timing list; it is named here so the page's list is whole.
  self.postMessage({ coi: self.crossOriginIsolated, wasm, resources: ['/worker.js', ...resources] });
}

run();
