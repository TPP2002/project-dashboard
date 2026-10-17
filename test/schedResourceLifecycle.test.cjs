'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('scheduler store resource lifecycle (actual store with browser/API fixtures)', { timeout: 30000 }, () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', 'web/tests/schedResourceLifecycle.check.mts'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 25000, env,
  });
  assert.equal(result.status, 0, (result.error?.message || '') + '\n' + result.stdout + '\n' + result.stderr);
  const passed = /# pass (\d+)/.exec(result.stdout);
  assert.ok(passed && Number(passed[1]) >= 8, 'inner behavioral checks must actually run');
});
