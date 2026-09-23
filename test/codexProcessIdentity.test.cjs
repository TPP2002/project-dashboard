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
      foreignBinary: supervisorLiveness(state, 'sample-job', { ...observed, commandLine: null, executablePath: 'C:\\Program Files\\Razer\\service.exe' }),
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
