'use strict';
const path = require('node:path');
// 必须先于看板模块加载，真钩子才会指向本检出而不是已安装的旧副本。
process.env.DASHBOARD_HOOK_CLI_ROOT = path.resolve(__dirname, '..');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { readBoard } = require('../cli/store.cjs');
const { scanCommits, syncFromGit, doctor } = require('../cli/gitSync.cjs');
const { hooksInstall } = require('../cli/hooksInstall.cjs');

function git(repo, args, env = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, ...env },
  }).trim();
}

/** 所有写入限于本用例临时目录，板经命令写入，全局设置也与本机隔离。 */
function setup(t) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, 'sync-mention-'));
  const reg = path.join(dir, 'registry.json'), repo = path.join(dir, 'repo');
  const savedSettings = process.env.DASHBOARD_GLOBAL_SETTINGS;
  process.env.DASHBOARD_GLOBAL_SETTINGS = path.join(dir, 'global-settings.json');
  t.after(() => {
    if (savedSettings === undefined) delete process.env.DASHBOARD_GLOBAL_SETTINGS;
    else process.env.DASHBOARD_GLOBAL_SETTINGS = savedSettings;
    assert.equal(path.dirname(dir), tempRoot, '清理只限本次创建的临时目录');
    assert.ok(path.basename(dir).startsWith('sync-mention-'));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  fs.writeFileSync(process.env.DASHBOARD_GLOBAL_SETTINGS, '{}');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'master', '--template=']);
  git(repo, ['config', 'user.email', 't@example.invalid']);
  git(repo, ['config', 'user.name', 'tester']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.hooksPath', path.join(repo, '.git', 'hooks')]);
  git(repo, ['commit', '--allow-empty', '-q', '-m', 'init']);
  const registered = cmds.register({ id: 'g', name: '临时项目', root: repo, registry: reg });
  return { dir, repo, reg, board: registered.board, branch: 'master', P: { project: 'g', registry: reg } };
}

function add(f, ...ids) {
  for (const id of ids) cmds.add({ ...f.P, _: [id], title: '临时验证卡', 'plain-title': '临时验证卡', model: 'test' });
}
function commit(repo, file, subject, env) {
  fs.writeFileSync(path.join(repo, file), subject + '\n');
  git(repo, ['add', file], env);
  git(repo, ['commit', '-q', '-m', subject], env);
  return git(repo, ['rev-parse', 'HEAD']);
}
const task = (f, id) => readBoard(f.board).tasks.find((x) => x.id === id);
const gitFields = (card) => [card.commitShas, card.prNumbers, card.gitBranch];
const syncActivity = (f) => (readBoard(f.board).activity || []).filter((a) => /sync-from-git/.test(a.text || ''));

test('M1：正文提及未认领卡，单次同步、窗口重扫和体检均不误关联', (t) => {
  const f = setup(t);
  add(f, 'LATER');
  const sha = commit(f.repo, 'm1.txt', 'docs(bot-p1): 已交付 PR #549，下一步挂 LATER 待拍 (#77)');
  const scan = scanCommits(f.repo, ['LATER'], { commit: sha });
  assert.equal(scan.scanned, 1);
  assert.deepEqual(scan.perTask, {});
  assert.deepEqual(scan.prose.LATER, { commits: new Set([sha.slice(0, 12)]), prs: new Set([77]) });
  const single = syncFromGit({ ...f.P, branch: f.branch, commit: sha });
  assert.equal(single.changed, 0);
  assert.deepEqual(gitFields(task(f, 'LATER')), [[], [], []]);
  assert.equal(syncFromGit({ ...f.P, branch: f.branch }).changed, 0);
  assert.equal(syncFromGit(f.P).changed, 0);
  assert.deepEqual(gitFields(task(f, 'LATER')), [[], [], []]);
  const beforeDoctor = fs.readFileSync(f.board, 'utf8');
  assert.doesNotMatch(doctor(f.P).text, /未记入 board|派生字段漂移/);
  assert.equal(fs.readFileSync(f.board, 'utf8'), beforeDoctor, '体检只读，不清理也不补写');
  assert.equal(syncActivity(f).length, 0, '没有更新就不追加同步流水');
});

test('M2：同条提交只把约定位置的 X 记入，正文 Y 保持空白', (t) => {
  const f = setup(t);
  add(f, 'X', 'Y');
  const sha = commit(f.repo, 'm2.txt', 'feat(X): 实现落地，下一步承接 Y (#14)');
  assert.equal(syncFromGit({ ...f.P, branch: f.branch, commit: sha }).changed, 1);
  assert.deepEqual(gitFields(task(f, 'X')), [[sha.slice(0, 12)], [14], [f.branch]]);
  assert.deepEqual(gitFields(task(f, 'Y')), [[], [], []]);
  assert.doesNotMatch(doctor(f.P).text, /未记入 board|派生字段漂移/);
});

