'use strict';
/**
 * launcherVisibleFailure.test.cjs —— 双击启动失败必须可见（AD-20261103-LAUNCHER-FAIL-SILENT）。
 *
 * 实证：launcher-silent.vbs 用 cmd 重定向写同一个 launcher-YYYYMMDD.log，常驻服务一直占着它，
 * 第二次双击时 cmd 报 "The process cannot access the file"，node 根本没跑；窗口隐藏，负责人只看到"点了没反应"。
 * 另外 serviceStatus 单次探活只要 400ms，服务稍微慢一点就误判"健康检查未响应"，同样没有任何提示。
 *
 * 这里钉住三件事：
 *   ① 每次双击写独立日志文件（旧式日志被占也不影响）；
 *   ② 慢服务（800ms）不再被 400ms 的探活门槛误杀；
 *   ③ 启动失败走 launcher.cjs 的通知出口弹窗，起稳之后的退出与服务复用不弹。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const lr = require('../core/launcherRuntime.cjs');
const launcher = require('../cli/launcher.cjs');
const { serviceStatus } = require('../cli/release.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const WIN = { skip: process.platform !== 'win32' ? '仅 Windows' : false, timeout: 45000 };

const HOST = 'launcher-visible-failure';
const PID = 43001;
const COMMIT = 'a'.repeat(40);

test('launcher-silent.vbs:连续两次算出的日志路径不同,且都是 launcher-日期-数字-数字.log', WIN, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-logname-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vbs = path.join(dir, 'probe.vbs');
  fs.writeFileSync(vbs, read('scripts/launcher-silent.vbs').replace('sh.Run command, 0, False', 'WScript.Echo logfile'));
  const run = () => cp.spawnSync('cscript', ['//Nologo', vbs], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, DASHBOARD_HOME: dir },
  });
  const first = run();
  const second = run();
  assert.equal(first.status, 0, String(first.stderr));
  assert.equal(second.status, 0, String(second.stderr));
  const a = String(first.stdout).trim();
  const b = String(second.stdout).trim();
  assert.match(a, /launcher-\d{8}-\d+-\d+\.log/, a);
  assert.match(b, /launcher-\d{8}-\d+-\d+\.log/, b);
  assert.notEqual(a, b, '两次双击必须各写各的日志');
});

test('旧式日志被 cmd 重定向独占时,换一个新文件名的重定向照样成功', WIN, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-loglock-'));
  const legacy = path.join(dir, 'launcher-20260101.log');
  // cmd 重定向会独占写入这个旧式日志：more 一直等 stdin（我们不关闭），重定向句柄就攥在 cmd 手里。
  const holder = cp.spawn(`more > "${legacy}"`, {
    shell: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
  });
  try {
    for (let i = 0; i < 50 && !fs.existsSync(legacy); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(fs.existsSync(legacy), '占位进程应当已经建好旧式日志');
    assert.equal(holder.exitCode, null, '占位进程应当还活着');
    const fresh = path.join(dir, `launcher-20260101-${Date.now()}-1.log`);
    const r = cp.spawnSync(`echo ok>> "${fresh}"`, { shell: true, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(r.status, 0, `新日志写入失败：${r.stderr || r.stdout}`);
    assert.match(fs.readFileSync(fresh, 'utf8'), /ok/);
  } finally {
    if (holder.pid) cp.spawnSync('taskkill', ['/pid', String(holder.pid), '/T', '/F'], { windowsHide: true, timeout: 20000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch { /* 临时目录留到系统清理，不影响判定 */ }
  }
});

test('serviceStatus:响应要 800 毫秒的慢服务仍判在跑', { timeout: 60000 }, async (t) => {
  const port = 39000 + Math.floor(Math.random() * 2000);
  const child = cp.spawn(process.execPath, ['-e', `
    const http = require('http');
    const port = ${port};
    const srv = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ service: 'claude-dashboard', pid: process.pid, port, mode: 'release', codeRoot: ${JSON.stringify(ROOT)}, releaseCommit: '${COMMIT}' }));
      }, 800);
    });
    srv.listen(port, '127.0.0.1', () => process.stdout.write('ready'));
  `], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.unref();
  t.after(() => { try { child.kill(); } catch { /* 已退出 */ } });
  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('慢服务没在 10 秒内就绪')), 10000);
    child.stdout.on('data', (c) => {
      out += c;
      if (out.includes('ready')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`慢服务提前退出（${code}）`)); });
  });
  const st = serviceStatus({ portBase: port, portRange: 0 });
  assert.equal(st.running, true, st.text);
  assert.equal(st.health.port, port);
});

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-visible-'));
  const codeRoot = path.join(dir, 'checkout');
  const home = path.join(dir, 'home');
  const relHome = path.join(dir, 'release');
  fs.mkdirSync(path.join(codeRoot, '.git'), { recursive: true });
  fs.mkdirSync(path.join(relHome, 'server'), { recursive: true });
  fs.writeFileSync(path.join(relHome, 'server', 'server.cjs'), '// never executed\n');
  return { dir, codeRoot, home, relHome, recordFile: lr.recordPath(home) };
}

