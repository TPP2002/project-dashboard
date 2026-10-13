'use strict';
/**
 * launcherRuntime.test.cjs —— 启动器常驻服务生命周期（DASH-LAUNCHER-NO-SCHED-HOLD-1012 阶段 2）。
 *
 * 要钉死的行为（验收 A1 的真实边界）：
 *   · 模式：默认严格；只有显式 --standalone 才独立；未知参数报错（零决策）。
 *   · 严格第一闸：调度客户端不可用/共享盘不可读/心跳超龄 → 拒绝启动，不触安装、不构建、不起服务、不动旧实例。
 *   · 启动互斥：并发双启动只许一个继续（真多进程竞态），另一个拿到明确的"正在启动/复用"结果，不起第二单。
 *   · hold 形状：只申请 1 核、project/category/workType 合法缺省、root=检出（稳定 cwd 纪律）、
 *     先落归属登记再 hold；每次实际生命周期拿全新幂等键（终态后能再启，不用永久固定已终态键）。
 *   · 归属判定矩阵：探活（只认匹配数据域/DASHBOARD_PORT 语义的实例）+ 归属登记 + 票态三重核验；
 *     复用/换新判定用【本次发布之后】的 stamp（主干换了确实退旧起新；没换只复用不另 hold）。
 *   · 退旧必须确认旧树真退了（stopTree 返回 ok）才起新单；停止失败不冒充、不吞错、不丢登记。
 *   · 严格看护起服务前核验 hold 注入的真实授予（verifyResidentGrant）：常驻单真实授予态是
 *     granted（当拍授予、不迁移 running，等不来 —— M1 实测），按共享盘事实逐条核对 —— 票在、
 *     非终态、resident 请求、SCHED_PERMIT 票号/令牌一致、机器/类别/核数一致、驻留租约
 *     pid = 本看护的包装进程；缺许可/错票号/伪造令牌/终态/普通票据/读取不明一律不起服务
 *     （退出码 2，不伪造许可、不用"总是 ok"的许可桩冒充实机）。
 *   · 看护判定：外部终态/票据消失/父链断开 → 停；共享盘持续不可读超预算（在断租销单窗口之内）→ 停(3) 且先停进程再退单。
 *   · 看护进程真实生命周期（起真子进程的端到端）：上述触发都真的停掉自己 spawn 的 server。
 *   · 归属登记身份守卫：登记写着别的生命周期键就不拼改、不覆盖；自己 key 对上才写。
 *   · Windows 参数与 cwd：cmd /c npm、taskkill /T /F 整树、绝对路径 Node argv 数组。
 *
 * 所有用例不起生产服务、不连真共享盘：调度客户端一律注入假件；真子进程只起 sleep 型 dummy。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const lr = require('../core/launcherRuntime.cjs');
const launcher = require('../cli/launcher.cjs');
const { CODE_ROOT } = require('../core/runtimeRoot.cjs');

const SHAM = 'a'.repeat(40);
const tmp = (p) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };
/** 与真实客户端 residentLeaseFile 同判据的租约路径：<share>/sched/leases/<单号>.json。 */
const leaseFileOf = (share, id) => path.join(share, 'sched', 'leases', `${id}.json`);

/** 一套隔离的启动器环境：临时数据根 + 临时发布副本（带假 server）。 */
function makeEnv() {
  const dir = tmp('lnc-');
  const home = path.join(dir, 'home');
  const relHome = path.join(dir, 'rel');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(relHome, 'server'), { recursive: true });
  fs.writeFileSync(path.join(relHome, 'server', 'server.cjs'), '// fake server\n');
  const recordFile = path.join(home, 'launcher-instance.json');
  const health = { service: 'claude-dashboard', pid: 1001, port: 6060, mode: 'release', codeRoot: relHome, releaseCommit: SHAM };
  return { dir, home, relHome, recordFile, health };
}

/** main() 的依赖注入基座：所有外部动作默认"不许发生"，用例各自覆写期望发生的那几个。 */
function deps(env, over = {}) {
  return {
    platform: process.platform,
    hostname: 'testhost',
    env: {},
    codeRoot: CODE_ROOT,
    home: env.home,
    relHome: env.relHome,
    now: () => new Date('2026-10-14T00:00:00Z'),
    random: Math.random,
    readStamp: () => ({ commit: SHAM }),
    loadClient: () => { throw new Error('不该加载调度客户端'); },
    verifyReady: () => ({ ok: true }),
    probeHealth: () => ({ running: false, health: null, text: '' }),
    runInstallDirect: () => { throw new Error('不该直跑安装'); },
    runInstallExec: async () => { throw new Error('不该走调度安装'); },
    runRelease: () => { throw new Error('不该跑发布'); },
    openBrowser: () => { throw new Error('不该开浏览器'); },
    startUnderHold: async () => { throw new Error('不该 hold 起服务'); },
    spawnWatcher: () => { throw new Error('不该直起看护'); },
    stopTree: () => { throw new Error('不该停任何进程'); },
    retireOwn: lr.retireOwnInstance,
    readRecord: lr.readRecord,
    writeRecord: lr.writeRecord,
    log: () => {},
    err: () => {},
    ...over,
  };
}

function strictRecord(over = {}) {
  return {
    schema: 1, hostname: 'testhost', mode: 'strict',
    key: 'serve-t-1', ticketId: 'tk-' + 'a'.repeat(20), title: lr.residentTitle('testhost'),
    wrapperPid: 9, watcherPid: 8, serverPid: 1001,
    serverCodeRoot: 'REL', releaseCommit: SHAM, startedAt: '2026-10-14T00:00:00Z',
    ...over,
  };
}

/** 假调度客户端：status 可指定票态/标题/抛错。 */
function fakeClient(state = 'running', title = lr.residentTitle('testhost')) {
  return {
    status: (id) => {
      if (state === 'throw') throw new Error('共享盘读不动');
      return { ticketId: id, state, title };
    },
    cancel: async () => ({ exitCode: 0 }),
    deriveTicketId: (p, k) => 'tk-' + k.slice(-6),
    hold: async () => ({ exitCode: 0 }),
  };
}

// ——————— 模式与参数 ———————

test('模式：默认严格；只有显式 --standalone 才独立；未知参数报错', () => {
  assert.deepEqual(launcher.parseLauncherArgs([]), { standalone: false });
  assert.deepEqual(launcher.parseLauncherArgs(['--standalone']), { standalone: true });
  assert.throws(() => launcher.parseLauncherArgs(['--whatever']), /不认识的参数/);
});

test('幂等键：每次实际生命周期唯一、SAFE_SEGMENT 内、主机名清洗、终态后再启是新键', () => {
  const now = new Date('2026-10-14T00:00:00Z');
  const keys = new Set();
  for (let i = 0; i < 300; i++) keys.add(lr.newLifecycleKey('serve', { now }));
  assert.equal(keys.size, 300, '同一毫秒内 300 个键也必须全不一样');
  for (const k of keys) assert.match(k, /^serve-[A-Za-z0-9._-]+$/);
  assert.ok([...keys].every((k) => k.length <= 64), '键要落在共享盘 SAFE_SEGMENT 的长度内');
  const weird = lr.newLifecycleKey('serve', { hostname: '我的 机器#1', now });
  assert.match(weird, /^serve-[A-Za-z0-9._-]+$/, '非安全字符（含中文/空格/#）必须清洗');
  assert.notEqual(
    lr.newLifecycleKey('serve', { now: new Date('2026-10-14T00:00:00Z') }),
    lr.newLifecycleKey('serve', { now: new Date('2026-10-14T00:00:01Z') }),
    '不同生命周期不许共用键 —— 固定已终态键会让"停了再启"卡死',
  );
});

test('Windows 安装参数：cmd /c npm 显式包装；类 Unix 直接 npm；cwd 都是 web', () => {
  const webRoot = tmp('web-install-');   // 平台生成的真实路径（占位盘符会被路径形状闸拦下）
  assert.deepEqual(lr.npmInstallCommand('win32', webRoot), { command: 'cmd', args: ['/c', 'npm', 'install'], cwd: webRoot });
  assert.deepEqual(lr.npmInstallCommand('linux', '/w/web'), { command: 'npm', args: ['install'], cwd: '/w/web' });
  clean(webRoot);
});

test('看护 argv：绝对路径 Node 数组 + -- 分隔；parse 往返一致（含 --key）；缺件报错', () => {
  const runtimePath = path.resolve('/x/core/launcherRuntime.cjs');
  const ticketId = 'tk-' + 'ab'.repeat(10);
  const args = lr.watcherArgv({
    runtimePath, ticketId, share: path.resolve('/s'), wrapperPid: 4242,
    recordFile: path.resolve('/h/rec.json'), serverPath: path.resolve('/r/server/server.cjs'),
    serverArgs: ['--port', '6060'], key: 'serve-h-20261014000000-abc123',
  });
  assert.equal(args[0], runtimePath);
  assert.equal(args[1], '--watch-server');
  assert.ok(path.isAbsolute(args[0]) && path.isAbsolute(args[args.indexOf('--server') + 1]));
  assert.deepEqual(args.slice(2, 6), ['--wrapper', '4242', '--record', path.resolve('/h/rec.json')]);
  const parsed = lr.parseWatchArgs(args.slice(2));
  assert.equal(parsed.wrapperPid, 4242);
  assert.equal(parsed.ticketId, ticketId);
  assert.equal(parsed.share, path.resolve('/s'));
  assert.equal(parsed.key, 'serve-h-20261014000000-abc123', '生命周期键要带到看护，登记换主核对比对的就是它');
  assert.deepEqual(parsed.serverArgs, ['--port', '6060']);
  // 独立模式形态：无票据
  const solo = lr.parseWatchArgs(lr.watcherArgv({ runtimePath, wrapperPid: 1, recordFile: path.resolve('/h/r.json'), serverPath: path.resolve('/s.cjs') }).slice(2));
  assert.equal(solo.ticketId, null);
  assert.equal(solo.key, null);
  assert.throws(() => lr.parseWatchArgs(['--wrapper', '1', '--record', 'r']), /--server/);
  assert.throws(() => lr.parseWatchArgs(['--server', 's', '--wrapper', '1', '--record', 'r', '--ticket', 't']), /--share/);
});

