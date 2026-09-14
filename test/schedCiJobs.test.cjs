'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../core/schedCiJobs.cjs');
const AT = Date.parse('2026-09-14T10:00:00Z');
const iso = offset => new Date(AT + offset).toISOString();
const base = `repos/${c.REPOSITORY}`;
const runningPath = `${base}/actions/runs?status=in_progress&per_page=20`;
const historyPath = `${base}/actions/runs?status=completed&per_page=100`;
const jobsPath = (id, page = 1) => `${base}/actions/runs/${id}/jobs?per_page=100&page=${page}`;
const run = (extra = {}) => ({ id: 1, name: 'CI', head_branch: 'feat/window', status: 'in_progress',
  event: 'pull_request', pull_requests: [{ number: 9 }], ...extra });
const job = (extra = {}) => ({ id: 11, name: 'fast', runner_name: 'rogue-local-win', status: 'in_progress',
  started_at: iso(-720_000), completed_at: null, conclusion: null, ...extra });
const successful = (extra = {}) => job({ id: 21, status: 'completed', conclusion: 'success',
  started_at: iso(-1_900_000), completed_at: iso(-1_000_000), ...extra });

function fixture() {
  let now = AT, failure = null;
  const calls = [];
  const responses = new Map([
    [runningPath, { workflow_runs: [run()] }],
    [jobsPath(1), { total_count: 1, jobs: [job()] }],
    [`${base}/pulls/9`, { title: '让检查进度一眼可见' }],
    [historyPath, { workflow_runs: [run({ id: 2, status: 'completed' })] }],
    [jobsPath(2), { total_count: 1, jobs: [successful()] }],
  ]);
  const monitor = c.createCiJobsMonitor({ now: () => now,
    readBoards: async () => [{ tasks: [{ gitBranch: ['feat/window'], plainTitle: '看清机器正在忙什么' }] }],
    gh: async endpoint => {
      calls.push(endpoint);
      if (failure) throw failure;
      assert.ok(responses.has(endpoint), `未登记的请求：${endpoint}`);
      return structuredClone(responses.get(endpoint));
    } });
  return { monitor, calls, responses, time: value => { now = value; }, fail: value => { failure = value; } };
}

test('六个 runner 精确映射；环境 JSON 可覆盖机器、增补 runner 并保留其它项目标识', () => {
  const mapping = c.runnerMapping();
  assert.deepEqual([...mapping].map(([runner, value]) => [runner, value.machine]), Object.entries(c.RUNNER_MACHINES));
  for (const runner of ['rogue-local-win', 'rogue-local-win-2', 'rogue-night-win', 'mama-local-win']) {
    assert.equal(mapping.get(runner).machine, 'Dx-202501231051');
  }
  for (const runner of ['rogue-local-win-3', 'rogue-local-win-4']) assert.equal(mapping.get(runner).machine, 'DESKTOP-B3NF3BA');
  assert.equal(mapping.get('mama-local-win').project, '别的项目');
  const changed = c.runnerMapping('{"rogue-local-win":"fixture-host","added":{"machine":"fixture-worker","project":"别的项目"},"removed":null}');
  assert.deepEqual(changed.get('rogue-local-win'), { machine: 'fixture-host', project: null });
  assert.deepEqual(changed.get('added'), { machine: 'fixture-worker', project: '别的项目' });
  assert.equal(changed.get('removed').machine, null);
  assert.equal(mapping.has('added'), false);
  for (const invalid of ['{', '[]', 'null', { runner: '' }, { runner: {} }, { runner: { machine: 1 } }, { runner: { machine: 'x', project: 2 } }]) {
    assert.throws(() => c.runnerMapping(invalid));
  }
});

test('名称翻成人话，未知名称原样保留，内置对象属性名不误当成翻译', () => {
  const names = [['MainGate', 'fast', '主干守门', '全量单测'], ['CI', 'e2e', 'PR 检查', '界面测试'],
    ['Nightly', 'night-bot', '夜跑', '混沌夜跑'], ['custom', 'draft-gate', 'custom', '草稿闸'],
    ['toString', 'constructor', 'toString', 'constructor']];
  const groups = c.groupJobs(names.map(([workflow, task], index) => ({ run: run({ name: workflow }),
    jobs: [job({ id: index + 1, name: task })] })), { nowMs: AT });
  assert.deepEqual(groups[0].jobs.map(item => [item.workflow, item.job]), names.map(item => item.slice(2)));
});

