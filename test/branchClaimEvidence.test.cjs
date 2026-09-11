'use strict';
/** 分支认领、无证据铺开面与四档清理契约；所有持久化夹具均落在临时目录。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { readBoard } = require('../cli/store.cjs');
const { doctor } = require('../cli/gitSync.cjs');
const branchAudit = require('../cli/branchAudit.cjs');
const { claimIndex, loadClaimIndex, classifyBranches, planBranchCleanup } = branchAudit;

const emptyGraph = () => ({ refs: new Map(), nodes: new Map(), trunk: null });
const claim = (taskId, branches) => ({ type: 'claim', taskId, text: `认领 ${taskId}：分支 ${branches}` });
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', windowsHide: true });
const branchesOf = (t, id) => readBoard(t.board).tasks.find((task) => task.id === id).gitBranch;
const backups = (t) => fs.readdirSync(path.dirname(t.board)).filter((name) => name.startsWith('board.json.bak-')).sort();

function setup(context, withGit = false) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'brclaims-')));
  const previousSettings = process.env.DASHBOARD_GLOBAL_SETTINGS;
  process.env.DASHBOARD_GLOBAL_SETTINGS = path.join(dir, 'global-settings.json');
  context.after(() => {
    if (previousSettings === undefined) delete process.env.DASHBOARD_GLOBAL_SETTINGS;
    else process.env.DASHBOARD_GLOBAL_SETTINGS = previousSettings;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  fs.writeFileSync(process.env.DASHBOARD_GLOBAL_SETTINGS, '{}');
  const reg = path.join(dir, 'registry.json'), repo = path.join(dir, 'repo');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  fs.mkdirSync(repo);
  if (withGit) {
    git(repo, ['init', '-q', '-b', 'master']);
    git(repo, ['config', 'user.email', 't@example.invalid']);
    git(repo, ['config', 'user.name', 'tester']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    const hooks = path.join(dir, 'hooks'); fs.mkdirSync(hooks);
    git(repo, ['config', 'core.hooksPath', hooks]);
    git(repo, ['commit', '--allow-empty', '-q', '-m', 'init']);
  }
  cmds.register({ id: 'g', name: 'demo', root: repo, registry: reg });
  return { dir, repo, reg, board: path.join(repo, '.dashboard', 'board.json'), P: { project: 'g', registry: reg } };
}

test('C1：只解析 claim 的分支段，合并多次认领，忽略占位与 set 流水', () => {
  const activity = [
    claim('CARD01', 'alpha,beta，文件域 cli/**,test/**'),
    claim('CARD01', ' beta, gamma , , -'),
    claim('CARD02', 'delta'), claim('EMPTY', '-'), claim('EMPTY', ' , - , '),
    { type: 'note', taskId: 'CARD01', text: 'set CARD01.gitBranch=["polluted"]' },
    { type: 'set', taskId: 'CARD02', text: '认领 CARD02：分支 fake-set' },
    { type: 'unclaim', taskId: 'CARD02', text: '认领 CARD02：分支 fake-unclaim' },
    { type: 'note', taskId: 'CARD02', text: '认领 CARD02：分支 fake-note' },
    { type: 'claim', taskId: 'FIELD-ID', text: '认领 TEXT-ID：分支 from-field' },
    { type: 'claim', taskId: 'EMPTY', text: '缺分支段' },
    { type: 'claim', taskId: null, text: '认领 EMPTY：分支 absent-id' }, null,
  ];
  const before = JSON.stringify(activity);
  assert.deepEqual(claimIndex(activity), new Map([
    ['CARD01', new Set(['alpha', 'beta', 'gamma'])], ['CARD02', new Set(['delta'])],
    ['FIELD-ID', new Set(['from-field'])],
  ]));
  assert.equal(JSON.stringify(activity), before, '解析不修改活动流');
  assert.deepEqual(claimIndex([]), new Map());
});

test('C2：本卡显式认领优先于提交和分支名反证，认领者按卡号排序', () => {
  const graph = {
    refs: new Map([['refs/heads/work-other', 'b']]), trunk: { name: 'master', sha: 'root' },
    nodes: new Map([['root', { parents: [], subject: 'init' }], ['b', { parents: ['root'], subject: 'feat(OTHER): 新活' }]]),
  };
  const tasks = [{ id: 'SELF', gitBranch: ['work-other'] }, { id: 'OTHER', gitBranch: ['work-other'] }];
  const claims = claimIndex([claim('ZED', 'work-other'), claim('SELF', 'work-other'), claim('ALPHA', 'work-other')]);
  const result = classifyBranches(tasks, graph, { claims });
  assert.deepEqual(result.entries[0], {
    taskId: 'SELF', branch: 'work-other', verdict: 'ok', evidence: 'claim', reason: '本卡显式认领过这条分支',
    otherIds: [], claimed: true, claimedBy: ['ALPHA', 'ZED'], spread: 0,
  });
  assert.equal(result.entries[1].verdict, 'ok', '分支名指向本卡时，别卡认领不能推翻正面证据');
  assert.equal(result.entries[1].evidence, 'name');
  assert.deepEqual(result.summary, { ok: 2, suspect: 0, unknown: 0 });
});

test('C2：无法核实但别卡认领过的改判可疑，跨板认领者也保留', () => {
  const tasks = [{ id: 'OLD', gitBranch: ['topic'] }, { id: 'OWNER', gitBranch: ['topic'] }];
  const claims = claimIndex([claim('ZED', 'topic'), claim('OWNER', 'topic'), claim('ALPHA', 'topic')]);
  const result = classifyBranches(tasks, emptyGraph(), { claims });
  const old = result.entries[0];
  assert.equal(old.verdict, 'suspect');
  assert.equal(old.evidence, 'claim');
  assert.equal(old.claimed, false);
  assert.deepEqual(old.claimedBy, ['ALPHA', 'OWNER', 'ZED']);
  assert.deepEqual(old.otherIds, old.claimedBy);
  assert.match(old.reason, /被 ALPHA、OWNER、ZED 显式认领过、本卡从没认领过/);
  assert.equal(result.entries[1].verdict, 'ok');
  assert.ok(result.entries.every((entry) => entry.spread === 1), '可信条目不计入铺开面，但也带相同计数');
  assert.deepEqual(result.summary, { ok: 1, suspect: 1, unknown: 0 });
});

test('C2：无人认领的无证据分支挂三张才可疑，显式门槛五张按五张计算', () => {
  const tasks = ['OLD01', 'OLD02', 'OLD03'].map((id) => ({ id, gitBranch: ['wide-topic'] }));
  const before = JSON.stringify(tasks);
  const result = classifyBranches(tasks, emptyGraph());
  for (const entry of result.entries) {
    assert.equal(entry.verdict, 'suspect'); assert.equal(entry.evidence, 'spread');
    assert.equal(entry.spread, 3); assert.equal(entry.claimed, false);
    assert.deepEqual(entry.claimedBy, []); assert.deepEqual(entry.otherIds, []);
    assert.match(entry.reason, /挂在本板 3 张卡上/);
  }
  assert.deepEqual(result.summary, { ok: 0, suspect: 3, unknown: 0 });
  for (const count of [1, 2]) {
    const small = classifyBranches(tasks.slice(0, count), emptyGraph());
    assert.ok(small.entries.every((entry) => entry.verdict === 'unknown' && entry.spread === count));
  }
  const high = classifyBranches(tasks, emptyGraph(), { spreadMin: 5 });
  assert.ok(high.entries.every((entry) => entry.verdict === 'unknown' && entry.spread === 3));
  assert.equal(JSON.stringify(tasks), before, '分类不修改卡片');
});

test('C3：四档逐级包含、保持条目顺序，共同保护主干、双向关系、可信与无法核实', () => {
  const make = (branch, evidence, otherIds = ['OWNER'], verdict = 'suspect') => ({ taskId: 'OLD', branch, otherIds, verdict, evidence });
  const tasks = [
    { id: 'OLD', gitBranch: [], deps: {} },
    { id: 'OWNER', gitBranch: ['owned', 'main', 'master', 'release'] },
    { id: 'KID', gitBranch: [] },
  ];
  const entries = [make('wide', 'spread', []), make('owned', 'commits'), make('elsewhere', 'claim'),
    make('orphan', 'commits', ['KID']), make('work-owner', 'name')];
  // 每种关系都覆盖本卡指向对方、对方指回本卡；相关保护先于正主判定。
  for (const key of ['dependsOn', 'blockedBy', 'relatedTasks']) {
    const forward = `FORWARD-${key}`, reverse = `REVERSE-${key}`;
    tasks[0].deps[key] = [forward];
    tasks.push({ id: forward, gitBranch: [] }, { id: reverse, gitBranch: [], deps: { [key]: ['OLD'] } });
    entries.push(make(`forward-${key}`, 'commits', ['OWNER', forward]), make(`reverse-${key}`, 'commits', [reverse]));
  }
  for (const branch of ['main', 'master', 'release']) entries.push(make(branch, 'commits'));
  for (const evidence of ['commits', 'name', 'claim', 'spread']) {
    entries.push(make(`unknown-${evidence}`, evidence, [], 'unknown'), make(`ok-${evidence}`, evidence, [], 'ok'));
  }
  tasks[0].gitBranch = entries.map((entry) => entry.branch);
  const before = JSON.stringify({ tasks, entries });
  const tiers = ['owned', 'suspect', 'claimed-elsewhere', 'broadcast'];
  const expected = [['owned'], ['owned', 'orphan', 'work-owner'], ['owned', 'elsewhere', 'orphan', 'work-owner'],
    ['wide', 'owned', 'elsewhere', 'orphan', 'work-owner']];
  let previous = [];
  for (const [i, tier] of tiers.entries()) {
    const plan = planBranchCleanup(tasks, entries, { tier, trunkNames: ['release'] });
    assert.deepEqual(plan.removals.map((entry) => entry.branch), expected[i]);
    assert.ok(previous.every((branch) => plan.removals.some((entry) => entry.branch === branch)));
    assert.deepEqual(plan.skipped, tier === 'owned' ? { related: 6, noOwner: 1 } : { related: 6, noOwner: 0, trunk: 3 });
    for (const entry of plan.removals) assert.deepEqual(entry, entries.find((item) => item.branch === entry.branch));
    previous = expected[i];
  }
  assert.deepEqual(planBranchCleanup(tasks, entries, { trunkNames: ['release'] }),
    planBranchCleanup(tasks, entries, { tier: 'owned', trunkNames: ['release'] }));
  assert.equal(JSON.stringify({ tasks, entries }), before, '规划不改卡片或判决');
});

test('C4：跨板合并同号卡与月度归档，坏板、缺失板和坏归档不连坐', (context) => {
  const t = setup(context);
  const movedRoot = path.join(t.dir, 'moved'); fs.mkdirSync(movedRoot);
  const movedBoard = path.join(movedRoot, 'ledger.json');
  cmds.register({ id: 'moved', name: 'moved', root: movedRoot, board: movedBoard, registry: t.reg });
  const moved = { project: 'moved', registry: t.reg };
  for (const P of [t.P, moved]) cmds.add({ _: ['SHARED'], title: '搬家同号卡', ...P });
  cmds.claim({ _: ['SHARED'], branch: ['old-topic', 'shared-topic'], ...t.P });
  cmds.claim({ _: ['SHARED'], branch: 'new-topic', ...moved });
  const archive = path.join(movedRoot, 'activity-202608.json');
  fs.writeFileSync(archive, JSON.stringify([claim('SHARED', 'archived-topic,shared-topic')]));
  const badArchive = path.join(movedRoot, 'activity-202607.json'); fs.writeFileSync(badArchive, '{');
  fs.writeFileSync(path.join(movedRoot, 'activity-202606.json'), JSON.stringify({ activity: [claim('IGNORED', 'object')] }));
  fs.writeFileSync(path.join(movedRoot, 'activity-20268.json'), JSON.stringify([claim('IGNORED', 'wrong-month-name')]));
  for (const id of ['bad', 'missing']) {
    const root = path.join(t.dir, id); fs.mkdirSync(root);
    const registered = cmds.register({ id, name: id, root, registry: t.reg });
    if (id === 'bad') fs.writeFileSync(registered.board, '{');
    else fs.unlinkSync(registered.board);
  }
  const files = [t.board, movedBoard, archive, badArchive, path.join(t.dir, 'bad', '.dashboard', 'board.json')];
  const before = files.map((file) => fs.readFileSync(file));
  let claims;
  assert.doesNotThrow(() => { claims = loadClaimIndex(t.reg); });
  assert.deepEqual(claims, new Map([['SHARED', new Set(['old-topic', 'shared-topic', 'new-topic', 'archived-topic'])]]));
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i], '跨板汇总一个字节都不改'));
});

test('C5：先摘别卡认领误记，再摘三卡广播，保留单卡未知；备份、档位留痕、幂等', (context) => {
  const t = setup(context, true);
  for (const id of ['OLD01', 'OLD02', 'OLD03', 'OWNER']) cmds.add({ _: [id], title: id, ...t.P });
  for (const branch of ['claimed-topic', 'wide-topic', 'solo-topic']) git(t.repo, ['branch', branch]);
  cmds.claim({ _: ['OWNER'], branch: 'claimed-topic', ...t.P });
  cmds.set({ _: ['OLD01'], field: 'gitBranch', value: JSON.stringify(['claimed-topic', 'wide-topic', 'solo-topic']), ...t.P });
  for (const id of ['OLD02', 'OLD03']) cmds.set({ _: [id], field: 'gitBranch', value: JSON.stringify(['wide-topic']), ...t.P });
  const before = fs.readFileSync(t.board, 'utf8');
  const view = doctor({ ...t.P, branches: true });
  assert.deepEqual(view.branchAudit.summary, { ok: 1, suspect: 4, unknown: 1 });
  assert.match(view.text, /被 OWNER 显式认领过/); assert.match(view.text, /挂在本板 3 张卡上/);
  assert.equal(fs.readFileSync(t.board, 'utf8'), before); assert.deepEqual(backups(t), []);

  const first = doctor({ ...t.P, branches: true, fix: true, tier: 'claimed-elsewhere' });
  const cleanup = JSON.parse(JSON.stringify(first)).branchAudit.cleanup;
  assert.equal(cleanup.tier, 'claimed-elsewhere'); assert.equal(cleanup.removed, 1);
  assert.deepEqual(cleanup.skipped, { related: 0, noOwner: 0, trunk: 0 });
  assert.deepEqual(cleanup.entries, [{ taskId: 'OLD01', branch: 'claimed-topic', otherIds: ['OWNER'], verdict: 'suspect', evidence: 'claim' }]);
  assert.deepEqual(branchesOf(t, 'OLD01'), ['wide-topic', 'solo-topic']);
  for (const id of ['OLD02', 'OLD03']) assert.deepEqual(branchesOf(t, id), ['wide-topic']);
  assert.equal(backups(t).length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(t.board), cleanup.backup), 'utf8'), before, '首次清理先保留原板');
  assert.match(first.text, /doctor --branches --fix --tier claimed-elsewhere：摘掉 1 条/);
  assert.ok(readBoard(t.board).activity.some((item) => item.type === 'note' && /--tier claimed-elsewhere：摘掉 1 条/.test(item.text)));
  const afterFirst = fs.readFileSync(t.board, 'utf8');
  const again = doctor({ ...t.P, branches: true, fix: true, tier: 'claimed-elsewhere' });
  assert.equal(again.branchAudit.cleanup.removed, 0); assert.equal(again.branchAudit.cleanup.backup, null);
  assert.equal(fs.readFileSync(t.board, 'utf8'), afterFirst); assert.equal(backups(t).length, 1);

  const second = doctor({ ...t.P, branches: true, fix: true, tier: 'broadcast' });
  assert.equal(second.branchAudit.cleanup.tier, 'broadcast'); assert.equal(second.branchAudit.cleanup.removed, 3);
  assert.deepEqual(second.branchAudit.cleanup.entries, ['OLD01', 'OLD02', 'OLD03'].map((taskId) =>
    ({ taskId, branch: 'wide-topic', otherIds: [], verdict: 'suspect', evidence: 'spread' })));
  assert.deepEqual(branchesOf(t, 'OLD01'), ['solo-topic']);
  for (const id of ['OLD02', 'OLD03']) assert.deepEqual(branchesOf(t, id), []);
  assert.deepEqual(branchesOf(t, 'OWNER'), ['claimed-topic']);
  assert.equal(backups(t).length, 2);
  assert.equal(fs.readFileSync(path.join(path.dirname(t.board), second.branchAudit.cleanup.backup), 'utf8'), afterFirst);
  assert.match(second.text, /--tier broadcast：摘掉 3 条/);
  assert.ok(readBoard(t.board).activity.some((item) => item.type === 'note' && /--tier broadcast：摘掉 3 条/.test(item.text)));
  const afterSecond = fs.readFileSync(t.board, 'utf8');
  assert.equal(doctor({ ...t.P, branches: true, fix: true, tier: 'broadcast' }).branchAudit.cleanup.removed, 0);
  assert.equal(fs.readFileSync(t.board, 'utf8'), afterSecond); assert.equal(backups(t).length, 2);
});

test('C5：已有缺提交漂移时非法档位仍先拒绝，不备份、不写板、不体检；不带修复也校验', (context) => {
  const t = setup(context, true);
  cmds.add({ _: ['OLD01'], title: '缺提交的卡', ...t.P });
  git(t.repo, ['commit', '--allow-empty', '-q', '-m', 'feat(OLD01): 尚未同步的提交']);
  assert.deepEqual(readBoard(t.board).tasks[0].commitShas, []);
  assert.match(doctor({ ...t.P }).text, /1 条 git 提交未记入 board/);
  const before = fs.readFileSync(t.board);
  context.mock.method(branchAudit, 'loadClaimIndex', () => assert.fail('非法档位不应读取跨板认领'));
  context.mock.method(branchAudit, 'auditBoardBranches', () => assert.fail('非法档位不应加载提交图'));
  for (const flags of [{ branches: true, fix: true }, { branches: true }, { fix: true }, {}]) {
    assert.throws(() => doctor({ ...t.P, ...flags, tier: 'wrong-tier' }),
      { message: '--tier 只能是 owned / suspect / claimed-elsewhere / broadcast' });
    assert.deepEqual(fs.readFileSync(t.board), before); assert.deepEqual(backups(t), []);
  }
});

test('C5：默认体检与 quick 不加载认领索引或分支图，quick 早退也不写板', (context) => {
  const t = setup(context, true), before = fs.readFileSync(t.board);
  context.mock.method(branchAudit, 'loadClaimIndex', () => assert.fail('未要求分支体检时不应读取认领索引'));
  context.mock.method(branchAudit, 'auditBoardBranches', () => assert.fail('未要求分支体检时不应加载提交图'));
  assert.equal(doctor({ ...t.P }).branchAudit, undefined);
  assert.equal(doctor({ ...t.P, quick: true, branches: true, fix: true, tier: 'wrong-tier' }).branchAudit, undefined);
  assert.deepEqual(fs.readFileSync(t.board), before); assert.deepEqual(backups(t), []);
});
