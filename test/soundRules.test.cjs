'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..');

/** 与派单参数测试一样经 tsx 子进程导入纯规则，不加载 Vue、存档或音频设备。 */
function runTs(code) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    'import { inQuietHours, shouldThrottle, toGain } from "./web/src/utils/soundRules.ts";\n' + code], {
    cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  assert.equal(result.status, 0, 'tsx 子进程失败:\n' + result.stderr);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
}

test('同日静音时段含起点、不含终点', () => {
  const out = runTs('console.log(JSON.stringify(["08:59", "09:00", "12:30", "16:59", "17:00", "23:00"]'
    + '.map(hm => inQuietHours(hm, "09:00", "17:00"))))');
  assert.deepEqual(out, [false, true, true, true, false, false]);
});

test('跨午夜静音覆盖夜间和清晨，边界仍为左闭右开', () => {
  const out = runTs('console.log(JSON.stringify(["22:29", "22:30", "23:00", "00:00", "07:00", "08:29", "08:30", "09:00"]'
    + '.map(hm => inQuietHours(hm, "22:30", "08:30"))))');
  assert.deepEqual(out, [false, true, true, true, true, true, false, false]);
});

test('起止相同表示不静音，午夜边界不会变成全天静音', () => {
  const out = runTs('console.log(JSON.stringify(['
    + 'inQuietHours("00:00", "00:00", "00:00"), inQuietHours("12:00", "12:00", "12:00"),'
    + 'inQuietHours("23:59", "12:00", "12:00"), inQuietHours("23:59", "23:00", "00:00"),'
    + 'inQuietHours("00:00", "23:00", "00:00")]))');
  assert.deepEqual(out, [false, false, false, true, false]);
});

test('同一 cue 一秒内限频；首次、刚好一秒及自定义窗口的边界可区分', () => {
  const out = runTs('console.log(JSON.stringify(['
    + 'shouldThrottle(undefined, 0), shouldThrottle(0, 0), shouldThrottle(0, 999),'
    + 'shouldThrottle(0, 1000), shouldThrottle(0, 1001), shouldThrottle(500, 749, 250),'
    + 'shouldThrottle(500, 750, 250), shouldThrottle(5, 5, 0)]))');
  assert.deepEqual(out, [false, true, true, false, false, true, false, false]);
});

test('音量限制在 0 到 100，主增益最大为 0.6', () => {
  const out = runTs('console.log(JSON.stringify([-50, 0, 35, 50, 100, 150].map(toGain)))');
  assert.deepEqual(out, [0, 0, 0.21, 0.3, 0.6, 0.6]);
});