// ——————— 停自己的子树 ———————

test('stopTree：Windows taskkill /T /F 整树 + 确认退出；类 Unix SIGTERM 有界异步等 → SIGKILL；等不到就如实报败', async () => {
  const calls = [];
  const r1 = await lr.stopTree(4242, {
    platform: 'win32',
    spawnSync: (cmd, args) => { calls.push([cmd, args]); return { status: 0 }; },
    kill: (p, s) => { if (s === 0) { const e = new Error('gone'); e.code = 'ESRCH'; throw e; } },  // taskkill 后立刻确认已退
  });
  assert.equal(r1.ok, true);
  assert.deepEqual(calls[0], ['taskkill', ['/pid', '4242', '/T', '/F']]);

  // taskkill 报成功但进程一直不退 → 不许冒充"已停止"
  const r1b = await lr.stopTree(4243, {
    platform: 'win32',
    spawnSync: () => ({ status: 0 }),
    kill: (p, s) => { if (s === 0) { /* 一直活着 */ } },
    graceMs: 60, delayMs: 10,
  });
  assert.equal(r1b.ok, false, '确认不了退出就要报败');
  assert.match(r1b.reason, /未见进程/);

  const sigs = [];
  const killGone = (p, s) => { sigs.push(s); if (s === 0) { const e = new Error('gone'); e.code = 'ESRCH'; throw e; } };
  const t0 = Date.now();
  const r2 = await lr.stopTree(7, { platform: 'linux', kill: killGone, graceMs: 20 });
  assert.equal(r2.ok, true);
  assert.ok(sigs.includes('SIGTERM'));
  assert.ok(!sigs.includes('SIGKILL'), '进程已消失就不补刀');
  assert.ok(Date.now() - t0 < 2000, '等退出是异步有界的，不是忙等占核');

  const sigs2 = [];
  const killStubborn = (p, s) => {   // SIGTERM 阶段打死不走，SIGKILL 之后才真退
    sigs2.push(s);
    if (s === 0 && sigs2.includes('SIGKILL')) { const e = new Error('gone'); e.code = 'ESRCH'; throw e; }
  };
  const r3 = await lr.stopTree(7, { platform: 'linux', kill: killStubborn, graceMs: 40, delayMs: 10 });
  assert.equal(r3.ok, true);
  assert.ok(sigs2.includes('SIGTERM'));
  assert.ok(sigs2.includes('SIGKILL'), '宽限过了还在就必须 SIGKILL');

  // SIGKILL 之后还退不掉 → 如实报败（调用方不得宣布已停止）
  let sigkilled = false;
  const killImmortal = (p, s) => {
    if (s === 'SIGKILL') sigkilled = true;
    if (s === 0) { const e = new Error('alive'); e.code = 'EPERM'; throw e; }   // 查活=权限拒绝（按活着处理）
  };
  const r3b = await lr.stopTree(9, { platform: 'linux', kill: killImmortal, graceMs: 30, delayMs: 10 });
  assert.equal(r3b.ok, false);
  assert.ok(sigkilled, '补了 SIGKILL 也确认不了退出 → 报败');

  assert.equal((await lr.stopTree(0, { platform: 'linux' })).ok, false, 'pid 不合法直接拒');
});

// ——————— 启动互斥 + 许可票号 ———————

test('启动互斥：独占创建；持锁进程活着别人拿不到；进程死了陈锁可清；release 后可再抢', () => {
  const dir = tmp('mtx-');
  const file = path.join(dir, 'launcher-instance.json.lock');
  const deadPid = spawn(process.execPath, ['-e', '']);
  return new Promise((resolve) => deadPid.once('exit', resolve)).then(() => {
    const a = lr.acquireLaunchMutex(file);
    assert.ok(a, '没人持锁 → 拿到');
    assert.equal(lr.acquireLaunchMutex(file, { kill: (p, s) => { if (s === 0) { const e = new Error('alive'); e.code = 'EPERM'; throw e; } } }), null,
      '持锁进程活着 → 第二个拿不到（不抢）');
    a.release();
    const b = lr.acquireLaunchMutex(file);
    assert.ok(b, 'release 之后能再抢');
    b.release();
    // 陈锁：持锁 pid 已死 → 清掉并拿到
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: deadPid.pid }));
    const c = lr.acquireLaunchMutex(file);
    assert.ok(c, '持锁进程已死 → 陈锁清理后拿到');
    c.release();
    // 锁文件内容坏掉【且够老】→ 按残骸清；坏而还新＝有人正拿着锁，绝不偷。
    // 特别地：独占创建到 JSON 落盘之间就是【空文件】，读到空/不完整只能拒抢，绝不当陈锁自动删。
    fs.writeFileSync(file, '');
    assert.equal(lr.acquireLaunchMutex(file), null, '空锁文件（正写到一半）→ 拒抢');
    fs.writeFileSync(file, '{"pid": ');
    assert.equal(lr.acquireLaunchMutex(file), null, '不完整 JSON（正写到一半）→ 拒抢');
    fs.writeFileSync(file, 'not-json');
    assert.equal(lr.acquireLaunchMutex(file), null, '内容坏但文件还新 → 当作有人正在写，不抢');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(file, old, old);
    const e2 = lr.acquireLaunchMutex(file);
    assert.ok(e2, '锁文件残骸够老（绝不可能是正常写盘窗口）→ 按陈锁清理后拿到');
    e2.release();
    clean(dir);
  });
});

test('启动互斥（真多进程并发）：恰有一个进程持锁贯穿 await，其余明确拿不到 —— 不靠一个短退冒充', { timeout: 30000 }, async () => {
  const dir = tmp('mtxr-');
  const file = path.join(dir, 'lock');
  const marker = path.join(dir, 'holders.txt');
  const goFile = path.join(dir, 'GO');
  const driver = path.join(dir, 'driver.cjs');
  const runtimePath = path.resolve(__dirname, '..', 'core', 'launcherRuntime.cjs');
  fs.writeFileSync(driver, [
    'const fs = require(\'node:fs\');',
    `const lr = require(${JSON.stringify(runtimePath)});`,
    '(async () => {',
    '  // 发令枪：四个进程都等 GO 文件出现再同时抢，保证真并发（不靠 Node 启动快慢碰运气）',
    `  const go = ${JSON.stringify(goFile)};`,
    '  const t0 = Date.now();',
    "  while (!fs.existsSync(go) && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 15));",
    `  const lock = lr.acquireLaunchMutex(${JSON.stringify(file)}, { attempts: 1 });`,
    "  if (!lock) { console.log('BUSY'); process.exit(0); }",
    '  await new Promise((r) => setTimeout(r, 300));   // 持锁跨 await，锁有效性不能依赖文件句柄',
    `  fs.appendFileSync(${JSON.stringify(marker)}, 'H\\n');`,
    '  lock.release();',
    "  console.log('OK');",
    '})();',
  ].join('\n'));
  const kids = [];
  for (let i = 0; i < 4; i++) {
    kids.push(spawn(process.execPath, [driver], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }));
  }
  await new Promise((r) => setTimeout(r, 800));   // 等四个都起好、都进入等 GO
  fs.writeFileSync(goFile, 'go');
  const outs = await Promise.all(kids.map((k) => new Promise((res) => {
    let o = ''; k.stdout.on('data', (d) => { o += d; });
    k.once('exit', () => res(o.trim()));
  })));
  const holders = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0;
  assert.equal(holders, 1, '四个进程同时抢、各持锁 300ms 跨 await —— 真正持锁的只能有一个');
  assert.equal(outs.filter((o) => o === 'BUSY').length, 3, '其余三个要明确知道自己没拿到');
  clean(dir);
});

test('SCHED_PERMIT 票号段解析：与本单一致才放行，语义核验在 verifyResidentGrant，这里只对票号', () => {
  const tid = 'tk-' + 'ab'.repeat(10);
  assert.equal(lr.permitTicketId(`${tid}:a1:tok`), tid);
  assert.equal(lr.permitTicketId('tk-zzzz:a1:tok'), null, '格式不对就 null（语义校验在客户端）');
  assert.equal(lr.permitTicketId(undefined), null);
  assert.equal(lr.permitTicketId(`${'tk-' + 'cd'.repeat(10)}:a2:x`), 'tk-' + 'cd'.repeat(10));
});

// ——————— 数据域探活 + 浏览器豁免（R5，只适配既有接口） ———————

test('探活语义：DASHBOARD_PORT=0 隔离自检不扫描；指定端口只扫那段；缺省 6060~6068', () => {
  let scans = 0;
  const scan = () => { scans += 1; return { running: false, health: null, text: '' }; };
  const p0 = launcher.probeOwnScope({ DASHBOARD_PORT: '0' }, { scan });
  assert.equal(scans, 0, '隔离自检：压根不扫描，绝不碰生产 6060');
  assert.match(p0.text, /不扫描/);
  launcher.probeOwnScope({ DASHBOARD_PORT: '6100' }, { scan });
  assert.equal(scans, 1);
  assert.equal(launcher.probeOptsFromEnv({}).portBase, 6060);
  assert.equal(launcher.probeOptsFromEnv({ DASHBOARD_PORT: '6100' }).portBase, 6100);
  assert.equal(launcher.probeOptsFromEnv({ DASHBOARD_PORT: '0' }), null);
});

test('探活语义：不同数据域的看板不是自有候选 —— 不接管、不换新、不冒充归属', () => {
  const home = path.resolve('/dh');
  const env = { DASHBOARD_HOME: home };
  const scanCalledWith = [];
  const scan = (opts) => {
    scanCalledWith.push(opts);
    return { running: true, health: { service: 'claude-dashboard', pid: 555, port: 6100, registryPath: path.resolve('/other/registry.json'), dataRoot: path.resolve('/other') } };
  };
  const r = launcher.probeOwnScope(env, { scan });
  assert.equal(r.running, false, '异域实例不当自有候选');
  assert.match(r.text, /别的数据域/);
  assert.ok(scanCalledWith[0].portBase > 0);
  // 同域：原样透传
  const r2 = launcher.probeOwnScope(env, { scan: () => ({ running: true, health: { pid: 556, port: 6060, registryPath: path.join(home, 'registry.json'), dataRoot: home } }) });
  assert.equal(r2.running, true);
  // sameDataScope：registry/dataRoot 对不上不同域；老版本健康（无域字段）只在无显式覆盖时同域
  assert.equal(launcher.sameDataScope({ registryPath: path.join(home, 'registry.json'), dataRoot: home }, env), true);
  assert.equal(launcher.sameDataScope({ registryPath: path.resolve('/x/registry.json'), dataRoot: path.resolve('/x') }, env), false);
  assert.equal(launcher.sameDataScope({ pid: 1 }, {}), true);
  assert.equal(launcher.sameDataScope({ pid: 1 }, { DASHBOARD_PORT: '6060' }), false);
});

