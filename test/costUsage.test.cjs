'use strict';
// BOARD-COST-MONITOR(0901):cost 命令 + token 流水聚合的单测。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cmds = require('../cli/commands.cjs');
const { getUsage, mapRepoToPrefix } = require('../core/costUsage.cjs');
const { validate } = require('../core/boardSchema.cjs');

function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cost-')));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  cmds.register({ id: 't', name: 'd', root, registry: reg });
  return { dir, P: { project: 't', registry: reg } };
}
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// ---------- CLI cost 命令 ----------

test('cost 登记追加 entries 且各字段落地', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  const r1 = cmds.cost({ _: ['P01'], agents: 'sonnet:3,opus:1', tokens: '120000', note: '首轮', author: 'a1', ...P });
  const e1 = r1.task.cost.entries[0];
  assert.deepEqual(e1.agents, { sonnet: 3, opus: 1 });
  assert.equal(e1.tokens, 120000);
  assert.equal(e1.note, '首轮');
  assert.equal(e1.author, 'a1');
  assert.match(e1.date, /^\d{4}-\d{2}-\d{2}$/);
  const r2 = cmds.cost({ _: ['P01'], agents: 'fable:1', ...P });
  assert.equal(r2.task.cost.entries.length, 2, '第二次登记应追加不覆盖');
  clean(dir);
});

test('add --model 建议档位落卡,超长被拒', () => {
  const { dir, P } = setup();
  const r = cmds.add({ _: ['M1'], title: 'x', model: 'sonnet·低', ...P });
  assert.equal(r.task.modelHint, 'sonnet·低');
  assert.throws(() => cmds.add({ _: ['M2'], title: 'x', model: 'x'.repeat(41), ...P }), /太长/);
  clean(dir);
});

test('cost 同模型重复段累加、非法格式与负 tokens 被拒', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  const r = cmds.cost({ _: ['P01'], agents: 'sonnet:2, sonnet:3', ...P });
  assert.deepEqual(r.task.cost.entries[0].agents, { sonnet: 5 });
  assert.throws(() => cmds.cost({ _: ['P01'], agents: 'fable=1', ...P }), /格式非法/);
  assert.throws(() => cmds.cost({ _: ['P01'], agents: 'fable:1', tokens: '-5', ...P }), /非负整数/);
  clean(dir);
});

test('schema:坏 cost(非法日期/agents 非对象)被校验拦下', () => {
  const board = {
    schemaVersion: '1.0',
    project: { id: 'x', name: 'x', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    tasks: [{ id: 'A1', title: 't', status: '未开工', wave: 0,
      cost: { entries: [{ date: '2026/09/01', agents: 'sonnet' }] } }],
  };
  const { ok, errors } = validate(board);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('cost.entries[0].date')), '应报日期格式');
  assert.ok(errors.some((e) => e.includes('cost.entries[0].agents')), '应报 agents 类型');
});

// ---------- costUsage 聚合 ----------

function jsonlLine({ ts, model, isSidechain, output, input, cacheRead, cacheWrite }) {
  return JSON.stringify({
    type: 'assistant', isSidechain: !!isSidechain, timestamp: ts, sessionId: 's',
    message: { model, usage: {
      input_tokens: input || 0, output_tokens: output || 0,
      cache_read_input_tokens: cacheRead || 0, cache_creation_input_tokens: cacheWrite || 0,
    } },
  });
}

