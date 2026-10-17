const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { dirname, join, resolve } = require('node:path')

const root = resolve(__dirname, '..')

test('status 不把占用历史 PID 的无关活进程说成监工仍在跑', t => {
  const jobsRoot = join(root, '.codex', 'jobs')
  const slug = `pid-reuse-test-${randomUUID().slice(0, 8)}`
  const dir = join(jobsRoot, slug)
  assert.equal(dirname(dir), jobsRoot)
  mkdirSync(dir, { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    taskId: 'TEST-PID-REUSE', dispatchedAt: '2026-09-22T00:00:00.000Z', marker: 'never-printed',
  }))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    pid: process.pid, startedAt: '2026-09-22T00:00:00.000Z', finishedAt: null,
    exitCode: null, timedOut: false, threadId: null,
  }))
  const result = spawnSync(process.execPath,
    ['--import', 'tsx', 'scripts/codex/codex-dispatch.ts', 'status', slug],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, NODE_NO_WARNINGS: '1' } })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.doesNotMatch(result.stdout, /跑着呢/, result.stdout)
  assert.match(result.stdout, /旧 PID 已被其他进程占用/, result.stdout)
})

test('监工身份同时校验脚本、工单号、创建时刻和新单令牌', () => {
  const code = `
    import { join } from 'node:path'
    import { REPO_ROOT } from './scripts/codex/codex-paths.ts'
    import { supervisorLiveness } from './scripts/codex/codex-process.ts'
    const startedAt = '2026-09-23T00:00:00.000Z'
    const script = join(REPO_ROOT, 'scripts', 'codex', 'codex-dispatch.ts')
    const state = { pid: 1234, startedAt, finishedAt: null, exitCode: null, timedOut: false, threadId: null }
    const observed = { pid: 1234, startedAt, commandLine: 'node --import tsx "' + script + '" _supervise sample-job --identity secret-token' }
    console.log(JSON.stringify({
      old: supervisorLiveness(state, 'sample-job', observed),
      new: supervisorLiveness({ ...state, identityToken: 'secret-token' }, 'sample-job', observed),
      wrongToken: supervisorLiveness({ ...state, identityToken: 'different-token' }, 'sample-job', observed),
      wrongSlug: supervisorLiveness(state, 'another-job', observed),
      wrongOrder: supervisorLiveness(state, 'sample-job', { ...observed, commandLine: 'node "' + script + '" sample-job _supervise --identity secret-token' }),
      wrongScript: supervisorLiveness(state, 'sample-job', { ...observed, commandLine: 'node other.js _supervise sample-job' }),
      foreignBinary: supervisorLiveness(state, 'sample-job', { ...observed, commandLine: null, executablePath: 'unrelated-service.exe' }),
      wrongStart: supervisorLiveness(state, 'sample-job', { ...observed, startedAt: '2026-09-23T00:01:00.000Z' }),
      missing: supervisorLiveness(state, 'sample-job', null),
      unavailable: supervisorLiveness(state, 'sample-job', undefined),
      finished: supervisorLiveness({ ...state, finishedAt: startedAt }, 'sample-job', observed),
    }))
  `
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, NODE_NO_WARNINGS: '1' } })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.deepEqual(JSON.parse(result.stdout), {
    old: 'running', new: 'running', wrongToken: 'reused', wrongSlug: 'reused', wrongOrder: 'reused',
    wrongScript: 'reused', foreignBinary: 'reused', wrongStart: 'reused',
    missing: 'exited', unavailable: 'unknown', finished: 'finished',
  })
})

// 原有两项测试保持原断言、子进程期限及调用方式；以下只追加覆盖。
function nodeProbe(code) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, NODE_NO_WARNINGS: '1' } })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return JSON.parse(result.stdout)
}

