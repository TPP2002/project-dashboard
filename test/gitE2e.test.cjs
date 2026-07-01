'use strict';
/**
 * gitE2e.test.cjs —— git ↔ board 端到端（临时 git 仓 + require CLI 模块，全程临时 registry）。
 * 绝不碰真实主仓 / registry。
 *
 * 覆盖：
 *   · sync-from-git：从 commit subject 派生 commitSha / PR#(#24) / 分支；无 id 提交不误派生。
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

test('sync-from-git：从 commit subject 派生 commitSha / PR#(#24) / 分支', () => {
  const t = setupRepo();
  try {
    cmds.add({ _: ['P01'], title: '派生', ...t.P });
    git(t.repo, ['checkout', '-q', '-b', 'feat-sync']); // 在具名分支上提交，便于断言 gitBranch
    commit(t.repo, 'a.txt', 'feat(P01): 落地某功能 (#24)');
    const r = syncFromGit({ ...t.P });
    assert.ok(r.changed >= 1, 'sync 应报告有变更');
    const task = findTask(t, 'P01');
    assert.ok(task.commitShas.length >= 1, 'commitSha 已派生');
    assert.match(task.commitShas[0], /^[0-9a-f]{7,40}$/, 'commitSha 形如短 hash');
    assert.ok(task.prNumbers.includes(24), 'PR #24 已派生');
    assert.ok(task.gitBranch.includes('feat-sync'), '分支 feat-sync 已派生');
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
