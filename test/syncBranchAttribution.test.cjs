'use strict';
/**
 * syncBranchAttribution.test.cjs —— gitBranch 张冠李戴（SYNC-FROM-GIT-BRANCH-MISATTRIBUTION）回归。
 *
 * 修前的病根链：post-commit 装在 <mainRepo>/.git/hooks（worktree 共享同一份）→ 调用行不传 --branch
 * → syncFromGit 退回 `git -C mainRepo rev-parse --abbrev-ref HEAD`（主目录此刻恰好签出的分支，纯竞态采样）
 * → scanCommits 重扫 300 条历史、把这个采样值广播给窗口里全部匹配到的卡。
 *
 * 修后的契约（本文件即契约）：
 *   · gitBranch 只在【显式给了 --branch】时才写；全量重扫绝不凭主目录 HEAD 臆造分支。
 *   · 给了 --commit 就只认那一次提交，不碰历史窗口里的其它卡。
 *   · commitShas 前缀相同的长短哈希视为同一个提交，只留长的那份。
 */
const path = require('node:path');
// 必须在 require 看板模块之前设：hooks 里嵌的 CLI 路径由 DASHBOARD_HOME 在模块加载时算死。
// 不设的话钩子会指向【已安装的那份】(~/.claude/dashboard)，端到端测的就不是本工作区的代码。
process.env.DASHBOARD_HOME = path.join(__dirname, '..');

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { readBoard } = require('../cli/store.cjs');
const { syncFromGit } = require('../cli/gitSync.cjs');
const { hooksInstall } = require('../cli/hooksInstall.cjs');

const git = (repo, args, env) => execFileSync('git', ['-C', repo, ...args], {
  stdio: 'ignore', windowsHide: true, env: env ? { ...process.env, ...env } : process.env,
});
const gitOut = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };

/** 临时目录 + 空 registry + git 仓 + 注册项目 g（与 gitE2e 同款，绝不碰真实主仓/registry）。 */
function setupRepo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'brattr-')));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'master']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 'tester']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['commit', '--allow-empty', '-q', '-m', 'init']);
  cmds.register({ id: 'g', name: 'demo', root: repo, registry: reg });
  return { dir, repo, reg, board: path.join(repo, '.dashboard', 'board.json'), P: { project: 'g', registry: reg } };
}

function commit(repo, file, msg, env) {
  fs.writeFileSync(path.join(repo, file), 'x-' + file + '-' + Date.now());
  git(repo, ['add', file], env);
  git(repo, ['commit', '-q', '-m', msg], env);
  return gitOut(repo, ['rev-parse', 'HEAD']);
}

const findTask = (t, id) => readBoard(t.board).tasks.find((x) => x.id === id);

test('Fix A：post-commit 把本工位真实分支与本次提交显式传给 sync-from-git', () => {
  const t = setupRepo();
  try {
    hooksInstall({ ...t.P });
    const pc = fs.readFileSync(path.join(t.repo, '.git', 'hooks', 'post-commit'), 'utf8');
    assert.match(pc, /rev-parse --abbrev-ref HEAD/, 'post-commit 应就地读本工位分支（照抄 pre-commit 的写法）');
    assert.match(pc, /--branch/, 'post-commit 应把分支显式传给 sync-from-git');
    assert.match(pc, /--commit/, 'post-commit 应把本次提交的哈希显式传给 sync-from-git');
    assert.doesNotMatch(pc, /rev-parse[^\n]*-C /, '不许用 -C 回查主目录——那正是张冠李戴的来源');
  } finally { clean(t.dir); }
});

