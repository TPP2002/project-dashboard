'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { buildPlan, runInstall } = require('../scripts/remote-host-install.cjs');

const agent = Buffer.from('a\r\nb\r\n');
const unit = Buffer.from('ExecStart=/usr/bin/python3 /opt/hostmon/hostmon.py daemon\r\n');
function fake(results, calls) {
  return (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    const result = results.shift() || { code: 0, out: '' };
    process.nextTick(() => { if (result.out) child.stdout.emit('data', Buffer.from(result.out)); if (result.err) child.stderr.emit('data', Buffer.from(result.err)); child.emit('close', result.code); });
    return child;
  };
}
const once = JSON.stringify({ hello: { host: { hostname: 'example', logicalCores: 32, memTotalMb: 98304 } }, point: { cpu: 2.5 }, procs: { tasks: [{ kind: 'job' }] } });
function deps(results, calls, lines) { return { spawn: fake(results, calls), readFile: async (p) => String(p).endsWith('.py') ? agent : unit, log: (s) => lines.push(String(s)), sleep: async () => {} }; }

test('plan has ordered commands, LF input, and custom install directory', () => {
  const plan = buildPlan({ targets: ['example'], agentDir: '/opt/test', agentSource: agent, unitSource: unit });
  assert.ok(plan.length >= 6);
  assert.match(plan[0].remote, /echo ok/);
  assert.match(plan[1].remote, /python3 -c/);
  assert.match(plan[2].remote, /mkdir -p.*hostmon\.py\.tmp.*mv.*chmod 755/);
  assert.match(plan[3].remote, /hostmon\.service\.tmp.*mv/);
  assert.match(plan[4].remote, /systemctl daemon-reload.*enable hostmon.*restart hostmon/);
  assert.match(plan[4].remote, /restart hostmon && \(pkill -f '\[h\]ostmon\.py stream' \|\| true\)$/);
  assert.match(plan[5].remote, /test -f/);
  assert.equal(plan[2].stdin.toString(), 'a\nb\n');
  assert.match(plan[3].stdin.toString(), /\/opt\/test\/hostmon\.py/);
  assert.doesNotMatch(plan[3].stdin.toString(), /\r/);
});
test('second target and successful install', async () => {
  const calls = [], lines = [];
  const results = [{ code: 1, err: 'no\n' }, { code: 0, out: 'ok' }, { code: 0, out: 'True\n' }, { code: 0 }, { code: 0 }, { code: 0 }, { code: 0 }, { code: 0, out: once }];
  assert.equal(await runInstall(['--target', 'first', '--target', 'second'], deps(results, calls, lines)), 0);
  assert.equal(lines.at(-1), '采集程序已装好,版本 1');
  assert.equal(calls[1].args[4], 'second');
  assert.ok(calls.every(c => c.cmd === 'ssh' && c.options.windowsHide === true && c.options.shell === false));
});
test('old Python fails', async () => {
  const calls = [], lines = [];
  assert.equal(await runInstall(['--target', 'example'], deps([{ code: 0 }, { code: 0, out: 'False\n' }], calls, lines)), 1);
  assert.match(lines.join('\n'), /3\.8/);
});
test('invalid targets fail', async () => {
  for (const target of ['-bad', 'bad name']) assert.equal(await runInstall(['--target', target], deps([], [], [])), 2);
});
test('dry run does not spawn', async () => {
  const calls = [], lines = [];
  assert.equal(await runInstall(['--target', 'example', '--dry-run'], deps([], calls, lines)), 0);
  assert.equal(calls.length, 0);
  assert.ok(lines.length >= 6);
});