test('getUsage:前缀匹配 worktree 目录、分桶聚合、坏行跳过、增量缓存', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const root = path.join(dir, 'projects');
  for (const d of ['X--repo', 'X--repo--wt-1', 'Y--other']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const ts = new Date().toISOString(); // 今天,必落在 days 窗口内
  fs.writeFileSync(path.join(root, 'X--repo', 'a.jsonl'), [
    jsonlLine({ ts, model: 'claude-fable-5', output: 100, input: 10, cacheRead: 1000, cacheWrite: 50 }),
    jsonlLine({ ts, model: 'claude-sonnet-5', isSidechain: true, output: 30 }),
    '{"type":"user","text":"不含usage,应跳过"}',
    '这行不是JSON{{{',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'X--repo--wt-1', 'b.jsonl'),
    jsonlLine({ ts, model: 'claude-fable-5', output: 7 }));
  fs.writeFileSync(path.join(root, 'Y--other', 'c.jsonl'),
    jsonlLine({ ts, model: 'claude-opus-5', output: 99999 }));
  const cachePath = path.join(dir, 'cache.json');

  const r = await getUsage({ prefix: 'X--repo', days: 30, projectsRoot: root, cachePath });
  assert.deepEqual(r.dirs.sort(), ['X--repo', 'X--repo--wt-1'], 'Y--other 不得混入');
  assert.equal(r.totals.output, 137, '100+30+7,不含别的项目的 99999');
  assert.equal(r.totals.mainOutput, 107);
  assert.equal(r.totals.sideOutput, 30, 'isSidechain 应进子agent桶');
  assert.equal(r.models['claude-fable-5'].output, 107);
  assert.equal(r.models['claude-sonnet-5'].msgs, 1);
  assert.equal(r.scanned, 2);
  assert.equal(r.sessions, 2);

  const r2 = await getUsage({ prefix: 'X--repo', days: 30, projectsRoot: root, cachePath });
  assert.equal(r2.scanned, 0, '第二跑应全走缓存');
  assert.equal(r2.cachedFiles, 2);
  assert.equal(r2.totals.output, 137, '缓存结果与实扫一致');

  fs.appendFileSync(path.join(root, 'X--repo', 'a.jsonl'),
    '\n' + jsonlLine({ ts, model: 'claude-fable-5', output: 3 }));
  const r3 = await getUsage({ prefix: 'X--repo', days: 30, projectsRoot: root, cachePath });
  assert.equal(r3.scanned, 1, '只重扫变过的文件');
  assert.equal(r3.totals.output, 140, '追加后合计更新');

  clean(dir);
});

test('mapRepoToPrefix:非字母数字一律变 -(与 Claude Code 目录编码一致)', () => {
  assert.equal(mapRepoToPrefix('F:\\stock-rogue'), 'F--stock-rogue');
  assert.equal(mapRepoToPrefix('C:\\Users\\Administrator\\Documents\\自动化求职'), 'C--Users-Administrator-Documents------');
});

test('getUsage:美元折算(缓存价生效,无TTL细分保守归1h桶)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usd-'));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'Z--p'), { recursive: true });
  const ts = new Date().toISOString();
  // fable 牌价 in$10/out$50:input10 + cacheRead1000 + cacheWrite50(无细分→1h桶×2) + output100
  fs.writeFileSync(path.join(root, 'Z--p', 'a.jsonl'),
    jsonlLine({ ts, model: 'claude-fable-5', input: 10, output: 100, cacheRead: 1000, cacheWrite: 50 }));
  const r = await getUsage({ prefix: 'Z--p', days: 30, projectsRoot: root, cachePath: path.join(dir, 'c.json') });
  assert.equal(r.totals.cw1h, 50, '无细分应全归 1h 桶');
  assert.equal(r.totals.cw5m, 0);
  // actual = (10×10 + 1000×0.1×10 + 50×2×10 + 100×50)/1e6 = 0.0071
  assert.ok(Math.abs(r.usd.actual - 0.0071) < 1e-9, `actual=${r.usd.actual}`);
  // noCache = ((10+1000+50)×10 + 100×50)/1e6 = 0.0156
  assert.ok(Math.abs(r.usd.noCache - 0.0156) < 1e-9, `noCache=${r.usd.noCache}`);
  assert.ok(Math.abs(r.usd.saved - 0.0085) < 1e-9, `saved=${r.usd.saved}`);
  assert.ok(r.byDay[0].usdActual > 0, '按天也应带折算');
  clean(dir);
});
