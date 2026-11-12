'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveProject } = require('../core/resolveProject.cjs');
const { mapRepoToPrefix, getUsage } = require('../core/costUsage.cjs');
const { validate } = require('../core/boardSchema.cjs');

test('seed creates isolated priced usage and dated card costs', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-seed-cost-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const script = path.resolve(__dirname, '../packaging/demo-seed.cjs');
  const run = () => spawnSync(process.execPath, [script, home], { env: { ...process.env, DEMO_SEED_TODAY: '2026-07-02' }, encoding: 'utf8', windowsHide: true });
  const result = run(); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'demo-instance.json'), 'utf8')), { schemaVersion: 1 });
  const registryPath = path.join(home, 'registry.json');
  const root = path.join(home, 'claude-projects');
  const prefixes = ['shopfast', 'blog'].map(id => mapRepoToPrefix(resolveProject(id, { registryPath }).costPrefixRoots[0]));
  assert.deepEqual(fs.readdirSync(root).sort(), prefixes.sort());
  for (const prefix of prefixes) {
    const usage = await getUsage({ prefix, days: 36500, projectsRoot: root, cachePath: path.join(home, 'cache.json') });
    assert.ok(usage.totals.output > 0);
    for (const file of fs.readdirSync(path.join(root, prefix))) assert.doesNotMatch(fs.readFileSync(path.join(root, prefix, file), 'utf8'), /[A-Za-z]:[\\/]/);
  }
  for (const [id, ids] of [['shopfast', ['FEAT-1', 'FEAT-2', 'BUG-7', 'CHORE-9']], ['blog', ['B1', 'B2']]]) {
    const board = JSON.parse(fs.readFileSync(path.join(home, 'boards', id + '.json'), 'utf8'));
    assert.equal(validate(board).ok, true);
    for (const taskId of ids) assert.ok(board.tasks.find(task => task.id === taskId).cost.entries.length > 0);
    assert.equal(board.activity.map(item => item.ts).sort().at(-1).slice(0, 10), '2026-07-01');
    if (id === 'shopfast') assert.equal(board.activity.map(item => item.ts).sort().at(-1), '2026-07-01T15:00:00Z');
  }
  const stale = path.join(root, prefixes[0], 'stale.jsonl'); fs.writeFileSync(stale, 'stale');
  assert.equal(run().status, 0); assert.equal(fs.existsSync(stale), false);
});
