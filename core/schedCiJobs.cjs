'use strict';

const { execFile } = require('node:child_process');
const POLL_MS = 30_000;
const HISTORY_MS = 10 * 60_000;
const GH_TIMEOUT_MS = 10_000;
const WORKFLOWS = Object.freeze({ MainGate: '主干守门', CI: 'PR 检查', Nightly: '夜跑' });
const JOBS = Object.freeze({ fast: '全量单测', e2e: '界面测试', 'draft-gate': '草稿闸', 'night-bot': '混沌夜跑' });
const nonempty = value => typeof value === 'string' && value.trim() !== '';
const timestamp = value => nonempty(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const sampleKey = (workflow, job, repository) => JSON.stringify(repository === undefined ? [workflow, job] : [repository, workflow, job]);
const label = (names, name, fallback) => Object.hasOwn(names, name) ? names[name] : nonempty(name) ? name : fallback;

function repositoryName(value) {
  return nonempty(value) && /^[\w.-]+\/[\w.-]+$/.test(value)
    && value.split('/').every(part => part !== '.' && part !== '..') ? value.toLowerCase() : null;
}
/** 仅接受 GitHub 的 HTTPS / SSH origin；不跟随 URL，不读取仓库内容。 */
function githubRepository(remote) {
  if (typeof remote !== 'string') return null;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^\s?#]+?)\/?$/i.exec(remote.trim());
  return match ? repositoryName(match[1].replace(/\.git$/i, '')) : null;
}
function repositories(boards, override) {
  const values = override === undefined ? boards.map(board => board.repository).filter(nonempty) : override.split(',').map(value => value.trim()).filter(Boolean);
  const names = values.map(repositoryName);
  if (names.some(name => !name)) throw new Error('检查仓库设置不可读');
  return [...new Set(names)];
}
/** 心跳出现冲突归属时保持未知，不凭机器顺序挑一个。 */
function runnerMachines(machines) {
  const result = new Map();
  for (const machine of machines) for (const runner of machine.ciRunners || []) {
    result.set(runner, result.has(runner) && result.get(runner) !== machine.name ? null : machine.name);
  }
  return new Map([...result].filter(([, machine]) => machine !== null));
}

/** 覆盖值可以是机器名、null，或 { machine, project? }；坏配置交给采集层标过期，不影响页面。 */
function runnerMapping(overrides = {}, observed = new Map()) {
  const values = typeof overrides === 'string' ? JSON.parse(overrides) : overrides;
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('机器对应设置不可读');
  const result = new Map([...observed].filter(([runner, machine]) => nonempty(runner) && nonempty(machine))
    .map(([runner, machine]) => [runner, { machine, project: null }]));
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

/** CI 样本独立于调度台账：按仓库 + 原始工作流名 + 作业名分组，只取最近 20 个成功作业。 */
function historicalMedians(entries) {
  const samples = new Map();
  for (const { repository, run, jobs } of entries) for (const job of jobs) {
    const start = timestamp(job.started_at), end = timestamp(job.completed_at);
    if (job.status !== 'completed' || job.conclusion !== 'success' || start === null || end === null || end < start) continue;
    const key = sampleKey(run.name, job.name, repository);
    if (!samples.has(key)) samples.set(key, []);
    samples.get(key).push({ at: end, ms: end - start });
  }
  return new Map([...samples].map(([key, values]) =>
    [key, median(values.sort((a, b) => b.at - a.at).slice(0, 20).map(value => value.ms))]));
}

function jobTiming(job, nowMs) {
  const start = timestamp(job.startedAt), queued = timestamp(job.queuedAt);
  const elapsedMs = start === null ? null : Math.max(0, nowMs - start);
  const queueEnd = job.phase === 'queued' ? nowMs : start;
  const queuedMs = queued === null || queueEnd === null ? null : Math.max(0, queueEnd - queued);
  return { ...job, queuedMs, elapsedMs, remainingMs: elapsedMs === null || job.expectedMs === null ? null : job.expectedMs - elapsedMs };
}

/** 不凭分支相似度猜卡；没有精确命中时保留 null。未知 runner 保留在 machine=null 的独立组。 */
function partitionJobs(entries, { boards = [], estimates = new Map(), mapping = runnerMapping(), nowMs }) {
  const titles = new Map();
  for (const board of boards) for (const task of Array.isArray(board?.tasks) ? board.tasks : []) {
    if (!nonempty(task?.plainTitle) || !Array.isArray(task.gitBranch)) continue;
    for (const branch of task.gitBranch) {
      const key = JSON.stringify([board.repository, branch]);
      if (nonempty(branch) && !titles.has(key)) titles.set(key, task.plainTitle);
    }
  }
  const groups = new Map(), queued = [];
  for (const { repository, run, jobs, prTitle } of entries) for (const job of jobs) {
    if (job.status !== 'in_progress' && job.status !== 'queued') continue;
    const phase = job.status === 'queued' ? 'queued' : 'running';
    const runner = phase === 'running' && nonempty(job.runner_name) ? job.runner_name : null;
    const location = (phase === 'running' && mapping.get(runner)) || { machine: null, project: null };
    const branch = nonempty(run.head_branch) ? run.head_branch : '';
    const commitTitle = run.event === 'push' && branch === 'main' && nonempty(run.head_commit?.message)
      ? run.head_commit.message.split(/\r?\n/, 1)[0] : null;
    const item = jobTiming({ id: apiId(job.id), ...(repository === undefined ? {} : { repository }), workflow: label(WORKFLOWS, run.name, '工作流名称未知'),
      job: label(JOBS, job.name, '作业名称未知'), title: prTitle || commitTitle || branch || '名称未知', branch,
      cardTitle: titles.get(JSON.stringify([repository, branch])) ?? null, phase, runner, ...location,
      startedAt: phase === 'queued' || timestamp(job.started_at) === null ? null : job.started_at,
      queuedAt: timestamp(job.created_at) !== null ? job.created_at : timestamp(run.created_at) !== null ? run.created_at : null,
      expectedMs: estimates.get(sampleKey(run.name, job.name, repository)) ?? null }, nowMs);
    if (phase === 'queued') { queued.push(item); continue; }
    if (!groups.has(location.machine)) groups.set(location.machine, []);
    groups.get(location.machine).push(item);
  }
  const machines = [...groups].map(([machine, jobs]) => ({ machine, jobs })).sort((a, b) =>
    a.machine === b.machine ? 0 : a.machine === null ? 1 : b.machine === null ? -1 : a.machine.localeCompare(b.machine));
  return { machines, queued };
}

/** 机器分组仍只含已开跑作业；未分配 runner 的排队项由快照的 queued 单独返回。 */
function groupJobs(entries, options) {
  return partitionJobs(entries, options).machines;
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
function createCiJobsMonitor({ gh = createGhApi(), now = Date.now, readBoards = async () => [],
  readRunnerMachines = async () => new Map(), runnerOverrides = {}, repositoryOverrides } = {}) {
  const states = new Map();
  let pending = null, pendingAt = null, boards = [], mapping = new Map(), readAt = null, failedAt = null, unavailable = false;

  async function jobsFor(base, run) {
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

  async function collectRepository(repository, state) {
    const base = `repos/${repository}`;
    try {
      const runs = new Map();
      for (const status of ['in_progress', 'queued']) {
        for (const run of apiList(await gh(`${base}/actions/runs?status=${status}&per_page=20`), 'workflow_runs')) {
          const id = apiId(run.id);
          if (!runs.has(id)) runs.set(id, run);
        }
      }
      const pulls = new Map();
      const entries = await mapLimited([...runs.values()], async run => {
        const jobs = await jobsFor(base, run);
        const pull = run.pull_requests?.[0];
        let prTitle = nonempty(pull?.title) ? pull.title : null;
        if (pull && !prTitle) {
          const number = apiId(pull.number);
          if (!pulls.has(number)) pulls.set(number, gh(`${base}/pulls/${number}`));
          const result = await pulls.get(number);
          prTitle = nonempty(result?.title) ? result.title : null;
        }
        return { repository, run, jobs, prTitle };
      });
      const observedAt = now();
      let history = state.history, historyAt = state.historyAt;
      // 每十分钟抽最近 100 个已完成 run，再按每组最近 20 个成功 job 取中位数。
      // 抽样是有限窗口；窗口内没有成功记录的组合保持 null，不借用别组的耗时。
      if (historyAt === null || now() - historyAt >= HISTORY_MS) {
        const completed = apiList(await gh(`${base}/actions/runs?status=completed&per_page=100`), 'workflow_runs');
        const samples = await mapLimited(completed, async run => ({ repository, run, jobs: await jobsFor(base, run) }));
        history = historicalMedians(samples);
        historyAt = now();
      }
      // 完整校验后一起替换本仓作业和样本，坏作业不能污染上一拍。
      partitionJobs(entries, { boards, mapping, estimates: history, nowMs: now() });
      Object.assign(state, { entries, history, historyAt, updatedAt: new Date(observedAt).toISOString(), staleSince: null, error: null });
    } catch (error) {
      if (error?.code === 'ENOENT') { unavailable = true; return; }
      state.staleSince ||= new Date(now()).toISOString();
      state.error = '暂时读不到检查作业';
    }
  }

  async function collect() {
    try {
      let nextBoards;
      try { nextBoards = await readBoards(); }
      catch (error) { if (repositoryOverrides === undefined) throw error; nextBoards = []; }
      const names = repositories(nextBoards, repositoryOverrides);
      let observed;
      try { observed = await readRunnerMachines(); } catch { observed = new Map(); }
      mapping = runnerMapping(runnerOverrides, observed);
      boards = nextBoards;
      for (const name of states.keys()) if (!names.includes(name)) states.delete(name);
      for (const name of names) if (!states.has(name)) {
        states.set(name, { entries: [], history: new Map(), historyAt: null, updatedAt: null, staleSince: null, error: null });
      }
      readAt = new Date(now()).toISOString(); failedAt = null; unavailable = false;
      // 单仓自己保留失败拍；其它仓继续采集，且完成后立即可从 snapshot 读取。
      await mapLimited(names.map(name => [name, states.get(name)]), ([repository, state]) => {
        state.pending ||= collectRepository(repository, state).finally(() => { state.pending = null; });
        return state.pending;
      });
    } catch {
      failedAt ||= new Date(now()).toISOString();
    }
    return snapshot();
  }

  function snapshot() {
    if (unavailable) return { unavailable: '本机没有 gh' };
    const nowMs = now(), machines = new Map(), queued = [], statuses = [];
    for (const [repository, state] of states) {
      const updated = timestamp(state.updatedAt);
      const staleSince = failedAt || state.staleSince || (updated !== null && nowMs - updated > POLL_MS * 2
        ? new Date(updated + POLL_MS * 2).toISOString() : null);
      statuses.push({ repository, updatedAt: state.updatedAt, staleSince });
      const current = partitionJobs(state.entries, { boards, mapping, estimates: state.history, nowMs });
      queued.push(...current.queued.map(job => ({ ...job, updatedAt: state.updatedAt, staleSince })));
      for (const group of current.machines) {
        if (!machines.has(group.machine)) machines.set(group.machine, []);
        machines.get(group.machine).push(...group.jobs.map(job => ({ ...job, updatedAt: state.updatedAt, staleSince })));
      }
    }
    const dates = statuses.map(status => status.updatedAt).filter(Boolean).sort();
    const staleSince = failedAt || (statuses.length && statuses.every(status => status.staleSince)
      ? statuses.map(status => status.staleSince).sort()[0] : null);
    return { machines: [...machines].map(([machine, jobs]) => ({ machine, jobs })), queued,
      updatedAt: statuses.length ? dates.at(-1) ?? null : readAt, staleSince,
      ...(statuses.length > 1 ? { repositories: statuses } : {}),
      ...(failedAt || [...states.values()].some(state => state.error) ? { error: '暂时读不到检查作业' } : {}) };
  }

  function refresh() {
    // 同一拍合并请求；下一拍只跳过仍在采集的仓库，健康仓库继续更新。
    if (!pending || now() - pendingAt >= POLL_MS) {
      pendingAt = now();
      const flight = collect().finally(() => { if (pending === flight) pending = null; });
      pending = flight;
    }
    return pending;
  }
  return { refresh, snapshot };
}

module.exports = { POLL_MS, HISTORY_MS, GH_TIMEOUT_MS, githubRepository, repositories, runnerMachines,
  runnerMapping, median, historicalMedians, groupJobs, createGhApi, createCiJobsMonitor };
