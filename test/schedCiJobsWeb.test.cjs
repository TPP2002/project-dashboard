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
  assert.deepEqual(values, [false, false, true, false, false, false, false, false, false, false]);
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

test('注册项目的 HTTPS 和 SSH 远端转成仓库名，配置整体覆盖并去重', () => {
  const c = require('../core/schedCiJobs.cjs');
  for (const remote of ['https://github.com/owner/repo', 'https://github.com/owner/repo.git', 'git@github.com:owner/repo', 'git@github.com:owner/repo.git']) {
    assert.equal(c.githubRepository(remote), 'owner/repo');
  }
  for (const remote of ['https://example.invalid/owner/repo', 'git@example.invalid:owner/repo', 'https://github.com/owner/repo/tree/main', '/fixture/local', 'https://github.com/owner/..']) {
    assert.equal(c.githubRepository(remote), null);
  }
  const boards = [{ repository: 'owner/repo' }, { repository: 'OWNER/REPO' }, { repository: null }];
  assert.deepEqual(c.repositories(boards), ['owner/repo']);
  assert.deepEqual(c.repositories(boards, ' owner/other, owner/other,owner/third '), ['owner/other', 'owner/third']);
  assert.deepEqual(c.repositories(boards, ''), []);
  assert.throws(() => c.repositories(boards, 'owner/repo,invalid'));
});

test('从 board 的上两级读取 Git origin，数组参数和十秒超时不经过 shell', async () => {
  const { readCiRepository } = require('../server/server.cjs');
  const root = path.join('fixture root; literal', 'project'), board = path.join(root, '.dashboard', 'board.json');
  let finish;
  const result = readCiRepository(board, (file, args, options, callback) => {
    assert.equal(file, 'git'); assert.deepEqual(args, ['-C', root, 'remote', 'get-url', 'origin']);
    assert.equal(options.timeout, 10_000); assert.equal(options.shell, undefined); assert.equal(options.windowsHide, true);
    finish = callback;
  });
  assert.ok(result instanceof Promise); finish(null, 'git@github.com:owner/repo.git\n');
  assert.equal(await result, 'owner/repo');
  const failure = Object.assign(new Error('fixture missing git'), { code: 'ENOENT' });
  await assert.rejects(readCiRepository(board, (_file, _args, _options, callback) => callback(failure)), error => error === failure);
});

test('机器表每拍来自心跳，读不到则全部未知，覆盖配置不猜项目', async () => {
  const c = require('../core/schedCiJobs.cjs');
  let machine = 'machine-a', reads = 0;
  const monitor = c.createCiJobsMonitor({ repositoryOverrides: 'owner/repo', now: () => 0,
    readRunnerMachines: async () => { reads++; if (!machine) throw new Error('fixture unreadable'); return new Map([['runner-1', machine]]); },
    gh: async endpoint => endpoint.includes('status=in_progress') ? { workflow_runs: [{ id: 1, name: 'CI', head_branch: 'fixture' }] }
      : endpoint.includes('/jobs?') ? { jobs: [{ id: 1, name: 'fast', status: 'in_progress', runner_name: 'runner-1', started_at: '1970-01-01T00:00:00Z' }] }
        : { workflow_runs: [] } });
  assert.equal((await monitor.refresh()).machines[0].machine, 'machine-a');
  machine = 'machine-b'; assert.equal((await monitor.refresh()).machines[0].machine, 'machine-b');
  machine = ''; const unknown = await monitor.refresh();
  assert.equal(unknown.machines[0].machine, null); assert.equal(unknown.machines[0].jobs[0].project, null);
  assert.equal(unknown.error, undefined); assert.equal(reads, 3); assert.equal(c.runnerMapping().size, 0);
  const observed = c.runnerMachines([{ name: 'machine-a', ciRunners: ['runner-1', 'shared'] }, { name: 'machine-b', ciRunners: ['shared'] }]);
  assert.deepEqual([...observed], [['runner-1', 'machine-a']]);
  assert.deepEqual(c.runnerMapping({ 'runner-1': 'machine-b' }, observed).get('runner-1'), { machine: 'machine-b', project: null });
});

