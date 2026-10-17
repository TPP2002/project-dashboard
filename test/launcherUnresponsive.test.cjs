'use strict';
// 行为回归：直接调用当前模块，派单器将本文件放回基线模块时必须在业务断言上失败。
// 全部动作只用临时数据域与桩；不启动进程、不接触真实票据或发布副本。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const lr = require('../core/launcherRuntime.cjs');
const launcher = require('../cli/launcher.cjs');

const HOST = 'health-miss-test';
const PID = 42001;
const COMMIT = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const TICKET = 'tk-' + 'a'.repeat(20);
function recordOf(mode, over = {}) {
  return {
    schema: lr.RECORD_SCHEMA, hostname: HOST, mode, serverPid: PID,
    key: 'serve-existing', wrapperPid: 42002, watcherPid: 42003,
    ticketId: mode === 'strict' ? TICKET : null,
    title: mode === 'strict' ? lr.residentTitle(HOST) : null,
    releaseCommit: COMMIT, ...over,
  };
}
function query(outcome, calls) {
  return (pid, signal) => {
    calls.push([pid, signal]);
    assert.equal(pid, PID);
    assert.equal(signal, 0, '只能探测，绝不发送停止信号');
    if (outcome !== 'alive') throw Object.assign(new Error(outcome), { code: outcome });
  };
}
function assertRefusal(route) {
  assert.equal(route.kind, 'refuse', '健康缺失不能把仍可能存活的登记进程判为 none');
  assert.match(route.reason, /健康检查未响应/);
  assert.match(route.reason, /仍活着或无法确认已退出/);
  assert.match(route.reason, /稍后重试或检查/);
  assert.doesNotMatch(route.reason, /超时/);
  assert.equal(route.health, undefined, '不能凭 PID 宣称健康或可复用');
}

for (const mode of ['strict', 'standalone']) {
  for (const outcome of ['alive', 'EPERM']) {
    test(`无健康结果：${mode} 本机有效登记 + ${outcome} → 明确拒绝`, () => {
      const calls = [];
      const route = lr.classifyInstance({
        health: null, record: recordOf(mode), hostname: HOST, launcherMode: mode,
        kill: query(outcome, calls),
        client: { status: () => assert.fail('无健康结果不凭票据授权接管') }, share: 'unused',
      });
      assertRefusal(route);
      assert.deepEqual(calls, [[PID, 0]]);
    });
  }
  test(`无健康结果：${mode} 登记 PID 确知 ESRCH → 可走原启动流程`, () => {
    const calls = [];
    assert.equal(lr.classifyInstance({
      health: null, record: recordOf(mode), hostname: HOST, launcherMode: mode,
      kill: query('ESRCH', calls),
    }).kind, 'none');
    assert.deepEqual(calls, [[PID, 0]]);
  });
  test(`无健康结果：${mode} 登记与本次启动模式不同也不能另起`, () => {
    assertRefusal(lr.classifyInstance({
      health: null, record: recordOf(mode), hostname: HOST,
      launcherMode: mode === 'strict' ? 'standalone' : 'strict', kill: query('alive', []),
    }));
  });
}

for (const [label, record] of [
  ['无记录', null], ['异机', recordOf('strict', { hostname: 'another-host' })],
  ['坏 schema', recordOf('strict', { schema: -1 })],
  ['无效 PID', recordOf('standalone', { serverPid: null })],
  ['严格记录缺票', recordOf('strict', { ticketId: null })],
]) {
  test(`无健康结果：${label} → 保留原 none 语义，不查询未核实的 PID`, () => {
    assert.equal(lr.classifyInstance({
      health: null, record, hostname: HOST, launcherMode: 'strict',
      kill: () => assert.fail('无有效本机登记不得查进程'),
    }).kind, 'none');
  });
}

