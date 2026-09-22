'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { getUsage } = require('../core/costUsage.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-location-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fixture', 'session.jsonl'), JSON.stringify({ type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z', sessionId: 'fixture', message: {
      id: 'one', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 10 } } }) + '\n');
  return { dir, root };
}
test('默认缓存写进全新数据根，第二个进程复用，代码目录不产生缓存', t => {
  const { dir, root } = fixture(t), data = path.join(dir, 'data-home');
  const copy = path.join(dir, 'release');
  fs.cpSync(path.resolve(__dirname, '../core'), path.join(copy, 'core'), { recursive: true });
  const script = "require('./core/costUsage.cjs').getUsage({prefix:'fixture',projectsRoot:process.env.FIXTURE_PROJECTS}).then(r=>console.log(JSON.stringify({scanned:r.scanned,cached:r.cachedFiles})))";
  const run = () => {
    const result = spawnSync(process.execPath, ['-e', script], { cwd: copy, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, DASHBOARD_HOME: data, FIXTURE_PROJECTS: root } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(run().scanned, 1);
  assert.ok(fs.existsSync(path.join(data, 'costUsageCache.json')));
  assert.deepEqual(run(), { scanned: 0, cached: 1 });
  assert.equal(fs.existsSync(path.join(copy, 'data')), false);
});
test('缓存不能写时结果仍返回，但必须可见提醒', async t => {
  const { dir, root } = fixture(t), logs = [];
  const blocking = path.join(dir, 'file'); fs.writeFileSync(blocking, 'not a directory');
  const result = await getUsage({ prefix: 'fixture', projectsRoot: root,
    cachePath: path.join(blocking, 'cache.json'), warn: text => logs.push(text) });
  assert.equal(result.scanned, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /成本缓存.*写入失败/);
});
