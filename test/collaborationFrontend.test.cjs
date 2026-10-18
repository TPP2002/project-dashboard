'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('collaboration UI preserves authorization and retries owner actions without duplicate execution', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap',
    'web/tests/collaborationFlow.check.mts', 'web/tests/ownerOperations.check.mts'], {
    cwd: path.resolve(__dirname, '..'), env, windowsHide: true, encoding: 'utf8', timeout: 30000,
  });
  const output = result.stdout + '\n' + result.stderr;
  assert.equal(result.status, 0, (result.error?.message || '') + '\n' + output);
  assert.match(output, /# pass [1-9]\d*/);
  assert.match(output, /# fail 0\b/);
});
