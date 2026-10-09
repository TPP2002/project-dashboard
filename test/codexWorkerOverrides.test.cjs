// 派单器拉起的每个 Codex 进程统一关掉桌面版注入的工具服务与 notify,并把传给 codex 的 PATH
// 洗掉 WindowsApps(DASH-CODEX-WORKER-MCP-OVERRIDES-1009,移植 stock-rogue PR #1132)。
// 常量与纯函数经 node --import tsx 子进程跑;两处接线(spawn/spawnSync 的 env)用源码文本断言。
// 不真起 Codex、不碰真工单目录、不跨仓读 stock-rogue 的文件 —— 四对字面量写死在本文件里比。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const REPO_ROOT = resolve(__dirname, '..')

/** 在 tsx 下执行一段 ESM 代码,stdout 只准打一行 JSON。 */
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

/** stock-rogue 主干 5771c8be9(PR #1132)的四对 -c 覆盖,逐元素写死比,不跨仓读文件。 */
const EXPECTED_OVERRIDES = [
  '-c', 'mcp_servers.node_repl.enabled=false',
  '-c', 'mcp_servers.node_repl.command="disabled-by-codex-dispatch"',
  '-c', 'plugins.unified-computer-use@openai-bundled.enabled=false',
  '-c', 'notify=[]',
]

/** args 里这段八元素连续子串出现了几次(逐元素比对,不许放宽成 arrayContaining)。 */
function segmentCount(args) {
  let count = 0
  for (let start = 0; start + EXPECTED_OVERRIDES.length <= args.length; start++) {
    if (EXPECTED_OVERRIDES.every((value, offset) => args[start + offset] === value)) count++
  }
  return count
}

test('CODEX_WORKER_CONFIG_OVERRIDES:与 stock-rogue 主干那份逐元素相等', () => {
  const out = runTs(`
    import { CODEX_WORKER_CONFIG_OVERRIDES } from './scripts/codex/codex-worker-overrides.ts'
    console.log(JSON.stringify([...CODEX_WORKER_CONFIG_OVERRIDES]))
  `)
  assert.deepEqual(out, EXPECTED_OVERRIDES)
})

const WINAPPS_BACKSLASH = 'C:\\Users\\X\\AppData\\Local\\Microsoft\\WindowsApps'
const WINAPPS_MIXED_CASE = 'd:\\Tools\\Microsoft\\WINDOWSAPPS\\'
const WINAPPS_SLASH = 'c:/users/x/appdata/local/microsoft/windowsapps/'
const PLAIN_A = 'C:\\Windows\\System32'
const PLAIN_B = 'C:\\Program Files\\Git\\cmd'

test('codexWorkerEnv:win32 上只动 PATH,WindowsApps 条目(大小写、正反斜杠、末尾斜杠)全去掉', () => {
  const dirtyPath = [WINAPPS_BACKSLASH, PLAIN_A, WINAPPS_SLASH, PLAIN_B, '', WINAPPS_MIXED_CASE].join(';')
  const envLiteral = JSON.stringify({ Path: dirtyPath, USERPROFILE: 'C:\\Users\\X', SCHED_SHARE: 'F:/calib-share' })
  const out = runTs(`
    import { codexWorkerEnv } from './scripts/codex/codex-worker-overrides.ts'
    const env = ${envLiteral}
    const snapshot = JSON.stringify(env)
    const filtered = codexWorkerEnv(env, 'win32')
    console.log(JSON.stringify({
      path: filtered.Path,
      profile: filtered.USERPROFILE,
      share: filtered.SCHED_SHARE,
      pathKeys: Object.keys(filtered).filter(key => key.toLowerCase() === 'path'),
      inputUntouched: JSON.stringify(env) === snapshot,
      returnsNewObject: filtered !== env,
    }))
  `)
  // 去掉三种写法的 WindowsApps 条目;普通条目、空条目、其余变量一字不动,顺序不变。
  assert.equal(out.path, [PLAIN_A, PLAIN_B, ''].join(';'))
  assert.ok(!out.path.toLowerCase().includes('windowsapps'))
  assert.equal(out.profile, 'C:\\Users\\X')
  assert.equal(out.share, 'F:/calib-share')
  assert.deepEqual(out.pathKeys, ['Path'], '保留原键名,不许多出第二个 PATH 键')
  assert.equal(out.inputUntouched, true)
  assert.equal(out.returnsNewObject, true)
})

test('codexWorkerEnv:PATH 没有 WindowsApps 时内容原样;键名大小写不敏感且保留原键', () => {
  const out = runTs(`
    import { codexWorkerEnv } from './scripts/codex/codex-worker-overrides.ts'
    console.log(JSON.stringify({
      clean: codexWorkerEnv({ PATH: 'C:\\\\Windows;C:\\\\Tools', FOO: 'bar' }, 'win32'),
      upperKey: codexWorkerEnv({ PATH: ${JSON.stringify(WINAPPS_BACKSLASH + ';C:\\Tools')} }, 'win32'),
    }))
  `)
  assert.deepEqual(out.clean, { PATH: 'C:\\Windows;C:\\Tools', FOO: 'bar' })
  assert.deepEqual(out.upperKey, { PATH: 'C:\\Tools' }, '键名是大写 PATH 也找得到,返回仍叫 PATH')
})