test('只有创建时刻明确不匹配可在缺少命令行时判复用，匹配和边界仍须完整身份', () => {
  const result = nodeProbe(`
    import { join } from 'node:path'
    import { REPO_ROOT } from './scripts/codex/codex-paths.ts'
    import { supervisorLiveness } from './scripts/codex/codex-process.ts'
    const startedAt = '2026-09-23T00:00:00.000Z'
    const state = { pid: 1234, startedAt, finishedAt: null, identityToken: 'fixture-token' }
    const script = join(REPO_ROOT, 'scripts', 'codex', 'codex-dispatch.ts')
    const commandLine = 'node "' + script + '" _supervise sample-job --identity fixture-token'
    const bare = { pid: 1234, startedAt, commandLine: null, executablePath: null }
    const at = delta => ({ ...bare, startedAt: new Date(Date.parse(startedAt) + delta).toISOString() })
    console.log(JSON.stringify({
      matchingBare: supervisorLiveness(state, 'sample-job', bare),
      positiveBoundary: supervisorLiveness(state, 'sample-job', at(10000)),
      negativeBoundary: supervisorLiveness(state, 'sample-job', at(-10000)),
      positiveMismatch: supervisorLiveness(state, 'sample-job', at(10001)),
      negativeMismatch: supervisorLiveness(state, 'sample-job', at(-10001)),
      valid: supervisorLiveness(state, 'sample-job', { ...bare, commandLine }),
      wrongScript: supervisorLiveness(state, 'sample-job', { ...bare, commandLine: 'node other.js _supervise sample-job --identity fixture-token' }),
      wrongSlug: supervisorLiveness(state, 'other-job', { ...bare, commandLine }),
      wrongToken: supervisorLiveness({ ...state, identityToken: 'other-token' }, 'sample-job', { ...bare, commandLine }),
      badExpected: supervisorLiveness({ ...state, startedAt: 'bad' }, 'sample-job', { ...bare, commandLine }),
      missingExpected: supervisorLiveness({ ...state, startedAt: undefined }, 'sample-job', bare),
      badActual: supervisorLiveness(state, 'sample-job', { ...bare, startedAt: 'bad', commandLine }),
      missingActual: supervisorLiveness(state, 'sample-job', { ...bare, startedAt: null, commandLine }),
      invalidPid: supervisorLiveness(state, 'sample-job', { ...bare, pid: 0, commandLine }),
      badTimeForeignBinary: supervisorLiveness(state, 'sample-job', { ...bare, startedAt: 'bad', executablePath: 'other.exe' }),
    }))
  `)
  assert.deepEqual(result, {
    matchingBare: 'unknown', positiveBoundary: 'unknown', negativeBoundary: 'unknown',
    positiveMismatch: 'reused', negativeMismatch: 'reused', valid: 'running',
    wrongScript: 'reused', wrongSlug: 'reused', wrongToken: 'reused',
    badExpected: 'unknown', missingExpected: 'unknown', badActual: 'unknown', missingActual: 'unknown',
    invalidPid: 'unknown', badTimeForeignBinary: 'unknown',
  })
})