function recordOf(over = {}) {
  return {
    schema: lr.RECORD_SCHEMA, hostname: HOST, mode: 'standalone', serverPid: PID,
    key: 'serve-existing', wrapperPid: 43002, watcherPid: 43003,
    ticketId: null, title: null, releaseCommit: COMMIT, startedAt: new Date().toISOString(), ...over,
  };
}

function baseDeps(f, over = {}) {
  return {
    platform: 'win32', hostname: HOST, env: {},
    codeRoot: f.codeRoot, home: f.home, relHome: f.relHome,
    acquireMutex: () => ({ release() {} }),
    probeHealth: () => ({ running: false, health: null }),
    readStamp: () => null,
    runRelease: () => 0,
    kill: () => {},
    log: () => {}, err: () => {},
    ...over,
  };
}

test('main:预检拒绝时通知一次并返回 1', { timeout: 26000 }, async (t) => {
  const f = makeRepo();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  lr.writeRecord(f.recordFile, recordOf());
  const notices = [];
  const code = await launcher.main(['--standalone'], baseDeps(f, {
    notifyFailure: (m) => notices.push(m),
  }));
  assert.equal(code, 1);
  assert.equal(notices.length, 1, '启动失败必须通知负责人');
  assert.match(notices[0], /健康检查未响应/);
});

test('main:服务起稳之后退出不通知', { timeout: 26000 }, async (t) => {
  const f = makeRepo();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(f.codeRoot, 'web', 'node_modules'), { recursive: true });
  let record = null;
  const notices = [];
  const child = new EventEmitter();
  const code = await launcher.main(['--standalone'], baseDeps(f, {
    env: { NODE_TEST_CONTEXT: 'child-v8' },
    readRecord: () => record,
    writeRecord: (_file, r) => { record = { ...r, serverPid: process.pid }; },
    spawnWatcher: () => { setTimeout(() => child.emit('exit', 1), 600); return child; },
    startConfirmMs: 5000,
    installWatchdog: () => {},
    openBrowser: () => {},
    notifyFailure: (m) => notices.push(m),
  }));
  assert.equal(code, 1);
  assert.deepEqual(notices, [], '服务已经起稳，后面的退出不算启动失败');
});

test('main:复用已有实例返回 0 不通知', { timeout: 26000 }, async (t) => {
  const f = makeRepo();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(f.codeRoot, 'web', 'node_modules'), { recursive: true });
  lr.writeRecord(f.recordFile, recordOf());
  const health = { pid: PID, port: 6061, mode: 'release', codeRoot: f.relHome, releaseCommit: COMMIT };
  const notices = [];
  const code = await launcher.main(['--standalone'], baseDeps(f, {
    probeHealth: () => ({ running: true, health }),
    readStamp: () => ({ commit: COMMIT }),
    openBrowser: () => {},
    notifyFailure: (m) => notices.push(m),
  }));
  assert.equal(code, 0);
  assert.deepEqual(notices, []);
});

test('notifyLaunchFailure:没设 DASHBOARD_LAUNCH_NOTIFY 就不 spawn', () => {
  const calls = [];
  launcher.notifyLaunchFailure('✖ 启动失败', {
    platform: 'win32', env: {}, spawn: (...args) => { calls.push(args); return { unref() {} }; },
  });
  assert.deepEqual(calls, []);
});

test('notifyLaunchFailure:设了就 spawn wscript,文本已清洗且不弹控制台', () => {
  const calls = [];
  const spawn = (...args) => { calls.push(args); return { unref() {} }; };
  launcher.notifyLaunchFailure('✖ 启动失败\n原因："日志被占用"', {
    platform: 'win32', env: { DASHBOARD_LAUNCH_NOTIFY: '1' }, spawn,
    script: 'C:\\repo\\scripts\\launcher-notify.vbs',
  });
  assert.equal(calls.length, 1);
  const [cmd, argv, opts] = calls[0];
  assert.equal(cmd, 'wscript.exe');
  assert.ok(argv.some((a) => /launcher-notify\.vbs$/.test(a)), argv.join(' '));
  const text = argv[2];
  assert.ok(!text.startsWith('✖'), text);
  assert.ok(!/[\r\n]/.test(text), text);
  assert.ok(!text.includes('"'), text);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.detached, true);
});

test('两个启动脚本只含 ASCII 字符', () => {
  for (const f of ['scripts/launcher-silent.vbs', 'scripts/launcher-notify.vbs']) {
    assert.ok(/^[\x00-\x7F]*$/.test(read(f)), `${f} 含非 ASCII 字符`);
  }
});