test('openBrowser：DASHBOARD_NO_OPEN=1 时不弹浏览器（与 server 同款豁免）', () => {
  let spawned = 0;
  const deps = { spawn: () => { spawned += 1; return { unref() {} }; } };
  launcher.openBrowser('http://127.0.0.1:6060/', { ...deps, env: { DASHBOARD_NO_OPEN: '1' } });
  assert.equal(spawned, 0, '隔离/脚本场景不许弹用户浏览器');
  launcher.openBrowser('http://127.0.0.1:6060/', { ...deps, env: {} });
  assert.equal(spawned, 1);
});

// ——————— 派单员心跳门槛（R4：超龄=调度台实质失效） ———————

test('严格许可：派单员心跳超龄/缺失 → 不 ready；新鲜 → ready', () => {
  const client = (overview) => ({ status: () => overview });
  const ok = launcher.verifySchedulingReady(client({ heartbeatAgeMs: 60_000, queued: 0, granted: 1 }), 'S');
  assert.equal(ok.ok, true);
  const stale = launcher.verifySchedulingReady(client({ heartbeatAgeMs: launcher.HEARTBEAT_MAX_AGE_MS + 1 }), 'S');
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /心跳/);
  const noAge = launcher.verifySchedulingReady(client({ queued: 0 }), 'S');
  assert.equal(noAge.ok, false, '报不出心跳时效就不许当作活着');
  assert.equal(launcher.HEARTBEAT_MAX_AGE_MS, 120000, '门槛=负责人指定的 120 秒');
  const unreadable = launcher.verifySchedulingReady({ status: () => { throw new Error('盘没了'); } }, 'S');
  assert.equal(unreadable.ok, false);
});

test('共享盘失联停止预算计入已有租约年龄与看护间隔：默认 60 秒', () => {
  assert.equal(lr.DEFAULT_SHARE_FAIL_BUDGET_MS, 60000);
  assert.ok(lr.DEFAULT_SHARE_FAIL_BUDGET_MS < 120000, '必须先于断租销单收场：先停自有进程、再退单');
});

// ——————— 归属判定矩阵（探活 + 归属登记 + 票态，绝不凭 PID 单独假定归属） ———————

const base = {
  launcherMode: 'strict', client: fakeClient(), share: 'S', hostname: 'testhost',
  stamp: { commit: SHAM }, releaseRoot: 'REL',
};
const healthOf = (over = {}) => ({ service: 'claude-dashboard', pid: 1001, port: 6060, mode: 'release', codeRoot: 'REL', releaseCommit: SHAM, ...over });

test('归属判定：没实例→正常启动；开发实例→拒接', () => {
  assert.equal(lr.classifyInstance({ ...base, health: null }).kind, 'none');
  const dev = lr.classifyInstance({ ...base, health: healthOf({ mode: 'dev', codeRoot: 'DEV', releaseCommit: null }) });
  assert.equal(dev.kind, 'refuse');
  assert.match(dev.reason, /开发实例/);
});

test('归属判定：没登记/登记失效/进程号对不上 → 拒接且一个进程都不动', () => {
  assert.equal(lr.classifyInstance({ ...base, health: healthOf(), record: null }).kind, 'refuse');
  assert.equal(lr.classifyInstance({ ...base, health: healthOf({ pid: 2002 }), record: strictRecord() }).kind, 'refuse');
  assert.equal(lr.classifyInstance({ ...base, health: healthOf(), record: strictRecord({ hostname: '别人' }) }).kind, 'refuse');
  assert.equal(lr.classifyInstance({ ...base, health: healthOf(), record: { foo: 1 } }).kind, 'refuse');
});

test('归属判定：跨模式拒接 —— 严格实例对独立模式、独立实例对严格模式', () => {
  assert.equal(lr.classifyInstance({ ...base, launcherMode: 'standalone', client: null, share: null, health: healthOf(), record: strictRecord() }).kind, 'refuse');
  const soloRec = strictRecord({ mode: 'standalone', ticketId: null, title: null });
  assert.equal(lr.classifyInstance({ ...base, health: healthOf(), record: soloRec }).kind, 'refuse');
});

test('归属判定：票态核验 —— 终态/核验失败/标题不符 → 拒接；running → 通过', () => {
  assert.equal(lr.classifyInstance({ ...base, client: fakeClient('cancelled'), health: healthOf(), record: strictRecord() }).kind, 'refuse');
  assert.equal(lr.classifyInstance({ ...base, client: fakeClient('voided'), health: healthOf(), record: strictRecord() }).kind, 'refuse');
  assert.equal(lr.classifyInstance({ ...base, client: fakeClient('throw'), health: healthOf(), record: strictRecord() }).kind, 'refuse');
  assert.equal(lr.classifyInstance({ ...base, client: fakeClient('running', '别人的单'), health: healthOf(), record: strictRecord() }).kind, 'refuse');
  assert.equal(lr.classifyInstance({ ...base, health: healthOf(), record: strictRecord() }).kind, 'reuse');
});

test('归属判定：同版本复用；旧版本换新；NO_RESTART 复用旧实例；独立登记按登记+进程号核验', () => {
  assert.equal(lr.classifyInstance({ ...base, health: healthOf(), record: strictRecord() }).kind, 'reuse');
  const oldHealth = healthOf({ releaseCommit: 'b'.repeat(40) });
  assert.equal(lr.classifyInstance({ ...base, health: oldHealth, record: strictRecord() }).kind, 'restart-own-old');
  assert.equal(lr.classifyInstance({ ...base, health: oldHealth, record: strictRecord(), noRestart: true }).kind, 'reuse-old');
  const soloRec = strictRecord({ mode: 'standalone', ticketId: null, title: null });
  assert.equal(lr.classifyInstance({ ...base, launcherMode: 'standalone', client: null, share: null, health: healthOf(), record: soloRec }).kind, 'reuse');
});

// ——————— 看护一拍的纯判定 ———————

test('看护判定：父链断开/外部终态/票据消失 → 停；持续不可读超预算 → 停(3)；其余 → 继续', () => {
  const rd = (r) => () => r;
  const dead = lr.watchDecision({ ticketId: 't', wrapperAlive: false, readStatus: rd({ ok: true, state: 'running' }) });
  assert.equal(dead.action, 'stop');
  assert.equal(dead.code, 0);
  assert.equal(dead.wrapperDied, true, '父链断开要带 wrapperDied 标记：停成后看护优先正式退自己的单');
  const term = lr.watchDecision({ ticketId: 't', wrapperAlive: true, readStatus: rd({ ok: true, state: 'cancelled' }) });
  assert.equal(term.action, 'stop');
  assert.equal(term.code, 0);
  assert.ok(!('wrapperDied' in term), '票据已终态不用再退单（账已被外部 cancel 收掉）');
  assert.match(term.reason, /cancelled/);
  const missing = lr.watchDecision({ ticketId: 't', wrapperAlive: true, readStatus: rd({ ok: false, missing: true, error: '单子不存在' }) });
  assert.equal(missing.action, 'stop');
  assert.equal(missing.code, 0);
  const cont = lr.watchDecision({ ticketId: 't', wrapperAlive: true, readStatus: rd({ ok: false, missing: false, error: 'IO' }), shareFailMs: 1000, shareFailBudgetMs: 5000 });
  assert.equal(cont.action, 'continue');
  const stop3 = lr.watchDecision({ ticketId: 't', wrapperAlive: true, readStatus: rd({ ok: false, missing: false, error: 'IO' }), shareFailMs: 6000, shareFailBudgetMs: 5000 });
  assert.equal(stop3.action, 'stop');
  assert.equal(stop3.code, 3);
  assert.equal(lr.watchDecision({ ticketId: 't', wrapperAlive: true, readStatus: rd({ ok: true, state: 'granted' }) }).action, 'continue');
  // 独立模式（无票据）：只看包装进程死活
  assert.equal(lr.watchDecision({ ticketId: null, wrapperAlive: true, readStatus: rd({ ok: false }) }).action, 'continue');
});

// ——————— 启动编排（cli/launcher.cjs main，依赖全注入） ———————

test('严格第一闸：调度客户端加载失败 → 拒绝启动，不安装、不构建、不起服务、不动在跑实例', async () => {
  const e = makeEnv();
  const errs = [];
  const d = deps(e, {
    loadClient: () => { throw new Error('排队客户端不可用，启动已拒绝（严格模式不降级、不裸跑）'); },
    probeHealth: () => ({ running: true, health: e.health, text: '在跑' }),
    err: (m) => errs.push(m),
  });
  const code = await launcher.main([], d);
  assert.equal(code, 1);
  assert.match(errs.join('\n'), /拒绝/);
  clean(e.dir);
});

test('严格第一闸：共享盘读不动 → 拒绝启动（不降级）', async () => {
  const e = makeEnv();
  const errs = [];
  const d = deps(e, {
    loadClient: () => fakeClient(),
    verifyReady: () => ({ ok: false, reason: '调度台不可读' }),
    err: (m) => errs.push(m),
  });
  const code = await launcher.main([], d);
  assert.equal(code, 1);
  assert.match(errs.join('\n'), /不可读/);
  clean(e.dir);
});