test('只列正在跑的作业，副机、其它项目和未知 runner 均不丢失或错误归属', () => {
  const entries = [{ run: run(), jobs: [job(), job({ id: 12, runner_name: 'rogue-local-win-3' }),
    job({ id: 13, runner_name: 'mama-local-win' }), job({ id: 14, runner_name: 'unregistered' }),
    job({ id: 15, runner_name: '' }), job({ id: 16, status: 'queued' }), successful()] }];
  const groups = c.groupJobs(entries, { nowMs: AT });
  assert.equal(groups.flatMap(group => group.jobs).length, 5);
  const host = groups.find(group => group.machine === 'Dx-202501231051');
  assert.deepEqual(host.jobs.map(item => [item.id, item.project]), [[11, null], [13, '别的项目']]);
  assert.deepEqual(groups.find(group => group.machine === 'DESKTOP-B3NF3BA').jobs.map(item => item.id), [12]);
  assert.equal(groups.at(-1).machine, null);
  assert.deepEqual(groups.at(-1).jobs.map(item => item.runner), ['unregistered', null]);
});

test('标题优先取 PR，其次仅 main push 取提交首行；分支精确命中各板的人话标题', () => {
  const entries = [
    { run: run(), jobs: [job()], prTitle: '修复机器显示' },
    { run: run({ head_branch: 'main', event: 'push', head_commit: { message: '补齐进度\n\n正文' } }), jobs: [job({ id: 12 })] },
    { run: run({ head_branch: 'feature', event: 'push', head_commit: { message: '不应显示这条' } }), jobs: [job({ id: 13 })] },
  ];
  const boards = [{ tasks: [{ gitBranch: ['feat'], plainTitle: '不能模糊匹配' }] },
    { tasks: [{ gitBranch: ['old', 'feat/window'], plainTitle: '让负责人看清进度' }] }];
  const items = c.groupJobs(entries, { boards, nowMs: AT })[0].jobs;
  assert.deepEqual(items.map(item => item.title), ['修复机器显示', '补齐进度', 'feature']);
  assert.deepEqual(items.map(item => item.cardTitle), ['让负责人看清进度', null, null]);
  assert.equal(items[0].branch, 'feat/window');
});

test('中位数支持空、奇偶和零，忽略非数值及负耗时，且不改变输入', () => {
  const values = [3, 0, 1, 2];
  assert.equal(c.median(values), 1.5);
  assert.deepEqual(values, [3, 0, 1, 2]);
  assert.equal(c.median([1, 9, 2]), 2);
  assert.equal(c.median([NaN, Infinity, -1, '3', null]), null);
  assert.equal(c.median([]), null);
});

test('按原始工作流和作业独立取最近 20 个成功样本，失败、无效时间不参与', () => {
  const samples = Array.from({ length: 22 }, (_, index) => ({ run: run(), jobs: [successful({
    started_at: iso(-index * 10_000 - (index + 1) * 1000), completed_at: iso(-index * 10_000),
  })] }));
  samples.push({ run: run(), jobs: [successful({ conclusion: 'failure' }), successful({ started_at: 'invalid' }),
    successful({ completed_at: iso(-2_000_000) }), successful({ status: 'in_progress' })] });
  samples.push({ run: run({ name: 'MainGate' }), jobs: [successful()] });
  samples.push({ run: run(), jobs: [successful({ name: 'e2e', started_at: iso(-1_100_000) })] });
  const result = c.historicalMedians(samples.reverse());
  assert.equal(result.get(JSON.stringify(['CI', 'fast'])), 10_500);
  assert.equal(result.get(JSON.stringify(['MainGate', 'fast'])), 900_000);
  assert.equal(result.get(JSON.stringify(['CI', 'e2e'])), 100_000);
  assert.equal(result.size, 3);
});

