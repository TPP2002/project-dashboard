'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('Python host monitor tests', () => {
  let python;
  for (const [cmd, args] of [['python', []], ['python3', []], ['py', ['-3']]]) {
    const probe = spawnSync(cmd, [...args, '-c', 'import sys; sys.exit(sys.version_info < (3, 8))'], { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: false });
    if (!probe.error && probe.status === 0) { python = [cmd, args]; break; }
  }
  assert.ok(python, 'Python 3.8 or newer is required');
  const run = spawnSync(python[0], [...python[1], '-m', 'unittest', 'discover', '-s', 'remote-agent/tests', '-p', 'test_*.py', '-v'], { encoding: 'utf8', timeout: 110000, windowsHide: true, shell: false, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const output = (run.stdout || '') + (run.stderr || '');
  assert.equal(run.status, 0, output);
  assert.match(output, /\bOK\b/);
  const count = output.match(/Ran (\d+) tests?/);
  assert.ok(count && Number(count[1]) >= 25, output);
});