test('Fix B：--commit 只认这一次提交，不把分支广播给历史窗口里的其它卡', () => {
  const t = setupRepo();
  try {
    cmds.add({ _: ['P01'], title: '老活', ...t.P });
    cmds.add({ _: ['P02'], title: '新活', ...t.P });

    const sha1 = commit(t.repo, 'a.txt', 'feat(P01): 老活落地');
    syncFromGit({ ...t.P, branch: 'br-old', commit: sha1 });

    const sha2 = commit(t.repo, 'b.txt', 'feat(P02): 新活落地');
    syncFromGit({ ...t.P, branch: 'br-new', commit: sha2 });

    const p01 = findTask(t, 'P01');
    const p02 = findTask(t, 'P02');
    assert.deepEqual(p01.gitBranch, ['br-old'], 'P01 只该有自己那次提交带来的分支，不该被后来的 br-new 污染');
    assert.deepEqual(p01.commitShas, [sha1.slice(0, 12)], 'P01 的提交清单不该被第二次 sync 改动');
    assert.ok(p02.gitBranch.includes('br-new'), 'P02 应记到本次分支');
    assert.ok(p02.commitShas.includes(sha2.slice(0, 12)), 'P02 应记到本次提交');
  } finally { clean(t.dir); }
});

test('Fix B：全量重扫（不给 --branch）不再凭主目录 HEAD 臆造 gitBranch', () => {
  const t = setupRepo();
  try {
    cmds.add({ _: ['P01'], title: 'x', ...t.P });
    const sha = commit(t.repo, 'c.txt', 'feat(P01): 全量重扫用');
    syncFromGit({ ...t.P }); // doctor --fix 走的就是这条路：没有逐条提交的分支信息
    const p01 = findTask(t, 'P01');
    assert.deepEqual(p01.gitBranch, [], '没有可信的分支来源时就该留空，而不是把主目录此刻的分支灌进来');
    assert.ok(p01.commitShas.includes(sha.slice(0, 12)), '提交哈希是逐条提交的事实，照旧要补齐');
  } finally { clean(t.dir); }
});

test('端到端：新工位提交，不把自己的分支扣到历史里的老卡头上（0903 现象复现）', () => {
  const t = setupRepo();
  const wt = path.join(t.dir, 'wt');
  try {
    cmds.add({ _: ['OLD01'], title: '早就干完的老卡', ...t.P });
    cmds.add({ _: ['NEW02'], title: '新工位的活', ...t.P });
    hooksInstall({ ...t.P });

    // 老卡的提交进 master 历史——新分支从这里长出去，于是它落在新分支的"最近 300 条"窗口里
    const shaOld = commit(t.repo, 'old.txt', 'feat(OLD01): 老活早已合入');

    git(t.repo, ['worktree', 'add', '-q', '-b', 'feat-new', wt, 'master']);
    git(t.repo, ['checkout', '-q', '-b', 'unrelated-main-branch']); // 主目录被别的会话切走了

    // 跳过 claim 闸门，好让 gitBranch 里只留 hook 写进去的那一笔
    const shaNew = commit(wt, 'new.txt', 'feat(NEW02): 新工位干的活', { DASHBOARD_SKIP_CLAIM_CHECK: '1' });

    const oldTask = findTask(t, 'OLD01');
    const newTask = findTask(t, 'NEW02');
    assert.deepEqual(oldTask.gitBranch, ['master'], '老卡只该留自己那次提交所在的分支，不该被新工位的分支串门');
    assert.deepEqual(oldTask.commitShas, [shaOld.slice(0, 12)], '老卡的提交清单不该被新提交搅动');
    assert.deepEqual(newTask.gitBranch, ['feat-new'], '新卡记的是本工位分支');
    assert.ok(!newTask.gitBranch.includes('unrelated-main-branch'), '绝不能记成主目录此刻恰好签出的分支');
    assert.ok(newTask.commitShas.includes(shaNew.slice(0, 12)), '新卡应记到本次提交');
  } finally { clean(wt); clean(t.dir); }
});

test('Fix C：同一提交的长短哈希不再重复登记', () => {
  const t = setupRepo();
  try {
    cmds.add({ _: ['P01'], title: 'x', ...t.P });
    const sha = commit(t.repo, 'd.txt', 'feat(P01): 哈希长度归一化');
    cmds.done({ _: ['P01'], commit: sha.slice(0, 8), ...t.P }); // 人工登记 8 位短写
    syncFromGit({ ...t.P, branch: 'br', commit: sha }); // 自动扫出 12 位

    const p01 = findTask(t, 'P01');
    assert.equal(p01.commitShas.length, 1, '同一个提交不该以两种长度并存');
    assert.equal(p01.commitShas[0], sha.slice(0, 12), '保留信息更全的那一份');
  } finally { clean(t.dir); }
});
