const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

const REPO_ROOT = resolve(__dirname, '..')

/** 纯取色模块经 tsx 独立加载，子进程不提供 localStorage、Vue 或 DOM。 */
function runTs(code) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  assert.equal(r.status, 0, 'tsx 子进程失败:\n' + r.stderr)
  const line = r.stdout.trim().split(/\r?\n/).pop()
  return JSON.parse(line)
}

test('hashIndex：稳定、范围正确，保留原面板的字符哈希', () => {
  const ids = ['', 'abc', 'alpha', '项目', '\u{20000}', 'z'.repeat(160)]
  const sizes = [1, 6, 17, 100000]
  const out = runTs(`
    import { hashIndex } from './web/src/utils/projectColor.ts'
    const ids = ${JSON.stringify(ids)}, sizes = ${JSON.stringify(sizes)}
    console.log(JSON.stringify(ids.map(id => sizes.map(size => [hashIndex(id, size), hashIndex(id, size)]))))
  `)
  for (const row of out) {
    row.forEach(([first, again], index) => {
      assert.equal(first, again)
      assert.ok(Number.isInteger(first) && first >= 0 && first < sizes[index])
    })
  }
  assert.equal(out[0][3][0], 0)
  assert.equal(out[1][3][0], 96354)
  assert.equal(out[4][3][0], 55360, '沿用 for...of 取码点后 charCodeAt(0) 的既有规则')
})

test('isHexColor：只接受六位十六进制字符串', () => {
  const out = runTs(`
    import { isHexColor } from './web/src/utils/projectColor.ts'
    const valid = ['#000000', '#ffffff', '#4A9eFf']
    const invalid = ['#abc', '#12345678', '123456', '#12345g', 'red', 'var(--project-blue)',
      ' #123456', '#123456 ', null, undefined, 123456, {}, ['#123456']]
    console.log(JSON.stringify({ valid: valid.map(isHexColor), invalid: invalid.map(isHexColor) }))
  `)
  assert.deepEqual(out.valid, [true, true, true])
  assert.ok(out.invalid.every(value => value === false))
})

test('pickProjectColor：本机覆盖 > registry > 固定后备色，并标明来源', () => {
  const out = runTs(`
    import { pickProjectColor } from './web/src/utils/projectColor.ts'
    const base = { projectId: 'abc', paletteIds: ['blue', 'green', 'amber'] }
    console.log(JSON.stringify([
      pickProjectColor({ ...base, override: 'green', registry: '#4A9eFf' }),
      pickProjectColor({ ...base, registry: '#4A9eFf' }),
      pickProjectColor(base),
      pickProjectColor({ ...base, registry: 'red' }),
      pickProjectColor({ ...base, registry: 123456 }),
      pickProjectColor({ ...base, override: '', registry: '#4A9eFf' }),
      pickProjectColor({ ...base, projectId: 'abd' }),
    ]))
  `)
  assert.deepEqual(out, [
    { source: 'override', value: 'var(--project-green)' },
    { source: 'registry', value: '#4A9eFf' },
    { source: 'hash', value: 'var(--project-blue)' },
    { source: 'hash', value: 'var(--project-blue)' },
    { source: 'hash', value: 'var(--project-blue)' },
    { source: 'registry', value: '#4A9eFf' },
    { source: 'hash', value: 'var(--project-green)' },
  ])
})

test('颜色插值：通道顺序、补零、四舍五入和两端值', () => {
  const out = runTs(`
    import { hexToRgb, rgbToHex, mixHex, lighten, darken } from './web/src/utils/projectColor.ts'
    console.log(JSON.stringify({
      rgb: hexToRgb('#4A9eFf'), hex: rgbToHex([1, 15, 255]), rounded: rgbToHex([0, 127.5, 255]),
      mixes: [0, .5, 1].map(t => mixHex('#123456', '#abcdef', t)),
      light: [0, 1].map(t => lighten('#4080c0', t)),
      dark: [0, 1].map(t => darken('#4080c0', t)),
    }))
  `)
  assert.deepEqual(out, {
    rgb: [74, 158, 255], hex: '#010fff', rounded: '#0080ff',
    mixes: ['#123456', '#5f81a3', '#abcdef'],
    light: ['#4080c0', '#ffffff'], dark: ['#4080c0', '#000000'],
  })
})

test('marqueeStops：五段闭环，亮部更亮、暗部更暗', () => {
  const out = runTs(`
    import { marqueeStops, hexToRgb } from './web/src/utils/projectColor.ts'
    const stops = marqueeStops('#4080c0')
    console.log(JSON.stringify({ stops, channels: stops.map(hexToRgb) }))
  `)
  assert.deepEqual(out.stops, ['#4080c0', '#79a6d3', '#4080c0', '#306090', '#4080c0'])
  assert.equal(out.stops.length, 5)
  assert.equal(out.stops[0], out.stops[4])
  out.channels[0].forEach((channel, index) => {
    assert.ok(out.channels[1][index] > channel)
    assert.ok(out.channels[3][index] < channel)
  })
})

test('resolveVarColor：实色不读取、变量去空白、空变量保留原式', () => {
  const out = runTs(`
    import { resolveVarColor } from './web/src/utils/projectColor.ts'
    const calls = []
    const read = name => { calls.push(name); return name === '--project-blue' ? '  #4a9eff  ' : '   ' }
    const values = ['#123456', 'var(--project-blue)', 'var(--missing)'].map(value => resolveVarColor(value, read))
    console.log(JSON.stringify({ values, calls }))
  `)
  assert.deepEqual(out, {
    values: ['#123456', '#4a9eff', 'var(--missing)'], calls: ['--project-blue', '--missing'],
  })
})
