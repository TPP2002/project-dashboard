'use strict';
/**
 * identifierCheck.test.cjs —— 公开仓标识闸（identifier-check）的回归门禁。
 * 合成的词与盘符路径一律用字符串拼接现造，绝不把真实机器名、真实路径、名单内容写进本文件，
 * 也不让本测试自身的源码字面量成为被扫描仓库里的违规夹具。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'index.cjs');
const scan = require('../core/localIdentifierScan.cjs');
const { hooksInstall } = require('../cli/hooksInstall.cjs');
const cmds = require('../cli/commands.cjs');

// 现造夹具：单个反斜杠常量、两条不含盘符/占位符的合成词、一条合成非占位盘符路径。
const B = '\\';
const TOKEN_1 = ['zzz', 'synthetic-one', 'zzz'].join('-');
const TOKEN_2 = ['qqq', 'synthetic-two', 'qqq'].join('-');
const TOKENS = [TOKEN_1, TOKEN_2];
const BAD_PATH = ['F:', 'definitely-not-a-placeholder', 'x'].join(B);
const MARKER_TEXT = '这个仓是公开的：提交前自动查本机标识。\n';
const MISSING_LIST_LINE = '本机没有标识名单，这次只查了盘符路径\n';

// ——— (a) 模块 ———
test('findTokenHits：给出正确的 file / line / tokenIndex，同一行命中两个词出两条', () => {
  const files = [{ file: 'a.cjs', content: ['line1', `${TOKEN_1} and ${TOKEN_2}`, 'line3'].join('\n') }];
  assert.deepEqual(scan.findTokenHits(TOKENS, files), [
    { file: 'a.cjs', line: 2, tokenIndex: 1 },
    { file: 'a.cjs', line: 2, tokenIndex: 2 },
  ]);
});

test('findTokenHits：JSON 双反斜杠写法的词能命中，大小写不同也命中', () => {
  const word = ['C:', 'synthetic', 'doubled'].join(B);
  const jsonWritten = ['C:', 'synthetic', 'doubled'].join(B + B);
  const files = [{ file: 'b.json', content: `{"p": "${jsonWritten}", "u": "${word.toUpperCase()}"}` }];
  assert.deepEqual(scan.findTokenHits([word], files), [{ file: 'b.json', line: 1, tokenIndex: 1 }]);
});

test('findTokenHits：TEXT_ALLOWLIST 放行的串不算，没有命中返回空数组', () => {
  const allowed = scan.TEXT_ALLOWLIST.get('README.md')[0];
  const inside = allowed.slice(0, 10);
  assert.deepEqual(scan.findTokenHits([inside], [{ file: 'README.md', content: allowed }]), []);
  assert.deepEqual(scan.findTokenHits(TOKENS, [{ file: 'clean.txt', content: 'nothing here' }]), []);
  assert.deepEqual(scan.findTokenHits(TOKENS, []), []);
});

test('findViolations / findBadPaths：从新模块 require，输出格式与原实现一致', () => {
  assert.deepEqual(scan.findViolations([TOKEN_1], [{ file: 'a.cjs', content: `x ${TOKEN_1} y` }]),
    [`a.cjs: ${TOKEN_1}`]);
  assert.deepEqual(scan.findBadPaths([{ file: 'p.cjs', content: `const p = '${BAD_PATH}';` }]),
    [`p.cjs:1: ${BAD_PATH}`]);
});

// ——— (b) 命令 ———
function tempBase(t, prefix) {
  const base = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, prefix));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), base, '只清理本测试直接创建的系统临时子目录');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return dir;
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function setup(t) {
  const root = tempBase(t, 'identifier-check-');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const emptyHome = path.join(root, 'empty-home');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  fs.mkdirSync(emptyHome);
  fs.writeFileSync(path.join(home, 'opensource-forbidden.txt'),
    ['# 合成名单', TOKEN_1, TOKEN_2, ''].join('\n'), 'utf8');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@t.invalid']);
  git(repo, ['config', 'user.name', 't']);
  const env = { ...process.env, DASHBOARD_HOME: home, DASHBOARD_HOOK_CLI_ROOT: ROOT };
  const noListEnv = { ...process.env, DASHBOARD_HOME: emptyHome, DASHBOARD_HOOK_CLI_ROOT: ROOT };
  return { root, repo, home, emptyHome, env, noListEnv };
}

function runCheck(f, args, env) {
  return spawnSync(process.execPath, [CLI, 'identifier-check', ...args], {
    cwd: f.repo, env: env || f.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
}

function putMarker(f) {
  fs.writeFileSync(path.join(f.repo, '.public-repo'), MARKER_TEXT, 'utf8');
}

test('命令 1：没有 .public-repo 不查（stderr 空）；--force 照查并拦下', (t) => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), ['clean', TOKEN_1, ''].join('\n'), 'utf8');
  git(f.repo, ['add', 'a.txt']);
  const plain = runCheck(f, []);
  assert.equal(plain.status, 0);
  assert.equal(plain.stderr, '');
  const forced = runCheck(f, ['--force']);
  assert.equal(forced.status, 1);
  assert.ok(forced.stderr.includes('a.txt:2'), forced.stderr);
});

test('命令 2：有标记文件时命中第 2 条词，报文件名行号与序号，不泄露词本身', (t) => {
  const f = setup(t);
  putMarker(f);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), ['line1', 'line2', TOKEN_2, ''].join('\n'), 'utf8');
  git(f.repo, ['add', 'a.txt']);
  const r = runCheck(f, []);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('a.txt:3'), r.stderr);
  assert.ok(r.stderr.includes('第 2 条'), r.stderr);
  assert.ok(!r.stderr.includes(TOKEN_2), r.stderr);
});

test('命令 3：默认只查暂存区；同一状态加 --all 才查工作区未暂存文件', (t) => {
  const f = setup(t);
  putMarker(f);
  fs.writeFileSync(path.join(f.repo, 'dirty.txt'), [TOKEN_1, ''].join('\n'), 'utf8');
  fs.writeFileSync(path.join(f.repo, 'clean.txt'), 'all clean\n', 'utf8');
  git(f.repo, ['add', 'clean.txt']);
  assert.equal(runCheck(f, []).status, 0);
  assert.equal(runCheck(f, ['--all']).status, 1);
});

test('命令 4：读的是暂存区内容，不是工作区', (t) => {
  const f = setup(t);
  putMarker(f);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), [TOKEN_1, ''].join('\n'), 'utf8');
  git(f.repo, ['add', 'a.txt']);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'clean now\n', 'utf8');
  assert.equal(runCheck(f, []).status, 1, '暂存区仍脏 → 拦下');
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'clean\n', 'utf8');
  git(f.repo, ['add', 'a.txt']);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), [TOKEN_1, ''].join('\n'), 'utf8');
  assert.equal(runCheck(f, []).status, 0, '暂存区干净 → 放行');
});

test('命令 5：白名单以外的盘符路径拦下且不打印路径本身；占位路径放行', (t) => {
  const f = setup(t);
  putMarker(f);
  fs.writeFileSync(path.join(f.repo, 'p.txt'), `const p = '${BAD_PATH}';\n`, 'utf8');
  git(f.repo, ['add', 'p.txt']);
  const r = runCheck(f, []);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('p.txt:1'), r.stderr);
  assert.ok(r.stderr.includes('盘符路径'), r.stderr);
  assert.ok(!r.stderr.includes(BAD_PATH), r.stderr);
  const placeholder = scan.PATH_PLACEHOLDERS[0];
  fs.writeFileSync(path.join(f.repo, 'p.txt'), `const p = '${placeholder}';\n`, 'utf8');
  git(f.repo, ['add', 'p.txt']);
  const ok = runCheck(f, []);
  assert.equal(ok.status, 0, ok.stderr);
});

test('命令 6：名单缺失时干净文件只打名单缺失一行；非占位盘符路径仍拦下', (t) => {
  const f = setup(t);
  putMarker(f);
  fs.writeFileSync(path.join(f.repo, 'clean.txt'), 'all clean\n', 'utf8');
  git(f.repo, ['add', 'clean.txt']);
  const clean = runCheck(f, [], f.noListEnv);
  assert.equal(clean.status, 0);
  assert.equal(clean.stderr, MISSING_LIST_LINE);
  fs.writeFileSync(path.join(f.repo, 'p.txt'), `const p = '${BAD_PATH}';\n`, 'utf8');
  git(f.repo, ['add', 'p.txt']);
  assert.equal(runCheck(f, [], f.noListEnv).status, 1);
});

test('命令 7：BINARY_EXTENSIONS 里的扩展名跳过', (t) => {
  const f = setup(t);
  putMarker(f);
  fs.writeFileSync(path.join(f.repo, 'image.png'), [TOKEN_1, ''].join('\n'), 'utf8');
  git(f.repo, ['add', 'image.png']);
  const r = runCheck(f, []);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('命令 8：不是 git 仓时退出码 0 且标准错误为空', (t) => {
  const f = setup(t);
  const notRepo = tempBase(t, 'identifier-norepo-');
  const r = spawnSync(process.execPath, [CLI, 'identifier-check'], {
    cwd: notRepo, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

// ——— (c) 钩子块 ———
function installedPreCommit(f) {
  const reg = path.join(f.root, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  cmds.register({ id: 't', name: 'demo', root: f.repo, registry: reg });
  const saved = process.env.DASHBOARD_HOOK_CLI_ROOT;
  process.env.DASHBOARD_HOOK_CLI_ROOT = ROOT;
  try {
    hooksInstall({ project: 't', registry: reg });
    hooksInstall({ project: 't', registry: reg });
  } finally {
    if (saved === undefined) delete process.env.DASHBOARD_HOOK_CLI_ROOT;
    else process.env.DASHBOARD_HOOK_CLI_ROOT = saved;
  }
  return {
    path: path.join(f.repo, '.git', 'hooks', 'pre-commit'),
    text: fs.readFileSync(path.join(f.repo, '.git', 'hooks', 'pre-commit'), 'utf8'),
  };
}

const CLAIM_BEGIN = '#dashboard-hook:begin:claim-gate';
const IDENT_BEGIN = '#dashboard-identifier-gate:begin';

test('钩子块：装两次后 identifier-gate 起始锚恰好一次、在 claim-gate 之后、含三字样', (t) => {
  const f = setup(t);
  const { text } = installedPreCommit(f);
  assert.equal(text.split(CLAIM_BEGIN).length - 1, 1, 'claim-gate 起始锚恰好出现 1 次');
  assert.equal(text.split(IDENT_BEGIN).length - 1, 1, 'identifier-gate 起始锚恰好出现 1 次');
  assert.ok(text.indexOf(IDENT_BEGIN) > text.indexOf(CLAIM_BEGIN), 'identifier-gate 在 claim-gate 之后');
  assert.ok(text.includes('.public-repo'));
  assert.ok(text.includes('identifier-check'));
  assert.ok(text.includes('DASHBOARD_SKIP_IDENTIFIER_CHECK'));
});

// ——— (d) 钩子真跑（本机有 sh 才跑） ———
test('钩子真跑：无标记放行、有标记且暂存脏拦下、显式跳过放行', (t) => {
  const probe = spawnSync('sh', ['-c', ':'], { windowsHide: true });
  if (probe.error || probe.status !== 0) { t.skip('本机没有可用的 sh，跳过钩子真跑'); return; }
  const f = setup(t);
  installedPreCommit(f);
  // 相对路径喂给 sh，免得 MSYS 翻译 Windows 绝对路径；cwd 就是临时仓根，钩子里的 git 也以此为起点。
  const hookArg = '.git/hooks/pre-commit';
  const env = { ...f.env, DASHBOARD_SKIP_CLAIM_CHECK: '1' };
  const run = (extra) => spawnSync('sh', [hookArg], {
    cwd: f.repo, env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(run({}).status, 0, '没有标记文件时退出码 0');
  putMarker(f);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), [TOKEN_1, ''].join('\n'), 'utf8');
  git(f.repo, ['add', 'a.txt']);
  assert.equal(run({}).status, 1, '有标记且暂存含合成词时退出码 1');
  assert.equal(run({ DASHBOARD_SKIP_IDENTIFIER_CHECK: '1' }).status, 0, '显式跳过时退出码 0');
});

// ——— (e) 本仓 ———
test('本仓：仓根存在 .public-repo 标记文件', () => {
  assert.ok(fs.existsSync(path.join(ROOT, '.public-repo')));
});
