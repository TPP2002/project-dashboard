'use strict';
/**
 * dispatchCwd.test.cjs —— 看板派单开出来的对话，站在哪个文件夹里（SERVER-GIT-CWD-USES-MAINREPO）。
 *
 * 治的病:三个派单入口(单卡 / 整项目 / 短触发)都拿 proj.mainRepo 当新对话的 cwd。
 * mainRepo 是「板的家」不是「代码的家」——cluster 这类板与代码分家的项目里,
 * 板在 F:\cluster-ops(非 git 仓、无 CLAUDE.md),代码在 F:\stock-rogue。
 * 派出去的对话落在前者 = 没有协议锚、没有 git、认领闸门也拦不住,等于站在空地上开工。
 *
 * 夹具沿用 codeRepoSplit.test.cjs 的「cluster 形状」:mainRepo = 普通目录,codeRepo = 另一处。
 * 派单本身要 spawn 真实终端窗口跑 claude,单测不能碰;所以这里只验落脚点的解析函数——
 * 它就是三个 handler 唯一取 cwd 的地方(server.cjs 里 grep `dispatchCwd(` 可核)。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// server.cjs 在 load 时就把 registry 路径定死(见其 REGISTRY 常量),故必须先于 require 设好。
// 文件此刻不必存在:每次调用都重读,ENOENT 当空表。
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatchcwd-')));
const REG = path.join(TMP, 'registry.json');
process.env.DASHBOARD_REGISTRY = REG;

// server.cjs 会装一个兜底的 uncaughtException 处理器(本意是别让单个请求拖垮服务)。
// 留在测试进程里会把真崩溃吞成静默通过,所以 require 完立刻摘掉它自己加的那几个。
const beforeListeners = process.listeners('uncaughtException');
const server = require('../server/server.cjs');
for (const fn of process.listeners('uncaughtException')) {
  if (!beforeListeners.includes(fn)) process.off('uncaughtException', fn);
}

const writeRegistry = (projects) => fs.writeFileSync(REG, JSON.stringify({ schemaVersion: '1.0', projects }));
const mkdir = (name) => { const p = path.join(TMP, name); fs.mkdirSync(p, { recursive: true }); return p; };

test('派单落脚点:板与代码分家时,进「代码的家」而不是「板的家」', () => {
  const boardHome = mkdir('cluster-board-home'); // 对应 F:\cluster-ops:只放板,不是 git 仓
  const codeRepo = mkdir('cluster-code-repo');   // 对应 F:\stock-rogue:卡真正要改的代码在这
  writeRegistry({
    cluster: {
      name: '副机集群', mainRepo: boardHome, codeRepo,
      board: path.join(boardHome, '.dashboard', 'board.json'),
    },
  });
  assert.strictEqual(server.dispatchCwd('cluster'), codeRepo,
    '派出去的对话必须站在 codeRepo;站在 mainRepo 就是本卡要治的病');
});

test('派单落脚点:没写 codeRepo 的老项目照旧用 mainRepo(零改动)', () => {
  const repo = mkdir('rogue-repo');
  writeRegistry({ rogue: { name: '股市肉鸽', mainRepo: repo } });
  assert.strictEqual(server.dispatchCwd('rogue'), repo, 'codeRepo 缺省必须回落 mainRepo');
});

test('派单落脚点:未注册项目返回 null(调用方据此拒绝派单,不能拿 undefined 去 spawn)', () => {
  writeRegistry({});
  assert.strictEqual(server.dispatchCwd('nobody'), null);
});
