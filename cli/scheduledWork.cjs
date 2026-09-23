'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { scheduledJob } = require('../core/scheduledJobs.cjs');
const { runScheduled, checkedCores } = require('../core/scheduledWork.cjs');
const { resolveSchedShare } = require('../core/settings.cjs');

function execute(job, root, cores) {
  return new Promise((resolve, reject) => {
    const child = spawn(job.command, job.args(cores), { cwd: job.cwd || root,
      env: { ...process.env, GOMAXPROCS: String(cores), UV_THREADPOOL_SIZE: String(cores) },
      stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1)));
  });
}

async function main(argv) {
  const args = [...argv];
  const granted = args[0] === '--granted';
  if (granted) args.shift();
  let root = path.resolve(__dirname, '..');
  if (args[0] === '--root') { args.shift(); root = path.resolve(args.shift()); }
  const name = args.shift(), job = scheduledJob(name, root, args);
  // GitHub 云 runner 不在本机共享算力池中；自托管 CI 仍须排队。
  if (!granted && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
    return execute(job, root, job.cores);
  }
  const share = process.env.SCHED_SHARE || resolveSchedShare();
  const file = path.join(share, 'sched', 'bin', 'sched.cjs');
  let client;
  try { client = require(file); }
  catch (error) { throw new Error(`排队客户端不可用，重活未启动：${file}；${error.message}`); }
  if (granted) {
    const cores = checkedCores(process.env.SCHED_GRANTED_CORES);
    const validation = client.validatePermit({ share, category: job.category, workTypes: [job.workType], cores });
    if (!validation.ok) throw new Error(`调度许可拒绝：${validation.reason}`);
    return execute(job, root, Math.min(cores, job.cores));
  }
  return runScheduled({ client, share, root, job, key: `dashboard-${name}-${randomUUID()}`,
    command: process.execPath, args: [__filename, '--granted', '--root', root, name, ...args] });
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(error => { console.error(error.message); process.exitCode = error.exitCode || 1; });
module.exports = { main };
