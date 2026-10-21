'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const service = require('../core/cloudService.cjs');
const { cloud } = require('../cli/cloudCmd.cjs');
const decode = args => Buffer.from(args.at(-1), 'base64').toString('utf16le');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud service '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return { home, root: path.join(home, 'sync'), registryPath: path.join(home, 'registry.json') };
}
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('launcher runs direct or hold with Windows argv quoting and hidden synchronous Run', () => {
  const node = path.join(os.tmpdir(), 'node runtime', 'node.exe');
  const script = path.join(os.tmpdir(), 'code root', 'cli', 'cloudSync.cjs');
  for (const scheduled of [false, true]) {
    const schedCli = path.join(os.tmpdir(), 'scheduler root', 'sched.cjs');
    const schedShare = path.join(os.tmpdir(), 'shared files');
    const workDir = path.join(os.tmpdir(), 'sync data');
    const source = service.launcherSource({ node, cloudSyncScript: script, ...(scheduled ? { schedCli, schedShare, workDir } : {}) });
    const match = source.match(/rc = sh\.Run\("((?:""|[^"])*)", 0, True\)/);
    assert.ok(match, source);
    const command = match[1].replace(/""/g, '"');
    assert.ok(command.startsWith(`"${node}" `));
    assert.ok(command.endsWith(`"${node === script ? node : script}" "run"`));
    assert.equal(command.includes('"hold"'), scheduled);
    if (scheduled) {
      for (const fragment of [`"${schedCli}" "hold"`, `"--share" "${schedShare}"`, '"--cores" "1"',
        '"--project" "dashboard"', '"--category" "other"', '"--work-type" "cloud-sync"', `"--" "${node}"`,
        `"--root" "${workDir}"`, '"--targets" "launcher.vbs"']) assert.ok(command.includes(fragment), fragment);
      // 常驻进程的工作目录不得落在代码根(发布副本),否则 release 换名会被占住
      assert.ok(!command.includes(`"--root" "${path.join(os.tmpdir(), 'code root')}"`));
    }
    assert.match(source, /WScript\.Quit rc/);
  }
  assert.throws(() => service.launcherSource({ node, cloudSyncScript: script, schedCli: script }), /同时提供/);
  assert.throws(() => service.launcherSource({ node, cloudSyncScript: script, schedCli: script, schedShare: script }), /同步数据目录/);
});

test('registration has current-user logon repetition, IgnoreNew and only a wscript action', () => {
  const args = service.taskArgs({ taskName: "Sync user's task", launcherPath: path.join(os.tmpdir(), 'data & files', 'launcher.vbs') });
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const source = decode(args);
  for (const text of ['Register-ScheduledTask', 'WindowsIdentity', 'InteractiveToken', '<LogonTrigger>',
    '<Interval>PT10M</Interval>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>', '<Command>wscript.exe</Command>', '&quot;', 'data &amp; files', "Sync user''s task"]) assert.ok(source.includes(text), text);
  assert.doesNotMatch(source, /<Command>[^<]*(?:node|cmd|powershell)\.exe/i);
});

test('install writes Unicode launcher at registry root before registration and starts immediately', t => {
  const f = fixture(t), calls = [];
  const result = service.install({ registryPath: f.registryPath, platform: 'win32', run(command, args) {
    calls.push([command, args]);
    assert.ok(fs.existsSync(path.join(f.root, 'launcher.vbs')));
  } });
  assert.equal(result.installed, true);
  assert.deepEqual(calls.map(c => c[0]), ['powershell.exe', 'schtasks.exe']);
  assert.match(decode(calls[0][1]), /Register-ScheduledTask/);
  assert.deepEqual(calls[1][1], ['/Run', '/TN', 'DashboardCloudSync']);
  const source = fs.readFileSync(result.launcherPath, 'utf16le');
  assert.equal(source[0], '\ufeff');
  assert.ok(source.includes(process.execPath));
  assert.ok(source.includes(path.resolve(__dirname, '../cli/cloudSync.cjs')));
  assert.ok(source.includes(f.registryPath));
  assert.match(source, /DASHBOARD_REGISTRY/);
});

test('non-Windows install/uninstall fail before executing or writing anything', async t => {
  const f = fixture(t), before = fs.readdirSync(f.home);
  const options = { registryPath: f.registryPath, platform: 'linux', run() { assert.fail('must not execute'); } };
  assert.throws(() => service.install(options), { message: '目前只支持 Windows', exitCode: 1 });
  await assert.rejects(service.uninstall(options), { message: '目前只支持 Windows', exitCode: 1 });
  assert.deepEqual(fs.readdirSync(f.home), before);
});

test('uninstall unregisters first, requests graceful stop, preserves all sync data', async t => {
  const f = fixture(t), calls = [];
  fs.mkdirSync(f.root);
  for (const name of ['agent.lock', 'launcher.vbs', 'outbox.jsonl', 'state.json', 'status.json']) fs.writeFileSync(path.join(f.root, name), '123');
  const result = await service.uninstall({ registryPath: f.registryPath, platform: 'win32', run(command, args) {
    calls.push(command); assert.match(decode(args), /Unregister-ScheduledTask/);
    assert.equal(fs.existsSync(path.join(f.root, 'stop.request')), false);
  }, sleep: async () => {
    assert.ok(fs.existsSync(path.join(f.root, 'stop.request')));
    assert.ok(fs.existsSync(path.join(f.root, 'launcher.vbs')));
    fs.unlinkSync(path.join(f.root, 'agent.lock'));
    fs.unlinkSync(path.join(f.root, 'stop.request'));
  } });
  assert.equal(result.forced, false); assert.deepEqual(calls, ['powershell.exe']);
  assert.equal(fs.existsSync(path.join(f.root, 'launcher.vbs')), false);
  for (const name of ['outbox.jsonl', 'state.json', 'status.json']) assert.equal(fs.readFileSync(path.join(f.root, name), 'utf8'), '123');
});

