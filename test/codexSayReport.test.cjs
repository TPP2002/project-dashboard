// 续聊回话里的新结论要回写 last-message.json（AD-20260908-CODEX-SAY-REPORT）。
// 0908 实测的坑：say 补做完之后，Codex 的新结论只打在 stdout，last-message.json 还是续聊前那份，
// collect 继续按旧自述判 blocked（wf-zoom / aud-hooks-dedup 两单：文件已改完、机器验收全绿，判决却是旧的）。
// 这份测试钉三件事：认得出成形的结论、认不出就一个字都不改、写回时同步补记续聊时刻。
// 派单器是 TS，测试经 node --import tsx 起一个子进程把纯函数跑一遍，不碰真 Codex、不碰真工单目录。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

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

/** 一份完整、合格的结论。各用例在它上面改一处，用来划"认/不认"的边界。 */
function verdictObject(overrides = {}) {
  return {
    status: 'completed',
    summary: '这活是把续聊之后的新结论存下来，已经做完了，不需要人处理。',
    changedFiles: ['scripts/codex/codex-say.ts'],
    acceptanceResults: [{ id: 'A1', ran: false, passed: false, evidence: '按工单要求没有自己跑验收' }],
    openQuestions: [],
    blockers: [],
    ...overrides,
  }
}

/** 仿真 `codex exec resume` 的 stdout：前有表头、中间回显我们发的话、后有 token 计数。 */
function resumeStdout(body) {
  return [
    '[2026-09-08T21:30:00] OpenAI Codex v0.151.0 (research preview)',
    '--------',
    'workdir: (略)',
    'model: gpt-6-astra',
    'sandbox: read-only',
    '--------',
    '[2026-09-08T21:30:01] User instructions:',
    '把测试补上，然后把最终结论重发一遍（openQuestions 清空 {}）',
    '[2026-09-08T21:33:12] codex',
    body,
    '[2026-09-08T21:33:13] tokens used: 40213',
  ].join('\n')
}

function extractVerdictJson(raw) {
  return runTs(
    'import { extractVerdictJson } from "./scripts/codex/codex-say.ts";' +
      'console.log(JSON.stringify(extractVerdictJson(' + JSON.stringify(raw) + ')))',
  )
}

test('jsonObjectSlices：配平地切出每个顶层对象，字符串里的括号不算数', () => {
  const raw = '前言 {"a":1,"b":{"c":2}} 中间 {"text":"这里有个 { 和 }"} 尾巴 {没配平的';
  const out = runTs(
    'import { jsonObjectSlices } from "./scripts/codex/codex-say.ts";' +
      'console.log(JSON.stringify(jsonObjectSlices(' + JSON.stringify(raw) + ')))',
  )
  assert.deepEqual(out, ['{"a":1,"b":{"c":2}}', '{"text":"这里有个 { 和 }"}'])
})

test('extractVerdictJson：从带表头和回显的回话里认出结论原文', () => {
  const verdict = verdictObject()
  const got = extractVerdictJson(resumeStdout(JSON.stringify(verdict, null, 2)))
  assert.notEqual(got, null, '成形的结论必须认出来')
  assert.deepEqual(JSON.parse(got), verdict)
})

test('extractVerdictJson：回话里有多份结论时取最后那份（这一轮的才算数）', () => {
  const older = verdictObject({ status: 'blocked', openQuestions: ['旧的那个选择题'] })
  const latest = verdictObject({ summary: '这一轮补做完了，不需要人处理。' })
  const got = extractVerdictJson(
    resumeStdout('上一轮我交的是：\n' + JSON.stringify(older) + '\n现在补做完了，最终结论：\n' + JSON.stringify(latest)),
  )
  assert.deepEqual(JSON.parse(got), latest)
})

test('extractVerdictJson：认不出就返回 null —— 散文、缺字段、状态不在枚举里、数组字段不是数组', () => {
  const cases = {
    散文: resumeStdout('我把测试补上了，你再收一次吧。'),
    空对象: resumeStdout('{}'),
    缺必填字段: resumeStdout(JSON.stringify({ status: 'completed', summary: '干完了' })),
    状态不在枚举里: resumeStdout(JSON.stringify(verdictObject({ status: 'done' }))),
    数组字段不是数组: resumeStdout(JSON.stringify(verdictObject({ changedFiles: 'codex-say.ts' }))),
    摘要不是字符串: resumeStdout(JSON.stringify(verdictObject({ summary: 42 }))),
    空回话: '',
  }
  for (const [name, raw] of Object.entries(cases)) {
    assert.equal(extractVerdictJson(raw), null, name + ' 不该被当成结论')
  }
})

