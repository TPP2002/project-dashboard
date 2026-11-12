'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getUsage } = require('../core/costUsage.cjs');

test('unchanged cost cache is not read again; external changes are read', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-cache-memo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'projects'), cachePath = path.join(dir, 'cache.json');
  fs.mkdirSync(path.join(root, 'demo-a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo-a', 'sample.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 2 } } }));
  const options = { prefix: 'demo-a', projectsRoot: root, cachePath };
  await getUsage(options);
  const read = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (file, ...args) {
    if (file === cachePath) reads++;
    return read.call(this, file, ...args);
  };
  try {
    await getUsage(options);
    assert.equal(reads, 0);
    fs.writeFileSync(cachePath, JSON.stringify({ schemaVersion: -1, files: {}, extra: 'external update' }));
    const actual = await getUsage(options);
    assert.equal(reads, 1);
    assert.equal(actual.scanned, 1);
    const { spawnSync } = require('node:child_process');
    const code = 'require(process.argv[1]).getUsage(JSON.parse(process.argv[2])).then(r => process.stdout.write(JSON.stringify(r.totals)))';
    const child = spawnSync(process.execPath, ['-e', code, require.resolve('../core/costUsage.cjs'), JSON.stringify(options)], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(actual.totals, JSON.parse(child.stdout));
  } finally { fs.readFileSync = read; }
});
