'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { contained } = require('./objects.cjs');
const domain = () => require('../sched/sched-rerun.js');
const timingConfig = 'scripts/sched/test-timing/vitest.sched-timing.config.ts';
async function prepare(command, job, directory) {
  if (job.auto || !domain().RERUN_WORK_TYPES.includes(job.kind)) return null;
  try { await contained(command.cwd, timingConfig); }
  catch (error) { if (error.code === 'ENOENT' && !job.rerun) return null; throw error; }
  const root = path.join(directory, 'timing'); await fs.mkdir(root);
  const report = path.join(root, 'timing.jsonl');
  const words = command.words ?? command.args;
  words.push('--config', timingConfig); command.env.UDQ_TIMING_OUT = report;
  if (job.rerun) {
    const selection = path.join(root, 'selection.json');
    await fs.writeFile(selection, JSON.stringify(job.rerun.selection), { flag: 'wx' }); command.env.UDQ_SELECTION = selection;
  }
  return report;
}
async function collect(report, suspension) {
  try {
    const rows = domain().parseTimingReport(await fs.readFile(report, 'utf8'));
    const plan = domain().planSuspendRerun(rows, { intervals: suspension.intervals ?? [], slowIntervals: suspension.slowIntervals ?? [] });
    return { complete: plan.complete, eligible: plan.eligible.map(({ identity, sourceSha256, overlapMs }) => ({ identity, sourceSha256, overlapMs })),
      slowTimeouts: plan.slowTimeouts.length, otherTimeouts: plan.otherTimeouts.length, retainedFailures: plan.retainedFailures,
      sharedHookTimeouts: plan.sharedHookTimeouts, notes: plan.notes };
  } catch (error) { return { complete: false, eligible: [], slowTimeouts: 0, otherTimeouts: 0, retainedFailures: 0,
    sharedHookTimeouts: 0, notes: [`计时报告缺失或损坏:${error.message}`] }; }
}
module.exports = { prepare, collect };