test('codexWorkerEnv:没有 PATH 键、非 win32 平台都原样返回(同一引用,一个字节不动)', () => {
  const out = runTs(`
    import { codexWorkerEnv } from './scripts/codex/codex-worker-overrides.ts'
    const noPath = { USERPROFILE: 'C:\\\\Users\\\\X', FOO: 'bar' }
    const dirty = { Path: ${JSON.stringify(WINAPPS_BACKSLASH + ';' + PLAIN_A)} }
    console.log(JSON.stringify({
      noPathSameRef: codexWorkerEnv(noPath, 'win32') === noPath,
      linuxSameRef: codexWorkerEnv(dirty, 'linux') === dirty,
      darwinSameRef: codexWorkerEnv(dirty, 'darwin') === dirty,
    }))
  `)
  assert.equal(out.noPathSameRef, true)
  assert.equal(out.linuxSameRef, true)
  assert.equal(out.darwinSameRef, true)
})

const EXEC_META = { cwd: 'F:/somewhere/job-wt' }
const EXEC_PATHS = { dir: 'F:/jobs/demo-card', lastMessage: 'F:/jobs/demo-card/last-message.json' }
const EXEC_PROMPT = '把活干完'
const expectedExecArgs = (sandbox, model) => [
  'exec',
  '--cd', EXEC_META.cwd,
  '--sandbox', sandbox,
  '--skip-git-repo-check',
  '--json',
  '--output-schema', join(EXEC_PATHS.dir, 'verdict.schema.json'),
  '-o', EXEC_PATHS.lastMessage,
  ...(model ? ['--model', model] : []),
  ...EXPECTED_OVERRIDES,
  EXEC_PROMPT,
]

test('buildCodexExecArgs:首轮参数除新增四对外逐字不变,四对完整出现且都在 prompt 之前', () => {
  const out = runTs(`
    import { buildCodexExecArgs } from './scripts/codex/codex-runner.ts'
    const meta = ${JSON.stringify(EXEC_META)}
    const paths = ${JSON.stringify(EXEC_PATHS)}
    console.log(JSON.stringify({
      withModel: buildCodexExecArgs(meta, { sandbox: 'workspace-write', model: 'gpt-6.1-sol' }, paths, ${JSON.stringify(EXEC_PROMPT)}),
      withoutModel: buildCodexExecArgs(meta, { sandbox: 'read-only', model: null }, paths, ${JSON.stringify(EXEC_PROMPT)}),
    }))
  `)
  assert.deepEqual(out.withModel, expectedExecArgs('workspace-write', 'gpt-6.1-sol'))
  assert.deepEqual(out.withoutModel, expectedExecArgs('read-only', null))
  for (const label of ['withModel', 'withoutModel']) {
    const args = out[label]
    assert.equal(args[0], 'exec', label + ':exec 仍是第一个')
    assert.equal(args[args.length - 1], EXEC_PROMPT, label + ':prompt 仍是最后一个 argv')
    assert.equal(segmentCount(args), 1, label + ':四对覆盖恰作为连续一段出现一次')
    const start = args.findIndex((_v, i) => EXPECTED_OVERRIDES.every((v, o) => args[i + o] === v))
    assert.ok(start + EXPECTED_OVERRIDES.length < args.length, label + ':整段覆盖都在 prompt 之前')
  }
})

test('buildResumeArgs:末尾带四对覆盖,原有元素与顺序不变', () => {
  const message = '第一行\n第二行:带"引号"'
  const out = runTs(`
    import { buildResumeArgs } from './scripts/codex/codex-say.ts'
    console.log(JSON.stringify(['read-only', 'workspace-write'].map(sandbox =>
      buildResumeArgs('01a-session', ${JSON.stringify(message)}, sandbox))))
  `)
  assert.deepEqual(out, ['read-only', 'workspace-write'].map(sandbox => [
    'exec', 'resume', '01a-session', message, '--skip-git-repo-check', '-c', 'sandbox_mode="' + sandbox + '"',
    ...EXPECTED_OVERRIDES,
  ]))
  for (const args of out) {
    assert.equal(args[0], 'exec')
    assert.equal(segmentCount(args), 1)
    assert.deepEqual(args.slice(-EXPECTED_OVERRIDES.length), EXPECTED_OVERRIDES)
  }
})

test('接线:两处起进程都传 env 且来自 codexWorkerEnv(源码文本断言,不真起进程)', () => {
  const runnerSource = readFileSync(join(REPO_ROOT, 'scripts/codex/codex-runner.ts'), 'utf8')
  const saySource = readFileSync(join(REPO_ROOT, 'scripts/codex/codex-say.ts'), 'utf8')
  assert.match(
    runnerSource,
    /spawn\(meta\.codexBin, args, \{[^}]*env: codexWorkerEnv\(process\.env\)/,
    'supervise 的 spawn 选项里要有 env: codexWorkerEnv(process.env)',
  )
  assert.match(
    saySource,
    /buildResumeArgs\(threadId, message, opts\?\.sandbox \?\? 'read-only'\), \{[^}]*env: codexWorkerEnv\(process\.env\)/,
    'sayToJob 的 spawnSync 选项里要有 env: codexWorkerEnv(process.env)',
  )
})