test('M3：正文只给当前分支已认领卡补本次提交，缺参数或换分支均不补', (t) => {
  const f = setup(t);
  add(f, 'Z');
  cmds.claim({ ...f.P, _: ['Z'], branch: f.branch });
  const claimed = task(f, 'Z');
  const sha = commit(f.repo, 'm3.txt', 'docs(bot): 继续记录 Z 的施工 (#88)');
  for (const flags of [{ branch: f.branch }, { commit: sha }, { branch: 'HEAD', commit: sha }]) {
    assert.equal(syncFromGit({ ...f.P, ...flags }).changed, 0);
    assert.deepEqual(gitFields(task(f, 'Z')), [[], [], [f.branch]]);
  }
  assert.equal(syncFromGit({ ...f.P, branch: f.branch, commit: sha }).changed, 1);
  assert.deepEqual(gitFields(task(f, 'Z')), [[sha.slice(0, 12)], [88], [f.branch]]);
  const semantic = (card) => Object.fromEntries(Object.entries(card)
    .filter(([key]) => !['commitShas', 'prNumbers', 'gitBranch'].includes(key)));
  assert.deepEqual(semantic(task(f, 'Z')), semantic(claimed), '语义字段保持原样');
  assert.equal(syncActivity(f).length, 1);
  assert.equal(syncActivity(f)[0].author, 'git-hook');
  assert.equal(syncFromGit({ ...f.P, branch: f.branch, commit: sha }).changed, 0);
  assert.equal(syncActivity(f).length, 1, '重复同步不重复留痕');

  git(f.repo, ['checkout', '-q', '-b', 'unclaimed-branch']);
  const other = commit(f.repo, 'm3-other.txt', 'docs(bot): 又提到 Z 的记录 (#99)');
  assert.equal(syncFromGit({ ...f.P, branch: 'unclaimed-branch', commit: other }).changed, 0);
  assert.equal(syncFromGit({ ...f.P, branch: f.branch }).changed, 0, '认领过也不能用窗口补正文');
  assert.deepEqual(gitFields(task(f, 'Z')), [[sha.slice(0, 12)], [88], [f.branch]]);
});

test('M4：末尾组中的两张卡都记提交和分支', (t) => {
  const f = setup(t);
  add(f, 'A', 'B');
  const sha = commit(f.repo, 'm4.txt', '联调记录定稿 (A / B)');
  assert.equal(syncFromGit({ ...f.P, branch: f.branch, commit: sha }).changed, 2);
  for (const id of ['A', 'B']) assert.deepEqual(gitFields(task(f, id)), [[sha.slice(0, 12)], [], [f.branch]]);
});

test('M5：正文 PR #549 不算，末尾纯标注只记 PR 77', (t) => {
  const f = setup(t);
  add(f, 'X');
  const sha = commit(f.repo, 'm5.txt', 'feat(X): 已交付 PR #549，已被 PR#474 覆盖 (#77)');
  assert.equal(syncFromGit({ ...f.P, branch: f.branch, commit: sha }).changed, 1);
  assert.deepEqual(gitFields(task(f, 'X')), [[sha.slice(0, 12)], [77], [f.branch]]);
});

test('M6：真 worktree 提交触发钩子，正文提及未认领卡仍不记任何字段', (t) => {
  const f = setup(t);
  add(f, 'CONTROL', 'LATER');
  hooksInstall(f.P);
  const wt = path.join(f.dir, 'wt'), branch = 'mention-worktree';
  git(f.repo, ['worktree', 'add', '-q', '-b', branch, wt, 'master']);
  const env = { DASHBOARD_SKIP_CLAIM_CHECK: '1' };
  // 正向对照保证钩子确实运行；只断言 LATER 为空会把钩子没跑也判成成功。
  const control = commit(wt, 'control.txt', 'feat(CONTROL): 验证同步钩子 (#90)', env);
  assert.deepEqual(gitFields(task(f, 'CONTROL')), [[control.slice(0, 12)], [90], [branch]]);
  commit(wt, 'mention.txt', 'docs(bot): 下一步挂 LATER 待拍，已交付 PR #549 (#88)', env);
  assert.deepEqual(gitFields(task(f, 'LATER')), [[], [], []]);
  assert.deepEqual(gitFields(task(f, 'CONTROL')), [[control.slice(0, 12)], [90], [branch]]);
});