test('已跑、预计剩余按注入时钟计算；超时保留负值，未开始和无样本保持 null', () => {
  const estimates = new Map([[JSON.stringify(['CI', 'fast']), 900_000]]);
  const items = c.groupJobs([{ run: run(), jobs: [job(), job({ id: 12, started_at: iso(-1_000_000) }),
    job({ id: 13, started_at: null }), job({ id: 14, started_at: iso(1000) }), job({ id: 15, name: 'unknown' })] }],
  { nowMs: AT, estimates })[0].jobs;
  assert.deepEqual(items.map(item => [item.elapsedMs, item.expectedMs, item.remainingMs]),
    [[720_000, 900_000, 180_000], [1_000_000, 900_000, -100_000], [null, 900_000, null], [0, 900_000, 900_000], [720_000, null, null]]);
});

test('gh 通过异步 execFile 数组传参，超时固定十秒，响应未到时不阻塞调用方', async () => {
  let finish;
  const gh = c.createGhApi((file, args, options, callback) => {
    assert.equal(file, 'gh'); assert.deepEqual(args, ['api', runningPath, '--method', 'GET']);
    assert.equal(options.timeout, 10_000); assert.equal(options.windowsHide, true); assert.equal(options.shell, undefined);
    finish = callback;
  });
  const pending = gh(runningPath);
  assert.ok(pending instanceof Promise);
  finish(null, '{"workflow_runs":[]}');
  assert.deepEqual(await pending, { workflow_runs: [] });
});

test('gh 超时、缺程序及损坏 JSON 原样拒绝，不重试不伪装空数据', async () => {
  for (const error of [Object.assign(new Error('missing'), { code: 'ENOENT' }), Object.assign(new Error('timeout'), { killed: true })]) {
    let calls = 0;
    const gh = c.createGhApi((_file, _args, _options, callback) => { calls++; callback(error); });
    await assert.rejects(gh(runningPath), failure => failure === error);
    assert.equal(calls, 1);
  }
  const invalid = c.createGhApi((_file, _args, _options, callback) => callback(null, '{'));
  await assert.rejects(invalid(runningPath), SyntaxError);
});

test('首次采集包含 PR 与卡标题；历史恰好缓存十分钟，普通刷新不重采样', async () => {
  const h = fixture();
  assert.deepEqual(h.monitor.snapshot(), { machines: [], updatedAt: null, staleSince: null });
  const first = await h.monitor.refresh(), item = first.machines[0].jobs[0];
  assert.equal(item.title, '让检查进度一眼可见'); assert.equal(item.cardTitle, '看清机器正在忙什么');
  assert.equal(item.expectedMs, 900_000); assert.equal(item.remainingMs, 180_000);
  h.time(AT + c.HISTORY_MS - 1); await h.monitor.refresh();
  assert.equal(h.calls.filter(endpoint => endpoint === historyPath).length, 1);
  h.time(AT + c.HISTORY_MS); await h.monitor.refresh();
  assert.equal(h.calls.filter(endpoint => endpoint === historyPath).length, 2);
  assert.equal(h.calls.filter(endpoint => endpoint === runningPath).length, 3);
});

test('失败和超时沿用上一拍，过期起点保持；读缓存无 gh 调用，恢复后清除过期', async () => {
  const h = fixture(), first = await h.monitor.refresh();
  h.time(AT + 30_000); h.fail(Object.assign(new Error('timeout'), { killed: true }));
  const stale = await h.monitor.refresh();
  assert.equal(stale.updatedAt, first.updatedAt); assert.equal(stale.staleSince, iso(30_000));
  assert.equal(stale.machines[0].jobs[0].title, first.machines[0].jobs[0].title);
  assert.equal(stale.machines[0].jobs[0].elapsedMs, 750_000);
  h.time(AT + 60_000); h.fail(new Error('permission denied'));
  assert.equal((await h.monitor.refresh()).staleSince, iso(30_000));
  const calls = h.calls.length; h.monitor.snapshot(); assert.equal(h.calls.length, calls);
  h.fail(null); const recovered = await h.monitor.refresh();
  assert.equal(recovered.staleSince, null); assert.equal(recovered.updatedAt, iso(60_000)); assert.equal(recovered.error, undefined);
});

