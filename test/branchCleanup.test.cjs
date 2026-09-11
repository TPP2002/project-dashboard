'use strict';
/**
 * branchCleanup.test.cjs —— 按分支体检结果自动摘掉误扣分支（BOARD-GITFIELD-HISTORY-AUTOCLEAN，拍板 d1=③-A）。
 *
 * 上游 BOARD-GITFIELD-HISTORY-CLEANUP 落地了 `doctor --branches` 只读体检；本卡承接拍板③-A：
 * `doctor --branches --fix` 才动手，只摘证据最硬的那一档，摘之前备份，摘完留痕，重跑幂等。
 *
 * 本文件即契约。一条 卡·分支 条目会被摘掉，当且仅当四件事同时成立：
 *   1) 体检判 verdict=suspect 且 evidence=commits（分支自有提交明明白白只提别的卡）；
 *   2) otherIds 非空，且其中每张卡自己的 gitBranch 里也挂着这条分支（分支有正主——早期批次容器分支
 *      如 rogue-b1a-1 的提交只写子卡号、子卡却不挂它，这类就不摘，机器自己认得出来）；
 *   3) otherIds 里没有任何一张卡与本卡在 deps 里有关系（dependsOn / blockedBy / relatedTasks，两个方向都算）；
 *   4) 给了 --fix。只给 --branches 一个字节都不改。
 * 分支名反证（evidence=name）、无法核实、可信的条目永远不碰；只动 gitBranch，不碰其它字段。
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
const { planBranchCleanup } = require('../cli/branchAudit.cjs');

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', windowsHide: true });
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };

function setupRepo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'brclean-')));
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
}
const task = (t, id) => readBoard(t.board).tasks.find((x) => x.id === id);
const bakFiles = (t) => fs.readdirSync(path.dirname(t.board)).filter((f) => f.startsWith('board.json.bak-'));

test('纯函数：四条件缺一不摘，摘的只有“有提交反证 + 分支有正主 + 无依赖关系”的条目', () => {
  const tasks = [
    { id: 'OLD', gitBranch: ['feat-new', 'feat-dep', 'feat-orphan', 'gone', 'br-ok'], deps: { dependsOn: ['DEP'], blockedBy: [], relatedTasks: [] } },
    { id: 'NEW', gitBranch: ['feat-new'], deps: { dependsOn: [], blockedBy: [], relatedTasks: [] } },
    { id: 'DEP', gitBranch: ['feat-dep'], deps: { dependsOn: [], blockedBy: [], relatedTasks: [] } },
    { id: 'KID', gitBranch: [], deps: { dependsOn: [], blockedBy: [], relatedTasks: [] } },
    { id: 'REL', gitBranch: ['feat-rel'], deps: { dependsOn: [], blockedBy: [], relatedTasks: ['ELDER'] } },
    { id: 'ELDER', gitBranch: ['feat-rel'], deps: { dependsOn: [], blockedBy: [], relatedTasks: [] } },
  ];
  const entries = [
    { taskId: 'OLD', branch: 'feat-new', verdict: 'suspect', evidence: 'commits', otherIds: ['NEW'] },      // 摘：NEW 自己挂着 feat-new
    { taskId: 'OLD', branch: 'feat-dep', verdict: 'suspect', evidence: 'commits', otherIds: ['DEP'] },      // 不摘：OLD dependsOn DEP
    { taskId: 'OLD', branch: 'feat-orphan', verdict: 'suspect', evidence: 'commits', otherIds: ['KID'] },   // 不摘：KID 没挂 feat-orphan（批次容器分支的样子）
    { taskId: 'OLD', branch: 'gone', verdict: 'suspect', evidence: 'name', otherIds: ['NEW'] },             // 不摘：只有名字线索
    { taskId: 'OLD', branch: 'br-ok', verdict: 'ok', evidence: 'commits', otherIds: [] },
    { taskId: 'NEW', branch: 'feat-new', verdict: 'ok', evidence: 'commits', otherIds: [] },
    { taskId: 'ELDER', branch: 'feat-rel', verdict: 'suspect', evidence: 'commits', otherIds: ['REL'] },    // 不摘：REL 的 relatedTasks 指着 ELDER（反向也算）
  ];
  const plan = planBranchCleanup(tasks, entries);
  assert.deepEqual(plan.removals.map((r) => r.taskId + '·' + r.branch), ['OLD·feat-new']);
  assert.deepEqual(plan.removals[0].otherIds, ['NEW']);
  assert.deepEqual(plan.skipped, { related: 2, noOwner: 1 }, '被跳过的要分类计数：有依赖关系 2（feat-dep、feat-rel）、分支没正主 1（feat-orphan）');
  assert.deepEqual(tasks[0].gitBranch, ['feat-new', 'feat-dep', 'feat-orphan', 'gone', 'br-ok'], '规划是纯函数，不改输入');
});

test('端到端：--branches --fix 摘掉 0903 误扣的分支，先备份、留痕、幂等；只给 --branches 不动', () => {
  const t = setupRepo();
  const wt = path.join(t.dir, 'wt');
  try {
    cmds.add({ _: ['OLD01'], title: '早就干完的老卡', ...t.P });
    cmds.add({ _: ['NEW02'], title: '新工位的活', ...t.P });
    cmds.add({ _: ['DEP03'], title: 'OLD01 的上游', ...t.P });
    commit(t.repo, 'old.txt', 'feat(OLD01): 老活早已合入');
    git(t.repo, ['worktree', 'add', '-q', '-b', 'feat-new', wt, 'master']);
    commit(wt, 'new.txt', 'feat(NEW02): 新工位干的活');
    git(t.repo, ['branch', '-q', 'feat-dep', 'master']);
    commit(t.repo, 'dep.txt', 'feat(DEP03): 上游的活'); // 落在 master 上；feat-dep 分支自有提交为空 → 不是本条测试的重点
    git(t.repo, ['checkout', '-q', 'feat-dep']);
    commit(t.repo, 'dep2.txt', 'feat(DEP03): 上游在 feat-dep 上的活');
    git(t.repo, ['checkout', '-q', 'master']);

    // 模拟修复前的广播污染：OLD01 被扣上 feat-new（正主 NEW02）与 feat-dep（正主 DEP03，但 OLD01 依赖 DEP03）
    cmds.set({ _: ['OLD01'], field: 'gitBranch', value: JSON.stringify(['feat-new', 'feat-dep']), ...t.P });
    cmds.claim({ _: ['NEW02'], branch: 'feat-new', ...t.P });
    cmds.claim({ _: ['DEP03'], branch: 'feat-dep', ...t.P });
    cmds.set({ _: ['OLD01'], field: 'deps.dependsOn', value: '["DEP03"]', ...t.P });
    const before = fs.readFileSync(t.board, 'utf8');

    doctor({ ...t.P, branches: true });
    assert.equal(fs.readFileSync(t.board, 'utf8'), before, '只给 --branches 一个字节都不改');
    assert.deepEqual(bakFiles(t), [], '不动手就不备份');

    const r = doctor({ ...t.P, branches: true, fix: true });
    assert.ok(r.branchAudit && r.branchAudit.cleanup, '--fix 应带回清理结果');
    assert.equal(r.branchAudit.cleanup.removed, 1);
    assert.deepEqual(r.branchAudit.cleanup.skipped, { related: 1, noOwner: 0 });
    assert.deepEqual(task(t, 'OLD01').gitBranch, ['feat-dep'], 'feat-new 摘掉；feat-dep 因 OLD01 依赖 DEP03 留着');
    assert.deepEqual(task(t, 'NEW02').gitBranch, ['feat-new'], '正主不受影响');
    assert.deepEqual(task(t, 'DEP03').gitBranch, ['feat-dep']);
    assert.deepEqual(task(t, 'OLD01').deps.dependsOn, ['DEP03'], '只动 gitBranch，语义字段不碰');
    assert.match(r.text, /摘/, '人读文本要说明摘了什么');
    assert.match(r.text, /OLD01·feat-new/);

    const baks = bakFiles(t);
    assert.equal(baks.length, 1, '动手前备份一份');
    assert.equal(fs.readFileSync(path.join(path.dirname(t.board), baks[0]), 'utf8'), before, '备份就是动手前那份原样');
    assert.ok(readBoard(t.board).activity.some((a) => a.type === 'note' && /摘掉 1 条/.test(a.text)), '活动流留痕');

    const again = doctor({ ...t.P, branches: true, fix: true });
    assert.equal(again.branchAudit.cleanup.removed, 0, '重跑幂等');
    assert.equal(bakFiles(t).length, 1, '没东西可摘就不再备份');
  } finally { clean(wt); clean(t.dir); }
});
