'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runTs(code) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout.trim());
}
const fixture = `const now = Date.parse('2026-09-14T10:00:00Z');
  const job = { id: 1, workflow: '主干守门', job: '全量单测', title: '检查改动', cardTitle: '看清进度', branch: 'fixture',
    project: null, runner: 'fixture-runner', machine: 'fixture-host', startedAt: '2026-09-14T09:48:00Z',
    elapsedMs: 720000, expectedMs: 900000, remainingMs: 180000 };`;

test('检查作业显示人话标题，随时钟走动，缺样本与超出预计分别说明', () => {
  const labels = runTs(`import { ciJobLabel } from './web/src/components/sched/format.ts'; ${fixture}
    console.log(JSON.stringify([ciJobLabel(job, now), ciJobLabel(job, now + 240000),
      ciJobLabel({ ...job, expectedMs: null, cardTitle: null }, now), ciJobLabel({ ...job, startedAt: null }, now)]));`);
  assert.equal(labels[0], '主干守门 · 全量单测 · 看清进度 · 已跑 12 分钟 · 预计还要 3 分钟');
  assert.equal(labels[1], '主干守门 · 全量单测 · 看清进度 · 已跑 16 分钟 · 已超出平均');
  assert.equal(labels[2], '主干守门 · 全量单测 · 检查改动 · 已跑 12 分钟 · 预计还要多久：算不出');
  assert.equal(labels[3], '主干守门 · 全量单测 · 看清进度 · 已跑时长未知 · 预计还要多久：算不出');
});

test('心跳未提供 runner 时不判不一致；空名单、不同名单和相同集合分别比较', () => {
  const values = runTs(`import { ciRunnersDiffer } from './web/src/components/sched/format.ts'; ${fixture}
    console.log(JSON.stringify([undefined, null, [], ['different'], ['fixture-runner'], ['fixture-runner', 'fixture-runner']]
      .map(observed => ciRunnersDiffer(observed, [job, job]))));`);
  assert.deepEqual(values, [false, false, true, true, false, false]);
});

test('客户端逐字段检查作业数据，接受未知扩展字段；坏响应不伪装成空列表', () => {
  const values = runTs(`import { isCiJobsSnapshot } from './web/src/api/schedCiJobs.ts'; ${fixture}
    const data = { updatedAt: new Date(now).toISOString(), staleSince: null, machines: [{ machine: job.machine, jobs: [job] }] };
    console.log(JSON.stringify([data, { ...data, future: true }, { unavailable: '本机没有 gh' },
      { machines: [] }, { ...data, machines: null }, { ...data, staleSince: 'bad' },
      ...[{ elapsedMs: -1 }, { expectedMs: '900' }, { machine: 'other' }, { startedAt: 'bad' }]
        .map(change => ({ ...data, machines: [{ machine: job.machine, jobs: [{ ...job, ...change }] }] }))]
      .map(isCiJobsSnapshot)));`);
  assert.deepEqual(values, [true, true, true, false, false, false, false, false, false, false]);
});

test('只读客户端向独立接口传取消信号；服务不可用和坏响应向卡片报错', () => {
  const value = runTs(`import { fetchCiJobs } from './web/src/api/schedCiJobs.ts';
    const signal = new AbortController().signal; let count = 0;
    globalThis.fetch = async (url, options) => {
      if (url !== '/api/sched/ci-jobs' || options.signal !== signal || options.method) throw new Error('错误的请求');
      count++;
      return { ok: count !== 2, json: async () => count === 3 ? {} : { unavailable: '本机没有 gh' } };
    };
    const first = await fetchCiJobs(signal); const errors = [];
    for (let i = 0; i < 2; i++) { try { await fetchCiJobs(signal); } catch (error) { errors.push(error.message); } }
    console.log(JSON.stringify({ first, errors, count }));`);
  assert.deepEqual(value, { first: { unavailable: '本机没有 gh' }, errors: ['暂时读不到检查作业', '暂时读不到检查作业'], count: 3 });
});