test('真实 Windows PowerShell：旧时刻活 PID 不调用 CIM，其它提示与共享 PID 均保守回退',
  { skip: process.platform !== 'win32' }, () => {
    const result = nodeProbe(`
      import cp from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      import { inspectProcesses, windowsProcessScript, supervisorLiveness } from './scripts/codex/codex-process.ts'
      const launch = cp.spawnSync
      const targetPid = ${process.pid}
      const old = { pid: targetPid, startedAt: '1900-01-01T00:00:00.000Z' }
      const forbidden = "function Get-CimInstance { param($ClassName, $Filter); throw 'fixture: CIM forbidden' }; "
      function run(script) {
        const found = launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
          { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 })
        if (found.status !== 0 || found.error) throw new Error(found.stderr || found.error?.message || 'PowerShell failed')
        return JSON.parse(found.stdout.trim())
      }
      // 独立读取真实创建时刻并 Dispose，再比较生产脚本输出；CIM 被明确禁止。
      const prefix = '$ErrorActionPreference="Stop"; $fixtureProcess=[System.Diagnostics.Process]::GetProcessById(' + targetPid + '); ' +
        'try { $fixtureActual=$fixtureProcess.StartTime.ToUniversalTime() } finally { $fixtureProcess.Dispose() }; '
      // 实际调用生产 inspectProcesses，只在其同一个 PowerShell 子进程前注入测试函数。
      let firstProbe, firstMap
      cp.spawnSync = (file, args, options) => {
        if (file !== 'powershell.exe') throw new Error('unexpected executable')
        const script = prefix + '[Console]::Error.WriteLine("fixtureActualMs:" + ([DateTimeOffset]$fixtureActual).ToUnixTimeMilliseconds()); ' +
          forbidden + args[args.length - 1]
        firstProbe = launch(file, [...args.slice(0, -1), script], options)
        return firstProbe
      }
      syncBuiltinESMExports()
      try { firstMap = inspectProcesses([targetPid], [old]) }
      finally { cp.spawnSync = launch; syncBuiltinESMExports() }
      if (!firstMap || firstMap.size !== 1) throw new Error(firstProbe?.stderr || 'real hinted probe failed')
      const first = [...firstMap.values()]
      const exact = /fixtureActualMs:([0-9]+)/.exec(firstProbe.stderr)
      if (!exact || Date.parse(first[0].startedAt) !== Number(exact[1])) throw new Error('creation time differs')
      const actual = Date.parse(first[0].startedAt)
      const hint = offset => ({ pid: targetPid, startedAt: new Date(actual + offset).toISOString() })
      const cases = [
        ['all-old', [targetPid], [old, hint(-20000)]],
        ['matching', [targetPid], [hint(0)]],
        ['positive-boundary', [targetPid], [hint(10000)]],
        ['negative-boundary', [targetPid], [hint(-10000)]],
        ['positive-outside', [targetPid], [hint(10001)]],
        ['negative-outside', [targetPid], [hint(-10001)]],
        ['no-hint', [targetPid], []],
        ['bad-hint', [targetPid], [{ pid: targetPid, startedAt: 'bad' }]],
        ['missing-time', [targetPid], [{ pid: targetPid }]],
        ['null-time', [targetPid], [{ pid: targetPid, startedAt: null }]],
        ['numeric-time', [targetPid], [{ pid: targetPid, startedAt: actual }]],
        ['old-and-bad', [targetPid], [old, { pid: targetPid, startedAt: 'bad' }]],
        ['old-then-matching', [targetPid], [old, hint(0)]],
        ['matching-then-old', [targetPid], [hint(0), old]],
        ['batch-mixed', [targetPid, process.pid], [old]],
        // Windows 有效 PID 按四对齐；这个合法正整数不能对应真实进程，CLR 读取必失败。
        ['start-read-failed', [2147483647], [{ pid: 2147483647, startedAt: old.startedAt }]],
      ]
      const capture = '$ErrorActionPreference="Stop"; $script:fixtureFilters=@(); ' +
        'function Get-CimInstance { param($ClassName, $Filter); $script:fixtureFilters += $Filter; throw "fixture: CIM forbidden" }; ' +
        'function Invoke-FixtureProbe($name, [scriptblock]$probe) { $script:fixtureFilters=@(); try { $raw=& $probe; ' +
          '[pscustomobject]@{ name=$name; failed=$false; encoded=[string]$raw; filters=@($script:fixtureFilters) } ' +
        '} catch { [pscustomobject]@{ name=$name; failed=$true; encoded=$null; filters=@($script:fixtureFilters) } } }; '
      // 每次最多六项，避免 Windows 命令行长度上限；每个 PowerShell 仍只给原五秒。
      const captured = []
      for (let index = 0; index < cases.length; index += 6) {
        const script = capture + '$cases=@(' + cases.slice(index, index + 6).map(([name, pids, hints]) =>
          "Invoke-FixtureProbe '" + name + "' { " + windowsProcessScript(pids, hints) + ' }; ').join('') +
          '); ConvertTo-Json -InputObject @($cases) -Compress -Depth 6'
        captured.push(...run(script).map(item => ({ ...item, rows: item.failed ? [] : JSON.parse(item.encoded) })))
      }
      console.log(JSON.stringify({ first, firstLiveness: supervisorLiveness({ ...old, finishedAt: null }, 'sample-job', first[0]),
        cases: captured, targetPid, otherPid: process.pid }))
    `)
    assert.equal(result.first.length, 1)
    assert.equal(result.first[0].pid, process.pid)
    assert.equal(result.first[0].commandLine, null)
    assert.equal(result.first[0].executablePath, null)
    assert.equal(result.firstLiveness, 'reused')
    for (const probe of result.cases) {
      const fast = ['all-old', 'positive-outside', 'negative-outside'].includes(probe.name)
      assert.equal(probe.failed, !fast, probe.name)
      if (fast) {
        assert.deepEqual(probe.filters, [], probe.name)
        assert.equal(probe.rows.length, 1, probe.name)
        assert.equal(probe.rows[0].startedAt, result.first[0].startedAt, probe.name)
        assert.equal(probe.rows[0].commandLine, null, probe.name)
      } else {
        const expectedPid = probe.name === 'batch-mixed' ? result.otherPid
          : probe.name === 'start-read-failed' ? 2147483647 : result.targetPid
        assert.deepEqual(probe.filters, ['ProcessId = ' + expectedPid], probe.name)
      }
    }
  })

