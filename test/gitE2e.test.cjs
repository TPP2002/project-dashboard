'use strict';
/**
 * gitE2e.test.cjs —— git ↔ board 端到端（临时 git 仓 + require CLI 模块，全程临时 registry）。
 * 绝不碰真实主仓 / registry。
 *
 * 覆盖：
 *   · sync-from-git：从 commit subject 派生 commitSha / PR#(#24)；分支只认显式 --branch；无 id 提交不误派生。
 *   · doctor：hook 未装时报「未安装」；hooksInstall 后不再报。
 *   · doctor --fix：补齐 git 派生字段，同时【语义字段逐字节不变】（快照）——印证 README §同步保险：
 *     git 派生字段（commit/pr/branch）与语义字段（decisions/deps/wave/status/禁区）字段集不相交、各有唯一权威。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { readBoard } = require('../cli/store.cjs');
const { syncFromGit, doctor } = require('../cli/gitSync.cjs');
// hook 根「永不指进 git 检出」(HOOK-CLI-POINTS-AT-LIVE-CHECKOUT);端到端要验的是本检出,显式指过去。
process.env.DASHBOARD_HOOK_CLI_ROOT = path.resolve(__dirname, '..');
const { hooksInstall } = require('../cli/hooksInstall.cjs');

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', windowsHide: true });
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };

/** 临时目录 + 空 registry + git 仓（init/config，禁签名）+ 注册项目 g。 */
function setupRepo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gite2e-')));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 'tester']);
  git(repo, ['config', 'commit.gpgsign', 'false']); // 无签名环境也能提交
  git(repo, ['commit', '--allow-empty', '-q', '-m', 'init']); // 中性初始提交（不含 task id，不派生），免空仓 rev-parse/log 报 fatal 噪音
  cmds.register({ id: 'g', name: 'demo', root: repo, registry: reg });
  return { dir, repo, reg, board: path.join(repo, '.dashboard', 'board.json'), P: { project: 'g', registry: reg } };
}

/** 写文件 + add + commit（subject 即 msg）。 */
function commit(repo, file, msg) {
  fs.writeFileSync(path.join(repo, file), 'x-' + file);
  git(repo, ['add', file]);
  git(repo, ['commit', '-q', '-m', msg]);
}

/** 语义字段快照 = task 去掉 git 派生字段（commitShas/prNumbers/gitBranch）后的规范 JSON。 */
function semanticSnap(task) {
  const c = { ...task };
  delete c.commitShas; delete c.prNumbers; delete c.gitBranch;
  return JSON.stringify(c);
}
const findTask = (t, id) => readBoard(t.board).tasks.find((x) => x.id === id);

test('sync-from-git：从 commit subject 派生 commitSha / PR#(#24)；分支只认显式传入', () => {
  const t = setupRepo();
  try {
    cmds.add({ _: ['P01'], title: '派生', ...t.P });
    git(t.repo, ['checkout', '-q', '-b', 'feat-sync']); // 在具名分支上提交，便于断言 gitBranch
    commit(t.repo, 'a.txt', 'feat(P01): 落地某功能 (#24)');
    const r = syncFromGit({ ...t.P });
    assert.ok(r.changed >= 1, 'sync 应报告有变更');
    let task = findTask(t, 'P01');
    assert.ok(task.commitShas.length >= 1, 'commitSha 已派生');
    assert.match(task.commitShas[0], /^[0-9a-f]{7,40}$/, 'commitSha 形如短 hash');
    assert.ok(task.prNumbers.includes(24), 'PR #24 已派生');
    // 分支不再由"主目录此刻签出的是哪个"倒推（SYNC-FROM-GIT-BRANCH-MISATTRIBUTION）：
    // 多 worktree 共享一份 .git/hooks，那个值是竞态采样，还会被窗口扫描广播给一批老卡。
    assert.deepEqual(task.gitBranch, [], '没给 --branch 就不该臆造分支');
    syncFromGit({ ...t.P, branch: 'feat-sync' });
    task = findTask(t, 'P01');
    assert.ok(task.gitBranch.includes('feat-sync'), '显式给了 --branch 才派生分支');
  } finally { clean(t.dir); }
});