test('严格启动：hold 只申请 1 核、先落归属登记、root=检出、watcher 指向发布副本 server；重启拿新键', async () => {
  const e = makeEnv();
  const checkout = path.join(e.dir, 'checkout');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });                 // isGitCheckout 只看 .git 存在
  fs.mkdirSync(path.join(checkout, 'web', 'node_modules'), { recursive: true });  // 依赖就绪 → 装依赖这步确定性跳过
  const holds = [];
  const releaseCalls = [];
  const fake = {
    status: () => ({}),
    deriveTicketId: (p, k) => 'tk-' + k.slice(-6),
  };
  // 旧发布副本里带着自己的发布 CLI —— 缺省严格模式照旧【优先副本 CLI】（R8 后一字不改）
  fs.mkdirSync(path.join(e.relHome, 'cli'), { recursive: true });
  fs.writeFileSync(path.join(e.relHome, 'cli', 'index.cjs'), '// 旧副本的发布 CLI\n');
  const d = deps(e, {
    loadClient: () => fake, codeRoot: checkout,
    runRelease: (cmd) => { releaseCalls.push(cmd); return 0; },
    startUnderHold: async (c, o) => { holds.push(o); return { exitCode: 0 }; },
  });
  assert.equal(await launcher.main([], d), 0);
  assert.equal(holds.length, 1);
  assert.equal(releaseCalls[0].args[0], path.join(e.relHome, 'cli', 'index.cjs'),
    '缺省严格模式优先用发布副本自己的发布 CLI（同 SHA 现场构建，行为不变）');
  assert.ok(!releaseCalls[0].args.includes('--standalone'), '缺省严格模式绝不夹带独立旗标');
  const h1 = holds[0];
  assert.equal(h1.cores, 1, '常驻只申请 1 核（实据见 docs/launcher-hold-1014.md）');
  assert.equal(h1.project, 'dashboard');
  assert.equal(h1.category, 'other');
  assert.equal(h1.workType, 'other');
  assert.equal(h1.root, checkout, 'hold 的 root/稳定 cwd 必须留在检出（EBUSY 纪律）');
  assert.equal(h1.command, process.execPath);
  assert.equal(h1.args[1], '--watch-server');
  assert.ok(h1.args.includes(path.join(e.relHome, 'server', 'server.cjs')), 'server 一律来自发布副本');
  assert.equal(h1.title, lr.residentTitle('testhost'));
  const keyAt = h1.args.indexOf('--key');
  assert.ok(keyAt > 0 && h1.args[keyAt + 1] === h1.key, '看护进程必须带着本单生命周期键（--key），登记换主才有身份可核');
  const rec1 = JSON.parse(fs.readFileSync(e.recordFile, 'utf8'));
  assert.equal(rec1.mode, 'strict');
  assert.equal(rec1.key, h1.key);
  assert.equal(rec1.ticketId, 'tk-' + h1.key.slice(-6));
  assert.equal(rec1.releaseCommit, SHAM);
  assert.equal(rec1.serverPid, null, 'hold 之前登记里还没有 serverPid（看护进程才补记）');
  // 停了再启：全新键、全新单号 —— 不用永久固定已终态键
  await launcher.main([], d);
  assert.equal(holds.length, 2);
  assert.notEqual(holds[1].key, holds[0].key);
  assert.notEqual(holds[1].ticketId ?? 'tk-' + holds[1].key.slice(-6), 'tk-' + holds[0].key.slice(-6));
  clean(e.dir);
});

test('同版本重复启动（主干没更新）：发布照跑、之后只复用 —— 不重复挂号、不重复占核、不退旧进程', async () => {
  const e = makeEnv();
  lr.writeRecord(e.recordFile, strictRecord());
  const opened = [];
  let held = 0;
  let releases = 0;
  let stopped = 0;
  const d = deps(e, {
    loadClient: () => fakeClient(),
    probeHealth: () => ({ running: true, health: e.health, text: '在跑' }),
    runRelease: () => { releases += 1; return 0; },
    startUnderHold: async () => { held += 1; return { exitCode: 0 }; },
    stopTree: () => { stopped += 1; return { ok: true }; },
    openBrowser: (u) => opened.push(u),
  });
  assert.equal(await launcher.main([], d), 0);
  assert.equal(releases, 1, '复用判定发生在这次发布【之后】—— 每次双击都先检查/发布过最新主干');
  assert.equal(held, 0, '复用就绝不许再挂一张长期占用单');
  assert.equal(stopped, 0, '同版本复用绝不动在跑的进程');
  assert.deepEqual(opened, ['http://127.0.0.1:6060/']);
  clean(e.dir);
});

test('未知实例：预检就明确拒接 —— 不安装、不构建、不碰发布，一个进程都不动', async () => {
  const e = makeEnv();
  const errs = [];
  let installed = 0; let released = 0;
  const d = deps(e, {
    loadClient: () => fakeClient(),
    probeHealth: () => ({ running: true, health: e.health, text: '在跑' }),
    runInstallDirect: () => { installed += 1; return 0; },
    runInstallExec: async () => { installed += 1; return { exitCode: 0 }; },
    runRelease: () => { released += 1; return 0; },
    err: (m) => errs.push(m),
  });
  assert.equal(await launcher.main([], d), 1);
  assert.match(errs.join('\n'), /不接管/);
  assert.equal(installed, 0, '未知归属不许先安装');
  assert.equal(released, 0, '未知归属不许先发布');
  clean(e.dir);
});

test('自己登记的旧版本实例：退旧单、停旧进程、再起新单（全新键）；NO_RESTART 则复用旧实例', async () => {
  const e = makeEnv();
  const checkout = path.join(e.dir, 'checkout');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'web', 'node_modules'), { recursive: true });
  lr.writeRecord(e.recordFile, strictRecord({ key: 'serve-old-1', ticketId: 'tk-old-old-old' }));
  const cancels = [];
  const stopped = [];
  const holds = [];
  const events = [];   // 换新次序必须：先发布（stamp 换新）→ 再退旧停旧 → 才挂新 hold
  const fake = {
    status: (id) => ({ ticketId: id, state: 'running', title: lr.residentTitle('testhost') }),
    cancel: async (id, o) => { cancels.push([id, o && o.reason]); return { exitCode: 0 }; },
    deriveTicketId: (p, k) => 'tk-' + k.slice(-6),
  };
  const d = deps(e, {
    loadClient: () => fake,
    codeRoot: checkout,
    runRelease: () => { events.push('release'); return 0; },
    startUnderHold: async (c, o) => { events.push('hold'); holds.push(o); return { exitCode: 0 }; },
    readStamp: () => ({ commit: 'b'.repeat(40) }),   // 发布副本已换新 → 在跑的是旧版本
    probeHealth: () => ({ running: true, health: { ...e.health, releaseCommit: SHAM }, text: '旧版在跑' }),
    stopTree: async (pid) => { events.push('stop'); stopped.push(pid); return { ok: true }; },
  });
  assert.equal(await launcher.main([], d), 0);
  assert.deepEqual(events, ['release', 'stop', 'hold'], '发布成功并确认 stamp 换新之后才退旧起新（先装先建，绝不先停旧服务）');
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0][0], 'tk-old-old-old', '先退自己的旧调度单');
  assert.deepEqual(stopped, [1001], '再停自己登记的旧进程');
  assert.equal(holds.length, 1);
  assert.notEqual(holds[0].key, 'serve-old-1', '换新必须拿全新生命周期键');

  // 退旧失败（停止未确认）：不许冒充成功、不许丢登记、绝不重复新起一单（R3）
  const e3 = makeEnv();
  fs.mkdirSync(path.join(e3.dir, 'checkout', '.git'), { recursive: true });
  fs.mkdirSync(path.join(e3.dir, 'checkout', 'web', 'node_modules'), { recursive: true });
  lr.writeRecord(e3.recordFile, strictRecord({ key: 'serve-old-2', ticketId: 'tk-old-old-old' }));
  const holds3 = [];
  const cancels3 = [];
  let released3 = 0;
  const d3 = deps(e3, {
    loadClient: () => ({
      status: (id) => ({ ticketId: id, state: 'running', title: lr.residentTitle('testhost') }),
      cancel: async (id) => { cancels3.push(id); return { exitCode: 0 }; },
      deriveTicketId: (p, k) => 'tk-' + k.slice(-6),
    }),
    codeRoot: path.join(e3.dir, 'checkout'),
    runRelease: () => { released3 += 1; return 0; },
    readStamp: () => ({ commit: 'b'.repeat(40) }),
    probeHealth: () => ({ running: true, health: { ...e3.health, releaseCommit: SHAM }, text: '旧版在跑' }),
    stopTree: async () => ({ ok: false, reason: 'taskkill 已下发但 3000ms 内未见进程 1001 退出' }),
    startUnderHold: async (c, o) => { holds3.push(o); return { exitCode: 0 }; },
    err: () => {},
  });
  assert.equal(await launcher.main([], d3), 1, '停止未确认 → 启动器明确失败，不吞错');
  assert.equal(holds3.length, 0, '旧树没退干净就绝不起新单');
  assert.equal(cancels3.length, 1, '旧票照退（避免账上挂着）');
  assert.equal(released3, 1, '发布已经跑过（次序不变），失败只发生在退旧这步');
  const rec3 = JSON.parse(fs.readFileSync(e3.recordFile, 'utf8'));
  assert.equal(rec3.serverPid, 1001, '归属登记保留（serverExitedAt 不补写），留着人看真相');
  assert.ok(!rec3.serverExitedAt, '不许伪记 server 已退出');
  clean(e3.dir);

  // DASHBOARD_NO_RESTART=1：不动旧实例，复用并明说仍是旧版本（既有换新语义的豁免口）
  const e2 = makeEnv();
  lr.writeRecord(e2.recordFile, strictRecord());
  const opened2 = [];
  let held2 = 0;
  const d2 = deps(e2, {
    loadClient: () => fake,
    env: { DASHBOARD_NO_RESTART: '1' },
    runRelease: () => 0,   // 复用判定发生在这次发布【之后】：发布照跑，只是 stamp 换新后按 NO_RESTART 豁免不退旧
    readStamp: () => ({ commit: 'b'.repeat(40) }),
    probeHealth: () => ({ running: true, health: { ...e2.health, releaseCommit: SHAM }, text: '' }),
    startUnderHold: async () => { held2 += 1; return { exitCode: 0 }; },
    openBrowser: (u) => opened2.push(u),
  });
  assert.equal(await launcher.main([], d2), 0);
  assert.equal(held2, 0);
  assert.deepEqual(opened2, ['http://127.0.0.1:6060/']);
  clean(e.dir);
  clean(e2.dir);
});