test('真实 Windows PowerShell：混合批量仅 CIM 查询剩余 PID，匹配项仍返回完整身份',
  { skip: process.platform !== 'win32' }, () => {
    const result = nodeProbe(`
      import { spawnSync } from 'node:child_process'
      import { join } from 'node:path'
      import { REPO_ROOT } from './scripts/codex/codex-paths.ts'
      import { windowsProcessScript, supervisorLiveness } from './scripts/codex/codex-process.ts'
      const oldPid = ${process.pid}, currentPid = process.pid
      const quote = text => "'" + text.replaceAll("'", "''") + "'"
      const command = 'node "' + join(REPO_ROOT, 'scripts', 'codex', 'codex-dispatch.ts') + '" _supervise sample-job --identity fixture-token'
      const fakeCim = '$ErrorActionPreference="Stop"; function Get-CimInstance { param($ClassName, $Filter); ' +
        'if ($ClassName -ne "Win32_Process" -or $Filter -ne "ProcessId = ' + currentPid + '") { throw "wrong pending filter" }; ' +
        '$fixtureProcess=[System.Diagnostics.Process]::GetProcessById(' + currentPid + '); try { ' +
        '[pscustomobject]@{ ProcessId=' + currentPid + '; CreationDate=$fixtureProcess.StartTime; CommandLine=' + quote(command) +
        '; ExecutablePath=' + quote(process.execPath) + ' } } finally { $fixtureProcess.Dispose() } }; '
      const script = fakeCim + windowsProcessScript([oldPid, currentPid], [{ pid: oldPid, startedAt: '1900-01-01T00:00:00.000Z' }])
      const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 })
      if (probe.status !== 0 || probe.error) throw new Error(probe.stderr || probe.error?.message || 'PowerShell failed')
      const rows = JSON.parse(probe.stdout.trim()), old = rows.find(row => row.pid === oldPid), current = rows.find(row => row.pid === currentPid)
      const state = { pid: currentPid, startedAt: current.startedAt, finishedAt: null, identityToken: 'fixture-token' }
      console.log(JSON.stringify({ count: rows.length, oldCommand: old.commandLine, currentCommand: current.commandLine,
        valid: supervisorLiveness(state, 'sample-job', current),
        wrongScript: supervisorLiveness(state, 'sample-job', { ...current, commandLine: 'node other.js _supervise sample-job --identity fixture-token' }),
        wrongSlug: supervisorLiveness(state, 'other-job', current),
        wrongToken: supervisorLiveness({ ...state, identityToken: 'other-token' }, 'sample-job', current),
      }))
    `)
    assert.equal(result.count, 2)
    assert.equal(result.oldCommand, null)
    assert.match(result.currentCommand, /_supervise sample-job --identity fixture-token/)
    assert.equal(result.valid, 'running')
    assert.equal(result.wrongScript, 'reused')
    assert.equal(result.wrongSlug, 'reused')
    assert.equal(result.wrongToken, 'reused')
  })

