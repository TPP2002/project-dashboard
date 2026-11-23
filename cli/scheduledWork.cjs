'use strict';
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { scheduledJob } = require('../core/scheduledJobs.cjs');
const { runScheduled, checkedCores, inheritedPermit } = require('../core/scheduledWork.cjs');
const { resolveSchedShare } = require('../core/settings.cjs');
const {
  sweepStaleRunRoots, createRunRoot, tempEnv, removeRunRoot,
} = require('../core/testTempRoot.cjs');

function execute(job, root, cores) {
  return new Promise((resolve, reject) => {
    // 本轮临时根：测试在系统临时文件夹里建的东西都落在它下面，跑完整个删掉（TEMP-LEAK-DASH-1123）。
    const base = os.tmpdir();
    for (const leftover of sweepStaleRunRoots(base)) {
      console.error(`[temp-root] 旧残留没删掉:${leftover.path} ${leftover.error}`);
    }
    const runRoot = createRunRoot(base);
    const cleanup = () => {
      const result = removeRunRoot(runRoot);
      if (!result.removed) console.error(`[temp-root] 本轮临时根没删掉:${runRoot} ${result.error}`);
    };
    const child = spawn(job.command, job.args(cores), { cwd: job.cwd || root,
      env: tempEnv({
        ...process.env,
        GOMAXPROCS: String(cores),
        UV_THREADPOOL_SIZE: String(cores),
      }, runRoot),
      stdio: 'inherit', windowsHide: true });
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal ? 130 : 1)); });
  });
}

async function main(argv, deps = {}) {
  const env = deps.env || process.env;
  const run = deps.execute || execute;
  const args = [...argv];
  const granted = args[0] === '--granted';
  if (granted) args.shift();
  let root = path.resolve(__dirname, '..');
  if (args[0] === '--root') { args.shift(); root = path.resolve(args.shift()); }
  const name = args.shift(), job = scheduledJob(name, root, args);
  // GitHub 云 runner 不在本机共享算力池中；自托管 CI 仍须排队。
  if (!granted && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted') {
    return run(job, root, job.cores);
  }
  const share = env.SCHED_SHARE || resolveSchedShare();
  const file = path.join(share, 'sched', 'bin', 'sched.cjs');
  let client = deps.client;
  if (!client) {
    try { client = require(file); }
    catch (error) { throw new Error(`排队客户端不可用，重活未启动：${file}；${error.message}`); }
  }
  if (granted) {
    const cores = checkedCores(env.SCHED_GRANTED_CORES);
    const validation = client.validatePermit({ share, category: job.category, workTypes: [job.workType], cores });
    if (!validation.ok) throw new Error(`调度许可拒绝：${validation.reason}`);
    return run(job, root, Math.min(cores, job.cores));
  }
  // 不带 --granted、也不是云 runner：先看环境里有没有对得上这件活的外层许可，有就沿用直接开跑。
  const inherited = inheritedPermit({ client, share, env, job });
  if (inherited && inherited.ok) {
    console.error(`沿用外层调度许可 ${inherited.ticketId},不再排队`);
    return run(job, root, inherited.cores);
  }
  if (inherited && !inherited.ok) {
    console.error(`外层调度许可不适用(${inherited.reason}),照常挂号`);
  }
  return runScheduled({ client, share, root, job, key: `dashboard-${name}-${randomUUID()}`,
    command: process.execPath, args: [__filename, '--granted', '--root', root, name, ...args] });
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(error => { console.error(error.message); process.exitCode = error.exitCode || 1; });
module.exports = { main, execute };
