'use strict';
/** Test-only observation/gate around a real file read; production readers remain unchanged. */
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const options = workerData || {};

if (options.fault) {
  parentPort.once('message', () => {
    if (options.fault === 'hang') return;
    if (options.fault === 'error') throw new Error('fixture worker failure');
    if (options.fault === 'exit') process.exit(0);
    parentPort.postMessage({ id: -1, ok: false });
  });
} else {
  if (options.gate) {
    const gate = new Int32Array(options.gate), original = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (String(file) === options.blockFile && Atomics.compareExchange(gate, 0, 0, 1) === 0) {
        while (Atomics.load(gate, 1) === 0) {
          if (Atomics.wait(gate, 1, 0, 5000) === 'timed-out') throw new Error('fixture read gate timed out');
        }
      }
      return original.call(this, file, ...args);
    };
  }
  require('../../../server/schedReadWorker.cjs');
}
