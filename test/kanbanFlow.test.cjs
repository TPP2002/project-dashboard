'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runTs(code, tz) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, ...(tz ? { TZ: tz } : {}) },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('施工排序取进度戳、开工日兜底、空值最后，同时间稳定且不改输入', () => {
  const result = runTs(`
    import { sortStalestFirst } from './web/src/utils/kanbanFlow.ts'
    const tasks = Object.freeze([
      { id: 'NONE-1', status: '施工中' },
      { id: 'SAME-1', lastProgressAt: '2026-09-08T02:00:00+08:00', dates: { start: '2026-01-01' } },
      { id: 'FALLBACK', dates: { start: '2026-09-07' } },
      { id: 'RECENT', lastProgressAt: '2026-09-08T04:00:00+08:00', dates: { start: '2025-01-01' } },
      { id: 'SAME-2', lastProgressAt: '2026-09-07T18:00:00Z' },
      { id: 'NONE-2', dates: { start: null } },
      { id: 'INVALID', lastProgressAt: 'invalid', dates: { start: '2026-09-06' } },
    ].map(task => Object.freeze(task)))
    const sorted = sortStalestFirst(tasks)
    console.log(JSON.stringify({ order: sorted.map(t => t.id), input: tasks.map(t => t.id),
      newArray: sorted !== tasks, sameObjects: sorted.every(task => tasks.includes(task)), empty: sortStalestFirst([]) }))
  `, 'Asia/Shanghai');
  assert.deepEqual(result.order, ['INVALID', 'FALLBACK', 'SAME-1', 'SAME-2', 'RECENT', 'NONE-1', 'NONE-2']);
  assert.deepEqual(result.input, ['NONE-1', 'SAME-1', 'FALLBACK', 'RECENT', 'SAME-2', 'NONE-2', 'INVALID']);
  assert.equal(result.newArray, true);
  assert.equal(result.sameObjects, true);
  assert.deepEqual(result.empty, []);
});

test('卡龄从本地零点计毫秒，未来夹为零，缺失和非法日期不给卡龄', () => {
  const result = runTs(`
    import { cardAgeMs, localDayStart } from './web/src/utils/kanbanFlow.ts'
    const now = new Date(2026, 8, 8, 3, 30).getTime()
    const starts = ['2026-09-08', '2026-09-07', '2026-09-09', null, '', 'bad', '2026-02-30', '2026-13-01']
    console.log(JSON.stringify({ ages: starts.map(start => cardAgeMs({ dates: { start } }, now)),
      missing: cardAgeMs({}, now), invalidNow: cardAgeMs({ dates: { start: '2026-09-08' } }, NaN),
      local: localDayStart('2026-09-08') === new Date(2026, 8, 8).getTime() }))
  `, 'Asia/Shanghai');
  assert.deepEqual(result.ages, [12600000, 99000000, 0, null, null, null, null, null]);
  assert.equal(result.missing, null);
  assert.equal(result.invalidNow, null);
  assert.equal(result.local, true);
});

test('本地日期跨夏令时仍按真实经过时间计龄，不把一天强算成二十四小时', () => {
  const result = runTs(`
    import { cardAgeMs } from './web/src/utils/kanbanFlow.ts'
    console.log(JSON.stringify(cardAgeMs({ dates: { start: '2026-03-08' } }, new Date(2026, 2, 9).getTime())))
  `, 'America/New_York');
  assert.equal(result, 23 * 3600000);
});

test('卡龄格式按分钟、小时、天向下取整，单位边界准确', () => {
  const result = runTs(`
    import { formatAge } from './web/src/utils/kanbanFlow.ts'
    console.log(JSON.stringify([0, 59999, 35*60000, 3599999, 3600000, 3*3600000,
      86399999, 86400000, 9*86400000, -1, NaN, Infinity].map(formatAge)))
  `);
  assert.deepEqual(result, ['0m', '0m', '35m', '59m', '1h', '3h', '23h', '1d', '9d', '0m', '0m', '0m']);
});

test('在制上限仅在超过时提醒，零表示不限', () => {
  const result = runTs(`
    import { isOverLimit } from './web/src/utils/kanbanFlow.ts'
    console.log(JSON.stringify([[0,0], [1000,0], [4,5], [5,5], [6,5], [999,999], [1000,999]].map(([n,limit]) => isOverLimit(n,limit))))
  `);
  assert.deepEqual(result, [false, false, false, false, true, false, true]);
});

test('泳道存档逐键校验，保留合法未知键，坏项丢弃且不牵入网页虚拟模块', () => {
  const result = runTs(`
    import { normalizeAppearance, defaultAppearance } from './web/src/utils/appearance.ts'
    const config = normalizeAppearance({ notify: true, wipLimits: {
      施工中: 0, 待开工: 999, 未知泳道: 7, '': 1, '  ': 2, ['x'.repeat(32)]: 3, ['x'.repeat(33)]: 4,
      小数: 1.5, 负数: -1, 越界: 1000, 字符串: '5', 布尔: true, 空值: null, 无穷: Infinity,
    } })
    const proto = normalizeAppearance(JSON.parse('{"wipLimits":{"__proto__":8,"constructor":9}}')).wipLimits
    const first = defaultAppearance(), second = defaultAppearance()
    first.wipLimits.施工中 = 99
    console.log(JSON.stringify({ limits: config.wipLimits, notify: config.notify,
      invalidBuilding: normalizeAppearance({ wipLimits: { 施工中: -1 } }).wipLimits,
      invalidRecord: [null, [], 'bad'].map(wipLimits => normalizeAppearance({ wipLimits }).wipLimits),
      defaults: second.wipLimits, proto: { own: Object.hasOwn(proto, '__proto__'), value: proto.__proto__, nullPrototype: Object.getPrototypeOf(proto) === null } }))
  `);
  assert.deepEqual(result.limits, { 施工中: 0, 待开工: 999, 未知泳道: 7, ['x'.repeat(32)]: 3 });
  assert.equal(result.notify, true);
  assert.deepEqual(result.invalidBuilding, { 施工中: 5 });
  assert.deepEqual(result.invalidRecord, [{ 施工中: 5 }, { 施工中: 5 }, { 施工中: 5 }]);
  assert.deepEqual(result.defaults, { 施工中: 5 });
  assert.deepEqual(result.proto, { own: true, value: 8, nullPrototype: true });
});
