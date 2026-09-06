'use strict';
/**
 * branchAudit.test.cjs —— 老卡 gitBranch 台账的只读体检（BOARD-GITFIELD-HISTORY-CLEANUP）。
 *
 * 背景：0903 之前 sync-from-git 把采样到的分支广播给最近 300 条历史窗口里全部匹配到的卡，
 * 老卡的 gitBranch 里真分支与误扣分支混在一起（rogue 板 569 张卡里 241 张挂着 ≥2 条分支，
 * 卡↔分支对 8324 个）。修复 0f853af 只止住了新污染，存量靠人肉一条条看不现实。
 *
 * 本文件即契约（拍板取②：只读体检，不擅自删数据）：
 *   · `doctor --branches` 才跑（默认不跑——doctor 挂在每次对话结束的 Stop 钩子上，不能拖慢它）。
 *   · 判据：某分支“自己带来的那批提交”里有没有一条 subject 提到本卡 id。
 *       - 分支还在（本地或远程 ref）且没合并：自有提交 = 分支可达 − 主干可达；
 *       - 已合并：自有提交 = 把它合进主干的那个 merge 的第二亲链（M^1..M^2）；
 *       - 分支已删：靠主干里的 merge 提交 subject（"Merge pull request #N from X/分支" / "Merge branch '分支'"）
 *         找回它的提交；找不到就老实标“无法核实”，不硬判。
 *     分支名本身点名本卡（如 rogue-d2a-1 之于 D2A）视为可信；分支名点名【别的】卡而又查不到提交的，标可疑。
 *   · 只读：doctor 跑完 board.json 一个字节不变。
 */
const path = require('node:path');
process.env.DASHBOARD_HOME = path.join(__dirname, '..');

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { readBoard } = require('../cli/store.cjs');
const { doctor } = require('../cli/gitSync.cjs');
const { classifyBranches } = require('../cli/branchAudit.cjs');

const git = (repo, args, env) => execFileSync('git', ['-C', repo, ...args], {
  stdio: 'ignore', windowsHide: true, env: env ? { ...process.env, ...env } : process.env,
});
const gitOut = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };

function setupRepo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'braudit-')));
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

function commit(repo, file, msg) {
  fs.writeFileSync(path.join(repo, file), 'x-' + file + '-' + Date.now());
  git(repo, ['add', file]);
  git(repo, ['commit', '-q', '-m', msg]);
  return gitOut(repo, ['rev-parse', 'HEAD']);
}

/** 把 verdict 表压成 {taskId·branch: verdict} 便于断言。 */
const asMap = (entries) => Object.fromEntries(entries.map((e) => [e.taskId + '·' + e.branch, e.verdict]));

test('纯函数：在一张手搓的提交图上按“分支自有提交是否提到本卡”分三档', () => {
  // 主干 c0 ← c1 ← M（把 b1 合进来，b1 在已删分支 br-p01 上）← c3
  // 活分支 br-p02 从 c3 长出 b2（提到 P02，未合并）
  const nodes = new Map([
    ['c0', { parents: [], subject: 'init' }],
    ['c1', { parents: ['c0'], subject: 'chore: 铺路' }],
    ['b1', { parents: ['c1'], subject: 'feat(P01): 老活落地' }],
    ['M', { parents: ['c1', 'b1'], subject: 'Merge pull request #5 from TPP2002/br-p01' }],
    ['c3', { parents: ['M'], subject: 'docs: 收尾' }],
    ['b2', { parents: ['c3'], subject: 'feat(P02): 新活' }],
    ['b3', { parents: ['c3'], subject: 'chore: 早期提交，不带卡号' }], // 活分支 br-none
  ]);
  const graph = {
    nodes,
    refs: new Map([['refs/heads/master', 'c3'], ['refs/heads/br-p02', 'b2'], ['refs/heads/br-none', 'b3']]),
    trunk: { name: 'master', sha: 'c3' },
  };
  const tasks = [
    { id: 'P01', gitBranch: ['br-p01', 'br-p02', 'master', 'gone-branch', 'br-none'] },
    { id: 'P02', gitBranch: ['br-p02'] },
    { id: 'P03', gitBranch: ['claude/p01-followup-9c02a1'] },
  ];
  const r = classifyBranches(tasks, graph);
  const m = asMap(r.entries);
  assert.equal(m['P01·br-p01'], 'ok', '分支虽已删，主干 merge 提交点了名，其第二亲链里有 P01 的提交 → 可信');
  assert.equal(m['P01·br-p02'], 'suspect', 'br-p02 自有提交只提 P02，从没提过 P01 → 可疑');
  assert.equal(m['P01·master'], 'ok', 'P01 的提交已在主干里 → 主干条目可信');
  assert.equal(m['P01·gone-branch'], 'unknown', '分支已删、主干里也找不到它的 merge → 老实说无法核实');
  assert.equal(m['P01·br-none'], 'unknown', '分支自有提交一张卡都没提：是没证据，不是反证（早期提交不带卡号是常态）→ 无法核实，不许判可疑');
  assert.equal(m['P02·br-p02'], 'ok');
  assert.equal(m['P03·claude/p01-followup-9c02a1'], 'suspect', '查不到提交，但分支名点名的是别的卡 P01 → 可疑');
  const sus = r.entries.find((e) => e.taskId === 'P01' && e.branch === 'br-p02');
  assert.deepEqual(sus.otherIds, ['P02'], '可疑条目要带上“这分支实际提到了谁”，人工确认才有依据');
  assert.equal(sus.evidence, 'commits', '判决要标明靠的是提交证据还是分支名证据，后续自动清理才好分档');
  assert.equal(r.entries.find((e) => e.taskId === 'P03').evidence, 'name');
  assert.deepEqual(r.summary, { ok: 3, suspect: 2, unknown: 2 });
});

