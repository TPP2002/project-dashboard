'use strict';
// WORKFLOW-OPS-SCRIPTS(0901):precheck / cleanup 的单测。命门 = junction 只删链接不伤真身。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('../cli/cleanup.cjs');
const { precheck } = require('../cli/precheck.cjs');
const cmds = require('../cli/commands.cjs');

const G = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** 造一个带一次提交的 git 仓 + 一个 worktree */
function gitEnv() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-')));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8' });
  G(repo, 'config', 'user.email', 't@t'); G(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n'); // 真实项目必备;不 ignore 时 cleanup 按脏工位保守拒绝
  G(repo, 'add', '.'); G(repo, 'commit', '-q', '-m', 'init');
  const wt = path.join(dir, 'wt1');
  G(repo, 'worktree', 'add', '-q', '-b', 'feat-1', wt);
  return { dir, repo, wt };
}
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows 偶发句柄滞留,临时目录留给系统清 */ } };

test('cleanup:脏工位拒绝动手', () => {
  const { dir, repo, wt } = gitEnv();
  fs.writeFileSync(path.join(wt, 'dirty.txt'), 'x');
  const r = cleanup({ repo, worktree: wt, yes: true });
  assert.equal(r.ok, false);
  assert.match(r.text, /未提交改动.*拒绝/s);
  assert.ok(fs.existsSync(wt), '工位必须原样保留');
  clean(dir);
});

test('cleanup:体检模式零执行,junction 检出但保留', () => {
  const { dir, repo, wt } = gitEnv();
  const real = path.join(dir, 'real-nm'); fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'proof.txt'), 'truth');
  fs.symlinkSync(real, path.join(wt, 'node_modules'), 'junction');
  const r = cleanup({ repo, worktree: wt });
  assert.match(r.text, /发现 1 个 junction/);
  assert.match(r.text, /体检模式/);
  assert.ok(fs.existsSync(path.join(wt, 'node_modules')), '体检模式不许摘链接');
  assert.ok(fs.existsSync(wt), '体检模式不许删工位');
  clean(dir);
});

test('cleanup --yes:摘链接不伤真身、工位清掉、未合入分支保留', () => {
  const { dir, repo, wt } = gitEnv();
  const real = path.join(dir, 'real-nm'); fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'proof.txt'), 'truth');
  fs.symlinkSync(real, path.join(wt, 'node_modules'), 'junction');
  const r = cleanup({ repo, worktree: wt, branch: 'feat-1', yes: true });
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(wt), '工位应被清掉');
  assert.ok(fs.existsSync(path.join(real, 'proof.txt')), '【命门】junction 指向的真身必须完好');
  const branches = G(repo, 'branch', '--list', 'feat-1');
  assert.ok(branches.includes('feat-1'), '【命门】验不出合入 → 分支必须保留不删');
  // 0906:这个测试仓压根没有 origin,旧断言写死「未合入 origin/main」本身就是那个写死 main 缺陷的产物。
  // 安全断言(上一行:分支必须保留)一字未动,只把文案改成如实的「探测不出干线所以不敢删」。
  assert.match(r.text, /探测不出本仓干线,无法验证 feat-1 是否已合入/);
  clean(dir);
});

test('cleanup:拒绝把主仓当工位清', () => {
  const { dir, repo } = gitEnv();
  assert.throws(() => cleanup({ repo, worktree: repo, yes: true }), /清不得/);
  clean(dir);
});

test('precheck:三段齐全,施工中占用与待拍板可见', () => {
  const { dir, repo } = gitEnv();
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const P = { project: 'p', registry: reg };
  cmds.register({ id: 'p', name: '测试项目', root: repo, registry: reg });
  cmds.add({ _: ['T1'], title: '干活卡', ...P });
  cmds.claim({ _: ['T1'], branch: 'feat-1', ...P });
  const r = precheck({ ...P, 'no-fetch': true });
  assert.match(r.text, /【① 新鲜度】/);
  assert.match(r.text, /【② 看板占用】/);
  assert.match(r.text, /【③ 正本必读/);
  assert.match(r.text, /🔨 T1/, '施工中的卡要列出来');
  assert.match(r.text, /跳过 fetch/);
  assert.match(r.text, /【④ 施工方】/, '第④查:施工方默认派 Codex 的提醒必须在');
  assert.match(r.text, /没有派单简报脚本/, '测试仓没有简报脚本时要明说,不能静默');
  clean(dir);
});

