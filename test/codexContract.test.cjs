const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

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

const baseTask = (over = {}) => ({
  schemaVersion: 1, taskId: 'DEMO-CARD', slug: 'demo-card', title: '示例任务',
  goal: '补齐派单检查', allowedPaths: ['test/example.test.cjs'],
  acceptance: [{ id: 'A1', kind: 'test:targeted', target: 'test/example.test.cjs' }],
  ...over,
})

// 拒收信息随结果一起跨进程传回，避免把预期拒收误判成 tsx 启动失败。
function parse(over = {}) {
  return runTs(`
    import { parseTask } from './scripts/codex/codex-contract.ts'
    let result
    try { result = { task: parseTask(${JSON.stringify(baseTask(over))}), error: null } }
    catch (error) { result = { task: null, error: error.message } }
    console.log(JSON.stringify(result))
  `)
}

test('parseTask：合法最小工单补齐全部可选默认值', () => {
  const { task, error } = parse()
  assert.equal(error, null)
  assert.deepEqual(task, {
    ...baseTask(), background: '', forbiddenPaths: ['.codex/jobs/**'], nonGoals: [],
    expectArtifacts: [], sandbox: 'workspace-write', cwd: null, worktree: false,
    model: null, timeoutSec: 900,
    acceptance: [{ id: 'A1', kind: 'test:targeted', target: 'test/example.test.cjs', required: true }],
  })
})

test('parseTask：显式只读、工作区及可选验收不会被默认值覆盖', () => {
  const { task, error } = parse({
    sandbox: 'read-only', worktree: true, timeoutSec: 600,
    acceptance: [{ id: 'A1', kind: 'manual', required: false, note: ' 人工看措辞 ' }],
  })
  assert.equal(error, null)
  assert.equal(task.sandbox, 'read-only')
  assert.equal(task.worktree, true)
  assert.equal(task.timeoutSec, 600)
  assert.deepEqual(task.acceptance, [{ id: 'A1', kind: 'manual', required: false, note: '人工看措辞' }])
})

test('parseTask：slug 只收以小写字母数字开头的 2 至 49 字符', () => {
  const slugs = ['a0', 'a-b', 'a'.repeat(49), '../escape', 'Has Space', '', 'a', '-ab', 'a_b', 'a'.repeat(50)]
  const out = runTs(`
    import { parseTask, isValidSlug } from './scripts/codex/codex-contract.ts'
    const base = ${JSON.stringify(baseTask())}
    console.log(JSON.stringify(${JSON.stringify(slugs)}.map(slug => {
      try { return { valid: isValidSlug(slug), slug: parseTask({ ...base, slug }).slug } }
      catch (error) { return { valid: isValidSlug(slug), error: error.message } }
    })))
  `)
  out.forEach((item, index) => {
    assert.equal(item.valid, index < 3, slugs[index])
    if (index < 3) assert.equal(item.slug, slugs[index])
    else assert.match(item.error, /slug/, slugs[index])
  })
})

test('parseTask：拒收 danger-full-access', () => {
  assert.match(parse({ sandbox: 'danger-full-access' }).error, /sandbox/)
})

test('parseTask：空白 goal 拒收', () => {
  assert.match(parse({ goal: '   ' }).error, /goal/)
})

test('parseTask：至少要有一条验收项', () => {
  assert.match(parse({ acceptance: [] }).error, /acceptance/)
})

test('parseTask：空施工面拒收', () => {
  assert.match(parse({ allowedPaths: [] }).error, /allowedPaths/)
})

test('parseTask：工单目录永远进禁区，已有规则不重复追加', () => {
  const added = parse({ forbiddenPaths: [] }).task.forbiddenPaths
  const retained = parse({ forbiddenPaths: ['scripts/**', '.codex/jobs/**'] }).task.forbiddenPaths
  assert.deepEqual(added, ['.codex/jobs/**'])
  assert.deepEqual(retained, ['scripts/**', '.codex/jobs/**'])
})

test('验收菜单：未知作业拒收并给出本仓库完整清单', () => {
  const { error } = parse({ acceptance: [{ id: 'A1', kind: 'unknown-job' }] })
  assert.match(error, /unknown-job.*不是可用作业名/)
  assert.match(error, /可用清单/)
  for (const name of ['test:targeted', 'test:all', 'web:typecheck', 'web:build', 'web:no-emoji', 'manual']) {
    assert.ok(error.includes(name), name)
  }
})

test('验收菜单：command 字段被丢弃，argv 只能来自模板', () => {
  const { task } = parse({
    acceptance: [{ id: 'A1', kind: 'web:typecheck', command: 'echo ok', required: true }],
  })
  assert.equal(Object.hasOwn(task.acceptance[0], 'command'), false)
  const argv = runTs(`
    import { resolveAcceptanceArgv } from './scripts/codex/codex-contract.ts'
    console.log(JSON.stringify(resolveAcceptanceArgv(${JSON.stringify(task.acceptance[0])})))
  `)
  assert.deepEqual(argv, ['npm', '--prefix', 'web', 'run', 'typecheck'])
})

test('验收菜单：定向作业缺 target 拒收', () => {
  assert.match(parse({ acceptance: [{ id: 'A1', kind: 'test:targeted' }] }).error, /target/)
})

test('验收菜单：target 不许越狱、绝对路径或 shell 元字符', () => {
  const targets = [
    '../../etc/passwd', '/abs/path.cjs', 'C:/abs/path.cjs', './test/a.test.cjs',
    'test/a.cjs && rm -rf .', 'test/$(whoami).cjs', 'test/a;echo.cjs', 'test/a|echo.cjs',
  ]
  const errors = runTs(`
    import { parseTask } from './scripts/codex/codex-contract.ts'
    const base = ${JSON.stringify(baseTask())}
    console.log(JSON.stringify(${JSON.stringify(targets)}.map(target => {
      try { parseTask({ ...base, acceptance: [{ id: 'A1', kind: 'test:targeted', target }] }); return null }
      catch (error) { return error.message }
    })))
  `)
  errors.forEach((error, index) => assert.match(error, /target/, targets[index]))
})

test('验收菜单：manual 的 argv 为 null', () => {
  const { task } = parse({ acceptance: [{ id: 'A1', kind: 'manual', required: false }] })
  const argv = runTs(`
    import { resolveAcceptanceArgv } from './scripts/codex/codex-contract.ts'
    console.log(JSON.stringify(resolveAcceptanceArgv(${JSON.stringify(task.acceptance[0])})))
  `)
  assert.equal(argv, null)
})

test('验收菜单：清单非空且只有本仓库六种作业，每项都有模板或显式人工项', () => {
  const out = runTs(`
    import { ACCEPTANCE_KINDS, acceptanceKindNames } from './scripts/codex/codex-contract.ts'
    console.log(JSON.stringify(acceptanceKindNames().map(name => ({
      name, needsTarget: ACCEPTANCE_KINDS[name].needsTarget,
      argvType: ACCEPTANCE_KINDS[name].argv === null ? 'manual' : typeof ACCEPTANCE_KINDS[name].argv,
    }))))
  `)
  assert.deepEqual(out.map(item => item.name), [
    'test:targeted', 'test:all', 'web:typecheck', 'web:build', 'web:no-emoji', 'manual',
  ])
  for (const item of out) {
    assert.equal(item.needsTarget, item.name === 'test:targeted')
    assert.equal(item.argvType, item.name === 'manual' ? 'manual' : 'function')
  }
})