function fixture(t, mode, { installed = false } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'health-miss-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codeRoot = path.join(dir, 'checkout');
  const home = path.join(dir, 'home');
  const relHome = path.join(dir, 'release');
  fs.mkdirSync(path.join(codeRoot, '.git'), { recursive: true });
  if (installed) fs.mkdirSync(path.join(codeRoot, 'web', 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(relHome, 'server'), { recursive: true });
  fs.writeFileSync(path.join(relHome, 'server', 'server.cjs'), '// never executed\n');
  const recordFile = lr.recordPath(home);
  const record = recordOf(mode, { serverCodeRoot: relHome });
  lr.writeRecord(recordFile, record);
  const original = fs.readFileSync(recordFile, 'utf8');
  const health = { pid: PID, port: 6060, mode: 'release', codeRoot: relHome, releaseCommit: COMMIT };
  const calls = { install: 0, release: 0, hold: 0, spawn: 0, retire: 0, stop: 0, write: 0, cancel: 0, open: 0 };
  const logs = []; const errors = []; const queries = [];
  const forbid = (name) => () => assert.fail(`未授权动作：${name}`);
  const client = {
    status: (id) => id ? { state: 'granted', title: record.title } : { heartbeatAgeMs: 0 },
    deriveTicketId: () => 'tk-' + 'b'.repeat(20),
    cancel: forbid('cancel'),
  };
  const d = {
    codeRoot, home, relHome, hostname: HOST, env: {},
    loadClient: () => client,
    probeHealth: () => ({ running: false, health: null }),
    readStamp: () => ({ commit: COMMIT }),
    kill: query('alive', queries),
    runInstallDirect: forbid('install'), runInstallExec: forbid('install exec'),
    runRelease: forbid('release'), startUnderHold: forbid('hold'),
    spawnWatcher: forbid('spawn'), retireOwn: forbid('retire'), stopTree: forbid('stop'),
    writeRecord: forbid('write'), openBrowser: forbid('open'),
    log: (s) => logs.push(s), err: (s) => errors.push(s),
  };
  return { d, calls, logs, errors, queries, recordFile, original, health, client };
}

// 观察桩让旧版真实 main 走到错误的新启动，而非因缺模块/意外外部动作提前报错。
function observeActions(f) {
  const { d, calls, client } = f;
  d.runInstallDirect = () => { calls.install++; return 0; };
  d.runInstallExec = async () => { calls.install++; return { exitCode: 0 }; };
  d.runRelease = () => { calls.release++; return 0; };
  d.startUnderHold = async () => { calls.hold++; return { exitCode: 0 }; };
  d.spawnWatcher = () => {
    calls.spawn++;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  };
  d.retireOwn = async () => { calls.retire++; return { ok: true }; };
  d.stopTree = async () => { calls.stop++; return { ok: true }; };
  d.writeRecord = (file, record) => { calls.write++; return lr.writeRecordLocked(file, record); };
  d.openBrowser = () => { calls.open++; };
  client.cancel = async () => { calls.cancel++; return { exitCode: 0 }; };
}
const argvFor = (mode) => mode === 'standalone' ? ['--standalone'] : [];
function assertNoStart(f, { afterRelease = false } = {}) {
  assert.deepEqual(f.calls, {
    install: afterRelease ? 1 : 0, release: afterRelease ? 1 : 0,
    hold: 0, spawn: 0, retire: 0, stop: 0, write: 0, cancel: 0, open: 0,
  });
  assert.equal(fs.readFileSync(f.recordFile, 'utf8'), f.original, '归属记录逐字节保留');
  assert.equal(fs.existsSync(f.recordFile + '.lock'), false, '拒绝返回也释放启动互斥');
  assert.match(f.errors.join('\n'), /健康检查未响应.*仍活着或无法确认已退出/);
  assert.match(f.errors.join('\n'), /稍后重试或检查/);
  assert.doesNotMatch(f.logs.join('\n'), /复用本启动器|看板服务已起稳|本次启动编排完成/);
}

for (const mode of ['strict', 'standalone']) {
  for (const outcome of ['alive', 'EPERM']) {
    test(`main 预检无响应：${mode}/${outcome} 拒绝，所有启动动作零次`, async (t) => {
      const f = fixture(t, mode);
      observeActions(f);
      f.d.kill = query(outcome, f.queries);
      // 基线会安装、发布、写记录并调用 hold/spawn，返回 0；这里必须是真实行为断言红。
      assert.equal(await launcher.main(argvFor(mode), f.d), 1, '不能继续新启动');
      assertNoStart(f);
      assert.deepEqual(f.queries, [[PID, 0]]);
    });
    test(`main 发布后才无响应：${mode}/${outcome} 拒绝新 hold/spawn/退旧/覆盖`, async (t) => {
      const f = fixture(t, mode);
      observeActions(f);
      f.d.kill = query(outcome, f.queries);
      let probes = 0;
      f.d.probeHealth = () => ++probes === 1
        ? { running: true, health: f.health } : { running: false, health: null };
      f.d.readStamp = () => ({ commit: f.calls.release ? NEXT : COMMIT });
      assert.equal(await launcher.main(argvFor(mode), f.d), 1, '第二次失联不能继续新启动');
      assertNoStart(f, { afterRelease: true });
      assert.equal(probes, 2);
      assert.deepEqual(f.queries, [[PID, 0]], '第二次分类使用同一注入依赖，健康存在时不用 PID 授权');
    });
  }
  test(`main ${mode}：已确认 ESRCH 可继续原启动流程`, async (t) => {
    const f = fixture(t, mode);
    observeActions(f);
    f.d.kill = query('ESRCH', f.queries);
    assert.equal(await launcher.main(argvFor(mode), f.d), 0);
    assert.equal(f.calls.install, 1);
    assert.equal(f.calls.release, 1);
    assert.equal(f.calls.hold, mode === 'strict' ? 1 : 0);
    assert.equal(f.calls.spawn, mode === 'standalone' ? 1 : 0);
    assert.equal(f.calls.write, 1);
    assert.equal(f.calls.retire, 0);
    assert.equal(f.calls.stop, 0);
    assert.deepEqual(f.queries, [[PID, 0], [PID, 0]]);
    assert.equal(fs.existsSync(f.recordFile + '.lock'), false);
  });
  test(`main ${mode}：健康同版本仍复用、健康旧版本仍有序换新`, async (t) => {
    for (const upgrade of [false, true]) {
      const f = fixture(t, mode, { installed: true });
      observeActions(f);
      const order = [];
      f.d.probeHealth = () => ({ running: true, health: f.health });
      f.d.kill = query('alive', f.queries);
      f.d.runRelease = () => { f.calls.release++; order.push('release'); return 0; };
      f.d.readStamp = () => ({ commit: upgrade && f.calls.release ? NEXT : COMMIT });
      // 使用真实退旧实现，只将调度撤单及停树换成安全桩。
      f.d.retireOwn = async (opts) => { f.calls.retire++; return lr.retireOwnInstance(opts); };
      f.client.cancel = async () => { f.calls.cancel++; order.push('cancel'); return { exitCode: 0 }; };
      f.d.stopTree = async (pid) => {
        assert.equal(pid, PID); f.calls.stop++; order.push('stop'); return { ok: true };
      };
      const hold = f.d.startUnderHold; const spawn = f.d.spawnWatcher;
      f.d.startUnderHold = (...args) => { order.push('hold'); return hold(...args); };
      f.d.spawnWatcher = (...args) => { order.push('spawn'); return spawn(...args); };
      assert.equal(await launcher.main(argvFor(mode), f.d), 0);
      assert.equal(f.calls.open, upgrade ? 0 : 1);
      assert.equal(f.calls.write, upgrade ? 1 : 0);
      assert.equal(f.calls.retire, upgrade ? 1 : 0);
      assert.deepEqual(f.queries, [], '健康分支沿原归属核验，不用 PID 查询授权');
      assert.deepEqual(order, upgrade
        ? ['release', ...(mode === 'strict' ? ['cancel'] : []), 'stop', mode === 'strict' ? 'hold' : 'spawn']
        : ['release']);
      if (!upgrade) assert.equal(fs.readFileSync(f.recordFile, 'utf8'), f.original);
    }
  });
}