test('只给过期仓库的作业加数据年龄，健康仓库保持新鲜文案', () => {
  const labels = runTs(`import { ciJobLabel } from './web/src/components/sched/format.ts'; ${fixture}
    console.log(JSON.stringify([ciJobLabel({ ...job, repository: 'owner/repo-a', updatedAt: '2026-09-14T09:59:30Z', staleSince: '2026-09-14T10:00:00Z' }, now),
      ciJobLabel({ ...job, repository: 'owner/repo-b', updatedAt: new Date(now).toISOString(), staleSince: null }, now)]));`);
  assert.ok(labels[0].endsWith(' · 数据 30 秒前'));
  assert.equal(labels[1], '主干守门 · 全量单测 · 看清进度 · 已跑 12 分钟 · 预计还要 3 分钟');
});

test('一个仓库尚未返回时，下一拍仍能刷新其它仓库且不重复占用慢仓库', async () => {
  const c = require('../core/schedCiJobs.cjs');
  let now = 0, release;
  const calls = [];
  const monitor = c.createCiJobsMonitor({ now: () => now, repositoryOverrides: 'owner/slow,owner/fast', gh: async endpoint => {
    calls.push(endpoint);
    if (endpoint.includes('/slow/') && endpoint.includes('status=in_progress')) return new Promise(resolve => { release = resolve; });
    return { workflow_runs: [] };
  } });
  const first = monitor.refresh();
  await new Promise(setImmediate);
  assert.equal(monitor.snapshot().repositories.find(item => item.repository === 'owner/fast').updatedAt, new Date(0).toISOString());
  now = 30_000; const second = monitor.refresh();
  await new Promise(setImmediate);
  assert.equal(monitor.snapshot().repositories.find(item => item.repository === 'owner/fast').updatedAt, new Date(now).toISOString());
  assert.equal(calls.filter(endpoint => endpoint.includes('/slow/') && endpoint.includes('status=in_progress')).length, 1);
  release({ workflow_runs: [] }); await Promise.all([first, second]);
});

test('仓库清单覆盖不依赖注册表可读，不额外采集其它仓库', async () => {
  const c = require('../core/schedCiJobs.cjs'), calls = [];
  const monitor = c.createCiJobsMonitor({ now: () => 0, repositoryOverrides: 'owner/override',
    readBoards: async () => { throw new Error('fixture unreadable registry'); },
    gh: async endpoint => { calls.push(endpoint); return { workflow_runs: [] }; } });
  assert.deepEqual(await monitor.refresh(), { machines: [], queued: [], updatedAt: new Date(0).toISOString(), staleSince: null });
  assert.deepEqual(calls, ['repos/owner/override/actions/runs?status=in_progress&per_page=20', 'repos/owner/override/actions/runs?status=queued&per_page=20', 'repos/owner/override/actions/runs?status=completed&per_page=100']);
});

const currentFixture = `${fixture}
  Object.assign(job, { phase: 'running', queuedAt: '2026-09-14T09:47:00Z', queuedMs: 60000,
    repository: 'owner/repo', runner: 'runner-1', machine: 'machine-a' });
  const queued = { ...job, id: 2, phase: 'queued', runner: null, machine: null, startedAt: null,
    queuedAt: '2026-09-14T09:03:00Z', queuedMs: 3420000, elapsedMs: null, remainingMs: null };
  const data = { updatedAt: new Date(now).toISOString(), staleSince: null,
    machines: [{ machine: job.machine, jobs: [job] }], queued: [queued] };`;