test('启动锁只护编排：第一张 hold 没退，锁也已放行 —— 常驻在跑时的双击重新判复用/换新（主干更新 → 真退旧起新）', { timeout: 30000 }, async () => {
  const e = makeEnv();
  const checkout = path.join(e.dir, 'checkout');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'web', 'node_modules'), { recursive: true });
  const lockFile = e.recordFile + '.lock';
  const fake = {
    status: (id) => ({ ticketId: id, state: 'running', title: lr.residentTitle('testhost') }),
    cancel: async () => ({ exitCode: 0 }),
    deriveTicketId: (p, k) => 'tk-' + k.slice(-6),
  };
  // 第一次启动：hold 起了就【不退】（常驻在跑）；看护把 serverPid 补进登记 → 启动锁必须放行
  const holds1 = [];
  const d1 = deps(e, {
    loadClient: () => fake,
    codeRoot: checkout,
    runRelease: () => 0,
    startUnderHold: async (c, o) => {
      holds1.push(o);
      lr.writeRecord(e.recordFile, { ...lr.readRecord(e.recordFile), watcherPid: 8, serverPid: 4321, serverStartedAt: '2026-10-14T00:00:00Z' });
      return new Promise(() => {});   // hold 挂着不回：常驻寿命不归启动锁管
    },
  });
  const first = launcher.main([], d1);   // 故意不 await 整个寿命
  assert.ok(await waitFor(() => !fs.existsSync(lockFile)), '服务起稳后启动锁必须放行 —— 锁绝不停留在常驻寿命上');
  assert.equal(lr.readRecord(e.recordFile).serverPid, 4321, '起稳判定来自登记里的 serverPid');
  assert.equal(holds1.length, 1);
  assert.ok(first instanceof Promise, '第一次启动还在等常驻退出');
  // 第二次双击（常驻仍在跑、锁已放行）：主干更新 → 这次发布把 stamp 换新 → 重新判定为退旧起新，
  // 绝不是"锁活着就复用了事"（那会绕过 R1：在跑用户永远收不到新版）
  const cancels2 = [];
  const stopped2 = [];
  const holds2 = [];
  const d2 = deps(e, {
    loadClient: () => fake,
    codeRoot: checkout,
    runRelease: () => 0,
    readStamp: () => ({ commit: 'b'.repeat(40) }),   // 发布副本已换新
    probeHealth: () => ({ running: true, health: { ...e.health, pid: 4321, releaseCommit: SHAM }, text: '旧版在跑' }),
    stopTree: async (pid) => { stopped2.push(pid); return { ok: true }; },
    startUnderHold: async (c, o) => { holds2.push(o); return { exitCode: 0 }; },
  });
  assert.equal(await launcher.main([], d2), 0);
  assert.deepEqual(stopped2, [4321], '退掉在跑的旧实例进程树');
  assert.equal(holds2.length, 1, '起新单');
  assert.notEqual(holds2[0].key, holds1[0].key, '换新拿全新生命周期键');
  clean(e.dir);
});

test('正在编排中（锁被持）的第二启动：明确"正在编排"、不起第二单、不安装不发布（起稳后锁放行才轮到它）', async () => {
  const e = makeEnv();
  const lock = lr.acquireLaunchMutex(e.recordFile + '.lock');   // 模拟另一个启动器正在编排（未起稳）
  const logs = [];
  const d = deps(e, {
    loadClient: () => fakeClient(),   // 第一闸要先过（闸在锁前）：客户端可用才轮到互斥判定
    log: (m) => logs.push(m),
  });   // 其余基座全 throw：装/建/起任何一步被碰到就炸
  assert.equal(await launcher.main([], d), 0);
  assert.match(logs.join('\n'), /正在编排/, '明确告知正在启动编排中');
  lock.release();
  clean(e.dir);
});

test('显式独立模式：不加载调度客户端；安装直跑；发布带 --standalone；直起看护并透传退出码', async () => {
  const e = makeEnv();
  const checkout = path.join(e.dir, 'checkout');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });   // isGitCheckout 只看 .git 存在
  // 旧发布副本里也带着一份【旧】发布 CLI —— 它不认识 --standalone（R8 实机反证 tk-ba08a92baad4ad4815c0：
  // 自举丢旗标 → 排队构建 → 无调度台发布失败 → 启动器回落旧副本，升级悄悄失效）。
  fs.mkdirSync(path.join(e.relHome, 'cli'), { recursive: true });
  fs.writeFileSync(path.join(e.relHome, 'cli', 'index.cjs'), '// 旧副本的发布 CLI（不认识 --standalone）\n');
  const installCalls = [];
  const releaseCalls = [];
  const spawnCalls = [];
  let loadAttempted = 0;
  const d = deps(e, {
    codeRoot: checkout,
    loadClient: () => { loadAttempted += 1; return {}; },
    runInstallDirect: (cmd) => { installCalls.push(cmd); return 0; },
    runRelease: (cmd) => { releaseCalls.push(cmd); return 0; },
    spawnWatcher: (cmd) => {
      spawnCalls.push(cmd);
      const { EventEmitter } = require('node:events');
      const c = new EventEmitter();
      c.pid = 777;
      queueMicrotask(() => c.emit('exit', 7, null));
      return c;
    },
  });
  assert.equal(await launcher.main(['--standalone'], d), 7, '看护/服务退出码要透传');
  assert.equal(loadAttempted, 0, '独立模式整条链路不经调度台');
  assert.equal(installCalls.length, 1);
  if (process.platform === 'win32') {
    assert.equal(installCalls[0].command, 'cmd');
    assert.deepEqual(installCalls[0].args, ['/c', 'npm', 'install']);
  } else {
    assert.equal(installCalls[0].command, 'npm');
    assert.deepEqual(installCalls[0].args, ['install']);
  }
  assert.equal(installCalls[0].cwd, path.join(checkout, 'web'));
  assert.equal(releaseCalls.length, 1);
  assert.deepEqual(releaseCalls[0].args.slice(-1), ['--standalone'], '独立模式必须把选择传进发布命令');
  assert.equal(releaseCalls[0].args[0], path.join(checkout, 'cli', 'index.cjs'),
    '旧副本存在时 --standalone 也必须选本检出的发布入口 —— 只有当前源码 CLI 有这个旗标的语义（R8）');
  assert.ok(releaseCalls[0].args.includes('--source'));
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, process.execPath);
  assert.ok(spawnCalls[0].args.includes('--watch-server'));
  assert.ok(!spawnCalls[0].args.includes('--ticket'), '独立模式没有票据');
  assert.equal(spawnCalls[0].opts.cwd, checkout, '稳定 cwd 留在检出');
  const rec = JSON.parse(fs.readFileSync(e.recordFile, 'utf8'));
  assert.equal(rec.mode, 'standalone');
  assert.equal(rec.ticketId, null);
  clean(e.dir);
});

test('独立模式遇到严格模式登记的在跑实例：无法核验票据，拒接', async () => {
  const e = makeEnv();
  lr.writeRecord(e.recordFile, strictRecord());
  const errs = [];
  const d = deps(e, { probeHealth: () => ({ running: true, health: e.health, text: '' }), err: (m) => errs.push(m) });
  assert.equal(await launcher.main(['--standalone'], d), 1);
  assert.match(errs.join('\n'), /不接管/);
  clean(e.dir);
});

// ——————— 看护进程真实生命周期（起真子进程的端到端） ———————

/**
 * 在假共享盘上写一张【真实形状】的常驻票据 + 驻留租约（字段与统一调度客户端 hold /
 * readTicket / validatePermit 的判据逐字对齐，permit.resident 为本机真实票据已核字段）：
 * 票面 granted、当前 attempt 带 permit、租约先于看护存在（真实客户端就是先写租约、
 * 再拉起本进程）。leasePid 缺省 = 本测试进程；leaseCores 缺省 = grantedCores（真实 hold
 * 就是按真实授予写租约）。
 */
function grantResident(share, {
  ticketId, state = 'granted', attempt = 'a1', token = 'TOK',
  machine = os.hostname(), category = 'other', workType = 'other',
  grantedCores = 1, permitResident = true, cancelRequested = false,
  resident = true, leasePid = process.pid, leaseCores = grantedCores, withLease = true,
}) {
  const ticketsDir = path.join(share, 'sched', 'tickets');
  fs.mkdirSync(ticketsDir, { recursive: true });
  const request = {
    idempotencyKey: 'key-' + ticketId.slice(-6), project: 'dashboard', submitter: machine,
    category, title: '看板常驻服务 @t', work: { type: workType, targetPaths: ['.'] },
    requestedCores: grantedCores, allowedMachines: [machine],
    codeRef: { kind: 'commit', value: SHAM }, createdAt: '2026-10-14T00:00:00Z',
    ...(resident ? { resident: true } : {}),
  };
  fs.writeFileSync(path.join(ticketsDir, `${ticketId}.json`), JSON.stringify({
    formatVersion: 1, ticketId, idempotencyKey: request.idempotencyKey, contentHash: SHAM,
    request, state, cancelRequested, currentAttemptId: attempt, lastSeq: 1,
    attempts: [{ attemptId: attempt, permit: {
      ticketId, attemptId: attempt, token, machine, category, grantedCores,
      ...(permitResident ? { resident: true } : {}),
    } }],
    timeline: [{ seq: 1, type: 'granted', at: '2026-10-14T00:00:00Z' }],
    updatedAt: '2026-10-14T00:00:00Z',
  }));
  if (withLease) {
    fs.mkdirSync(path.join(share, 'sched', 'leases'), { recursive: true });
    fs.writeFileSync(leaseFileOf(share, ticketId), JSON.stringify({
      schema: 1, ticketId, machine, cores: leaseCores, pid: leasePid, at: '2026-10-14T00:00:00Z',
    }));
  }
}

/**
 * 假共享盘客户端：票面状态由状态文件控制（用例里改文件=外部 cancel 等）；租约判据与真实
 * 客户端同构。【没有 validatePermit】——授予核验已经回到启动器侧的 verifyResidentGrant
 * （读共享盘事实），客户端里再放一个"总是 ok"的许可桩只会冒充实机口径；谁要是把核验改
 * 回去调 client.validatePermit，这里没有这个导出，会当场炸 —— 故意留的绊线。
 */
