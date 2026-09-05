'use strict';
/**
 * codeRepoSplit.test.cjs —— 「看板归属 ≠ 代码归属」的分离（CLUSTER-BOARD-REPO-PATH-WRONG）。
 *
 * 治的病:registry 里 mainRepo 一个字段同时扛两个语义——「板放哪」和「代码在哪」。
 * 板自成一家、代码却住在别人仓里的项目(cluster:板在 F:\cluster-ops、代码在 F:\stock-rogue)
 * 一进来这个字段就必然自相矛盾:按板走则 git 类动作全落在非仓目录上 fatal,按代码走则板找不着。
 *
 * 拆法:registry 新增可选 codeRepo(缺省回落 mainRepo,老项目零改动),
 * 凡「跑 git / 找正本」的用 codeRepo,凡「找板」的仍用 mainRepo。
 *
 * 本文件按 cluster 的真实形状搭夹具:mainRepo = 普通目录(非 git 仓),codeRepo = 真 git 仓。
 * 改之前这四条必红(在非仓目录上跑 git 会 fatal / hook 恒判未装)。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { resolveProject } = require('../core/resolveProject.cjs');
const cmds = require('../cli/commands.cjs');
const { readBoard } = require('../cli/store.cjs');
const { syncFromGit, doctor } = require('../cli/gitSync.cjs');

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', windowsHide: true });
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };

/**
 * 搭「cluster 形状」的夹具:
 *   boardHome —— 只放板的普通目录(**不是 git 仓**),对应 F:\cluster-ops
 *   codeRepo  —— 真 git 仓,卡改的是这里的代码,对应 F:\stock-rogue
 * registry 直接写 JSON(register 子命令没有 codeRepo 入口,本用例只验解析与消费侧)。
 */
function setupSplit() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coderepo-')));
  const boardHome = path.join(dir, 'board-home'); fs.mkdirSync(boardHome);
  const codeRepo = path.join(dir, 'code-repo'); fs.mkdirSync(codeRepo);
  git(codeRepo, ['init', '-q']);
  git(codeRepo, ['config', 'user.email', 't@t.t']);
  git(codeRepo, ['config', 'user.name', 'tester']);
  git(codeRepo, ['config', 'commit.gpgsign', 'false']);
  git(codeRepo, ['commit', '--allow-empty', '-q', '-m', 'init']);
  const board = path.join(boardHome, '.dashboard', 'board.json');
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({
    schemaVersion: '1.0',
    projects: { c: { name: '副机集群', mainRepo: boardHome, codeRepo, board } },
  }));
  return { dir, boardHome, codeRepo, board, reg, P: { project: 'c', registry: reg } };
}

test('resolveProject:没写 codeRepo 时回落 mainRepo(老项目零改动)', () => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coderepo-')));
  try {
    const repo = path.join(d, 'repo'); fs.mkdirSync(repo);
    const reg = path.join(d, 'registry.json');
    fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: { g: { name: 'A股', mainRepo: repo } } }));
    const r = resolveProject('g', { registryPath: reg });
    assert.strictEqual(r.codeRepo, repo, 'codeRepo 缺省必须等于 mainRepo');
  } finally { clean(d); }
});

test('resolveProject:写了 codeRepo 就与 mainRepo 分家(板归板、代码归代码)', () => {
  const t = setupSplit();
  try {
    const r = resolveProject('c', { registryPath: t.reg });
    assert.strictEqual(r.mainRepo, t.boardHome, 'mainRepo 仍指板所在处');
    assert.strictEqual(r.codeRepo, t.codeRepo, 'codeRepo 指真正放代码的仓');
    assert.strictEqual(r.board, t.board, '板路径不受影响');
  } finally { clean(t.dir); }
});

test('sync-from-git:板不在 git 仓里时,仍能从 codeRepo 派生 commit/PR', () => {
  const t = setupSplit();
  try {
    cmds.add({ _: ['CLUSTER-X'], title: '派生', ...t.P });
    fs.writeFileSync(path.join(t.codeRepo, 'a.txt'), 'x');
    git(t.codeRepo, ['add', 'a.txt']);
    git(t.codeRepo, ['commit', '-q', '-m', 'fix(bot): CLUSTER-X 修好了 (#77)']);

    const r = syncFromGit({ ...t.P });
    assert.strictEqual(r.ok, true);

    const task = readBoard(t.board).tasks.find((x) => x.id === 'CLUSTER-X');
    assert.strictEqual(task.commitShas.length, 1, '应从 codeRepo 派生出 1 个 commit');
    assert.deepStrictEqual(task.prNumbers, [77], '应派生出 PR 号');
  } finally { clean(t.dir); }
});

test('doctor:hook 在 codeRepo 上就不该再报「未安装」', () => {
  const t = setupSplit();
  try {
    cmds.add({ _: ['CLUSTER-Y'], title: '体检', ...t.P });
    const before = doctor({ ...t.P });
    assert.match(before.text, /hook 未安装/, '造 hook 之前应报未安装(证明这条断言真在检验目标)');

    // 不调 hooksInstall(那是 HOOK-CLAIM-GATE-MULTI-PROJECT 的文件域):
    // 直接按「宿主仓已装看板 hook」的样子造一个,只验 doctor 去哪个仓找。
    const hookDir = path.join(t.codeRepo, '.git', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, 'post-commit'), '#!/bin/sh\n# dashboard sync\n');

    const after = doctor({ ...t.P });
    assert.doesNotMatch(after.text, /hook 未安装/, 'hook 在 codeRepo 上时不该再误报');
  } finally { clean(t.dir); }
});
