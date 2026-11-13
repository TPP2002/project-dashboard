'use strict';
/** 额度吃紧时给看的人一句话；纯函数直接跑 tsx，不起服务、不联网。 */
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

test('放慢与暂停的说法逐字一致，分钟最少一分钟，缺省不提示', () => {
  const notes = runTs(`import { ciThrottleNote } from './web/src/components/sched/format.ts';
    const slow = { level: 'slow', intervalMs: 120000, nextAt: null, resetAt: null, remaining: 1500, limit: 5000 };
    const at = new Date(2026, 8, 14, 7, 5).toISOString();
    console.log(JSON.stringify([
      ciThrottleNote(slow, 0),
      ciThrottleNote({ ...slow, intervalMs: 300000 }, 0),
      ciThrottleNote({ ...slow, intervalMs: 20000 }, 0),
      ciThrottleNote({ ...slow, remaining: null, limit: null }, 0),
      ciThrottleNote({ ...slow, level: 'paused', nextAt: at }, 0),
      ciThrottleNote({ ...slow, level: 'paused', nextAt: null }, 0),
      ciThrottleNote(undefined, 0),
      ciThrottleNote(null, 0)]));`);
  assert.deepEqual(notes, [
    { text: 'GitHub 查询额度剩 1500/5000,检查作业改为每 2 分钟刷新', warn: false },
    { text: 'GitHub 查询额度剩 1500/5000,检查作业改为每 5 分钟刷新', warn: false },
    { text: 'GitHub 查询额度剩 1500/5000,检查作业改为每 1 分钟刷新', warn: false },
    { text: '为省 GitHub 查询额度,检查作业改为每 2 分钟刷新', warn: false },
    { text: 'GitHub 查询额度快用完了,检查作业暂停刷新,07:05 恢复', warn: true },
    { text: 'GitHub 查询额度快用完了,检查作业暂停刷新,稍后恢复', warn: true },
    null, null,
  ]);
});

test('快照校验接受合法说明与老快照，坏形状整份作废', () => {
  const result = runTs(`import { isCiJobsSnapshot } from './web/src/api/schedCiJobs.ts';
    const data = { updatedAt: '2026-09-14T10:00:00Z', staleSince: null, machines: [], queued: [] };
    const throttle = { level: 'slow', intervalMs: 120000, nextAt: null, resetAt: '2026-09-14T10:20:00Z',
      remaining: 1500, limit: 5000 };
    const valid = [data, { ...data, throttle },
      { ...data, throttle: { ...throttle, remaining: null, limit: null } },
      { ...data, throttle: { ...throttle, level: 'paused', nextAt: '2026-09-14T10:20:05Z' } }];
    const invalid = [{ ...data, throttle: null }, { ...data, throttle: { ...throttle, level: 'normal' } },
      { ...data, throttle: { ...throttle, intervalMs: 0 } }, { ...data, throttle: { ...throttle, intervalMs: -1 } },
      { ...data, throttle: { ...throttle, remaining: -1 } }, { ...data, throttle: { ...throttle, nextAt: 'bad' } },
      { ...data, throttle: { ...throttle, intervalMs: '120000' } }];
    console.log(JSON.stringify({ valid: valid.map(isCiJobsSnapshot), invalid: invalid.map(isCiJobsSnapshot) }));`);
  assert.deepEqual(result.valid, [true, true, true, true]);
  assert.deepEqual(result.invalid, [false, false, false, false, false, false, false]);
});
