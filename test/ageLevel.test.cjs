'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runTs(code) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('默认卡龄阈值为分钟，三个档位均在达到阈值时切换', () => {
  const result = runTs(`
    import { ageLevel, ageTone, DEFAULT_AGE_THRESHOLDS } from './web/src/utils/ageLevel.ts'
    const elapsed = [0, 3599999, 3600000, 3600001, 14399999, 14400000, 14400001, 86399999, 86400000, 86400001]
    console.log(JSON.stringify({ thresholds: DEFAULT_AGE_THRESHOLDS, levels: elapsed.map(ms => ageLevel(ms)),
      tones: [0, 1, 2, 3].map(level => ageTone(level)) }))
  `);
  assert.deepEqual(result.thresholds, [60, 240, 1440]);
  assert.deepEqual(result.levels, [0, 0, 1, 1, 1, 2, 2, 2, 3, 3]);
  assert.deepEqual(result.tones, ['n', 'info', 'warn', 'bad']);
});

test('非有限数和负数按新鲜处理，合法极大值仍为第三档', () => {
  const result = runTs(`
    import { ageLevel } from './web/src/utils/ageLevel.ts'
    console.log(JSON.stringify([NaN, Infinity, -Infinity, -1, -0.1, -0, Number.MAX_VALUE].map(ms => ageLevel(ms))))
  `);
  assert.deepEqual(result, [0, 0, 0, 0, 0, 0, 3]);
});

test('自定义阈值按分钟换算，支持只读数组且不修改调用方输入', () => {
  const result = runTs(`
    import { ageLevel } from './web/src/utils/ageLevel.ts'
    const thresholds = Object.freeze([1, 2, 3])
    console.log(JSON.stringify({ levels: [59999, 60000, 119999, 120000, 179999, 180000].map(ms => ageLevel(ms, thresholds)), thresholds }))
  `);
  assert.deepEqual(result, { levels: [0, 1, 1, 2, 2, 3], thresholds: [1, 2, 3] });
});

test('卡龄存档任一档非法就整组回默认，合法设置与其它字段保留', () => {
  const result = runTs(`
    import { normalizeAppearance, defaultAppearance } from './web/src/utils/appearance.ts'
    const invalid = [null, [], [60, 240], [60, 240, 1440, 2000], [0, 240, 1440], [-1, 240, 1440],
      [60, 60, 1440], [300, 240, 1440], [60.5, 240, 1440], ['60', 240, 1440], [60, 240, 525601], [NaN, 240, 1440], [60, Infinity, 1440]]
    const valid = normalizeAppearance({ ageThresholds: [1, 5, 525600], notify: true,
      notifyEvents: { pending: false, done: 'yes', block: false }, quietStart: '12:30' })
    const defaults = defaultAppearance()
    const second = defaultAppearance()
    defaults.ageThresholds[0] = 1
    defaults.notifyEvents.pending = false
    console.log(JSON.stringify({ invalid: invalid.map(ageThresholds => normalizeAppearance({ ageThresholds }).ageThresholds),
      valid: { ages: valid.ageThresholds, notify: valid.notify, events: valid.notifyEvents, quiet: valid.quietStart },
      defaults: { ages: second.ageThresholds, notify: second.notify, events: second.notifyEvents },
      badNotify: normalizeAppearance({ notify: 'true', notifyEvents: [] }).notify }))
  `);
  for (const value of result.invalid) assert.deepEqual(value, [60, 240, 1440]);
  assert.deepEqual(result.valid, { ages: [1, 5, 525600], notify: true, events: { pending: false, done: true, block: false }, quiet: '12:30' });
  assert.deepEqual(result.defaults, { ages: [60, 240, 1440], notify: false, events: { pending: true, done: true, block: true } });
  assert.equal(result.badNotify, false);
});
