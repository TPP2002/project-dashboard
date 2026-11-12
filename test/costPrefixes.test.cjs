'use strict';
// SERVER-CODEX-COST-USES-MAINREPO(2026-09-06):费用归属由登记的对话目录决定。
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { mapRepoToPrefix } = require('../core/costUsage.cjs');

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'costprefixes-')));
const REG = path.join(TMP, 'registry.json');
// registry 路径在 require 时固定;每次测试只改这份临时清单。
const previousRegistry = process.env.DASHBOARD_REGISTRY;
process.env.DASHBOARD_REGISTRY = REG;
const beforeListeners = process.listeners('uncaughtException');
const server = require('../server/server.cjs');
// 摘掉 server 新装的兜底处理器,免得测试崩溃被吞成通过。
for (const fn of process.listeners('uncaughtException')) {
  if (!beforeListeners.includes(fn)) process.off('uncaughtException', fn);
}
after(() => {
  if (previousRegistry === undefined) delete process.env.DASHBOARD_REGISTRY;
  else process.env.DASHBOARD_REGISTRY = previousRegistry;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const writeRegistry = (projects) => fs.writeFileSync(REG, JSON.stringify({ schemaVersion: '1.0', projects }));
const mkdir = (name) => { const p = path.join(TMP, name); fs.mkdirSync(p, { recursive: true }); return p; };

test('costPrefixes:两个项目共用 codeRepo 时各自拿登记清单,老项目仍只认 mainRepo', () => {
  const boardHome = mkdir('cluster-board-home');
  const codeRepo = mkdir('rogue-code-repo');
  const sharedDrive = mkdir('calib-share');
  const agentDesk = mkdir('rogue-code-repo-cluster-agent');
  writeRegistry({
    cluster: { mainRepo: boardHome, codeRepo, costRoots: [sharedDrive, boardHome, agentDesk, sharedDrive] },
    rogue: { mainRepo: codeRepo, codeRepo },
  });
  const clusterPrefixes = [sharedDrive, boardHome, agentDesk].map(mapRepoToPrefix);
  const roguePrefixes = [mapRepoToPrefix(codeRepo)];
  assert.deepEqual(server.costPrefixes('cluster'), { prefixes: clusterPrefixes, otherPrefixes: roguePrefixes });
  assert.deepEqual(server.costPrefixes('rogue'), { prefixes: roguePrefixes, otherPrefixes: clusterPrefixes });
});

test('costPrefixes:编码后去重且保序,与本项目相同的其他项目前缀必须留下', () => {
  const boardHome = mkdir('tie-board-home');
  const deskA = mkdir('tie-desk_a');
  const deskB = mkdir('tie-desk-b');
  const alias = mkdir('tie-desk-a'); // 与 deskA 编码相同,不是同一路径
  writeRegistry({
    cluster: { mainRepo: boardHome, costRoots: [deskB, deskA, alias] },
    peer: { mainRepo: boardHome, costRoots: [deskA, deskB, alias] },
    peer2: { mainRepo: boardHome, costRoots: [deskA] },
  });
  assert.deepEqual(server.costPrefixes('cluster'), {
    prefixes: [deskB, deskA].map(mapRepoToPrefix), otherPrefixes: [deskA, deskB].map(mapRepoToPrefix),
  });
});

test('costPrefixes:其他项目的路径解析异常逐个跳过,后续合法项目仍参与仲裁', () => {
  const boardHome = mkdir('safe-board-home');
  const desk = mkdir('safe-desk');
  const peerHome = mkdir('safe-peer-home');
  writeRegistry({
    cluster: { mainRepo: boardHome, costRoots: [desk] },
    badMainRepo: { mainRepo: 17 },
    badCostRoot: { mainRepo: boardHome, costRoots: ['bad\0path'] },
    peer: { mainRepo: peerHome },
  });
  assert.deepEqual(server.costPrefixes('cluster'), {
    prefixes: [mapRepoToPrefix(desk)], otherPrefixes: [mapRepoToPrefix(peerHome)],
  });
});

test('costPrefixes:未注册项目返回 null', () => {
  writeRegistry({});
  assert.strictEqual(server.costPrefixes('nobody'), null);
});

test('costPrefixes:mainRepo 是 junction 时,前缀同时含真实路径与联接路径两种编码', (t) => {
  // junction 建在独立临时目录,测试自己先拆联接再删真实目录,绝不让 recursive 穿过联接删。
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moved-')));
  const real = path.join(base, 'real');
  const alias = path.join(base, 'alias');
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias, 'junction');
  const peerHome = mkdir('peer-home');
  t.after(() => {
    fs.rmSync(alias, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });
  writeRegistry({
    moved: { mainRepo: alias },
    peer: { mainRepo: peerHome },
  });
  const moved = server.costPrefixes('moved');
  assert.deepEqual(moved.prefixes, [real, alias].map(mapRepoToPrefix));
  const peer = server.costPrefixes('peer');
  for (const expected of [real, alias].map(mapRepoToPrefix)) {
    assert.ok(peer.otherPrefixes.includes(expected), `peer 的其他前缀应含 ${expected}`);
  }
});
