'use strict';
/**
 * forbiddenListResolve.test.cjs —— 名单来源解析（resolveForbiddenList）的回归门禁。
 * 合成词一律用数组拼接现造，本文件不写任何真实机器名、项目名、盘符或用户目录路径，
 * 也不让本测试自身的源码字面量成为被扫描仓库里的违规夹具。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { resolveForbiddenList } = require('../core/localIdentifierScan.cjs');

const MAIN_TEST = 'A2: 全部被 git 跟踪的文本文件不含本机路径、项目显示名或主机名';
const LIST_NAME = 'opensource-forbidden.txt';
const PERMIT = ['tk-0123456789abcdef0123', 'a1', 'x'].join(':');
const HOME_TOKEN_1 = ['zzz', 'syn-list-home-one', 'zzz'].join('-');
const HOME_TOKEN_2 = ['zzz', 'syn-list-home-two', 'zzz'].join('-');
const SHARE_TOKEN_1 = ['qqq', 'syn-list-share-one', 'qqq'].join('-');
const SHARE_TOKEN_2 = ['qqq', 'syn-list-share-two', 'qqq'].join('-');

function temporaryHome(t) {
  const base = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, 'forbidden-list-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), base, '只清理本测试创建的 TEMP 子目录');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 造一个「共享盘根」：private/ 下按需放名单，不放就是空的共享根。 */
function shareRoot(t, lines) {
  const root = temporaryHome(t);
  const priv = path.join(root, 'private');
  fs.mkdirSync(priv);
  if (lines) fs.writeFileSync(path.join(priv, LIST_NAME), lines.join('\n') + '\n', 'utf8');
  return root;
}

function shareFileOf(root) {
  return path.join(root, 'private', LIST_NAME);
}

function homeFileOf(home) {
  return path.join(home, LIST_NAME);
}

test('F1 不在调度台下：只读本机名单，不碰共享盘', (t) => {
  const dir = temporaryHome(t);
  const homeFile = homeFileOf(dir);
  fs.writeFileSync(homeFile, [HOME_TOKEN_1, HOME_TOKEN_2, ''].join('\n'), 'utf8');
  assert.deepEqual(resolveForbiddenList({ env: {}, homeFile }), {
    tokens: [HOME_TOKEN_1, HOME_TOKEN_2],
    required: false,
    problem: null,
    homeCount: 2,
    shareCount: 0,
    shareFile: null,
  });
});

test('F2 只有 SCHED_SHARE 没有 SCHED_PERMIT：仍只读本机名单', (t) => {
  const dir = temporaryHome(t);
  const homeFile = homeFileOf(dir);
  fs.writeFileSync(homeFile, [HOME_TOKEN_1, HOME_TOKEN_2, ''].join('\n'), 'utf8');
  const root = shareRoot(t, [SHARE_TOKEN_1, SHARE_TOKEN_2]);
  assert.deepEqual(resolveForbiddenList({ env: { SCHED_SHARE: root }, homeFile }), {
    tokens: [HOME_TOKEN_1, HOME_TOKEN_2],
    required: false,
    problem: null,
    homeCount: 2,
    shareCount: 0,
    shareFile: null,
  });
});

test('F3 不在调度台下且本机名单不存在：空名单照旧跳过', (t) => {
  const dir = temporaryHome(t);
  assert.deepEqual(resolveForbiddenList({ env: {}, homeFile: homeFileOf(dir) }), {
    tokens: [], required: false, problem: null, homeCount: 0, shareCount: 0, shareFile: null,
  });
});

test('F4 副机场景：本机没有名单，改用共享盘那份', (t) => {
  const home = temporaryHome(t);
  const root = shareRoot(t, [SHARE_TOKEN_1, SHARE_TOKEN_2]);
  assert.deepEqual(resolveForbiddenList({
    env: { SCHED_PERMIT: PERMIT, SCHED_SHARE: root },
    homeFile: homeFileOf(home),
  }), {
    tokens: [SHARE_TOKEN_1, SHARE_TOKEN_2],
    required: true,
    problem: null,
    homeCount: 0,
    shareCount: 2,
    shareFile: shareFileOf(root),
  });
});

test('F5 在调度台下共享盘那份缺失：判 share-list-missing', (t) => {
  const home = temporaryHome(t);
  const homeFile = homeFileOf(home);
  fs.writeFileSync(homeFile, [HOME_TOKEN_1, HOME_TOKEN_2, ''].join('\n'), 'utf8');
  const root = shareRoot(t, null);
  assert.deepEqual(resolveForbiddenList({
    env: { SCHED_PERMIT: PERMIT, SCHED_SHARE: root }, homeFile,
  }), {
    tokens: [HOME_TOKEN_1, HOME_TOKEN_2],
    required: true,
    problem: 'share-list-missing',
    homeCount: 2,
    shareCount: 0,
    shareFile: shareFileOf(root),
  });
});