function makeFakeShare(dir, stateFile) {
  const bin = path.join(dir, 'sched', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'sched.cjs'), [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const STATE = ${JSON.stringify(stateFile)};`,
    'module.exports = {',
    '  status(id) {',
    "    const s = fs.readFileSync(STATE, 'utf8').trim();",
    "    if (s === 'missing') { const e = new Error('单子不存在'); e.exitCode = 2; throw e; }",
    "    if (s === 'broken') throw new Error('共享盘 I/O 不可用');",
    "    return { ticketId: id, title: '看板常驻服务 @t', state: s };",
    '  },',
    "  // 驻留租约路径：与真实客户端 residentLeaseFile 同构（<share>/sched/leases/<单号>.json），",
    '  // 启动器侧的授予核验（verifyResidentGrant）按它读授权方落下的归属事实。',
    '  residentLeaseFile(share, id) {',
    "    return path.join(share, 'sched', 'leases', `${id}.json`);",
    '  },',
    '  hold: async () => ({ exitCode: 0 }),',
    '  exec: async () => ({ exitCode: 0 }),',
    '  cancel: async () => ({ exitCode: 0 }),',
    "  deriveTicketId: (p, k) => 'tk-' + k.slice(-6),",
    '};',
    '',
  ].join('\n'));
}

/**
 * 测试专用的 hold 包装进程替身：等 GO 文件 → 先写驻留租约（pid = 自己，与真实客户端 hold
 * "先写租约、再拉起"的次序与事实一致）→ 把 --wrapper 换成自己的 pid → 直接 spawn 看护
 * （它就是看护的实际父进程）→ 退出码转发。授予核验核的【实际父链】由它构成。
 */
const HOLD_WRAPPER_SCRIPT = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const os = require('node:os');",
  "const cp = require('node:child_process');",
  'const [goFile, leaseFile, ticketId, ...rest] = process.argv.slice(2);',
  'for (let t0 = Date.now(); !fs.existsSync(goFile) && Date.now() - t0 < 15000; ) {}',
  'fs.mkdirSync(path.dirname(leaseFile), { recursive: true });',
  "fs.writeFileSync(leaseFile, JSON.stringify({ schema: 1, ticketId, machine: os.hostname(), cores: 1, pid: process.pid, at: new Date().toISOString() }));",
  'const watcherArgs = [];',
  'for (let i = 0; i < rest.length; i++) {',
  "  if (rest[i] === '--wrapper') { watcherArgs.push('--wrapper', String(process.pid)); i += 1; continue; }",
  '  watcherArgs.push(rest[i]);',
  '}',
  // Windows 默认进程 Job 会随 wrapper 关闭一并终止子树；本用例需让看护存活，验证它主动停服及补记。
  "const child = cp.spawn(process.execPath, watcherArgs, { stdio: 'inherit', detached: true, windowsHide: true });",
  "child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));",
  "child.once('error', () => process.exit(1));",
  '',
].join('\n');

/**
 * 起一个真看护进程：它 spawn 真 dummy server（写 pid 后 sleep），间隔与预算用测试档。
 * 有票据就先在假共享盘上落【真实授予事实】（票据 + 驻留租约，租约 pid = 传给看护的包装进程，
 * 对齐真实客户端"先写租约再拉起"的次序）；granted: false = 故意不写（读不到事实的拒绝用例）。
 * viaWrapper: true 时不直起看护，改起真实中间 wrapper（租约也由它写 —— 测试不知道 pid，不能代写），
 * 测试拿到 GO 文件路径，先备好事实再放行。SCHED_PERMIT 一律【显式覆盖】注入（缺省
 * `${ticketId}:a1:TOK`）—— 自测运行器自己可能带着真许可，绝不能泄漏进被测看护进程；
 * permit: null = 故意不给（缺许可用例）。
 */
function spawnWatcher(env, { ticketId, wrapperPid, interval = 250, budget = 1500, key = 'k', permit, granted = true, token = 'TOK', viaWrapper = false }) {
  const dummy = path.join(env.dir, 'dummy-server.cjs');
  const pidFile = path.join(env.dir, 'dummy.pid');
  fs.writeFileSync(dummy, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 250);\n`);
  fs.writeFileSync(env.recordFile, JSON.stringify({
    schema: 1, hostname: os.hostname(), mode: 'strict',
    key, ticketId, title: '看板常驻服务 @t',
    wrapperPid: process.pid, serverPid: null,
  }));
  if (ticketId && granted !== false) {
    grantResident(env.share, { ticketId, leasePid: wrapperPid, token, withLease: !viaWrapper });
  }
  const args = lr.watcherArgv({
    runtimePath: path.resolve(__dirname, '..', 'core', 'launcherRuntime.cjs'),
    // viaWrapper 时 --wrapper 由真实中间 wrapper 进程换成自己的 pid（占位 -1 不会落到看护眼前）
    ticketId, share: env.share, wrapperPid: viaWrapper ? -1 : wrapperPid,
    recordFile: env.recordFile, serverPath: dummy, key,
  });
  const childEnv = {
    ...process.env,
    DASHBOARD_LAUNCHER_WATCH_INTERVAL_MS: String(interval),
    DASHBOARD_LAUNCHER_WATCH_SHARE_FAIL_BUDGET_MS: String(budget),
  };
  if (permit === null) delete childEnv.SCHED_PERMIT;
  else {
    childEnv.SCHED_PERMIT = permit === undefined ? `${ticketId}:a1:TOK` : permit;
    childEnv.SCHED_GRANTED_CORES = '1';   // 真实客户端授予时注入的核数环境
  }
  let child;
  let goFile = null;
  if (viaWrapper) {
    goFile = path.join(env.dir, 'GO');
    const wrapperFile = path.join(env.dir, 'hold-wrapper.cjs');
    fs.writeFileSync(wrapperFile, HOLD_WRAPPER_SCRIPT);
    child = spawn(process.execPath, [wrapperFile, goFile, leaseFileOf(env.share, ticketId), String(ticketId), ...args], {
      cwd: env.dir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    child = spawn(process.execPath, args, {
      cwd: env.dir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  let output = '';
  child.stdout.on('data', (b) => { output += b; });
  child.stderr.on('data', (b) => { output += b; });
  return { child, pidFile, goFile, output: () => output };
}

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('看护真实生命周期：外部 cancel（票面终态）→ 真的停掉自己管理的 server', { timeout: 30000 }, async () => {
  const e = makeEnv();
  e.share = path.join(e.dir, 'share');
  const stateFile = path.join(e.dir, 'state.txt');
  fs.writeFileSync(stateFile, 'running');
  makeFakeShare(e.share, stateFile);
  const { child, pidFile } = spawnWatcher(e, { ticketId: 'tk-' + 'a'.repeat(20), wrapperPid: process.pid });
  try {
    assert.ok(await waitFor(() => fs.existsSync(pidFile)), 'dummy server 没被看护拉起');
    const rec = JSON.parse(fs.readFileSync(e.recordFile, 'utf8'));
    assert.equal(typeof rec.serverPid, 'number', '看护要把 serverPid 补进归属登记');
    fs.writeFileSync(stateFile, 'cancelled');   // 正式外部 cancel 之后票面就是这个状态
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, '票据终态停服 = 正常收场');
    const rec2 = JSON.parse(fs.readFileSync(e.recordFile, 'utf8'));
    assert.ok(rec2.serverExitedAt, '登记要补记 server 退出时刻');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    clean(e.dir);
  }
});

test('看护真实生命周期：包装进程死亡（父链断开）→ 真的停掉自己管理的 server', { timeout: 30000 }, async () => {
  const e = makeEnv();
  e.share = path.join(e.dir, 'share');
  const stateFile = path.join(e.dir, 'state.txt');
  fs.writeFileSync(stateFile, 'running');
  makeFakeShare(e.share, stateFile);
  // 真实中间 wrapper（hold 的直接 spawn 链就是如此）：看护的实际父进程 = 租约 pid = --wrapper 参数，
  // 授予核验核的【实际父链】由此构成 —— 生产不许拿 CLI 参数冒充事实（R8）。
  const { child: wrapper, pidFile, goFile, output } = spawnWatcher(e, { ticketId: 'tk-' + 'b'.repeat(20), viaWrapper: true });
  try {
    fs.writeFileSync(goFile, 'go');   // 票据事实已备好，放行 wrapper 写租约并拉起看护
    assert.ok(await waitFor(() => fs.existsSync(pidFile)), 'dummy server 没被看护拉起');
    const rec = JSON.parse(fs.readFileSync(e.recordFile, 'utf8'));
    assert.equal(typeof rec.serverPid, 'number', '授予核验（含实际父链）通过后 server 才起');
    const wrapperExit = once(wrapper, 'exit');
    assert.ok(wrapper.kill());   // 只杀 wrapper 本身：看护与 server 都还在，逼看护按父链断开自己收场
    await wrapperExit;
    assert.equal(lr.pidAlive(wrapper.pid), false, '包装进程退出后应确实不可探活');
    assert.ok(await waitFor(() => {
      try { return Boolean(JSON.parse(fs.readFileSync(e.recordFile, 'utf8')).serverExitedAt); }
      catch { return false; }
    }), '包装进程一死，看护必须停掉自己管理的服务并如实补记退出时刻：' + output() +
      JSON.stringify({ watcherAlive: lr.pidAlive(rec.watcherPid), serverAlive: lr.pidAlive(rec.serverPid), rec }));
    const serverPid = Number(fs.readFileSync(pidFile, 'utf8'));
    let serverGone = false;
    try { process.kill(serverPid, 0); } catch { serverGone = true; }
    assert.ok(serverGone, 'server 进程树真的退了，不留散兵');
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill();
    clean(e.dir);
  }
});

test('看护真实生命周期：共享盘持续不可读超过预算 → 停掉自己管理的 server（退出码 3，先停进程再退单）', { timeout: 30000 }, async () => {
  const e = makeEnv();
  e.share = path.join(e.dir, 'share');
  const stateFile = path.join(e.dir, 'state.txt');
  fs.writeFileSync(stateFile, 'running');   // 起服务那刻共享盘还是好的（读不到就不能当授予，起不来的）
  makeFakeShare(e.share, stateFile);
  const { child, pidFile } = spawnWatcher(e, { ticketId: 'tk-' + 'c'.repeat(20), wrapperPid: process.pid, budget: 1200 });
  try {
    assert.ok(await waitFor(() => fs.existsSync(pidFile)), 'dummy server 没被看护拉起');
    fs.writeFileSync(stateFile, 'broken');   // 起来之后共享盘坏掉，持续超过预算
    const [code] = await once(child, 'exit');
    assert.equal(code, 3, '账可能已被按断租超时回收，不能无账长时间运行');
    const rec = JSON.parse(fs.readFileSync(e.recordFile, 'utf8'));
    assert.ok(rec.serverExitedAt, '正常停树后要补记 server 退出时刻');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    clean(e.dir);
  }
});

test('看护真实生命周期：hold 没注入 SCHED_PERMIT（缺许可）→ 不起服务，退出码 2', { timeout: 30000 }, async () => {
  const e = makeEnv();
  e.share = path.join(e.dir, 'share');
  const stateFile = path.join(e.dir, 'state.txt');
  fs.writeFileSync(stateFile, 'running');
  makeFakeShare(e.share, stateFile);
  const { child, pidFile } = spawnWatcher(e, { ticketId: 'tk-' + 'd'.repeat(20), wrapperPid: process.pid, permit: null });
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 2, '读取正常的票 + 缺许可 = 没有授予：严格模式不裸跑');
    assert.ok(!fs.existsSync(pidFile), '没拿到有效授予就绝不 spawn server');
    const rec = JSON.parse(fs.readFileSync(e.recordFile, 'utf8'));
    assert.equal(rec.serverPid, null, '登记不动：没有服务起过');
    assert.ok(!rec.watcherPid && !rec.serverStartedAt, '连看护自己的登记也不写');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    clean(e.dir);
  }
});

test('看护真实生命周期：SCHED_PERMIT 票号与本单不一致 → 不起服务，退出码 2', { timeout: 30000 }, async () => {
  const e = makeEnv();
  e.share = path.join(e.dir, 'share');
  const stateFile = path.join(e.dir, 'state.txt');
  fs.writeFileSync(stateFile, 'running');
  makeFakeShare(e.share, stateFile);
  const myTicket = 'tk-' + 'e'.repeat(20);
  const otherPermit = `tk-${'f'.repeat(20)}:a1:TOK`;   // 别的单的许可 —— 票号对不上就不算本单的授予
  const { child, pidFile } = spawnWatcher(e, { ticketId: myTicket, wrapperPid: process.pid, permit: otherPermit });
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 2, '冒用别人的许可必须被票号一致性检查挡下');
    assert.ok(!fs.existsSync(pidFile), '不许起服务');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    clean(e.dir);
  }
});

