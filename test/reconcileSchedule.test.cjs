'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const svc = require('../core/reconcileSchedule.cjs');
const { reconcileSchedule } = require('../cli/reconcileSchedule.cjs');

function tmp(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rcsched-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return { dir, reg: path.join(dir, 'registry.json'), data: path.join(dir, 'reconcile') };
}
const decode = (args) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

test('S1 launcherSource:Run 行隐藏、命令齐全、含空格与双引号的路径转义正确', () => {
  const logPath = path.join(os.tmpdir(), 'my logs', 'a"b', 'reconcile.log');
  const node = path.join(os.tmpdir(), 'node dir', 'node.exe');
  const cliScript = path.join(os.tmpdir(), 'cli dir', 'index.cjs');
  const src = svc.launcherSource({ node, cliScript, registryPath: path.join(os.tmpdir(), 'r"eg.json'), logPath });
  const runLine = src.split('\r\n').find((l) => l.includes('sh.Run('));
  assert.ok(runLine.endsWith(', 0, True)'));
  assert.ok(src.includes('reconcile --all --apply --fetch'));
  // argv 引号层:内部双引号变 \";VBScript 字面量层:每个 " 再翻倍
  const argvQuoted = '"' + logPath.replace(/"/g, '\\"') + '"';
  assert.ok(runLine.includes(argvQuoted.replace(/"/g, '""')), runLine);
  assert.ok(src.includes('DASHBOARD_REGISTRY") = "' + path.join(os.tmpdir(), 'r""eg.json') + '"'));
  assert.ok(runLine.includes('cmd.exe /d /s /c'));
  assert.ok(src.includes('WScript.Quit rc'));
});

test('S2 taskArgs:任务 XML 含间隔、wscript、IgnoreNew、PT30M', () => {
  const args = svc.taskArgs({ taskName: 'T', launcherPath: path.join(os.tmpdir(), 'launcher.vbs'), everyHours: 3 });
  const text = decode(args);
  assert.ok(text.includes('<Interval>PT3H</Interval>'));
  assert.ok(text.includes('<Command>wscript.exe</Command>'));
  assert.ok(text.includes('IgnoreNew'));
  assert.ok(text.includes('PT30M'));
  assert.ok(text.includes('<StartWhenAvailable>true</StartWhenAvailable>'));
});

test('S3 install 在 linux 抛错且 exitCode 为 1', (t) => {
  const { reg } = tmp(t);
  assert.throws(() => svc.install({ registryPath: reg, platform: 'linux', run: () => assert.fail('不该调用') }),
    (e) => e.exitCode === 1 && /只支持 Windows/.test(e.message));
});

test('S4 install:只调一次 powershell.exe,launcher.vbs 以 UTF-16 BOM 开头', (t) => {
  const { reg, data } = tmp(t);
  const calls = [];
  const res = svc.install({ registryPath: reg, platform: 'win32', run: (cmd, args) => { calls.push([cmd, args]); return ''; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.ok(!calls.some((c) => c[0] === 'schtasks.exe'));
  const buf = fs.readFileSync(path.join(data, 'launcher.vbs'));
  assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xfe);
  assert.equal(res.ok, true);
  assert.equal(res.everyHours, 2);
  assert.equal(res.logPath, path.join(data, 'reconcile.log'));
  assert.ok(decode(calls[0][1]).includes('<Interval>PT2H</Interval>'));
});

test('S5 everyHours 为 0、25、1.5 时拒绝', (t) => {
  const { reg } = tmp(t);
  for (const everyHours of [0, 25, 1.5]) {
    assert.throws(() => svc.install({ registryPath: reg, platform: 'win32', everyHours, run: () => assert.fail('不该调用') }), /1~24/);
  }
});

test('S6 日志超过 1 MB 时 install 改名成 reconcile.log.1', (t) => {
  const { reg, data } = tmp(t);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'reconcile.log'), Buffer.alloc(1024 * 1024 + 1, 97));
  fs.writeFileSync(path.join(data, 'reconcile.log.1'), 'old');
  svc.install({ registryPath: reg, platform: 'win32', run: () => '' });
  assert.ok(!fs.existsSync(path.join(data, 'reconcile.log')));
  assert.equal(fs.statSync(path.join(data, 'reconcile.log.1')).size, 1024 * 1024 + 1);
});

test('S7 uninstall 删 launcher.vbs、保留日志', (t) => {
  const { reg, data } = tmp(t);
  svc.install({ registryPath: reg, platform: 'win32', run: () => '' });
  fs.writeFileSync(path.join(data, 'reconcile.log'), 'line\n');
  const calls = [];
  svc.uninstall({ registryPath: reg, platform: 'win32', run: (c, a) => { calls.push(c); return ''; } });
  assert.deepEqual(calls, ['powershell.exe']);
  assert.ok(!fs.existsSync(path.join(data, 'launcher.vbs')));
  assert.equal(fs.readFileSync(path.join(data, 'reconcile.log'), 'utf8'), 'line\n');
});

test('S8 cli 对未知子命令退出码 2;status 带日志末 20 行', (t) => {
  const { reg, data } = tmp(t);
  const codes = [];
  const origWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    reconcileSchedule({ _: ['bogus'], registry: reg }, { exit: (c) => codes.push(c) });
    reconcileSchedule({ _: [], registry: reg }, { exit: (c) => codes.push(c) });
  } finally { process.stderr.write = origWrite; }
  assert.deepEqual(codes, [2, 2]);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'reconcile.log'), Array.from({ length: 30 }, (_, i) => 'L' + i).join('\n') + '\n');
  const res = reconcileSchedule({ _: ['status'], registry: reg },
    { platform: 'win32', run: () => JSON.stringify({ installed: true, nextRunTime: null }) });
  assert.equal(res.installed, true);
  assert.equal(res.logTail.length, 20);
  assert.equal(res.logTail[19], 'L29');
});