test('新快照必有排队数组及作业阶段、排队时间；每个字段缺失或类型错误均拒绝', () => {
  const result = runTs(`import { isCiJobsSnapshot } from './web/src/api/schedCiJobs.ts'; ${currentFixture}
    const without = (value, key) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
    const runningData = item => ({ ...data, machines: [{ machine: job.machine, jobs: [item] }] });
    const queuedData = item => ({ ...data, queued: [item] });
    const valid = [data, { ...data, future: true }, { ...data, queued: [] }, { ...data, machines: [] },
      queuedData({ ...queued, queuedAt: null, queuedMs: null }),
      runningData({ ...job, startedAt: null, queuedAt: null, queuedMs: null, elapsedMs: null, remainingMs: null })];
    const invalid = [without(data, 'queued'), { ...data, queued: null }, { ...data, queued: {} },
      ...['phase', 'queuedAt', 'queuedMs'].flatMap(key => [runningData(without(job, key)), queuedData(without(queued, key))]),
      ...[{ phase: 'waiting' }, { phase: null }, { queuedAt: 'bad' }, { queuedMs: -1 }, { queuedMs: '60000' },
        { queuedMs: NaN }, { queuedMs: Infinity }].flatMap(change => [runningData({ ...job, ...change }), queuedData({ ...queued, ...change })]),
      ...[{ elapsedMs: -1 }, { expectedMs: '900' }, { machine: 'other' }, { startedAt: 'bad' }]
        .map(change => runningData({ ...job, ...change })),
      ...[{ phase: 'running' }, { runner: 'runner-1' }, { machine: 'machine-a' }, { startedAt: job.startedAt },
        { elapsedMs: 0 }, { remainingMs: 0 }].map(change => queuedData({ ...queued, ...change })),
      { ...data, machines: [{ machine: null, jobs: [queued] }] }, queuedData(job)];
    console.log(JSON.stringify({ valid: valid.map(isCiJobsSnapshot), invalid: invalid.map(isCiJobsSnapshot) }));`);
  assert.deepEqual(result.valid, [true, true, true, true, true, true]);
  assert.equal(result.invalid.length, 35);
  assert.ok(result.invalid.every(value => value === false));
});

test('排队文案显示项目、人话标题和整分钟，时钟走动、缺时间与过期分别说明', () => {
  const labels = runTs(`import { ciQueuedLabel } from './web/src/components/sched/format.ts'; ${currentFixture}
    console.log(JSON.stringify([ciQueuedLabel(queued, now), ciQueuedLabel(queued, now + 60000),
      ciQueuedLabel(queued, now + 600000), ciQueuedLabel({ ...queued, queuedAt: new Date(now).toISOString(), queuedMs: 0 }, now),
      ciQueuedLabel({ ...queued, project: '项目甲', cardTitle: null }, now),
      ciQueuedLabel({ ...queued, queuedAt: null, queuedMs: null }, now),
      ciQueuedLabel({ ...queued, updatedAt: '2026-09-14T09:59:30Z', staleSince: new Date(now).toISOString() }, now)]));`);
  assert.equal(labels[0], 'owner/repo · 主干守门 · 全量单测 · 看清进度 · 排队 57 分钟');
  assert.equal(labels[1], 'owner/repo · 主干守门 · 全量单测 · 看清进度 · 排队 58 分钟');
  assert.equal(labels[2], 'owner/repo · 主干守门 · 全量单测 · 看清进度 · 排队 67 分钟');
  assert.equal(labels[3], 'owner/repo · 主干守门 · 全量单测 · 看清进度 · 排队 0 分钟');
  assert.equal(labels[4], '项目甲 · 主干守门 · 全量单测 · 检查改动 · 排队 57 分钟');
  assert.equal(labels[5], 'owner/repo · 主干守门 · 全量单测 · 看清进度 · 排队时长未知');
  assert.equal(labels[6], 'owner/repo · 主干守门 · 全量单测 · 看清进度 · 排队 57 分钟 · 数据 30 秒前');
  assert.doesNotMatch(labels.join('\n'), /已跑|预计还要|已超出平均/);
});

