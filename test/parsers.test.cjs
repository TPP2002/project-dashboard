'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseIndexTable, statusFromText } = require('../cli/importCmd.cjs');
const { buildStatusMarkdown } = require('../cli/renderIndex.cjs');
const { missingFields } = require('../cli/backfill.cjs');

test('parseIndexTable 剥删除线 + 抽可靠字段', () => {
  const md = [
    '## 一、核实结论总表', '',
    '| # | 方案 | 核实结论 | 一句话现状 |',
    '|---|---|---|---|',
    '| P01 | [标题A](P01-x.md) | ✅ **已完工**（2026-06-12，stock-r14-21） | 干完了 ~~旧作废分支 stock-r14-99~~ |',
    '| P09 | [标题B](P09-y.md) | ✅ 真实待开工 | 没开始 |',
    '', '## 二、别的', 'xxx',
  ].join('\n');
  const { tasks } = parseIndexTable(md, 'docs/plans/股市清零工程');
  assert.equal(tasks.length, 2);
  const p1 = tasks.find((t) => t.id === 'P01');
  assert.equal(p1.status, '已完工');
  assert.equal(p1.title, '标题A');
  assert.deepEqual(p1.gitBranch, ['stock-r14-21']); // 删除线里的 r14-99 已被剥离，不入库
  assert.deepEqual(p1.docs, ['docs/plans/股市清零工程/P01-x.md']);
  assert.equal(tasks.find((t) => t.id === 'P09').status, '待开工');
});

test('statusFromText 关键词映射', () => {
  assert.equal(statusFromText('✅ **已完工**（...）'), '已完工');
  assert.equal(statusFromText('🚫 被卡（暂缓书）'), '暂缓');
  assert.equal(statusFromText('📋 立项完成·待施工'), '待开工');
  assert.equal(statusFromText('✅ 真实待开工'), '待开工');
  assert.equal(statusFromText('🔨 施工中'), '施工中');
});

test('buildStatusMarkdown 含勿改标记/表头/任务行/PR/完工日', () => {
  const board = { tasks: [{ id: 'P01', title: 'x', status: '已完工', percent: 100, gitBranch: ['b'], prNumbers: [24], dates: { done: '2026-06-12' } }] };
  const md = buildStatusMarkdown(board);
  assert.ok(md.includes('自动生成'));
  assert.ok(md.includes('勿手改'));
  assert.ok(md.includes('| P01 |'));
  assert.ok(md.includes('PR#24'));
  assert.ok(md.includes('2026-06-12'));
});

test('missingFields 识别缺失语义字段', () => {
  const bare = { id: 'P01', status: '未开工', wave: 0, decisions: [], deps: { dependsOn: [], blockedBy: [], relatedTasks: [] } };
  assert.deepEqual(missingFields(bare).sort(), ['bot', 'deps', 'decisions', 'tests', 'wave', '禁区'].sort());
  const full = { id: 'P02', wave: 1, decisions: [{ id: 'd1' }], deps: { dependsOn: ['P01'], blockedBy: [], relatedTasks: [] }, bot: {}, tests: {}, forbiddenZones: ['x'] };
  assert.deepEqual(missingFields(full), []);
});