test('长时间未更新自动标过期，外部修改响应不能污染缓存', async () => {
  const h = fixture(), first = await h.monitor.refresh();
  first.machines[0].jobs[0].title = '污染'; first.machines.push({ machine: null, jobs: [] });
  h.time(AT + 60_001);
  const stale = h.monitor.snapshot();
  assert.equal(stale.staleSince, iso(60_000)); assert.equal(stale.machines.length, 1);
  assert.equal(stale.machines[0].jobs[0].title, '让检查进度一眼可见');
});

test('缺 gh 整块 unavailable，安装后失败不继续谎报缺程序，恢复可重新读到作业', async () => {
  const h = fixture(); h.fail(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  assert.deepEqual(await h.monitor.refresh(), { unavailable: '本机没有 gh' });
  h.time(AT + 30_000); h.fail(new Error('auth'));
  const failed = await h.monitor.refresh(); assert.equal(failed.unavailable, undefined); assert.equal(failed.staleSince, iso(30_000));
  assert.deepEqual(failed.machines, []);
  h.fail(null); assert.equal((await h.monitor.refresh()).machines[0].jobs.length, 1);
});

test('历史采样慢时不把旧的正在跑作业标成刚刚更新', async () => {
  let now = AT;
  const monitor = c.createCiJobsMonitor({ now: () => now, gh: async endpoint => {
    if (endpoint === runningPath) return { workflow_runs: [run({ pull_requests: [] })] };
    if (endpoint === jobsPath(1)) return { total_count: 1, jobs: [job()] };
    assert.equal(endpoint, historyPath); now += 120_000; return { workflow_runs: [] };
  } });
  const data = await monitor.refresh();
  assert.equal(data.updatedAt, iso(0)); assert.equal(data.staleSince, iso(60_000));
  assert.equal(data.machines[0].jobs[0].elapsedMs, 840_000);
});

test('损坏响应、作业分页及历史失败均不能把上一拍清空', async () => {
  for (const endpoint of [runningPath, jobsPath(1), historyPath, jobsPath(2)]) {
    const h = fixture(); await h.monitor.refresh(); h.time(AT + c.HISTORY_MS);
    h.responses.set(endpoint, {});
    const stale = await h.monitor.refresh();
    assert.equal(stale.updatedAt, iso(0), endpoint); assert.equal(stale.staleSince, iso(c.HISTORY_MS), endpoint);
    assert.equal(stale.machines[0].jobs[0].id, 11, endpoint);
  }
});

test('同一 run 超过一页的作业全部读取，同一 PR 只查一次', async () => {
  const h = fixture();
  h.responses.set(runningPath, { workflow_runs: [run(), run({ id: 3 })] });
  h.responses.set(jobsPath(1), { total_count: 2, jobs: [job()] });
  h.responses.set(jobsPath(1, 2), { total_count: 2, jobs: [job({ id: 12 })] });
  h.responses.set(jobsPath(3), { total_count: 1, jobs: [job({ id: 13 })] });
  const snapshot = await h.monitor.refresh();
  assert.deepEqual(snapshot.machines[0].jobs.map(item => item.id), [11, 12, 13]);
  assert.equal(h.calls.filter(endpoint => endpoint === `${base}/pulls/9`).length, 1);
});

test('重叠刷新共用一个采集过程；没有任务及历史时明确返回空成功拍', async () => {
  let release, calls = 0;
  const monitor = c.createCiJobsMonitor({ now: () => AT, gh: async endpoint => {
    calls++;
    if (endpoint === runningPath) return new Promise(resolve => { release = resolve; });
    assert.equal(endpoint, historyPath); return { workflow_runs: [] };
  } });
  const first = monitor.refresh(), second = monitor.refresh();
  assert.equal(first, second); assert.equal(calls, 1);
  release({ workflow_runs: [] });
  assert.deepEqual(await first, { machines: [], updatedAt: iso(0), staleSince: null }); assert.equal(calls, 2);
});
