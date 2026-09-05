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
  assert.ok(branches.includes('feat-1'), '无 origin/main 可验合入 → 分支必须保留不删');
  assert.match(r.text, /未合入 origin\/main/);
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
