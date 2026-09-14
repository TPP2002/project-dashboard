'use strict';

const { execFile } = require('node:child_process');
const REPOSITORY = 'TPP2002/stock-rogue';
const POLL_MS = 30_000;
const HISTORY_MS = 10 * 60_000;
const GH_TIMEOUT_MS = 10_000;
const RUNNER_MACHINES = Object.freeze({
  'rogue-local-win': 'Dx-202501231051',
  'rogue-local-win-2': 'Dx-202501231051',
  'rogue-night-win': 'Dx-202501231051',
  'rogue-local-win-3': 'DESKTOP-B3NF3BA',
  'rogue-local-win-4': 'DESKTOP-B3NF3BA',
  'mama-local-win': 'Dx-202501231051',
});
const WORKFLOWS = Object.freeze({ MainGate: '主干守门', CI: 'PR 检查', Nightly: '夜跑' });
const JOBS = Object.freeze({ fast: '全量单测', e2e: '界面测试', 'draft-gate': '草稿闸', 'night-bot': '混沌夜跑' });
const nonempty = value => typeof value === 'string' && value.trim() !== '';
const timestamp = value => nonempty(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const sampleKey = (workflow, job) => JSON.stringify([workflow, job]);
const label = (names, name, fallback) => Object.hasOwn(names, name) ? names[name] : nonempty(name) ? name : fallback;

/** 覆盖值可以是机器名、null，或 { machine, project? }；坏配置交给采集层标过期，不影响页面。 */
function runnerMapping(overrides = {}) {
  const values = typeof overrides === 'string' ? JSON.parse(overrides) : overrides;
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('机器对应设置不可读');
  const result = new Map(Object.entries(RUNNER_MACHINES).map(([runner, machine]) =>
    [runner, { machine, project: runner === 'mama-local-win' ? '别的项目' : null }]));
  for (const [runner, value] of Object.entries(values)) {
    const entry = value === null || typeof value === 'string' ? { machine: value } : value;
    if (!nonempty(runner) || !entry || Array.isArray(entry) || typeof entry !== 'object'
      || !(entry.machine === null || nonempty(entry.machine))
      || !(entry.project === undefined || entry.project === null || nonempty(entry.project))) {
      throw new Error('机器对应设置不可读');
    }
    result.set(runner, { machine: entry.machine,
      project: entry.project === undefined ? result.get(runner)?.project ?? null : entry.project });
  }
  return result;
}

function median(values) {
  const sorted = values.filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
}

/** CI 样本独立于调度台账：按原始工作流名 + 作业名分组，只取最近 20 个成功作业。 */
function historicalMedians(entries) {
  const samples = new Map();
  for (const { run, jobs } of entries) for (const job of jobs) {
    const start = timestamp(job.started_at), end = timestamp(job.completed_at);
    if (job.status !== 'completed' || job.conclusion !== 'success' || start === null || end === null || end < start) continue;
    const key = sampleKey(run.name, job.name);
    if (!samples.has(key)) samples.set(key, []);
    samples.get(key).push({ at: end, ms: end - start });
  }
  return new Map([...samples].map(([key, values]) =>
    [key, median(values.sort((a, b) => b.at - a.at).slice(0, 20).map(value => value.ms))]));
}

function jobTiming(job, nowMs) {
  const start = timestamp(job.startedAt);
  const elapsedMs = start === null ? null : Math.max(0, nowMs - start);
  return { ...job, elapsedMs, remainingMs: elapsedMs === null || job.expectedMs === null ? null : job.expectedMs - elapsedMs };
}

/** 不凭分支相似度猜卡；没有精确命中时保留 null。未知 runner 保留在 machine=null 的独立组。 */
function groupJobs(entries, { boards = [], estimates = new Map(), mapping = runnerMapping(), nowMs }) {
  const titles = new Map();
  for (const board of boards) for (const task of Array.isArray(board?.tasks) ? board.tasks : []) {
    if (!nonempty(task?.plainTitle) || !Array.isArray(task.gitBranch)) continue;
    for (const branch of task.gitBranch) if (nonempty(branch) && !titles.has(branch)) titles.set(branch, task.plainTitle);
  }
  const groups = new Map();
  for (const { run, jobs, prTitle } of entries) for (const job of jobs) {
    if (job.status !== 'in_progress') continue;
    const runner = nonempty(job.runner_name) ? job.runner_name : null;
    const location = mapping.get(runner) || { machine: null, project: null };
    const branch = nonempty(run.head_branch) ? run.head_branch : '';
    const commitTitle = run.event === 'push' && branch === 'main' && nonempty(run.head_commit?.message)
      ? run.head_commit.message.split(/\r?\n/, 1)[0] : null;
    const item = jobTiming({ id: apiId(job.id), workflow: label(WORKFLOWS, run.name, '工作流名称未知'),
      job: label(JOBS, job.name, '作业名称未知'), title: prTitle || commitTitle || branch || '名称未知', branch,
      cardTitle: titles.get(branch) ?? null, runner, ...location,
      startedAt: timestamp(job.started_at) === null ? null : job.started_at,
      expectedMs: estimates.get(sampleKey(run.name, job.name)) ?? null }, nowMs);
    if (!groups.has(location.machine)) groups.set(location.machine, []);
    groups.get(location.machine).push(item);
  }
  return [...groups].map(([machine, jobs]) => ({ machine, jobs })).sort((a, b) =>
    a.machine === b.machine ? 0 : a.machine === null ? 1 : b.machine === null ? -1 : a.machine.localeCompare(b.machine));
}

/** 只读 gh API，数组传参不经 shell；每个子进程最多 10 秒，ENOENT 原样交给采集层区分。 */
function createGhApi(runFile = execFile) {
  return endpoint => new Promise((resolve, reject) => {
    runFile('gh', ['api', endpoint, '--method', 'GET'], {
      encoding: 'utf8', windowsHide: true, timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(JSON.parse(stdout)); } catch (failure) { reject(failure); }
    });
  });
}