test('F6 在调度台下没有 SCHED_SHARE：判 share-list-missing 且 shareFile 为空', (t) => {
  const home = temporaryHome(t);
  const homeFile = homeFileOf(home);
  fs.writeFileSync(homeFile, [HOME_TOKEN_1, ''].join('\n'), 'utf8');
  assert.deepEqual(resolveForbiddenList({ env: { SCHED_PERMIT: PERMIT }, homeFile }), {
    tokens: [HOME_TOKEN_1],
    required: true,
    problem: 'share-list-missing',
    homeCount: 1,
    shareCount: 0,
    shareFile: null,
  });
});

test('F7 两份词相同而顺序、注释、空行不同：不算不一致，词不重复', (t) => {
  const home = temporaryHome(t);
  const homeFile = homeFileOf(home);
  fs.writeFileSync(homeFile, [HOME_TOKEN_2, '# 合成注释', '', `  ${HOME_TOKEN_1}  `, ''].join('\n'), 'utf8');
  const root = shareRoot(t, [HOME_TOKEN_1, HOME_TOKEN_2]);
  const list = resolveForbiddenList({ env: { SCHED_PERMIT: PERMIT, SCHED_SHARE: root }, homeFile });
  assert.equal(list.problem, null);
  assert.equal(list.required, true);
  assert.deepEqual([...list.tokens].sort(), [HOME_TOKEN_1, HOME_TOKEN_2].sort());
  assert.equal(new Set(list.tokens).size, list.tokens.length);
  assert.equal(list.homeCount, 2);
  assert.equal(list.shareCount, 2);
});

test('F8 两份词不同：判 lists-differ，条数各自正确，词取并集', (t) => {
  const home = temporaryHome(t);
  const homeFile = homeFileOf(home);
  fs.writeFileSync(homeFile, [HOME_TOKEN_1, HOME_TOKEN_2, ''].join('\n'), 'utf8');
  const root = shareRoot(t, [SHARE_TOKEN_1, SHARE_TOKEN_2]);
  assert.deepEqual(resolveForbiddenList({
    env: { SCHED_PERMIT: PERMIT, SCHED_SHARE: root }, homeFile,
  }), {
    tokens: [HOME_TOKEN_1, HOME_TOKEN_2, SHARE_TOKEN_1, SHARE_TOKEN_2],
    required: true,
    problem: 'lists-differ',
    homeCount: 2,
    shareCount: 2,
    shareFile: shareFileOf(root),
  });
});

test('F9 SCHED_PERMIT 只有空白：视为不在调度台下', (t) => {
  const home = temporaryHome(t);
  const homeFile = homeFileOf(home);
  fs.writeFileSync(homeFile, [HOME_TOKEN_1, ''].join('\n'), 'utf8');
  assert.deepEqual(resolveForbiddenList({ env: { SCHED_PERMIT: ' \t ' }, homeFile }), {
    tokens: [HOME_TOKEN_1], required: false, problem: null, homeCount: 1, shareCount: 0, shareFile: null,
  });
});

/** 起子进程跑主用例：清掉递归标记与外层调度台变量，再按需注入。 */
function runMainTest(home, sched) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper === 'SCHED_PERMIT' || upper === 'SCHED_SHARE') delete env[key];
  }
  env.DASHBOARD_HOME = home;
  if (sched) Object.assign(env, sched);
  return spawnSync(process.execPath, [
    '--test', '--test-reporter=tap', `--test-name-pattern=^${MAIN_TEST}$`,
    path.join(ROOT, 'test', 'noLocalIdentifiers.test.cjs'),
  ], {
    cwd: ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
}

test('F10 副机上有共享盘名单：主用例真查并通过', (t) => {
  const home = temporaryHome(t);
  const absent = ['qqq', 'syn', 'share', 'absent', 'qqq'].join('-');
  const root = shareRoot(t, [absent]);
  const result = runMainTest(home, { SCHED_PERMIT: PERMIT, SCHED_SHARE: root });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^# pass 1\r?$/m);
  assert.match(result.stdout, /^# skipped 0\r?$/m);
});

test('F11 副机上共享盘名单缺失：主用例判红不 skip，且失败信息不带共享盘路径', (t) => {
  const home = temporaryHome(t);
  const root = shareRoot(t, null);
  const result = runMainTest(home, { SCHED_PERMIT: PERMIT, SCHED_SHARE: root });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /^# fail 1\r?$/m);
  assert.match(result.stdout, /^# skipped 0\r?$/m);
  assert.ok(result.stdout.includes('名单是必需的'), result.stdout);
  assert.ok(!result.stdout.includes(root), '失败信息不得带共享盘路径');
  assert.ok(!result.stderr.includes(root), '失败信息不得带共享盘路径');
});

test('F12 不在调度台下且本机没有名单：主用例照旧 skip', (t) => {
  const home = temporaryHome(t);
  const result = runMainTest(home, null);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^# skipped 1\r?$/m);
});
