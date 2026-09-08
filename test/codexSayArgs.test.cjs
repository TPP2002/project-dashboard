// 派单器 say 的参数解析与工作目录回落：这两处各踩过一次坑（多行消息被截断、续聊在主工位跑被沙箱拒写）。
// 派单器是 TS，测试经 node --import tsx 起一个子进程把纯函数跑一遍，不碰真 Codex。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')

const REPO_ROOT = resolve(__dirname, '..')

/** 在 tsx 下执行一段 ESM 代码，stdout 只准打一行 JSON。 */
function runTs(code) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  assert.equal(r.status, 0, 'tsx 子进程失败:\n' + (r.error?.message || r.stderr))
  const lines = r.stdout.trim().split(/\r?\n/)
  assert.equal(lines.length, 1, 'stdout 只准输出一行 JSON')
  return JSON.parse(lines[0])
}

function tempDir(t, prefix) {
  const root = resolve(tmpdir())
  const dir = mkdtempSync(join(root, prefix))
  assert.equal(dirname(dir), root)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('say 参数：选项放哪都行，消息可以在 --sandbox 之后', () => {
  const cases = [
    ['a-b', 'hello'],
    ['a-b', '--sandbox', 'workspace-write', 'hello'],
    ['a-b', 'hello', '--sandbox', 'workspace-write'],
    ['a-b', '--message-file', 'x.txt'],
    ['a-b'],
    ['a-b', 'hello', '--message-file', 'x.txt'],
    ['a-b', '--sandbox'],
    ['a-b', 'hello', '--bogus'],
  ]
  const out = runTs(
    'import { parseSayArgs } from "./scripts/codex/codex-say.ts";' +
      'console.log(JSON.stringify(' + JSON.stringify(cases) + '.map(parseSayArgs)))',
  )
  assert.deepEqual(out[0], { slug: 'a-b', message: 'hello', messageFile: null, sandbox: null, error: null })
  assert.deepEqual(out[1], { slug: 'a-b', message: 'hello', messageFile: null, sandbox: 'workspace-write', error: null })
  assert.deepEqual(out[2], { slug: 'a-b', message: 'hello', messageFile: null, sandbox: 'workspace-write', error: null })
  assert.deepEqual(out[3], { slug: 'a-b', message: null, messageFile: 'x.txt', sandbox: null, error: null })
  assert.match(out[4].error, /缺消息/)
  assert.match(out[5].error, /只能给一个/)
  assert.match(out[6].error, /后面要跟值/)
  assert.match(out[7].error, /不认识的选项/)
})

test('say 消息：--message-file 保住多行，CR 去掉、首尾空白剪掉', t => {
  const dir = tempDir(t, 'codex-say-')
  const file = join(dir, 'msg.txt')
  writeFileSync(file, '  第一行\r\n第二行：带"引号"\r\n\n', 'utf8')
  const out = runTs(
    'import { parseSayArgs, readSayMessage } from "./scripts/codex/codex-say.ts";' +
      'console.log(JSON.stringify(readSayMessage(parseSayArgs(["a-b", "--message-file", ' + JSON.stringify(file) + ']))))',
  )
  assert.equal(out, '第一行\n第二行：带"引号"')
})

test('续聊工作目录：meta.json 里的 cwd 存在就用它，缺了或目录没了回落 null', t => {
  const dir = tempDir(t, 'codex-meta-')
  const wt = join(dir, 'wt'); mkdirSync(wt)
  const good = join(dir, 'good.json'); writeFileSync(good, JSON.stringify({ cwd: wt }))
  const gone = join(dir, 'gone.json'); writeFileSync(gone, JSON.stringify({ cwd: join(dir, 'not-there') }))
  const broken = join(dir, 'broken.json'); writeFileSync(broken, '{oops')
  const out = runTs(
    'import { cwdFromMeta } from "./scripts/codex/codex-say.ts";' +
      'console.log(JSON.stringify([' + [good, gone, broken, join(dir, 'missing.json')].map((p) => 'cwdFromMeta(' + JSON.stringify(p) + ')').join(',') + ']))',
  )
  assert.equal(resolve(out[0]), resolve(wt))
  assert.equal(out[1], null)
  assert.equal(out[2], null)
  assert.equal(out[3], null)
})

function tempLog(t, content) {
  const file = join(tempDir(t, 'codex-thread-'), 'exec.jsonl')
  writeFileSync(file, content, 'utf8')
  return file
}

function threadIds(files) {
  return runTs(`
    import { extractThreadId } from './scripts/codex/codex-say.ts'
    console.log(JSON.stringify(${JSON.stringify(files)}.map(extractThreadId)))
  `)
}

test('extractThreadId：正常 JSONL 取第一条 thread.started 的会话号', t => {
  const file = tempLog(t, [
    JSON.stringify({ type: 'thread.started', thread_id: '01a-first' }),
    JSON.stringify({ type: 'thread.started', thread_id: '01a-second' }),
  ].join('\n'))
  assert.deepEqual(threadIds([file]), ['01a-first'])
})

test('extractThreadId：跳过非 JSON 诊断行，继续取后面的会话号', t => {
  const file = tempLog(t, [
    'Reading additional input from stdin...',
    JSON.stringify({ type: 'thread.started', thread_id: '01a-real-session' }),
    JSON.stringify({ type: 'turn.started' }),
  ].join('\r\n'))
  assert.deepEqual(threadIds([file]), ['01a-real-session'])
})

test('extractThreadId：超大事件流只扫描开头 64KB', t => {
  const nearStart = tempLog(t, [
    'Reading additional input from stdin...',
    JSON.stringify({ type: 'thread.started', thread_id: '01a-near-start' }),
    'x'.repeat(256 * 1024),
  ].join('\n'))
  const tooLate = tempLog(t, [
    'x'.repeat(70 * 1024),
    JSON.stringify({ type: 'thread.started', thread_id: '01a-too-late' }),
  ].join('\n'))
  assert.deepEqual(threadIds([nearStart, tooLate]), ['01a-near-start', null])
})

test('extractThreadId：文件不存在返回 null', t => {
  const file = join(tempDir(t, 'codex-thread-missing-'), 'missing.jsonl')
  assert.deepEqual(threadIds([file]), [null])
})

test('extractThreadId：没有 thread.started 返回 null', t => {
  const file = tempLog(t, [
    JSON.stringify({ type: 'turn.started' }), 'not json either',
    JSON.stringify({ type: 'item.completed' }),
  ].join('\n'))
  assert.deepEqual(threadIds([file]), [null])
})

test('parsePorcelain：保留两位状态码之后的完整路径和带引号路径', () => {
  const porcelain = [
    ' M scripts/codex/codex-dispatch.ts', '?? scripts/codex/codex-say.ts',
    ' M "scripts/codex/quoted path.ts"',
  ].join('\n')
  const out = runTs(`
    import { parsePorcelain } from './scripts/codex/codex-runner.ts'
    console.log(JSON.stringify(parsePorcelain(${JSON.stringify(porcelain)})))
  `)
  assert.deepEqual(out.map(file => resolve(REPO_ROOT, file)), [
    join(REPO_ROOT, 'scripts', 'codex', 'codex-dispatch.ts'),
    join(REPO_ROOT, 'scripts', 'codex', 'codex-say.ts'),
    join(REPO_ROOT, 'scripts', 'codex', 'quoted path.ts'),
  ])
})

test('buildResumeArgs：逐项保留会话和消息，沙箱只经 -c 覆盖', () => {
  const sandboxes = ['read-only', 'workspace-write']
  const message = '第一行\n第二行：带"引号"'
  const out = runTs(`
    import { buildResumeArgs } from './scripts/codex/codex-say.ts'
    console.log(JSON.stringify(${JSON.stringify(sandboxes)}.map(sandbox =>
      buildResumeArgs('01a-session', ${JSON.stringify(message)}, sandbox))))
  `)
  assert.deepEqual(out, sandboxes.map(sandbox => [
    'exec', 'resume', '01a-session', message, '--skip-git-repo-check', '-c', 'sandbox_mode="' + sandbox + '"',
  ]))
})

// 缺会话用例只模拟文件不存在；禁止真实读取 .codex/jobs 或继续找 Codex 二进制。
function rejectedSay(slug, message) {
  return runTs(`
    import fs from 'node:fs'
    import childProcess from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    import { sayToJob } from './scripts/codex/codex-say.ts'
    const checked = []
    fs.existsSync = file => { checked.push(String(file)); return false }
    const forbiddenIO = () => { throw new Error('拒绝路径不许访问真实工单或启动进程') }
    fs.readFileSync = fs.openSync = fs.appendFileSync = forbiddenIO
    childProcess.spawnSync = childProcess.spawn = forbiddenIO
    syncBuiltinESMExports()
    console.log(JSON.stringify({ result: sayToJob(${JSON.stringify(slug)}, ${JSON.stringify(message)}), checked }))
  `)
}

function assertRejected(result, reason) {
  assert.equal(result.ok, false)
  assert.equal(result.threadId, null)
  assert.equal(result.reply, null)
  assert.equal(result.exitCode, null)
  assert.match(result.error, reason)
}

test('sayToJob：非法 slug 直接拒绝，不碰工单', () => {
  const out = rejectedSay('../escape', '补充消息')
  assertRejected(out.result, /slug/i)
  assert.deepEqual(out.checked, [])
})

test('sayToJob：纯空白消息直接拒绝，不碰工单', () => {
  const out = rejectedSay('valid-job', '   \r\n  ')
  assertRejected(out.result, /消息/)
  assert.deepEqual(out.checked, [])
})

test('sayToJob：状态和事件流均无会话号则拒绝，不启动 Codex', () => {
  const slug = 'missing-thread-id-unit-test'
  const out = rejectedSay(slug, '补充消息')
  assertRejected(out.result, /thread|会话/i)
  assert.deepEqual(out.checked.map(file => resolve(file)), [
    join(REPO_ROOT, '.codex', 'jobs', slug, 'state.json'),
    join(REPO_ROOT, '.codex', 'jobs', slug, 'exec.jsonl'),
  ])
})