function apiList(value, field) {
  if (!Array.isArray(value?.[field])) throw new Error('检查服务返回的数据不完整');
  return value[field];
}
function apiId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('检查服务返回的编号不合法');
  return value;
}

// 历史采样与当前作业共用有界并发；失败后不再发新请求，并等已发出的请求收尾。
async function mapLimited(items, visit) {
  const result = new Array(items.length);
  let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length && !failure) {
      const index = next++;
      try { result[index] = await visit(items[index]); } catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
  return result;
}

/** 不启动定时器、不写磁盘；调用方注入时钟和 gh。refresh 合并并发调用，snapshot 始终即时返回。 */
function createCiJobsMonitor({ gh = createGhApi(), now = Date.now, readBoards = async () => [], runnerOverrides = {} } = {}) {
  let current = { machines: [], updatedAt: null, staleSince: null };
  let history = new Map(), historyAt = null, pending = null;
  const base = `repos/${REPOSITORY}`;

  async function jobsFor(run) {
    const jobs = [];
    for (let page = 1; ; page++) {
      const data = await gh(`${base}/actions/runs/${apiId(run.id)}/jobs?per_page=100&page=${page}`);
      const batch = apiList(data, 'jobs');
      if (data.total_count !== undefined && (!Number.isSafeInteger(data.total_count) || data.total_count < 0)) {
        throw new Error('检查作业分页数据不完整');
      }
      jobs.push(...batch);
      if (jobs.length >= data.total_count || (data.total_count === undefined && batch.length < 100)) return jobs;
      if (!batch.length) throw new Error('检查作业分页数据不完整');
    }
  }

  async function collect() {
    try {
      const mapping = runnerMapping(runnerOverrides);
      const runs = apiList(await gh(`${base}/actions/runs?status=in_progress&per_page=20`), 'workflow_runs');
      const pulls = new Map();
      const entries = await mapLimited(runs, async run => {
        const jobs = await jobsFor(run);
        const pull = run.pull_requests?.[0];
        let prTitle = nonempty(pull?.title) ? pull.title : null;
        if (pull && !prTitle) {
          const number = apiId(pull.number);
          if (!pulls.has(number)) pulls.set(number, gh(`${base}/pulls/${number}`));
          const result = await pulls.get(number);
          prTitle = nonempty(result?.title) ? result.title : null;
        }
        return { run, jobs, prTitle };
      });
      const observedAt = now();
      // 每十分钟抽最近 100 个已完成 run，再按每组最近 20 个成功 job 取中位数。
      // 抽样是有限窗口；窗口内没有成功记录的组合保持 null，不借用别组的耗时。
      if (historyAt === null || now() - historyAt >= HISTORY_MS) {
        const completed = apiList(await gh(`${base}/actions/runs?status=completed&per_page=100`), 'workflow_runs');
        const samples = await mapLimited(completed, async run => ({ run, jobs: await jobsFor(run) }));
        history = historicalMedians(samples);
        historyAt = now();
      }
      const boards = await readBoards();
      const nowMs = now();
      current = { machines: groupJobs(entries, { mapping, estimates: history, boards, nowMs }),
        updatedAt: new Date(observedAt).toISOString(), staleSince: null };
    } catch (error) {
      if (error?.code === 'ENOENT') current = { ...current, unavailable: '本机没有 gh' };
      else {
        const { unavailable, ...previous } = current;
        current = { ...previous, staleSince: current.staleSince || new Date(now()).toISOString(), error: '暂时读不到检查作业' };
      }
    }
    return snapshot();
  }

  function snapshot() {
    if (current.unavailable) return { unavailable: current.unavailable };
    const nowMs = now(), updated = timestamp(current.updatedAt);
    const staleSince = current.staleSince || (updated !== null && nowMs - updated > POLL_MS * 2
      ? new Date(updated + POLL_MS * 2).toISOString() : null);
    return { ...current, staleSince, machines: current.machines.map(group =>
      ({ ...group, jobs: group.jobs.map(job => jobTiming(job, nowMs)) })) };
  }

  function refresh() {
    if (!pending) pending = collect().finally(() => { pending = null; });
    return pending;
  }
  return { refresh, snapshot };
}

module.exports = { REPOSITORY, POLL_MS, HISTORY_MS, GH_TIMEOUT_MS, RUNNER_MACHINES,
  runnerMapping, median, historicalMedians, groupJobs, createGhApi, createCiJobsMonitor };