// ── BOARD-CLEANUP-DELETES-MAIN(0906 负责人拍 A)────────────────────────────
// 命门 = 干线(main/master/仓库实际默认分支)在任何走法下都不能被 cleanup 删掉。
// 上面的 gitEnv() 没有远程,origin/<干线> 解析不出来 → 删分支那条路整个走不到,
// 所以旧测试全绿也盖不住本缺陷;这里必须造带远程的仓。
function gitEnvRemote(trunk) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-rm-')));
  const origin = path.join(dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', trunk, origin], { encoding: 'utf8' });
  const repo = path.join(dir, 'repo');
  execFileSync('git', ['clone', '-q', origin, repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  G(repo, 'config', 'user.email', 't@t'); G(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  G(repo, 'add', '.'); G(repo, 'commit', '-q', '-m', 'init');
  G(repo, 'push', '-q', '-u', 'origin', trunk);
  return { dir, origin, repo, trunk };
}
const hasBranch = (repo, b) => G(repo, 'branch', '--list', b).trim() !== '';

test('cleanup:工位签在干线上时,干线绝不能被删(0902 实际事故路径)', () => {
  const { dir, repo } = gitEnvRemote('main');
  G(repo, 'checkout', '-q', '--detach', 'HEAD');        // 主仓让开,好让工位签出 main
  const wt = path.join(dir, 'wt-main');
  G(repo, 'worktree', 'add', '-q', wt, 'main');         // 跑基线对照那种 main 工位
  const r = cleanup({ repo, worktree: wt, yes: true }); // 标准命令,一个 --branch 都不传
  assert.ok(hasBranch(repo, 'main'), '【命门】干线 main 必须还在');
  assert.match(r.text, /干线/, '必须明说这是干线、已拒删');
  clean(dir);
});

test('cleanup:显式 --branch 指干线同样拒删,且不得打印删远程正本的引导语', () => {
  const { dir, repo } = gitEnvRemote('main');
  const wt = path.join(dir, 'wt1');
  G(repo, 'worktree', 'add', '-q', wt, '-b', 'feat-1');
  const r = cleanup({ repo, worktree: wt, branch: 'main', yes: true });
  assert.ok(hasBranch(repo, 'main'), '【命门】干线 main 必须还在');
  assert.doesNotMatch(r.text, /push origin --delete main/, '【命门】绝不能引导人删远程正本');
  clean(dir);
});

test('cleanup:干线叫 master 的仓库,已合入的支线要真的删掉(修掉写死 origin/main)', () => {
  const { dir, repo } = gitEnvRemote('master');
  const wt = path.join(dir, 'wt1');
  G(repo, 'worktree', 'add', '-q', wt, '-b', 'feat-1'); // 与 master 同点 = 已合入
  const r = cleanup({ repo, worktree: wt, yes: true });
  assert.ok(hasBranch(repo, 'master'), '干线 master 必须还在');
  assert.ok(!hasBranch(repo, 'feat-1'), '已合入的支线应被清掉(写死 origin/main 时这里会漏删)');
  assert.match(r.text, /origin\/master/, '合入校验应对着本仓真正的干线 master');
  clean(dir);
});

test('cleanup:--branch 指的分支已不存在时判为已删并跳过,不去动别的分支', () => {
  const { dir, repo } = gitEnvRemote('main');
  const wt = path.join(dir, 'wt1');
  G(repo, 'worktree', 'add', '-q', wt, '-b', 'feat-1');
  const r = cleanup({ repo, worktree: wt, branch: 'feat-gone', yes: true });
  assert.match(r.text, /已不存在|已被删/, '应判为「分支已被删,无需处理」');
  assert.ok(hasBranch(repo, 'main'), '干线必须完好');
  assert.ok(hasBranch(repo, 'feat-1'), '别的分支一根汗毛都不许动');
  clean(dir);
});
