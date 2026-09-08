const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

const REPO_ROOT = resolve(__dirname, '..')

function runTs(code) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  assert.equal(r.status, 0, 'tsx 子进程失败:\n' + (r.error?.message || r.stderr))
  const lines = r.stdout.trim().split(/\r?\n/)
  assert.equal(lines.length, 1, 'stdout 只准输出一行 JSON')
  return JSON.parse(lines[0])
}

// 只替换外部 IO：已安装/未安装的机器都走相同分支，不读工单，也不开真实窗格。
// 用当前 Node 路径满足「存在的文件」契约；所有进程调用均被截获，不会执行它。
function herdr(expression, { installed = true, running = true } = {}) {
  return runTs(`
    import fs from 'node:fs'
    import childProcess from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    import { resolveHerdrBin, probeHerdr, openWatchPane } from './scripts/codex/codex-herdr.ts'
    const bin = process.execPath
    process.env.HERDR_BIN = bin
    const checked = [], calls = [], diagnostics = []
    fs.existsSync = file => { checked.push(String(file)); return ${installed} && file === bin }
    childProcess.spawnSync = (command, args) => {
      calls.push({ command, args })
      if (command === bin && args.length === 1 && args[0] === 'status') {
        return { status: 0, stdout: ${JSON.stringify(running ? 'status: running\n' : 'status: stopped\n')}, stderr: '' }
      }
      if ((command === 'where' || command === 'which') && args.length === 1 && args[0] === 'herdr') {
        return { status: 1, stdout: '', stderr: '' }
      }
      throw new Error('测试禁止启动外部进程: ' + command + ' ' + args.join(' '))
    }
    syncBuiltinESMExports()
    const write = process.stdout.write
    let result
    try {
      process.stdout.write = chunk => { diagnostics.push(String(chunk)); return true }
      result = ${expression}
    } finally { process.stdout.write = write }
    console.log(JSON.stringify({ result, bin, checked, calls, diagnostics }))
  `)
}

test('resolveHerdrBin：存在的环境变量路径原样返回', () => {
  const out = herdr('resolveHerdrBin()')
  assert.equal(resolve(out.result), resolve(process.execPath))
  assert.ok(existsSync(out.result))
  assert.deepEqual(out.calls, [])
})

test('resolveHerdrBin：环境变量、搜索路径和回落路径都不存在则为 null', () => {
  const out = herdr('resolveHerdrBin()', { installed: false })
  assert.equal(out.result, null)
  assert.deepEqual(out.calls, [{ command: process.platform === 'win32' ? 'where' : 'which', args: ['herdr'] }])
})

for (const scenario of [
  { name: '未安装', installed: false, running: false },
  { name: '已安装未启动', installed: true, running: false },
  { name: '服务已启动', installed: true, running: true },
]) {
  test('probeHerdr：' + scenario.name + '也给齐三个字段和非空提示', () => {
    const out = herdr('probeHerdr()', scenario)
    assert.deepEqual(Object.keys(out.result).sort(), ['bin', 'hint', 'serverRunning'])
    assert.equal(out.result.serverRunning, scenario.running)
    assert.equal(typeof out.result.hint, 'string')
    assert.ok(out.result.hint.trim().length > 0)
    if (scenario.installed) {
      assert.equal(resolve(out.result.bin), resolve(out.bin))
      assert.deepEqual(out.calls, [{ command: out.bin, args: ['status'] }])
    } else {
      assert.equal(out.result.bin, null)
      assert.match(out.result.hint, /没装.*不影响派单/)
    }
  })
}

test('openWatchPane：不存在的工单返回 null，不创建标签页', () => {
  const slug = 'missing-herdr-unit-test'
  const out = herdr(`openWatchPane(${JSON.stringify(slug)})`)
  assert.equal(out.result, null)
  assert.match(out.diagnostics.join(''), /没有这一单的事件流/)
  assert.deepEqual(out.calls, [{ command: out.bin, args: ['status'] }])
  assert.deepEqual(out.checked.map(file => resolve(file)), [
    resolve(out.bin), join(REPO_ROOT, '.codex', 'jobs', slug, 'exec.jsonl'),
  ])
})

test('openWatchPane：诡异 slug 不抛错、不查工单、不向 shell 传参', () => {
  const slugs = ['', '../../escape', 'a b c', '"; rm -rf /']
  const out = herdr(`${JSON.stringify(slugs)}.map(slug => openWatchPane(slug))`)
  assert.deepEqual(out.result, slugs.map(() => null))
  assert.equal(out.diagnostics.length, slugs.length)
  for (const diagnostic of out.diagnostics) assert.match(diagnostic, /slug 不合法/)
  assert.deepEqual(out.checked.map(file => resolve(file)), slugs.map(() => resolve(out.bin)))
  assert.deepEqual(out.calls, slugs.map(() => ({ command: out.bin, args: ['status'] })))
})