// 内存中编译实际组件与依赖，仅为组件初始快照注入夹具；计数、分组和文案仍走实际代码。
function machineRenderer() {
  const fs = require('node:fs');
  const webRequire = require('node:module').createRequire(path.join(__dirname, '../web/package.json'));
  const { parse, compileScript, compileTemplate } = webRequire('vue/compiler-sfc');
  const ts = webRequire('typescript'), { createSSRApp, h } = webRequire('vue');
  const { renderToString } = webRequire('vue/server-renderer');
  const directory = path.join(__dirname, '../web/src/components/sched');
  function evaluate(source, requireFn = webRequire) {
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    const output = { exports: {} };
    new Function('require', 'module', 'exports', outputText)(requireFn, output, output.exports);
    return output.exports;
  }
  const format = evaluate(fs.readFileSync(path.join(directory, 'format.ts'), 'utf8'));
  const api = evaluate(fs.readFileSync(path.join(__dirname, '../web/src/api/schedCiJobs.ts'), 'utf8'));
  const capacity = evaluate(fs.readFileSync(path.join(__dirname, '../core/schedMachineDisplay.mjs'), 'utf8'));
  function compile(name, dependencies) {
    const filename = path.join(directory, name);
    const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename });
    assert.deepEqual(errors, []);
    const script = compileScript(descriptor, { id: name });
    const template = compileTemplate({ id: name, filename, source: descriptor.template.content,
      compilerOptions: { bindingMetadata: script.bindings } });
    assert.deepEqual(template.errors, []);
    const resolve = id => Object.hasOwn(dependencies, id) ? dependencies[id] : webRequire(id);
    const component = evaluate(script.content, resolve).default;
    component.render = evaluate(template.code, resolve).render;
    return component;
  }
  const EstimateText = compile('EstimateText.vue', { './format': format });
  const MachineCard = compile('MachineCard.vue', { './format': format, './EstimateText.vue': { default: EstimateText },
    '@/api/schedCiJobs': api, '../../../../core/schedMachineDisplay.mjs': capacity });
  return async (snapshot, name, now) => {
    const component = { ...MachineCard, setup(props, context) {
      const state = MachineCard.setup(props, context);
      state.ciSnapshot.value = snapshot;
      return state;
    } };
    const machine = { name, online: true, fresh: true, ci: 'idle', ciRunners: null,
      heartbeatAt: new Date(now).toISOString(), loadSampledAt: new Date(now).toISOString(),
      quotaCores: 4, grantedCores: 0, externalLoadCores: 0, availableCores: 4 };
    const html = await renderToString(createSSRApp({ render: () => h(component, {
      machine, host: 'machine-a', tickets: [], estimates: {}, now, busy: false,
    }) }));
    return { html, visible: html.replace(/<[^>]*>/g, '') };
  };
}

test('实际机器卡标题分开数在跑与排队，排队和未知机器仅在主机出现，只有排队也能展开', async () => {
  const { data, now } = runTs(`${currentFixture}
    data.machines.push({ machine: 'machine-b', jobs: [{ ...job, id: 3, machine: 'machine-b', runner: 'runner-2' }] },
      { machine: null, jobs: [{ ...job, id: 4, machine: null, runner: null }] });
    data.queued.push({ ...queued, id: 5 });
    console.log(JSON.stringify({ data, now }));`);
  const render = machineRenderer();
  const host = await render(data, 'machine-a', now), worker = await render(data, 'machine-b', now);
  assert.match(host.html, /<summary>CI:在跑 2 · 排队 2<\/summary>/);
  assert.match(host.visible, /排队等 runner\(2\)/); assert.match(host.visible, /排队 57 分钟/);
  assert.match(host.visible, /未知机器/);
  assert.equal((host.html.match(/class="machine-ci-jobs"/g) || []).length, 1);
  assert.doesNotMatch(host.html, /<details[^>]*\sopen(?:\s|=|>)/);
  assert.match(worker.html, /<summary>CI:在跑 1 · 排队 0<\/summary>/);
  assert.doesNotMatch(worker.visible, /排队等 runner|排队 57 分钟|未知机器/);
  const onlyQueued = await render({ ...data, machines: [] }, 'machine-a', now);
  assert.match(onlyQueued.html, /<summary>CI:在跑 0 · 排队 2<\/summary>/);
  assert.match(onlyQueued.visible, /排队等 runner\(2\)/);
  const empty = await render({ ...data, machines: [], queued: [] }, 'machine-a', now);
  assert.doesNotMatch(empty.html, /machine-ci-details/);
  assert.match(empty.visible, /没有查到正在跑或排队的检查/);
});
