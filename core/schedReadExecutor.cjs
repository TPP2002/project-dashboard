'use strict';
/** One reusable read-only worker; only unfinished reads are shared. No response cache. */
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const MAX_PENDING = 16, MAX_WAITERS = 128, IDLE_MS = 10 * 60 * 1000, READ_TIMEOUT_MS = 60000;
const WORKER_FILE = path.join(__dirname, '../server/schedReadWorker.cjs');
const cancelled = () => Object.assign(new Error('调度读取已取消'), { name: 'AbortError' });

function createSchedReadExecutor({ maxPending = MAX_PENDING, maxWaiters = MAX_WAITERS, idleMs = IDLE_MS, timeoutMs = READ_TIMEOUT_MS,
  workerFactory = () => new Worker(WORKER_FILE) } = {}) {
  for (const [name, value] of Object.entries({ maxPending, maxWaiters, idleMs, timeoutMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`非法调度读取上限:${name}`);
  }
  if (timeoutMs > READ_TIMEOUT_MS) throw new Error('调度读取期限不能超过60秒');
  const jobs = new Map(), queue = [];
  let worker = null, retiring = null, active = null, waiters = 0, sequence = 0;
  let idleTimer = null, closed = false, closing, retirementError;

  function clearIdle() { if (idleTimer !== null) clearTimeout(idleTimer); idleTimer = null; }
  function settle(job, error, value) {
    clearTimeout(job.timer);
    jobs.delete(job.key);
    for (const waiter of job.waiters) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiters--;
      if (error) waiter.reject(error); else waiter.resolve(value);
    }
    job.waiters.clear();
  }
  function failJobs(error) {
    const failed = [...jobs.values()];
    active = null; queue.length = 0;
    for (const job of failed) settle(job, error);
  }
  // Wait for actual termination before another worker can be constructed.
  function retire(holder) {
    clearIdle();
    worker = null; retiring = holder;
    holder.done = holder.thread.terminate().then(() => {
      holder.thread.removeListener('message', holder.message);
      holder.thread.removeListener('error', holder.error);
      holder.thread.removeListener('messageerror', holder.messageError);
      holder.thread.removeListener('exit', holder.exit);
      retiring = null;
      pump();
    }, error => {
      // Failed termination cannot authorize a replacement thread. Keep the executor closed
      // and surface the failure to close(), rather than risk two concurrent readers.
      retirementError = error; closed = true; failJobs(error);
    });
    return holder.done;
  }
  function workerFailed(holder, error) {
    if (worker !== holder) return;
    retire(holder);
    failJobs(error);
  }
  function armIdle() {
    if (!worker || active || queue.length || closed || idleTimer !== null) return;
    worker.thread.unref();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (worker && !active && !queue.length) retire(worker);
    }, idleMs);
    idleTimer.unref();
  }
  function startWorker(share) {
    const holder = { thread: workerFactory(), share };
    holder.message = message => {
      if (worker !== holder) return;
      if (!active || !message || message.id !== active.id || typeof message.ok !== 'boolean'
        || (!message.ok && typeof message.error?.message !== 'string')) {
        workerFailed(holder, new Error('调度读取工作线程返回无效消息')); return;
      }
      const job = active;
      active = null;
      if (message.ok) settle(job, null, message.value);
      else {
        const error = new Error(message.error.message);
        for (const field of ['name', 'code', 'status']) {
          if (message.error[field] !== undefined) error[field] = message.error[field];
        }
        settle(job, error);
      }
      pump();
    };
    holder.error = error => workerFailed(holder, error);
    holder.messageError = error => workerFailed(holder, error);
    holder.exit = code => workerFailed(holder, new Error(`调度读取工作线程已退出:${code}`));
    worker = holder;
    holder.thread.on('message', holder.message);
    holder.thread.on('error', holder.error);
    holder.thread.on('messageerror', holder.messageError);
    holder.thread.on('exit', holder.exit);
    return holder;
  }
  function pump() {
    if (closed || active || retiring) return;
    if (!queue.length) { armIdle(); return; }
    clearIdle();
    try {
      if (worker && worker.share !== queue[0].request.share) { retire(worker); return; }
      const holder = worker || startWorker(queue[0].request.share);
      active = queue.shift();
      const job = active;
      job.timer = setTimeout(() => {
        if (worker === holder && active === job) workerFailed(holder, new Error('调度读取超时'));
      }, timeoutMs);
      job.timer.unref();
      holder.thread.ref();
      holder.thread.postMessage({ id: active.id, ...active.request });
    } catch (error) {
      if (worker) workerFailed(worker, error);
      else failJobs(error);
    }
  }
  function run(request, { signal } = {}) {
    if (closed) return Promise.reject(new Error('调度读取已关闭'));
    if (signal?.aborted) return Promise.reject(cancelled());
    if (waiters >= maxWaiters) return Promise.reject(new Error('调度读取等待人数已满'));
    // Freeze inputs before queueing. Sorting query keys also merges reordered URL parameters.
    const { action, share, query: inputQuery = {}, nowMs } = request;
    const copy = { action, share, query: structuredClone(inputQuery), nowMs };
    const query = copy.query || {};
    const key = JSON.stringify([copy.share, copy.action, Object.keys(query).sort().map(name => [name, query[name]])]);
    let job = jobs.get(key);
    if (!job && jobs.size >= maxPending) return Promise.reject(new Error('调度读取队列已满'));
    if (!job) {
      job = { key, id: ++sequence, request: copy, waiters: new Set() };
      jobs.set(key, job); queue.push(job);
    }
    const promise = new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      waiter.abort = () => {
        if (!job.waiters.delete(waiter)) return;
        signal.removeEventListener('abort', waiter.abort); waiters--;
        // An executing synchronous read cannot be interrupted individually. Keep just its
        // bounded descriptor (no HTTP waiters), allowing a later identical read to join it.
        if (job !== active && !job.waiters.size) {
          jobs.delete(key); queue.splice(queue.indexOf(job), 1);
        }
        reject(cancelled());
      };
      job.waiters.add(waiter); waiters++;
      signal?.addEventListener('abort', waiter.abort, { once: true });
    });
    pump();
    return promise;
  }
  function close() {
    if (closing) return closing;
    closed = true; clearIdle();
    failJobs(new Error('调度读取已关闭'));
    const stopped = worker ? retire(worker) : retiring?.done || Promise.resolve();
    closing = stopped.then(() => { if (retirementError) throw retirementError; });
    return closing;
  }
  function sweep(share) {
    if (worker && !active && !queue.length && worker.share !== share) retire(worker);
  }
  return { run, close, sweep, stats: () => ({ closed, workers: worker || retiring ? 1 : 0,
    threadId: worker?.thread.threadId ?? null, active: active ? 1 : 0, queued: queue.length,
    pending: jobs.size, waiters, idleTimer: idleTimer !== null, maxPending, maxWaiters, idleMs, timeoutMs }) };
}

module.exports = { createSchedReadExecutor, MAX_PENDING, MAX_WAITERS, IDLE_MS, READ_TIMEOUT_MS };