test('sync-from-git：subject 无 task id 的提交不误派生', () => {
  const t = setupRepo();
  try {
    cmds.add({ _: ['P01'], title: 'x', ...t.P });
    commit(t.repo, 'b.txt', 'chore: 无关提交，不该记到任何任务');
    const r = syncFromGit({ ...t.P });
    assert.equal(r.changed, 0, '无匹配 → 无变更');
    assert.equal(findTask(t, 'P01').commitShas.length, 0, '无 id 的提交不派生到 P01');
  } finally { clean(t.dir); }
});

test('doctor：hook 未装时报「未安装」', () => {
  const t = setupRepo();
  try {
    cmds.add({ _: ['P01'], title: 'x', ...t.P });
    const rep = doctor({ ...t.P });
    assert.equal(rep.ok, false);
    assert.match(rep.text, /hook 未安装|未装/, 'doctor 应报同步 hook 未安装');
  } finally { clean(t.dir); }
});

test('doctor --fix：补齐 git 派生字段、语义字段逐字节不变（快照）', () => {
  const t = setupRepo();
  try {
    // 铺一批语义字段：title/desc/wave/status/decisions/blockReason/禁区
    cmds.add({ _: ['P01'], title: '语义任务', desc: '一句话描述', wave: '2', ...t.P });
    cmds.pending({ _: ['P01'], q: '选甲还是乙', opt: ['甲', '乙'], rec: '甲',
      background: '【场景】这是端到端测试用的背景描述文字需要够长才能通过校验器所以我在这里多写一些占位。【问题】占位以通过 skill 六点二的字数最小值。【要做的事】占位。【为什么重要】占位。',
      'pros-甲': '【好处】甲的好处。【代价】甲的代价描述。',
      'pros-乙': '【好处】乙的好处。【代价】乙的代价描述。',
      reason: '推荐甲的理由描述需要写得足够长才能通过校验器所以在这里多写一些内容用来占位。',
      ...t.P });
    cmds.decide({ _: ['P01'], did: 'd1', answer: '甲', ...t.P });
    cmds.park({ _: ['P01'], reason: '等依赖', ...t.P });
    cmds.set({ _: ['P01'], field: 'forbiddenZones', value: '["src/engine"]', ...t.P });

    // 制造 git 漂移：git 里有 P01 的提交，但 board 尚未 sync
    commit(t.repo, 'c.txt', 'fix(P01): 修复某问题 (#7)');
    const before = semanticSnap(findTask(t, 'P01'));

    // doctor（不 fix）应报漂移，且不改 board
    const rep = doctor({ ...t.P });
    assert.match(rep.text, /未记入 board|漂移/, 'doctor 报 git 派生字段漂移');
    assert.strictEqual(semanticSnap(findTask(t, 'P01')), before, 'doctor 只读不改 board');

    // doctor --fix：补齐 git 派生字段
    doctor({ ...t.P, fix: true });
    const after = findTask(t, 'P01');
    assert.ok(after.commitShas.length >= 1, '--fix 已补 commitSha');
    assert.ok(after.prNumbers.includes(7), '--fix 已补 PR#7');
    assert.strictEqual(semanticSnap(after), before, '语义字段逐字节未变（与 git 派生字段集不相交）');
  } finally { clean(t.dir); }
});

test('hooksInstall 后 doctor 不再报 hook 未装', () => {
  const t = setupRepo();
  try {
    cmds.add({ _: ['P01'], title: 'x', ...t.P });
    hooksInstall({ ...t.P });
    const rep = doctor({ ...t.P });
    assert.doesNotMatch(rep.text, /hook 未安装|未装/, '装 hook 后 doctor 不该再报未装');
  } finally { clean(t.dir); }
});

// ---------------------------------------------------------------------------
// DOCTOR-FIX-MISSING-NEVER-CLEARS —— doctor 的「已记入」口径必须与 unionShas 同源。
// 现场证据（2026-09-07 只读探针）：rogue 板恒报 11 条漂移、cluster 5 条，逐条比对后
// 【真缺 0 条】——那些提交板里全都有，只是 done --commit 存的是 40 位全哈希，而 doctor
// 只认「恰好 12 位」或「恰好 7 位」。于是 doctor 报缺 → --fix 调 syncFromGit → unionShas
// 按前缀关系认出是同一个提交、什么也没加（changed=0）→ 下次 doctor 照报，备份文件每跑一次多一份。
// ---------------------------------------------------------------------------