test('端到端：0903 现象——老卡被灌了新工位的分支，doctor --branches 点得出来，且只读', () => {
  const t = setupRepo();
  const wt = path.join(t.dir, 'wt');
  try {
    cmds.add({ _: ['OLD01'], title: '早就干完的老卡', ...t.P });
    cmds.add({ _: ['NEW02'], title: '新工位的活', ...t.P });
    commit(t.repo, 'old.txt', 'feat(OLD01): 老活早已合入');
    git(t.repo, ['worktree', 'add', '-q', '-b', 'feat-new', wt, 'master']);
    commit(wt, 'new.txt', 'feat(NEW02): 新工位干的活');

    // 模拟修复前的广播污染：OLD01 被扣上 feat-new；NEW02 是真分支
    cmds.claim({ _: ['OLD01'], branch: 'feat-new', ...t.P });
    cmds.claim({ _: ['NEW02'], branch: 'feat-new', ...t.P });
    const before = fs.readFileSync(t.board, 'utf8');

    const plain = doctor({ ...t.P });
    assert.equal(plain.branchAudit, undefined, '不给 --branches 就不跑（Stop 钩子每次对话结束都跑 doctor，不能拖慢它）');

    const r = doctor({ ...t.P, branches: true });
    assert.ok(r.branchAudit, '给了 --branches 就应带回体检结果');
    const m = asMap(r.branchAudit.entries);
    assert.equal(m['OLD01·feat-new'], 'suspect', 'feat-new 自己那条提交只提 NEW02，扣在 OLD01 头上就是张冠李戴');
    assert.equal(m['NEW02·feat-new'], 'ok');
    assert.match(r.text, /OLD01/, '可疑条目要出现在人读的体检文本里');
    assert.match(r.text, /feat-new/);
    assert.equal(fs.readFileSync(t.board, 'utf8'), before, '体检是只读的，board.json 一个字节都不该变');
  } finally { clean(wt); clean(t.dir); }
});

test('端到端：分支合并后已删除，凭主干里的 merge 提交仍能判真伪', () => {
  const t = setupRepo();
  try {
    cmds.add({ _: ['P01'], title: 'x', ...t.P });
    cmds.add({ _: ['P02'], title: 'y', ...t.P });
    git(t.repo, ['checkout', '-q', '-b', 'br-x']);
    commit(t.repo, 'a.txt', 'feat(P01): 在 br-x 上干的');
    git(t.repo, ['checkout', '-q', 'master']);
    git(t.repo, ['merge', '-q', '--no-ff', '--no-edit', 'br-x']); // 默认信息 "Merge branch 'br-x'"
    git(t.repo, ['branch', '-q', '-D', 'br-x']);
    cmds.claim({ _: ['P01'], branch: 'br-x', ...t.P });
    cmds.claim({ _: ['P02'], branch: 'br-x', ...t.P });

    const r = doctor({ ...t.P, branches: true });
    const m = asMap(r.branchAudit.entries);
    assert.equal(m['P01·br-x'], 'ok', '分支没了，但 merge 提交的第二亲链里有 P01 的提交');
    assert.equal(m['P02·br-x'], 'suspect', '同一条分支从没提过 P02');
    assert.equal(readBoard(t.board).tasks.find((x) => x.id === 'P02').gitBranch.length, 1, '只报不删');
  } finally { clean(t.dir); }
});
