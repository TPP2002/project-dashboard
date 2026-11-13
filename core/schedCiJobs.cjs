'use strict';

const { execFile } = require('node:child_process');
const POLL_MS = 30_000;
const HISTORY_MS = 10 * 60_000;
const GH_TIMEOUT_MS = 10_000;
// 额度读数一分钟一读；同一轮次明细最多复用五分钟；标题十分钟重读一次（与历史采样同节拍）。
const RATE_READ_MS = 60_000;
const LIVE_JOBS_MAX_AGE_MS = 300_000;
const PR_TITLE_MS = 10 * 60_000;
const PR_RETRY_MS = 10 * 60_000;
const PR_KEEP_MS = 60 * 60_000;
const PAUSE_MARGIN_MS = 5_000;
const PAUSE_FALLBACK_MS = 900_000;
const WORKFLOWS = Object.freeze({ MainGate: '主干守门', CI: 'PR 检查', Nightly: '夜跑' });
const JOBS = Object.freeze({ fast: '全量单测', e2e: '界面测试', 'draft-gate': '草稿闸', 'night-bot': '混沌夜跑' });
const nonempty = value => typeof value === 'string' && value.trim() !== '';
const timestamp = value => nonempty(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const sampleKey = (workflow, job, repository) => JSON.stringify(repository === undefined ? [workflow, job] : [repository, workflow, job]);
const label = (names, name, fallback) => Object.hasOwn(names, name) ? names[name] : nonempty(name) ? name : fallback;

/**
 * 按剩余额度定档：额度充足照旧 30 秒一拍，剩得少就按档放慢，见底就停到恢复时刻。
 * 读不到额度（或读数不合法）一律按 normal 走，不能因为读不到就停。
 */
function ciPollPlan({ remaining, limit, resetAt, nowMs, pausedUntil } = {}) {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  if (finite(pausedUntil) && pausedUntil > nowMs) {
    return { level: 'paused', intervalMs: pausedUntil - nowMs, nextAt: pausedUntil };
  }
  if (!finite(remaining) || !finite(limit) || limit <= 0) return { level: 'normal', intervalMs: POLL_MS, nextAt: null };
  const ratio = remaining / limit;
  if (ratio >= 0.4) return { level: 'normal', intervalMs: POLL_MS, nextAt: null };
  if (ratio >= 0.2) return { level: 'slow', intervalMs: 120_000, nextAt: null };
  if (ratio >= 0.1) return { level: 'slow', intervalMs: 300_000, nextAt: null };
  const reset = finite(resetAt) ? resetAt : timestamp(resetAt);
  const nextAt = reset === null ? nowMs + PAUSE_FALLBACK_MS : reset + PAUSE_MARGIN_MS;
  return { level: 'paused', intervalMs: nextAt - nowMs, nextAt };
}

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

/** 排队作业只有在标签、在线 runner 和已知归属都确定时才给候选机器；其余情况交给主机卡。 */
function queuedCandidates(job, runners, runnerHomes) {
  const labels = Array.isArray(job.labels) ? job.labels.filter(value => typeof value === 'string') : null;
  if (!Array.isArray(runners) || labels === null || !labels.some(value => value.toLowerCase() === 'self-hosted')) {
    return { candidateMachines: null, candidateRunners: [] };
  }
  const wanted = labels.map(value => value.toLowerCase());
  const names = [...new Set(runners.filter(runner => runner && runner.status === 'online' && nonempty(runner.name)
    && Array.isArray(runner.labels)
    && wanted.every(label => runner.labels.some(tag => typeof tag?.name === 'string' && tag.name.toLowerCase() === label)))
    .map(runner => runner.name))].sort();
  if (!names.length) return { candidateMachines: [], candidateRunners: [] };
  const homes = names.map(name => runnerHomes.get(name));
  if (!homes.every(nonempty)) return { candidateMachines: null, candidateRunners: names };
  return { candidateMachines: [...new Set(homes)].sort(), candidateRunners: names };
}

/** 不凭分支相似度猜卡；没有精确命中时保留 null。未知 runner 保留在 machine=null 的独立组。 */
function partitionJobs(entries, { boards = [], estimates = new Map(), mapping = runnerMapping(), runnerHomes = new Map(), nowMs }) {
  const titles = new Map();
  for (const board of boards) for (const task of Array.isArray(board?.tasks) ? board.tasks : []) {
    if (!nonempty(task?.plainTitle) || !Array.isArray(task.gitBranch)) continue;
    for (const branch of task.gitBranch) {
      const key = JSON.stringify([board.repository, branch]);
      if (nonempty(branch) && !titles.has(key)) titles.set(key, task.plainTitle);
    }
  }
  const groups = new Map(), queued = [];
  for (const { repository, run, jobs, runners, prTitle } of entries) for (const job of jobs) {
    if (job.status !== 'in_progress' && job.status !== 'queued') continue;
    const phase = job.status === 'queued' ? 'queued' : 'running';
    const runner = phase === 'running' && nonempty(job.runner_name) ? job.runner_name : null;
    const location = (phase === 'running' && mapping.get(runner)) || { machine: null, project: null };
    const branch = nonempty(run.head_branch) ? run.head_branch : '';
    const commitTitle = run.event === 'push' && branch === 'main' && nonempty(run.head_commit?.message)
      ? run.head_commit.message.split(/\r?\n/, 1)[0] : null;
    const candidates = phase === 'queued' ? queuedCandidates(job, runners, runnerHomes) : null;
    const item = jobTiming({ id: apiId(job.id), ...(repository === undefined ? {} : { repository }), workflow: label(WORKFLOWS, run.name, '工作流名称未知'),
      job: label(JOBS, job.name, '作业名称未知'), title: prTitle || commitTitle || branch || '名称未知', branch,
      cardTitle: titles.get(JSON.stringify([repository, branch])) ?? null, phase, runner, ...location, ...candidates,
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

/**
 * 额度读数只认 resources.core；rate_limit 接口本身不计入额度，任何失败都当读不到。
 * 不读、不打印令牌，只走 gh 自己的登录态。
 */
function readQuota() {
  return new Promise(resolve => {
    execFile('gh', ['api', 'rate_limit'], { encoding: 'utf8', windowsHide: true, timeout: GH_TIMEOUT_MS }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const core = JSON.parse(stdout)?.resources?.core;
        resolve({ remaining: core?.remaining, limit: core?.limit,
          resetAt: Number.isFinite(core?.reset) ? new Date(core.reset * 1000).toISOString() : null });
      } catch { resolve(null); }
    });
  });
}

/** 注入的读数可能是半截对象；缺的字段一律当读不到，不拿 0 冒充。 */
function rateReading(value) {
  const count = item => typeof item === 'number' && Number.isFinite(item) ? item : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { remaining: count(value.remaining), limit: count(value.limit),
    resetAt: typeof value.resetAt === 'string' && Number.isFinite(Date.parse(value.resetAt)) ? value.resetAt : null };
}

/** gh 的报错里出现限额字样就当作撞限额；其余错误照旧交给采集层标过期。 */
function rateLimited(error) {
  return /rate limit|HTTP 403|HTTP 429/i.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`);
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
function createCiJobsMonitor({ gh, now = Date.now, readBoards = async () => [],
  readRunnerMachines = async () => new Map(), runnerOverrides = {}, repositoryOverrides, concurrency = 4,
  readRateLimit } = {}) {
  const states = new Map();
  const limit = Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 16 ? concurrency : 4;
  const rawGh = gh ?? createGhApi(), waiting = [];
  // 老调用方都直接注入 gh：没给读数入口就一个额外请求都不发，额度充足时的行为与改前一致。
  const quota = typeof readRateLimit === 'function' ? readRateLimit : gh === undefined ? readQuota : async () => null;
  let inFlight = 0;
  gh = async endpoint => {
    if (inFlight >= limit) await new Promise(resolve => waiting.push(resolve));
    else inFlight++;
    try { return await rawGh(endpoint); }
    finally { if (waiting.length) waiting.shift()(); else inFlight--; }
  };
  let pending = null, pendingAt = null, pausedFlight = null;
  let boards = [], mapping = new Map(), readAt = null, failedAt = null, unavailable = false;
  let collectAt = null, pausedUntil = null, rateCache = null, rateRead = null;
  // 心跳只列正在跑活的 runner，空闲的不在里面；这里记住见过的归属，只在内存里，不写盘。
  const knownRunners = new Map();
  // PR 标题与在跑轮次的作业明细跨拍保留，同样只在内存里。
  const prTitles = new Map();

  /** 读不到额度时的档位按 normal 走；缓存过期不在这里重读，交给真正要采集的那一拍。 */
  function planAt(nowMs) {
    if (pausedUntil !== null && pausedUntil <= nowMs) pausedUntil = null;
    const reading = rateCache?.value ?? null;
    const next = ciPollPlan({ remaining: reading?.remaining, limit: reading?.limit, resetAt: reading?.resetAt, nowMs, pausedUntil });
    // 恢复时刻已经过去就不算暂停：下一拍照常采集，由新读数重新定档。
    return next.level === 'paused' && !(next.nextAt > nowMs) ? { level: 'normal', intervalMs: POLL_MS, nextAt: null } : next;
  }

  /** 额度读数缓存一分钟；并发调用共用一次读数，撞限额时可强制绕过缓存。 */
  function readRateNow(force = false) {
    const at = now();
    if (!force && rateCache && at - rateCache.at < RATE_READ_MS) return Promise.resolve(rateCache.value);
    if (rateRead) return rateRead;
    const flight = (async () => {
      let value = null;
      try { value = rateReading(await quota()); } catch { value = null; }
      rateCache = { at: now(), value };
      return value;
    })();
    rateRead = flight.finally(() => { rateRead = null; });
    return rateRead;
  }

  async function readyPlan() {
    if (!rateCache || now() - rateCache.at >= RATE_READ_MS) await readRateNow();
    return planAt(now());
  }

  /** 撞到限额：立刻绕过缓存重读一次；读得到恢复时刻就等到那一刻，读不到就保守停十五分钟。 */
  async function pauseForRateLimit() {
    const at = now();
    pausedUntil = at + PAUSE_FALLBACK_MS;
    const reading = await readRateNow(true);
    const reset = timestamp(reading?.resetAt);
    if (reset !== null && reset > at) pausedUntil = reset + PAUSE_MARGIN_MS;
  }

  async function runnerList(base) {
    try { return apiList(await gh(`${base}/actions/runners?per_page=100`), 'runners'); } catch { return null; }
  }

  async function jobsFor(base, run, attempt = null) {
    const jobs = [];
    let total;
    const path = `${base}/actions/runs/${apiId(run.id)}${attempt === null ? '' : `/attempts/${attempt}`}/jobs`;
    for (let page = 1; ; page++) {
      const data = await gh(`${path}?per_page=100&page=${page}`);
      const batch = apiList(data, 'jobs');
      if (data.total_count !== undefined && (!Number.isSafeInteger(data.total_count) || data.total_count < 0)) {
        throw new Error('检查作业分页数据不完整');
      }
      if (total !== undefined && data.total_count !== total) throw new Error('检查作业分页数据不完整');
      total = data.total_count;
      jobs.push(...batch);
      if (total !== undefined && jobs.length > total) throw new Error('检查作业分页数据不完整');
      if (jobs.length >= data.total_count || (data.total_count === undefined && batch.length < 100)) return jobs;
      if (!batch.length) throw new Error('检查作业分页数据不完整');
    }
  }

  /**
   * 同一轮次（同一 attempt）的作业明细在 updated_at 没变且不到五分钟时直接复用；
   * 变了或太旧才重取。历史采样走自己的 completed 缓存，不受这里影响。
   */
  async function liveJobs(base, run, state) {
    const key = `${apiId(run.id)}:${run.run_attempt ?? ''}`;
    const at = now();
    const cached = state.liveJobs.get(key);
    if (cached && nonempty(run.updated_at) && cached.updatedAt === run.updated_at && at - cached.fetchedAt < LIVE_JOBS_MAX_AGE_MS) {
      return cached.jobs;
    }
    const jobs = await jobsFor(base, run);
    state.liveJobs.set(key, { updatedAt: run.updated_at, jobs, fetchedAt: at });
    return jobs;
  }

  /** 标题取不到十分钟内不重试；取到的十分钟后重读一次，改名也能跟上。 */
  async function pullTitle(base, key, number) {
    const at = now();
    const cached = prTitles.get(key);
    if (cached && (cached.retryAt === null ? at - cached.fetchedAt < PR_TITLE_MS : at < cached.retryAt)) {
      cached.seenAt = at;
      return cached.title;
    }
    let title = null;
    try {
      const result = await gh(`${base}/pulls/${number}`);
      title = nonempty(result?.title) ? result.title : null;
    } catch (error) {
      if (rateLimited(error)) await pauseForRateLimit();
    }
    prTitles.set(key, { title, fetchedAt: at, retryAt: title === null ? at + PR_RETRY_MS : null, seenAt: at });
    return title;
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
        const jobs = await liveJobs(base, run, state);
        const pull = run.pull_requests?.[0];
        let prTitle = null;
        if (pull && nonempty(pull.title)) {
          // 轮次里自带的标题优先，顺手刷新缓存，改名立即生效；没有编号也照旧可用。
          prTitle = pull.title;
          if (Number.isSafeInteger(pull.number) && pull.number > 0) {
            const key = `${repository}#${pull.number}`;
            prTitles.set(key, { title: prTitle, fetchedAt: now(), retryAt: null, seenAt: now() });
          }
        } else if (pull) {
          const number = apiId(pull.number);
          const key = `${repository}#${number}`;
          // 同一拍里同一 PR 只发一次；跨拍由 prTitles 兜住。
          if (!pulls.has(key)) pulls.set(key, pullTitle(base, key, number));
          prTitle = await pulls.get(key);
        }
        return { repository, run, jobs, prTitle };
      });
      // 本拍轮次清单里没有的作业明细、一小时没再出现的标题都要回收，缓存不能只增不减。
      const live = new Set(entries.map(entry => `${apiId(entry.run.id)}:${entry.run.run_attempt ?? ''}`));
      for (const key of state.liveJobs.keys()) if (!live.has(key)) state.liveJobs.delete(key);
      const seenAt = now();
      for (const [key, entry] of prTitles) {
        if (key.startsWith(`${repository}#`) && seenAt - entry.seenAt >= PR_KEEP_MS) prTitles.delete(key);
      }
      // 有排队作业才读 runner 清单；读不到就当没有候选，不污染整仓的成败。
      const runners = entries.some(entry => entry.jobs.some(job => job.status === 'queued')) ? await runnerList(base) : null;
      for (const entry of entries) entry.runners = runners;
      const observedAt = now();
      let history = state.history, historyAt = state.historyAt;
      // 每十分钟抽最近 100 个已完成 run，再按每组最近 20 个成功 job 取中位数。
      // 抽样是有限窗口；窗口内没有成功记录的组合保持 null，不借用别组的耗时。
      if (historyAt === null || now() - historyAt >= HISTORY_MS) {
        const completed = apiList(await gh(`${base}/actions/runs?status=completed&per_page=100`), 'workflow_runs');
        // 每仓只保留最近100条窗口。attempt缺失时照常读取，但不以“默认第1次”冒充身份。
        const keyOf = run => run.status === 'completed' && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0
          ? `${apiId(run.id)}:${run.run_attempt}` : null;
        const window = new Set(completed.slice(0, 100).map(keyOf).filter(Boolean));
        for (const key of state.completedJobs.keys()) if (!window.has(key)) state.completedJobs.delete(key);
        const samples = await mapLimited(completed, async run => {
          const key = keyOf(run);
          let jobs = key === null ? undefined : state.completedJobs.get(key);
          if (jobs === undefined) {
            jobs = await jobsFor(base, run, key === null ? null : run.run_attempt);
            // 分页全部完成后才保存；后续别的run失败不丢掉已经完整取回的这条。
            if (key !== null && window.has(key) && jobs.every(job => job.status === 'completed')) {
              state.completedJobs.set(key, jobs);
            }
          }
          return { repository, run, jobs };
        });
        history = historicalMedians(samples);
        historyAt = now();
      }
      // 完整校验后一起替换本仓作业和样本，坏作业不能污染上一拍。
      partitionJobs(entries, { boards, mapping, runnerHomes: knownRunners, estimates: history, nowMs: now() });
      Object.assign(state, { entries, history, historyAt, updatedAt: new Date(observedAt).toISOString(), staleSince: null, error: null,
        idleTicks: runs.size ? 0 : 3 });
    } catch (error) {
      if (error?.code === 'ENOENT') { unavailable = true; return; }
      // 撞到限额就先停到恢复时刻，本仓照旧记过期与错误，别把旧数据当成新拍的。
      if (rateLimited(error)) await pauseForRateLimit();
      state.staleSince ||= new Date(now()).toISOString();
      state.error = '暂时读不到检查作业';
    }
  }

  async function collect({ paused = false } = {}) {
    try {
      let nextBoards;
      try { nextBoards = await readBoards(); }
      catch (error) { if (repositoryOverrides === undefined) throw error; nextBoards = []; }
      const names = repositories(nextBoards, repositoryOverrides);
      let observed;
      try { observed = await readRunnerMachines(); } catch { observed = new Map(); }
      mapping = runnerMapping(runnerOverrides, observed);
      for (const [runner, home] of mapping) {
        if (nonempty(home.machine)) knownRunners.set(runner, home.machine);
        else knownRunners.delete(runner);
      }
      boards = nextBoards;
      for (const name of states.keys()) if (!names.includes(name)) states.delete(name);
      for (const name of names) if (!states.has(name)) {
        states.set(name, { entries: [], history: new Map(), completedJobs: new Map(), liveJobs: new Map(),
          historyAt: null, updatedAt: null, staleSince: null, error: null, idleTicks: 0 });
      }
      readAt = new Date(now()).toISOString(); failedAt = null; unavailable = false;
      // 单仓自己保留失败拍；其它仓继续采集，且完成后立即可从 snapshot 读取。
      await mapLimited(names.map(name => [name, states.get(name)]), ([repository, state]) => {
        // 暂停拍只刷新仓库清单与时间戳，一个作业都不查；没有仓库时页面也知道这一拍看过了。
        if (paused) return;
        if (!state.pending && state.idleTicks > 0) { state.idleTicks--; return; }
        state.pending ||= collectRepository(repository, state).finally(() => { state.pending = null; });
        return state.pending;
      });
    } catch {
      failedAt ||= new Date(now()).toISOString();
    }
    return snapshot();
  }

  /** 放慢或暂停时告诉页面为什么刷得慢；数字只给整数，时间转成 ISO。 */
  function throttleOf(plan, reading) {
    const count = value => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
    return { level: plan.level, intervalMs: plan.intervalMs,
      nextAt: plan.nextAt === null ? null : new Date(plan.nextAt).toISOString(),
      remaining: count(reading?.remaining), limit: count(reading?.limit),
      resetAt: typeof reading?.resetAt === 'string' ? reading.resetAt : null };
  }

  function snapshot() {
    if (unavailable) return { unavailable: '本机没有 gh' };
    const nowMs = now(), plan = planAt(nowMs), window = plan.intervalMs * 2;
    const throttle = plan.level === 'normal' ? null : throttleOf(plan, rateCache?.value ?? null);
    const machines = new Map(), queued = [], statuses = [];
    for (const [repository, state] of states) {
      const updated = timestamp(state.updatedAt);
      // 判过期的宽限期跟着当前档位走：放慢档下数据旧一点是预期，不冒充过期。
      const staleSince = failedAt || state.staleSince || (updated !== null && nowMs - updated > window
        ? new Date(updated + window).toISOString() : null);
      statuses.push({ repository, updatedAt: state.updatedAt, staleSince });
      const current = partitionJobs(state.entries, { boards, mapping, runnerHomes: knownRunners, estimates: state.history, nowMs });
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
      ...(throttle ? { throttle } : {}),
      ...(failedAt || [...states.values()].some(state => state.error) ? { error: '暂时读不到检查作业' } : {}) };
  }

  function start(nowMs) {
    pendingAt = nowMs;
    const flight = (async () => {
      // 第一拍还不知道额度：先读一次再定档，别白跑一整轮。
      const plan = await readyPlan(), at = now();
      if (plan.level === 'paused' && at < plan.nextAt) return collect({ paused: true });
      if (plan.level === 'slow' && collectAt !== null && at - collectAt < plan.intervalMs) return snapshot();
      collectAt = at;
      return collect();
    })().finally(() => { if (pending === flight) pending = null; });
    pending = flight;
    return flight;
  }

  function refresh() {
    // normal 档的门控与改前逐字一致；slow 拉开间隔，paused 不查作业、只刷新清单与时间戳。
    // 一律回 Promise：调用方会对返回值挂 catch。
    const at = now(), plan = planAt(at);
    if (plan.level === 'paused') {
      if (at >= plan.nextAt) return start(at);
      if (pausedFlight) return pausedFlight;
      const flight = collect({ paused: true }).finally(() => { if (pausedFlight === flight) pausedFlight = null; });
      pausedFlight = flight;
      return flight;
    }
    if (plan.level === 'slow') {
      if (pending) return pending;
      return collectAt !== null && at - collectAt < plan.intervalMs ? Promise.resolve(snapshot()) : start(at);
    }
    if (!pending || at - pendingAt >= POLL_MS) return start(at);
    return pending;
  }
  return { refresh, snapshot };
}

module.exports = { POLL_MS, HISTORY_MS, GH_TIMEOUT_MS, RATE_READ_MS, LIVE_JOBS_MAX_AGE_MS, ciPollPlan,
  githubRepository, repositories, runnerMachines, runnerMapping, median, historicalMedians, groupJobs,
  createGhApi, createCiJobsMonitor };