/** 数 board 旁边的 .bak-* 备份文件个数。 */
function countBackups(boardPath) {
  const dir = path.dirname(boardPath);
  const base = path.basename(boardPath);
  return fs.readdirSync(dir).filter((f) => f.startsWith(base + '.bak-')).length;
}

test('doctor：板里存 40 位全哈希时不算漂移，--fix 也不该落备份', () => {
  const t = setupRepo();
  try {
    cmds.add({ _: ['P01'], title: 'x', ...t.P });
    commit(t.repo, 'a.txt', 'fix(P01): 修一个问题');
    const full = execFileSync('git', ['-C', t.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(full.length, 40, '前提：拿到的是 40 位全哈希');
    // 模拟 `done --commit <40位>` 的写法（真实板上 rogue 有 436 条这样的记录）
    cmds.set({ _: ['P01'], field: 'commitShas', value: JSON.stringify([full]), ...t.P });

    const rep = doctor({ ...t.P });
    assert.doesNotMatch(rep.text, /未记入 board|漂移/, '板里已有同一提交（全哈希），不该报漏记');

    doctor({ ...t.P, fix: true });
    assert.equal(countBackups(t.board), 0, '没有真漂移就不该生成 .bak 备份');
  } finally { clean(t.dir); }
});

test('doctor：板里存 8 位短哈希时不算漂移，但 sync 会把它升到 12 位并报 changed', () => {
  const t = setupRepo();
  try {
    cmds.add({ _: ['P01'], title: 'x', ...t.P });
    commit(t.repo, 'a.txt', 'fix(P01): 修一个问题');
    const full = execFileSync('git', ['-C', t.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    cmds.set({ _: ['P01'], field: 'commitShas', value: JSON.stringify([full.slice(0, 8)]), ...t.P });

    assert.doesNotMatch(doctor({ ...t.P }).text, /未记入 board|漂移/, '8 位短哈希是同一个提交，不算漏记');
    const r = syncFromGit({ ...t.P });
    assert.equal(r.changed, 1, '精度从 8 位升到 12 位是真改动，changed 必须如实报（不能只比数组长度）');
    assert.deepEqual(findTask(t, 'P01').commitShas, [full.slice(0, 12)], '升级为 12 位，不并存两种写法');
  } finally { clean(t.dir); }
});

test('doctor --fix：连跑两次只留一份备份（第二次已无漂移可补）', () => {
  const t = setupRepo();
  try {
    cmds.add({ _: ['P01'], title: 'x', ...t.P });
    commit(t.repo, 'a.txt', 'fix(P01): 真的还没记进板');

    assert.match(doctor({ ...t.P }).text, /未记入 board/, '真漂移要照报');
    doctor({ ...t.P, fix: true });
    assert.equal(countBackups(t.board), 1, '第一次真补齐 → 留一份回退点');
    assert.ok(findTask(t, 'P01').commitShas.length >= 1, '漂移已补进板');

    const rep2 = doctor({ ...t.P, fix: true });
    assert.doesNotMatch(rep2.text, /未记入 board/, '补过之后不该再报同一批漂移');
    assert.equal(countBackups(t.board), 1, '第二次无事可补 → 不许再攒一份备份');
  } finally { clean(t.dir); }
});

test('sync-from-git：真有变更时要在 activity 留痕', () => {
  const t = setupRepo();
  try {
    cmds.add({ _: ['P01'], title: 'x', ...t.P });
    commit(t.repo, 'a.txt', 'fix(P01): 落地');
    const r = syncFromGit({ ...t.P });
    assert.equal(r.changed, 1);
    const acts = (readBoard(t.board).activity || []).filter((a) => /sync-from-git/.test(a.text || ''));
    assert.equal(acts.length, 1, 'changed>0 就该留一条 sync-from-git 流水');
    assert.equal(acts[0].author, 'git-hook');

    syncFromGit({ ...t.P }); // 无新变更
    const acts2 = (readBoard(t.board).activity || []).filter((a) => /sync-from-git/.test(a.text || ''));
    assert.equal(acts2.length, 1, 'changed=0 不该往流水里灌噪音');
  } finally { clean(t.dir); }
});