test('看护真实生命周期：真实 resident 授予形态（票面 granted，M1 实测）→ 核验通过并起服务', { timeout: 30000 }, async () => {
  const e = makeEnv();
  e.share = path.join(e.dir, 'share');
  const stateFile = path.join(e.dir, 'state.txt');
  fs.writeFileSync(stateFile, 'granted');   // 常驻单当拍授予且停留在 granted —— running 等不来（真实 M1 实测的缝隙）
  makeFakeShare(e.share, stateFile);
  const T = 'tk-' + 'f'.repeat(20);
  const { child, pidFile } = spawnWatcher(e, { ticketId: T, wrapperPid: process.pid });
  try {
    assert.ok(await waitFor(() => fs.existsSync(pidFile)), 'granted 的常驻单必须被核验为有效授予并起服务');
    const rec = JSON.parse(fs.readFileSync(e.recordFile, 'utf8'));
    assert.equal(typeof rec.serverPid, 'number', 'serverPid 照常补进归属登记');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    clean(e.dir);
  }
});

test('看护真实生命周期：令牌与票面不符（伪造许可）→ 不起服务，退出码 2', { timeout: 30000 }, async () => {
  const e = makeEnv();
  e.share = path.join(e.dir, 'share');
  const stateFile = path.join(e.dir, 'state.txt');
  fs.writeFileSync(stateFile, 'granted');
  makeFakeShare(e.share, stateFile);
  const T = 'tk-' + '9'.repeat(20);
  const { child, pidFile } = spawnWatcher(e, { ticketId: T, wrapperPid: process.pid, permit: `${T}:a1:EVIL` });
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 2, '伪造令牌必须被票面 permit 逐字比对挡下');
    assert.ok(!fs.existsSync(pidFile), '不许起服务');
    const rec = JSON.parse(fs.readFileSync(e.recordFile, 'utf8'));
    assert.equal(rec.serverPid, null, '登记不动：没有服务起过');
    assert.ok(!rec.watcherPid, '没有有效授予就连接看护自己的登记也不写');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    clean(e.dir);
  }
});

// ——————— 严格看护的 resident 授予核验（对齐真实客户端 hold 的授予语义） ———————

test('verifyResidentGrant：真实 resident 授予形态（granted）放行；普通票据/伪造/终态/撤单/归属不符逐条拒', () => {
  const dir = tmp('grant-');
  const share = path.join(dir, 'share');
  const T = 'tk-' + '9'.repeat(20);
  const client = { residentLeaseFile: leaseFileOf };   // 判据与真实客户端导出的同一份
  const v = (over = {}) => lr.verifyResidentGrant(
    { ticketId: T, share, client, permit: `${T}:a1:TOK`, wrapperPid: process.pid, ppid: process.pid, env: {}, ...over },
  );
  const reset = (o = {}) => { clean(share); grantResident(share, { ticketId: T, ...o }); };
  reset();
  const ok = v();
  assert.equal(ok.ok, true, '真实授予形态（granted 常驻单 + 匹配的许可与租约）必须放行');
  assert.equal(ok.permit.token, 'TOK', '放行时带回票面 permit');

  // ① 许可串：缺、格式不对、票号不是本单
  assert.equal(v({ permit: undefined }).ok, false);
  assert.equal(v({ permit: 'not-a-permit' }).ok, false);
  assert.match(v({ permit: `${'tk-' + '8'.repeat(20)}:a1:TOK` }).reason, /票号与本单不一致/);
  // ② 票据：读不到、普通派发票（非 resident）、终态、非开跑状态、已请求撤单
  clean(share);
  assert.match(v().reason, /读不到本单票据/);
  reset({ resident: false });
  assert.match(v().reason, /不是长期占用单/);
  reset({ state: 'cancelled' });
  assert.match(v().reason, /终态/);
  reset({ state: 'waiting' });
  assert.match(v().reason, /开跑状态/, 'waiting 不是 hold 会放行的授予态');
  reset({ state: 'paused' });
  assert.match(v().reason, /开跑状态/, 'paused/slow 也不是常驻单的开跑态（只认 granted/running）');
  reset({ cancelRequested: true });
  assert.match(v().reason, /撤单/);
  // ③ 票面 permit 与注入许可的逐字比对：令牌/当前执行/resident/机器/类别/核数/核数环境
  reset();
  assert.match(v({ permit: `${T}:a1:EVIL` }).reason, /令牌不符/);
  reset({ attempt: 'a2' });
  assert.match(v().reason, /不是当前执行/);
  reset({ permitResident: false });
  assert.match(v().reason, /不是常驻授予/, 'permit.resident 缺失/非 true 的许可不许起常驻服务（R8）');
  reset();
  assert.match(v({ hostname: '别的机器' }).reason, /机器不符/);
  assert.match(v({ category: 'unit-test' }).reason, /类别/);
  assert.match(v({ workType: 'unit-test' }).reason, /作业类型/);
  assert.match(v({ cores: 2 }).reason, /核数不够/);
  assert.match(v({ env: { SCHED_GRANTED_CORES: '5' } }).reason, /核数环境与授予不符/);
  assert.match(v({ env: { SCHED_GRANTED_CORES: '0' } }).reason, /核数环境与授予不符/);
  assert.match(v({ env: { SCHED_GRANTED_CORES: 'x' } }).reason, /核数环境与授予不符/);
  assert.equal(v({ env: { SCHED_GRANTED_CORES: '1' } }).ok, true, '核数环境落在授予范围内就放行');
  // ④ 驻留租约：缺、换机器、pid 不是本看护的包装进程、核数≠真实授予、客户端没有租约判据
  reset({ withLease: false });
  assert.match(v().reason, /读不到驻留租约/);
  reset({ leasePid: 4242 });
  assert.match(v({ wrapperPid: 1, ppid: 1 }).reason, /父子归属不符/);
  assert.equal(v({ wrapperPid: 4242, ppid: 4242 }).ok, true, '租约 pid = 本看护的包装进程就放行');
  reset({ grantedCores: 2, leaseCores: 1 });
  assert.match(v().reason, /真实授予不符/, '租约必须按真实授予写核数（真实 hold 就是 permit.grantedCores，R8）');
  reset();
  assert.match(v({ client: {} }).reason, /驻留租约判据/);
  // ⑤ 实际父链（事实，不是参数）：--wrapper 填得再真，实际父进程不是它就不算父子归属（R8）
  assert.match(v({ ppid: 777 }).reason, /实际父进程/);
  assert.match(v({ wrapperPid: 777, ppid: process.pid }).reason, /父子归属不符/,
    '租约 pid 对不上参数 wrapper 一样要拒（租约、参数、实际父链三方一致才放行）');
  assert.equal(v({ ppid: process.pid }).ok, true, '租约 pid = wrapper 参数 = 实际父进程，三方一致就放行');
  clean(dir);
});

// ——————— 看护进程的归属登记只动本次自己的生命周期（deps 注入版） ———————