test('uninstall waits 15 seconds then kills only lock pid and checks it exited', async t => {
  const f = fixture(t), calls = []; let time = 0, live = true;
  fs.mkdirSync(f.root); fs.writeFileSync(path.join(f.root, 'agent.lock'), '4321');
  const result = await service.uninstall({ registryPath: f.registryPath, platform: 'win32', now: () => time,
    sleep: async ms => { time += ms; }, alive: pid => { assert.equal(pid, 4321); return live; },
    run(command, args) { calls.push([command, args]); if (command === 'taskkill.exe') { assert.equal(time, 15000); live = false; } } });
  assert.equal(result.forced, true);
  assert.deepEqual(calls[1], ['taskkill.exe', ['/PID', '4321', '/T', '/F']]);
  assert.equal(fs.existsSync(path.join(f.root, 'agent.lock')), false);
});

test('status combines task query, live lock and report without trusting stale reports', t => {
  const f = fixture(t); fs.mkdirSync(f.root);
  const report = { agent: { pid: 4321, state: 'connected' } }; write(path.join(f.root, 'status.json'), report);
  const options = { registryPath: f.registryPath, platform: 'win32', alive: pid => pid === 4321,
    run(command, args) { assert.equal(command, 'powershell.exe'); assert.match(decode(args), /Get-ScheduledTaskInfo/);
      assert.match(decode(args), /if \(\$i\.NextRunTime\)/);
      return JSON.stringify({ installed: true, nextRunTime: '2026-01-01T10:00:00' }); } };
  assert.equal(service.status(options).running, false);
  fs.writeFileSync(path.join(f.root, 'agent.lock'), '4321');
  const result = service.status(options);
  assert.equal(result.running, true); assert.equal(result.installed, true);
  assert.equal(result.nextRunTime, '2026-01-01T10:00:00'); assert.deepEqual(result.status, report);
  assert.equal(service.status({ ...options, alive: () => false }).running, false);
});

test('cloud dispatcher passes service flags and returns structured results', async t => {
  const original = service.install;
  t.after(() => { service.install = original; });
  const f = fixture(t);
  service.install = options => ({ ok: true, options });
  const result = await cloud({ _: ['service', 'install'], registry: f.registryPath, 'task-name': 'custom',
    'sched-cli': 'scheduler', 'sched-share': 'share', json: true });
  assert.deepEqual(result.options, { registryPath: f.registryPath, taskName: 'custom', schedCli: 'scheduler', schedShare: 'share' });
  await assert.rejects(cloud({ _: ['service', 'unknown'], registry: f.registryPath }), { exitCode: 2 });
});

test('real run exits 0 on stop.request in reconnect state and second instance exits 3', { timeout: 20000 }, async t => {
  const f = fixture(t); fs.mkdirSync(f.root); write(f.registryPath, { projects: {} });
  write(path.join(f.root, 'config.json'), { v: 1, mode: 'direct', origin: 'http://127.0.0.1:1', baseUrl: 'http://127.0.0.1:1' });
  const preload = path.join(f.home, 'credential.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(path.resolve(__dirname, '../core/syncCredential.cjs'))}).loadDeviceCredential=async()=>({origin:'http://127.0.0.1:1',expiresAt:'2099-01-01',token:'test-only'});`);
  const start = () => {
    const child = spawn(process.execPath, ['--require', preload, path.resolve(__dirname, '../cli/cloudSync.cjs'), 'run'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DASHBOARD_REGISTRY: f.registryPath, DASHBOARD_HOME: f.home } });
    let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, output })); });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
    return { child, exited };
  };
  const first = start();
  const readyDeadline = Date.now() + 4000;
  while (Date.now() < readyDeadline) {
    if (fs.existsSync(path.join(f.root, 'status.json'))) {
      const report = JSON.parse(fs.readFileSync(path.join(f.root, 'status.json'), 'utf8'));
      if (report.agent.state === 'reconnecting' && report.agent.lastError) break;
    }
    await sleep(50);
  }
  const report = JSON.parse(fs.readFileSync(path.join(f.root, 'status.json'), 'utf8'));
  assert.equal(report.agent.state, 'reconnecting'); assert.ok(report.agent.lastError);
  const second = start(); assert.equal((await second.exited).code, 3);
  const at = Date.now(); fs.writeFileSync(path.join(f.root, 'stop.request'), 'stop');
  let timer;
  const result = await Promise.race([first.exited, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('stop request exceeded 15 seconds')), 15000);
  })]).finally(() => clearTimeout(timer));
  assert.equal(result.code, 0, result.output); assert.equal(result.signal, null); assert.ok(Date.now() - at < 15000);
  assert.equal(fs.existsSync(path.join(f.root, 'agent.lock')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'stop.request')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'status.json'), 'utf8')).agent.state, 'stopped');
});

test('all child_process calls in service and cloud command explicitly hide windows', () => {
  let calls = 0;
  for (const file of ['../core/cloudService.cjs', '../cli/cloudCmd.cjs']) {
    const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
    for (const match of source.matchAll(/\b(?:execFileSync|execFile|spawnSync|spawn|execSync|exec|fork)\s*\([^;]+/g)) {
      calls++; assert.match(match[0], /windowsHide:\s*true/);
    }
  }
  assert.ok(calls > 0);
});
