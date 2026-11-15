'use strict';
/** reconcile-schedule —— 装/卸/看「每 N 小时静默对账」的 Windows 计划任务。逻辑在 core/reconcileSchedule.cjs。 */
const path = require('node:path');
const svc = require('../core/reconcileSchedule.cjs');

function reconcileSchedule(flags, deps = {}) {
  const sub = flags._ && flags._[0];
  if (!['install', 'uninstall', 'status'].includes(sub)) {
    process.stderr.write('✖ reconcile-schedule 需要子命令 install | uninstall | status\n');
    (deps.exit || process.exit)(2);
    return { ok: false, text: '缺参数:需要 install | uninstall | status' };
  }
  const opts = {};
  if (flags.registry && flags.registry !== true) opts.registryPath = path.resolve(String(flags.registry));
  if (flags['task-name'] && flags['task-name'] !== true) opts.taskName = String(flags['task-name']);
  if (deps.run) opts.run = deps.run;
  if (deps.platform) opts.platform = deps.platform;
  if (sub === 'install') {
    if (flags['every-hours'] !== undefined) {
      opts.everyHours = flags['every-hours'] === true ? NaN : Number(flags['every-hours']);
    }
    return svc.install(opts);
  }
  if (sub === 'uninstall') return svc.uninstall(opts);
  return svc.status(opts);
}

module.exports = { reconcileSchedule };
