'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const { withLock } = require('../core/lock.cjs');
const { fixture } = require('./remoteBoardFixtures.test.cjs');

test('authority transaction waits through a locked board replacement', async t => {
  const f = fixture(t);
  const proj = { id: 'p', board: f.board, lock: f.board + '.lock' };
  const gate = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(`
    const { parentPort, workerData: d } = require('node:worker_threads');
    const fs = require('node:fs');
    process.env.DASHBOARD_HOME = d.home;
    delete process.env.DASHBOARD_REMOTE_CONFIG;
    const store = require(d.store);
    const gate = new Int32Array(d.gate);
    const observed = () => { Atomics.store(gate, 1, 1); Atomics.notify(gate, 1); };
    // Observe a real lock attempt or the old premature missing-board check.
    // Neither hook changes the filesystem result; the parent controls the gap.
    const exists = fs.existsSync, open = fs.openSync;
    fs.existsSync = function(file) {
      const result = exists.apply(this, arguments);
      if (file === d.proj.board && !result) observed();
      return result;
    };
    fs.openSync = function(file) {
      try { return open.apply(this, arguments); }
      catch (error) {
        if (file === d.proj.lock && error.code === 'EEXIST') observed();
        throw error;
      }
    };
    parentPort.postMessage('ready');
    Atomics.wait(gate, 0, 0);
    try {
      const result = store.commandTransaction(d.proj, d.identity, () => ({ ok: true }));
      parentPort.postMessage({ result });
    } catch (error) { parentPort.postMessage({ error: error.message }); }
    parentPort.close();
  `, { eval: true, workerData: {
    home: f.cloud, store: path.resolve(__dirname, '../cli/store.cjs'),
    proj, gate: gate.buffer,
    identity: { subject: 'owner', request: f.request('list'), inputHash: 'b'.repeat(64) },
  } });
  t.after(() => worker.terminate());
  assert.deepEqual(await once(worker, 'message'), ['ready']);
  const outcome = once(worker, 'message');
  const exit = once(worker, 'exit');
  const replacement = f.board + '.replacement';
  withLock(proj.lock, () => {
    fs.renameSync(f.board, replacement);
    try {
      Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
      assert.notEqual(Atomics.wait(gate, 1, 0, 10000), 'timed-out', 'contender must reach the replacement gap');
    } finally { fs.renameSync(replacement, f.board); }
  });
  assert.deepEqual(await outcome, [{ result: { ok: true } }]);
  assert.deepEqual(await exit, [0]);
  assert.equal(f.read().revision, 1);
  assert.equal(Object.keys(f.read()._commandReceipts).length, 1);
});

test('authority transaction still rejects an actually missing board without creating data', t => {
  const f = fixture(t);
  fs.unlinkSync(f.board);
  const result = f.gateway(f.request('add', { _: ['A'], title: '标题', 'plain-title': '共享任务', model: 'test' }));
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /权威账本不存在/);
  assert.equal(fs.existsSync(f.board), false);
  assert.equal(fs.existsSync(f.board + '.lock'), false);
});