// sayToJob 的落盘路径：把 fs 和 child_process 全换成假的，既不启动 Codex 也不碰真工单目录。
// 断言看的是"到底往哪个文件写了什么"，这正是 0908 那个坑的所在。
function sayWithReply(stdout, statePatch = {}) {
  // 被测模块必须**先**静态导入：import 是提升的，会在下面这些替身装上之前跑完，
  // 否则 tsx 的加载器自己要用 fs 读源码，当场被假 fs 绊住（第一版就这么翻的）。
  return runTs(`
    import fs from 'node:fs'
    import childProcess from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    import { sayToJob } from './scripts/codex/codex-say.ts'

    const stateBefore = { pid: 4242, startedAt: '2026-09-08T20:00:00.000Z', finishedAt: '2026-09-08T21:00:00.000Z',
      exitCode: 0, timedOut: false, threadId: '01a-session', ...${JSON.stringify(statePatch)} }
    const writes = []
    fs.existsSync = () => true
    fs.readFileSync = (file) => {
      const p = String(file).replace(/\\\\/g, '/')
      if (p.endsWith('state.json')) return JSON.stringify(stateBefore)
      if (p.endsWith('meta.json')) return JSON.stringify({ cwd: process.cwd() })
      throw new Error('拒绝读真文件:' + p)
    }
    fs.writeFileSync = (file, content) => { writes.push({ file: String(file).replace(/\\\\/g, '/'), content }) }
    fs.appendFileSync = () => {}
    fs.openSync = () => { throw new Error('不该去翻事件流:state.json 里已经有会话号了') }
    childProcess.spawnSync = () => ({ status: 0, stdout: ${JSON.stringify(stdout)}, stderr: '', error: undefined })
    syncBuiltinESMExports()

    process.env.CODEX_BIN = process.execPath
    console.log(JSON.stringify({ result: sayToJob('say-report-unit-test', '把结论重发一遍'), writes }))
  `)
}

function pick(writes, suffix) {
  return writes.filter((w) => w.file.endsWith(suffix))
}

test('sayToJob：回话带回成形结论 → 覆盖 last-message.json，并补记两个时刻', () => {
  const verdict = verdictObject()
  const out = sayWithReply(resumeStdout(JSON.stringify(verdict, null, 2)))
  assert.equal(out.result.ok, true)
  assert.equal(out.result.reportRefreshed, true)

  const [written, ...extra] = pick(out.writes, 'last-message.json')
  assert.equal(extra.length, 0, 'last-message.json 只该写一次')
  assert.ok(written, '认出结论就必须回写 last-message.json，否则 collect 还按旧自述判')
  assert.deepEqual(JSON.parse(written.content), verdict)

  const [state] = pick(out.writes, 'state.json')
  const parsed = JSON.parse(state.content)
  assert.equal(parsed.pid, 4242, 'state.json 原有字段不许被覆盖掉')
  assert.equal(parsed.threadId, '01a-session')
  assert.ok(Date.parse(parsed.resumedAt) > 0, 'resumedAt 要是个时刻')
  assert.equal(parsed.selfReportUpdatedAt, parsed.resumedAt, '这一轮刷新了自述，两个时刻应当一致')
})

test('sayToJob：回话认不出结论 → last-message.json 一个字都不动，只记续聊过', () => {
  const out = sayWithReply(resumeStdout('测试补上了，你再收一次吧。'))
  assert.equal(out.result.ok, true)
  assert.equal(out.result.reportRefreshed, false)
  assert.deepEqual(pick(out.writes, 'last-message.json'), [], '认不出结论就不许覆盖，宁可让 collect 用旧的')

  const [state] = pick(out.writes, 'state.json')
  const parsed = JSON.parse(state.content)
  assert.ok(Date.parse(parsed.resumedAt) > 0)
  assert.equal(parsed.selfReportUpdatedAt, null, '没刷新就得留 null，collect 靠它印那行警告')
})

test('sayToJob：认不出结论时，上一次刷新的时刻要保留下来（不能被这次续聊抹平）', () => {
  const earlier = '2026-09-08T21:00:00.000Z'
  const out = sayWithReply(resumeStdout('好的，我看看。'), { selfReportUpdatedAt: earlier })
  const [state] = pick(out.writes, 'state.json')
  assert.equal(JSON.parse(state.content).selfReportUpdatedAt, earlier)
})