/** runWatchServer 的 deps 注入基座：假客户端 + 假 spawn + 假停止，全部当场抓调用。 */
function watchDeps(env, over = {}) {
  const child = {
    pid: 4321,
    once(ev, fn) { (this._h ||= {})[ev] = fn; return this; },
    emitExit() { const h = this._h && this._h.exit; if (h) h(0, null); },
  };
  const d = {
    platform: process.platform,
    cwd: env.dir,
    env: {},
    intervalMs: 20,
    shareFailBudgetMs: 1000,
    spawn: () => child,
    stopTree: async () => ({ ok: true }),
    updateRecord: lr.updateRecord,
    log: () => {},
    err: () => {},
    kill: () => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; },   // 包装进程默认已死
    exit: () => {},
    hostname: os.hostname(),
    client: {
      status: () => ({ state: 'running' }),
      // 与真实客户端同判据的驻留租约路径。【没有 validatePermit】——授予核验走启动器侧
      // verifyResidentGrant 真实现（按共享盘事实读），不放"总是 ok"的许可桩冒充实机。
      residentLeaseFile: leaseFileOf,
      cancel: async () => ({ exitCode: 0 }),
    },
    ...over,
  };
  return { d, child };
}

test('看护只动本次自己的登记：key 不符 = 真正零写入（连读改写都不进）；key 对上才写', async () => {
  // ① 别人的 key：一次写盘都不发生，新生命周期补进登记的字段原样保留 ——
  //    绝不允许"旧读出来的对象再交回写盘方"，那会把别人刚补的字段抹掉。
  const e = makeEnv();
  const foreign = {
    schema: 1, hostname: 'testhost', mode: 'strict', key: 'someone-else', ticketId: 'tk-x',
    serverPid: 555, serverExitedAt: '2026-10-14T00:00:01Z', title: '新生命周期刚补的字段',
  };
  lr.writeRecord(e.recordFile, foreign);
  let writes = 0;
  const { d } = watchDeps(e, {
    updateRecord: (file, fn) => { writes += 1; return lr.updateRecord(file, fn); },
  });
  await lr.runWatchServer({
    ticketId: null, wrapperPid: 1, record: e.recordFile, server: 'server.cjs', key: 'mine',
  }, d);
  assert.equal(writes, 0, '别人的登记：零写入（连 updateRecord 都不进）');
  const rec = JSON.parse(fs.readFileSync(e.recordFile, 'utf8'));
  assert.deepEqual(rec, foreign, '登记逐字节原样保留（key/serverPid/退出时刻等新字段一个不少）');
  clean(e.dir);

  // ② 自己的 key：正常两笔（spawn 补记 serverPid + 收场补记 serverExitedAt），守卫没挡掉该写的那支笔
  const e2 = makeEnv();
  lr.writeRecord(e2.recordFile, { schema: 1, hostname: 'testhost', mode: 'strict', key: 'mine', ticketId: 'tk-x', serverPid: null });
  let writes2 = 0;
  const { d: d2 } = watchDeps(e2, {
    updateRecord: (file, fn) => { writes2 += 1; return lr.updateRecord(file, fn); },
  });
  await lr.runWatchServer({ ticketId: null, wrapperPid: 1, record: e2.recordFile, server: 'server.cjs', key: 'mine' }, d2);
  assert.equal(writes2, 2, '自己的生命周期：spawn 补记 + 收场补记，两笔都照常');
  const rec2 = JSON.parse(fs.readFileSync(e2.recordFile, 'utf8'));
  assert.equal(rec2.serverPid, 4321, '自己的生命周期照常登记');
  assert.ok(rec2.serverExitedAt, '收尾补记照常');
  clean(e2.dir);
});

test('看护停止失败不冒充：有界重试；停不成看护【不退出】（hold 不撤、账/进程一致），自有进程真退了才收场（码 1）', async () => {
  const e = makeEnv();
  lr.writeRecord(e.recordFile, { schema: 1, hostname: 'testhost', mode: 'strict', key: 'k', ticketId: null, serverPid: null });
  const stopCalls = [];
  let exitCode = null;
  const { d, child } = watchDeps(e, {
    stopTree: async (pid) => { stopCalls.push(pid); return { ok: false, reason: '进程停不下来' }; },
    stopRetries: 2, stopRetryDelayMs: 20,
    exit: (code) => { exitCode = code; },
  });
  // wrapperPid=1 已死（注入 kill 抛 ESRCH）→ 第一拍就触发停树，而停树一直不成
  const p = lr.runWatchServer({ ticketId: null, wrapperPid: 1, record: e.recordFile, server: 'server.cjs', key: 'k' }, d);
  let settled = false;
  p.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 150));   // 两次重试（20ms 间隔）早就跑完了
  assert.deepEqual(stopCalls, [4321, 4321], '有界重试：停了两轮');
  assert.equal(settled, false, '停不成绝不 finish/退出 —— 看护先退、hold 随后注销而 server 还活着的脱节就是这么堵的');
  let rec = JSON.parse(fs.readFileSync(e.recordFile, 'utf8'));
  assert.equal(rec.serverPid, 4321, '现场保留');
  assert.ok(!rec.serverExitedAt, '没退就是不退，绝不伪记退出时刻');
  child.emitExit();   // 人工把进程树收掉之后，自有进程真退出 → 看护才收场
  await p;
  assert.equal(exitCode, 1, '最终收场也是明确失败码 1，不用 0 冒充');
  rec = JSON.parse(fs.readFileSync(e.recordFile, 'utf8'));
  assert.ok(rec.serverExitedAt, 'server 真退了才如实补记退出时刻');
  clean(e.dir);
});

test('父链断开停服成功 → 看护【优先正式退自己的单】；票据终态 → 不再重复退单', async () => {
  const T1 = 'tk-' + '1'.repeat(20);
  const T2 = 'tk-' + '2'.repeat(20);
  // ① wrapper 死 + 停树成功：正式 cancel 自己的票（cancel 不成才留断租兜底）
  const e = makeEnv();
  e.share = path.join(e.dir, 'share');
  grantResident(e.share, { ticketId: T1, leasePid: 1 });   // 真实授予事实：租约 pid = 本看护的包装进程
  lr.writeRecord(e.recordFile, { schema: 1, hostname: 'testhost', mode: 'strict', key: 'k', ticketId: T1, serverPid: null });
  const cancels = [];
  const { d } = watchDeps(e, {
    env: { SCHED_PERMIT: `${T1}:a1:TOK` },
    ppid: 1,   // 单测显式注入实际父链（生产用真实 process.ppid，不许参数冒充）
    client: {
      status: () => ({ state: 'granted' }),
      residentLeaseFile: leaseFileOf,
      cancel: async (id, o) => { cancels.push([id, o && o.reason]); return { exitCode: 0 }; },
    },
  });
  const code = await lr.runWatchServer({
    ticketId: T1, share: e.share, wrapperPid: 1, record: e.recordFile, server: 'server.cjs', key: 'k',
  }, d);
  assert.equal(code, 0);
  assert.equal(cancels.length, 1, '停成后优先正式退单，不等派单员断租扫');
  assert.equal(cancels[0][0], T1);
  assert.match(cancels[0][1], /包装进程已不在/);
  clean(e.dir);

  // ② 票据在起服务后被外部 cancel（终态）：账已收，不再重复退单
  const e2 = makeEnv();
  e2.share = path.join(e2.dir, 'share');
  grantResident(e2.share, { ticketId: T2, leasePid: 999999 });
  lr.writeRecord(e2.recordFile, { schema: 1, hostname: 'testhost', mode: 'strict', key: 'k', ticketId: T2, serverPid: null });
  const cancels2 = [];
  let statusCalls = 0;
  const { d: d2 } = watchDeps(e2, {
    env: { SCHED_PERMIT: `${T2}:a1:TOK` },
    ppid: 999999,   // 单测显式注入实际父链（生产用真实 process.ppid）
    kill: (pid) => {   // 包装进程活着（999999 探活正常），只有票被外部 cancel
      if (pid === 999999) return;
      const err = new Error('ESRCH'); err.code = 'ESRCH'; throw err;
    },
    client: {
      // 第一次读票是起服务前的授予核验（非终态才放行）；之后的看护拍读到的是外部 cancel 后的终态
      status: () => ({ state: (statusCalls += 1) <= 1 ? 'running' : 'cancelled' }),
      residentLeaseFile: leaseFileOf,
      cancel: async (id) => { cancels2.push(id); return { exitCode: 0 }; },
    },
  });
  const code2 = await lr.runWatchServer({
    ticketId: T2, share: e2.share, wrapperPid: 999999, record: e2.recordFile, server: 'server.cjs', key: 'k',
  }, d2);
  assert.equal(code2, 0);
  assert.equal(cancels2.length, 0, '票据终态是外部 cancel 收的账，看护不重复退');
  clean(e2.dir);
});

test('停树重试：第一次不成、第二次成了 → 只在这之后退单/收场，不吞失败也不双跑', async () => {
  const T3 = 'tk-' + '3'.repeat(20);
  const e = makeEnv();
  e.share = path.join(e.dir, 'share');
  grantResident(e.share, { ticketId: T3, leasePid: 1 });
  lr.writeRecord(e.recordFile, { schema: 1, hostname: 'testhost', mode: 'strict', key: 'k', ticketId: T3, serverPid: null });
  const stopCalls = [];
  const cancels = [];
  const { d } = watchDeps(e, {
    env: { SCHED_PERMIT: `${T3}:a1:TOK` },
    ppid: 1,   // 单测显式注入实际父链（生产用真实 process.ppid）
    stopTree: async (pid) => {
      stopCalls.push(pid);
      return stopCalls.length === 1 ? { ok: false, reason: '还在退' } : { ok: true };
    },
    stopRetries: 3, stopRetryDelayMs: 20,
    client: {
      status: () => ({ state: 'granted' }),
      residentLeaseFile: leaseFileOf,
      cancel: async (id) => { cancels.push(id); return { exitCode: 0 }; },
    },
  });
  const code = await lr.runWatchServer({
    ticketId: T3, share: e.share, wrapperPid: 1, record: e.recordFile, server: 'server.cjs', key: 'k',
  }, d);
  assert.equal(code, 0);
  assert.equal(stopCalls.length, 2, '第一拍没停成，第二拍才停成');
  assert.deepEqual(cancels, [T3], '确认停成后才退单');
  const rec = JSON.parse(fs.readFileSync(e.recordFile, 'utf8'));
  assert.ok(rec.serverExitedAt, '正常收场补记退出时刻');
  clean(e.dir);
});