test('inspectProcesses 查询/解析/形状失败保持 unknown，保留单次五秒预算且不缓存失败', () => {
  const result = nodeProbe(`
    import cp from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    import { join } from 'node:path'
    import { REPO_ROOT } from './scripts/codex/codex-paths.ts'
    import { inspectProcesses, supervisorLiveness } from './scripts/codex/codex-process.ts'
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const state = { pid: 1234, startedAt: '2026-09-23T00:00:00.000Z', finishedAt: null, identityToken: 'fixture-token' }
    const row = { pid: state.pid, startedAt: state.startedAt, executablePath: 'C:/node.exe',
      commandLine: 'node "' + join(REPO_ROOT, 'scripts', 'codex', 'codex-dispatch.ts') + '" _supervise sample-job --identity fixture-token' }
    let response, calls = 0
    const options = []
    cp.spawnSync = (file, args, config) => {
      if (file !== 'powershell.exe') throw new Error('unexpected executable')
      if (args[0] !== '-NoProfile' || args[1] !== '-NonInteractive' || args[2] !== '-Command') throw new Error('unexpected invocation')
      calls++; options.push({ timeout: config.timeout, windowsHide: config.windowsHide, maxBuffer: config.maxBuffer })
      return response
    }
    syncBuiltinESMExports()
    const failures = [
      { status: 1, stdout: '' },
      { status: 1, stdout: JSON.stringify([row]) },
      { status: null, error: new Error('fixture timeout'), stdout: '' },
      { status: 0, error: new Error('fixture query failed'), stdout: JSON.stringify([row]) },
      { status: 0, stdout: 'not-json' },
      { status: 0, stdout: '{}' },
      ...[null, 17, { ...row, pid: '1234' }, { ...row, startedAt: 17 },
        { ...row, commandLine: 17 }, { ...row, executablePath: 17 }].map(bad => ({ status: 0, stdout: JSON.stringify([bad]) })),
    ]
    const statuses = failures.map(failure => {
      response = failure
      const found = inspectProcesses([state.pid], [state])
      if (found !== null) throw new Error('failed probe must return null')
      return supervisorLiveness(state, 'sample-job', found === null ? undefined : found.get(state.pid) ?? null)
    })
    response = { status: 0, stdout: JSON.stringify([row]) }
    const recovered = inspectProcesses([state.pid], [state])
    const recoveredStatus = supervisorLiveness(state, 'sample-job', recovered === null ? undefined : recovered.get(state.pid) ?? null)
    response = { status: 0, stdout: '[]' }
    const missing = inspectProcesses([state.pid])
    const missingStatus = supervisorLiveness(state, 'sample-job', missing === null ? undefined : missing.get(state.pid) ?? null)
    console.log(JSON.stringify({ statuses, recoveredStatus, missingStatus, calls, expectedCalls: failures.length + 2, options }))
  `)
  assert.ok(result.statuses.length >= 10)
  assert.deepEqual(result.statuses, result.statuses.map(() => 'unknown'))
  assert.equal(result.recoveredStatus, 'running')
  assert.equal(result.missingStatus, 'exited')
  assert.equal(result.calls, result.expectedCalls)
  for (const options of result.options) assert.deepEqual(options, { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 })
})
