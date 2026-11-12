'use strict';
// 行为回归（AD-20261113-LAUNCHER-QUEUE-STUCK）：
//   · 发布副本缺 server 时「先查后退」——绝不先退在跑的旧实例再发现起不了新服务（新旧都没了）；
//   · 发布副本完整时照常退旧起新，正常换新路径不被这道检查挡住；
//   · 严格模式的发布命令同样带 --standalone：界面构建直接跑、不去调度台排队（负责人 2026-11-11）。
// 全部动作只用临时数据域与桩：不启动进程、不接触真实票据/发布副本/调度台。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lr = require('../core/launcherRuntime.cjs');
const launcher = require('../cli/launcher.cjs');

const HOST = 'testhost';
const PID = 43101;
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const TICKET = 'tk-' + 'c'.repeat(20);

/** 隔离环境：临时数据根 + 临时检出 + 临时发布副本（server 可按用例缺省）。 */
function fixture(t, { server = true, running = true } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'broken-release-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codeRoot = path.join(dir, 'checkout');
  const home = path.join(dir, 'home');
  const relHome = path.join(dir, 'release');
  fs.mkdirSync(path.join(codeRoot, '.git'), { recursive: true });                 // isGitCheckout 只看 .git 存在
  fs.mkdirSync(path.join(codeRoot, 'web', 'node_modules'), { recursive: true });  // 依赖就绪 → 安装这步跳过
  fs.mkdirSync(relHome, { recursive: true });
  if (server) {
    fs.mkdirSync(path.join(relHome, 'server'), { recursive: true });
    fs.writeFileSync(path.join(relHome, 'server', 'server.cjs'), '// 从不执行\n');
  }
  // 发布副本自带发布 CLI（严格模式优先用它）——只作为参数被记录，绝不执行。
  fs.mkdirSync(path.join(relHome, 'cli'), { recursive: true });
  fs.writeFileSync(path.join(relHome, 'cli', 'index.cjs'), '// 发布副本的发布 CLI（不执行）\n');

  const recordFile = lr.recordPath(home);
  const record = {
    schema: lr.RECORD_SCHEMA, hostname: HOST, mode: 'strict',
    key: 'serve-old-1', ticketId: TICKET, title: lr.residentTitle(HOST),
    wrapperPid: 42002, watcherPid: 42003, serverPid: PID,
    serverCodeRoot: relHome, releaseCommit: OLD, startedAt: '2026-11-13T00:00:00Z',
  };
  let original = null;
  if (running) {
    lr.writeRecord(recordFile, record);
    original = fs.readFileSync(recordFile, 'utf8');
  }
  const health = { service: 'claude-dashboard', pid: PID, port: 6060, mode: 'release', codeRoot: relHome, releaseCommit: OLD };

  const calls = { install: 0, release: 0, retire: 0, hold: 0, spawn: 0, write: 0, stop: 0, cancel: 0, open: 0 };
  const logs = [];
  const errors = [];
  const releaseCmds = [];
  const forbid = (name) => () => assert.fail(`未授权动作：${name}`);
  const client = {
    status: (id) => (id ? { ticketId: id, state: 'running', title: record.title } : { heartbeatAgeMs: 0 }),
    deriveTicketId: (p, k) => 'tk-' + k.slice(-6),
    cancel: async () => { calls.cancel += 1; return { exitCode: 0 }; },
  };
  const d = {
    codeRoot, home, relHome, hostname: HOST, env: {},
    loadClient: () => client,
    probeHealth: () => (running
      ? { running: true, health, text: '本启动器登记的旧版本实例在跑' }
      : { running: false, health: null, text: '' }),
    // 这次发布之前的副本印章 = OLD；发布跑过之后 = NEW（在跑的旧实例因此判为 restart-own-old）。
    readStamp: () => ({ commit: calls.release ? NEW : OLD }),
    runInstallDirect: () => { calls.install += 1; return 0; },
    runInstallExec: async () => { calls.install += 1; return { exitCode: 0 }; },
    runRelease: (cmd) => { calls.release += 1; releaseCmds.push(cmd); return 0; },
    openBrowser: () => { calls.open += 1; },
    retireOwn: async () => { calls.retire += 1; return { ok: true }; },
    startUnderHold: async () => { calls.hold += 1; return { exitCode: 0 }; },
    spawnWatcher: () => { calls.spawn += 1; throw new Error('不该直起看护'); },
    stopTree: async () => { calls.stop += 1; return { ok: true }; },
    writeRecord: (file, rec) => { calls.write += 1; return lr.writeRecordLocked(file, rec); },
    log: (s) => logs.push(s),
    err: (s) => errors.push(s),
  };
  return { dir, codeRoot, home, relHome, recordFile, record, original, health, calls, logs, errors, releaseCmds, d };
}

test('(a) 严格模式：发布副本缺 server → 不退在跑的旧实例、不挂号不起服务，明确报错退出', async (t) => {
  const f = fixture(t, { server: false });
  assert.equal(await launcher.main([], f.d), 1);
  assert.equal(f.calls.release, 1, '发布照跑（先查后退的前提：发布已经结束才判副本）');
  assert.equal(f.calls.retire, 0, '副本缺 server：绝不先退旧实例 —— 先查后退');
  assert.equal(f.calls.hold, 0, '不起新单');
  assert.equal(f.calls.spawn, 0, '不直起看护');
  assert.equal(f.calls.write, 0, '不写登记（旧登记原样保留）');
  assert.equal(f.calls.install, 0, '依赖已就绪，安装这步不掺和');
  assert.equal(fs.readFileSync(f.recordFile, 'utf8'), f.original, '归属登记逐字节原样');
  assert.equal(fs.existsSync(f.recordFile + '.lock'), false, '失败返回也放行启动锁');
  const text = f.errors.join('\n');
  assert.match(text, /没有 server/, '要说清是发布副本缺 server');
  assert.match(text, /旧看板没动/, '要明说在跑的旧看板没被动过');
});

test('(b) 严格模式：副本完整 → 照常退旧起新（正常换新没被这道检查挡住）', async (t) => {
  const f = fixture(t, { server: true });
  assert.equal(await launcher.main([], f.d), 0);
  assert.equal(f.calls.retire, 1, '副本完整才退旧实例');
  assert.equal(f.calls.hold, 1, '退旧之后照常挂新 hold 起新服务');
  assert.equal(f.calls.write, 1, '新生命周期照常接主登记');
});

test('(c) 严格模式发布命令带 --standalone：界面构建直接跑、不去调度台排队', async (t) => {
  const f = fixture(t, { server: true, running: false });
  assert.equal(await launcher.main([], f.d), 0);
  assert.equal(f.releaseCmds.length, 1);
  const cmd = f.releaseCmds[0];
  assert.equal(cmd.args[0], path.join(f.relHome, 'cli', 'index.cjs'),
    '严格模式仍优先发布副本自己的 CLI（选法不变）');
  assert.equal(cmd.args[cmd.args.length - 1], '--standalone',
    '发布命令最后一个参数必须是 --standalone：界面构建直接跑，不挂号排队');
  const at = cmd.args.indexOf('--source');
  assert.ok(at > 0);
  assert.equal(cmd.args[at + 1], f.codeRoot, '仍是同一次发布：--source 指向本检出');
});
