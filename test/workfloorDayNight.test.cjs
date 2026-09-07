const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const HOURS = [0, 5, 5.999, 6, 6.001, 12, 17, 17.999, 18, 18.001, 23]

function runTs(code) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { resolveDayNight } = await import('./web/src/workfloor/daynight.ts');
    ${code}
  `], { cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve(ROOT, 'web/tsconfig.json') } })
  assert.equal(result.status, 0, '昼夜子进程失败:\n' + result.stderr)
  return JSON.parse(result.stdout.trim())
}

for (const setting of ['theme', 'night', 'clock']) {
  test(`昼夜 ${setting}：两个实际主题与全部边界小时`, () => {
    const cases = ['light', 'dark'].flatMap(theme => HOURS.map(hour => ({ setting, theme, hour })))
    const actual = runTs(`console.log(JSON.stringify(${JSON.stringify(cases)}.map(({setting,theme,hour}) => resolveDayNight(setting,theme,hour))));`)
    const clock = ['night', 'night', 'night', 'day', 'day', 'day', 'day', 'day', 'night', 'night', 'night']
    const expected = setting === 'night' ? cases.map(() => 'night')
      : setting === 'theme' ? [...HOURS.map(() => 'day'), ...HOURS.map(() => 'night')] : [...clock, ...clock]
    assert.deepEqual(actual, expected)
  })
}

test('主题连续切换即时解析，钉死夜景不受主题与时钟影响', () => {
  assert.deepEqual(runTs(`console.log(JSON.stringify([
    resolveDayNight('theme','light',12), resolveDayNight('theme','dark',12), resolveDayNight('theme','light',12),
    resolveDayNight('night','light',6), resolveDayNight('night','dark',18)
  ]));`), ['day', 'night', 'day', 'night', 'night'])
})

test('昼夜过渡为 600 毫秒，途中反向连续，减少动效直接落位', () => {
  const actual = runTs(`
    const { createPaletteTransition } = await import('./web/src/workfloor/paletteTransition.ts');
    const values=[]; const light=createPaletteTransition('night',false,value=>values.push(value));
    light.setDayNight('day'); light.tick(300); const middle=light.daylight;
    light.tick(299); const beforeEnd=light.daylight; light.tick(1); const end=light.daylight;
    light.setDayNight('night'); light.tick(300); const reverseStart=light.daylight;
    light.setDayNight('day'); const continuous=light.daylight;
    light.setReducedMotion(true); const stationary=light.daylight;
    light.setDayNight('night'); light.tick(600);
    console.log(JSON.stringify({initial:values[0],middle,beforeEnd,end,reverseStart,continuous,stationary,last:light.daylight}));
  `)
  assert.equal(actual.initial, 0)
  assert.equal(actual.middle, .5)
  assert.ok(actual.beforeEnd > .99 && actual.beforeEnd < 1)
  assert.equal(actual.end, 1)
  assert.equal(actual.reverseStart, .5)
  assert.equal(actual.continuous, actual.reverseStart)
  assert.equal(actual.stationary, 1)
  assert.equal(actual.last, 0)
})
