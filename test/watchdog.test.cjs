'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createWatchdog } = require('../cli/watchdog.cjs');

function fixture(platform = 'win32', output = '') {
  const calls = [], files = new Map(), messages = [];
  const fs = { mkdirSync() {}, writeFileSync(p, v) { files.set(p, v); }, readFileSync(p) { if (!files.has(p)) throw Error('missing'); return files.get(p); } };
  const run = (command, args, options) => { calls.push([command, ...args, options]); return command === 'whoami' ? '' : output; };
  return { calls, files, messages, dog: createWatchdog({ platform, home: 'C:\\dashboard', repoRoot: 'C:\\repo', fs, run, probe: () => ({ running: false }), log: x => messages.push(x), err: x => messages.push(x), now: () => new Date('2026-11-01T00:00:00Z') }) };
}
test('render: ASCII CRLF cmd, hidden vbs and UTF-16 task', () => {
  const { dog } = fixture(); const r = dog.render();
  assert.ok([...r.cmd].every(c => c.charCodeAt(0) < 128));
  assert.ok(!/(?<!\r)\n|\r(?!\n)/.test(r.cmd));
  for (const text of ['6060,1,6068', 'DASHBOARD_NO_OPEN=1', 'forfiles', '1048576']) assert.ok(r.cmd.includes(text));
  assert.match(r.vbs, /, 0, False/);
  assert.deepEqual([...r.xml.subarray(0, 2)], [255, 254]);
  const xml = r.xml.subarray(2).toString('utf16le');
  for (const text of ['wscript.exe', 'PT5M', 'IgnoreNew', 'PT0S', 'LogonTrigger']) assert.ok(xml.includes(text));
});
test('install registers and queries task, preserving errors', () => {
  const f = fixture(); f.dog.install();
  const create = f.calls.find(c => c[1] === '/Create');
  assert.deepEqual(create.slice(0, -1), ['schtasks', '/Create', '/TN', 'DashboardLauncherWatchdog', '/XML', path.join('C:\\dashboard', 'watchdog', 'DashboardLauncherWatchdog.xml'), '/F']);
  assert.equal(create.at(-1).windowsHide, true);
  const dog = createWatchdog({ platform: 'win32', home: 'C:\\dashboard', repoRoot: 'C:\\repo', fs: { mkdirSync() {}, writeFileSync() {} }, run(c) { if (c === 'schtasks') { const e = Error('failed'); e.stderr = 'original stderr'; throw e; } return ''; } });
  assert.throws(() => dog.install(), /original stderr/);
});
for (const sample of [
  'Last Run Time: yesterday\nLast Result: 0\nNext Run Time: tomorrow\nStatus: Ready',
  '上次运行时间: yesterday\n上次结果: 0\n下次运行时间: tomorrow\n状态: Ready',
]) test('status parses task fields', () => {
  const f = fixture('win32', sample); const result = f.dog.status();
  assert.equal(result.task.lastRunTime, 'yesterday'); assert.equal(result.task.lastResult, '0');
  assert.equal(result.task.nextRunTime, 'tomorrow'); assert.equal(result.task.status, 'Ready');
});
test('non-Windows install reports alternatives without invoking commands', () => {
  const f = fixture('darwin'); assert.equal(f.dog.install(), 2); assert.equal(f.calls.length, 0);
  assert.match(f.messages.join('\n'), /launchd/); assert.match(f.messages.join('\n'), /cron/);
});
