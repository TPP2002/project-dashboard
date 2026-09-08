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

const report = (over = {}) => ({
  status: 'completed', summary: '补齐了检查', changedFiles: ['test/example.test.cjs'],
  acceptanceResults: [], openQuestions: [], blockers: [], ...over,
})
const passedItem = { id: 'A1', required: true, ran: true, passed: true, exitCode: 0 }
const failedItem = { ...passedItem, passed: false, exitCode: 1 }
const normalizedPaths = paths => paths.map(file => resolve(REPO_ROOT, file))

function verdict(over = {}) {
  const input = {
    slug: 'demo-card', taskId: 'DEMO-CARD', allowedPaths: ['test/example.test.cjs'],
    forbiddenPaths: ['scripts/**', '.codex/jobs/**'], expectArtifacts: ['test/example.test.cjs'],
    taskFrozen: true, exitCode: 0, timedOut: false, markerPrinted: true,
    changedFiles: ['test/example.test.cjs'], existingArtifacts: ['test/example.test.cjs'],
    acceptance: [passedItem], selfReport: report(), ...over,
  }
  return runTs(`
    import { judge } from './scripts/codex/codex-verdict.ts'
    console.log(JSON.stringify(judge(${JSON.stringify(input)})))
  `)
}

function matches(cases) {
  return runTs(`
    import { matchesAny } from './scripts/codex/codex-verdict.ts'
    console.log(JSON.stringify(${JSON.stringify(cases)}.map(([file, patterns]) => matchesAny(file, patterns))))
  `)
}

test('matchesAny：目录通配覆盖自身及整棵子树，但不误伤相邻目录', () => {
  assert.deepEqual(matches([
    ['scripts/codex/deep/a.ts', ['scripts/codex/**']],
    ['scripts/codex', ['scripts/codex/**']],
    ['scripts/codex-extra/a.ts', ['scripts/codex/**']],
  ]), [true, true, false])
})

test('matchesAny：精确路径只匹配自己', () => {
  assert.deepEqual(matches([
    ['test/a.cjs', ['test/a.cjs']], ['test/a.test.cjs', ['test/a.cjs']],
  ]), [true, false])
})

test('matchesAny：单层通配不跨目录分隔符', () => {
  assert.deepEqual(matches([
    ['test/a.test.cjs', ['test/*.test.cjs']], ['test/deep/a.test.cjs', ['test/*.test.cjs']],
  ]), [true, false])
})

test('matchesAny：文件和模式中的 Windows 反斜杠都归一', () => {
  assert.deepEqual(matches([
    ['scripts\\codex\\a.ts', ['scripts/codex/**']],
    ['scripts/codex/a.ts', ['scripts\\codex\\**']],
  ]), [true, true])
})

test('matchesAny：空清单永不命中', () => {
  assert.deepEqual(matches([['test/a.test.cjs', []]]), [false])
})

test('judge：证据齐全则 accepted，保留机器验收记录', () => {
  const v = verdict()
  assert.equal(v.finalStatus, 'accepted')
  assert.deepEqual(v.reasons, [])
  assert.deepEqual(v.acceptance, [passedItem])
})

test('judge：工单哈希改过压过禁区、越界、超时和待拍板', () => {
  const v = verdict({
    taskFrozen: false, changedFiles: ['scripts/codex/a.ts', 'other.cjs'],
    timedOut: true, markerPrinted: false, existingArtifacts: [], acceptance: [failedItem],
    selfReport: report({ status: 'blocked', openQuestions: ['要拍板'] }),
  })
  assert.equal(v.finalStatus, 'rejected')
  assert.equal(v.reasons.length, 1)
  assert.match(v.reasons[0], /工单.*哈希/)
})

test('judge：禁区先记、施工面外后记，二者都压过 blocked', () => {
  const v = verdict({
    changedFiles: ['scripts/codex/a.ts', 'other.cjs'], timedOut: true,
    selfReport: report({ status: 'blocked', openQuestions: ['要拍板'] }),
  })
  assert.equal(v.finalStatus, 'rejected')
  assert.deepEqual(normalizedPaths(v.forbiddenTouched), normalizedPaths(['scripts/codex/a.ts']))
  assert.deepEqual(normalizedPaths(v.outsideAllowed), normalizedPaths(['other.cjs']))
  assert.equal(v.reasons.length, 2)
  assert.match(v.reasons[0], /禁区/)
  assert.match(v.reasons[1], /施工面/)
})

test('judge：施工面之外的改动压过进程超时无结论', () => {
  const v = verdict({ changedFiles: ['test/other.test.cjs'], timedOut: true, selfReport: null })
  assert.equal(v.finalStatus, 'rejected')
  assert.deepEqual(normalizedPaths(v.outsideAllowed), normalizedPaths(['test/other.test.cjs']))
  assert.equal(v.reasons.length, 1)
  assert.match(v.reasons[0], /施工面/)
})

test('judge：超时且没交结论判 crashed，压过缺标记与产物', () => {
  const v = verdict({ timedOut: true, exitCode: null, selfReport: null, markerPrinted: false, existingArtifacts: [] })
  assert.equal(v.finalStatus, 'crashed')
  assert.equal(v.reasons.length, 1)
  assert.match(v.reasons[0], /超时/)
})

test('judge：非零退出码且无结论也判 crashed', () => {
  const v = verdict({ exitCode: 1, selfReport: null })
  assert.equal(v.finalStatus, 'crashed')
  assert.match(v.reasons[0], /退出码 1/)
})

test('judge：自述 blocked 即使没有开放问题也优先等人拍板', () => {
  const v = verdict({
    timedOut: true, markerPrinted: false, existingArtifacts: [], acceptance: [failedItem],
    selfReport: report({ status: 'blocked', openQuestions: [] }),
  })
  assert.equal(v.finalStatus, 'blocked')
  assert.deepEqual(v.openQuestions, [])
  assert.equal(v.reasons.length, 1)
  assert.match(v.reasons[0], /拍板/)
})

test('judge：自称 completed 但有开放问题仍判 blocked', () => {
  const v = verdict({ markerPrinted: false, selfReport: report({ openQuestions: ['A 还是 B?'] }) })
  assert.equal(v.finalStatus, 'blocked')
  assert.deepEqual(v.openQuestions, ['A 还是 B?'])
  assert.equal(v.reasons.length, 1)
})

test('judge：缺完工标记拒收，按标记、产物、必过断言顺序记录', () => {
  const v = verdict({ markerPrinted: false, existingArtifacts: [], acceptance: [failedItem] })
  assert.equal(v.finalStatus, 'rejected')
  assert.equal(v.reasons.length, 3)
  assert.match(v.reasons[0], /标记/)
  assert.match(v.reasons[1], /文件不存在/)
  assert.match(v.reasons[2], /A1.*机器复核未通过/)
})

test('judge：说好要交的产物不在则 rejected', () => {
  const v = verdict({ existingArtifacts: [] })
  assert.equal(v.finalStatus, 'rejected')
  assert.deepEqual(normalizedPaths(v.missingArtifacts), normalizedPaths(['test/example.test.cjs']))
})

test('judge：必过断言机器复核未过，施工方自称全绿也不采信', () => {
  const v = verdict({
    acceptance: [failedItem],
    selfReport: report({ acceptanceResults: [{ id: 'A1', ran: true, passed: true, evidence: '我跑过了' }] }),
  })
  assert.equal(v.finalStatus, 'rejected')
  assert.match(v.reasons.join(' '), /A1.*机器复核未通过/)
  assert.deepEqual(v.acceptance, [failedItem])
})

test('judge：必过断言没跑起来不能空过', () => {
  const v = verdict({ acceptance: [{ ...failedItem, ran: false, exitCode: null }] })
  assert.equal(v.finalStatus, 'rejected')
  assert.match(v.reasons.join(' '), /A1.*没跑起来/)
})

test('judge：可选断言失败或未跑只登记，不否决整单', () => {
  const optional = [
    { ...failedItem, id: 'A2', required: false },
    { ...failedItem, id: 'A3', required: false, ran: false, exitCode: null },
  ]
  const v = verdict({ acceptance: [passedItem, ...optional] })
  assert.equal(v.finalStatus, 'accepted')
  assert.deepEqual(v.reasons, [])
  assert.deepEqual(v.acceptance, [passedItem, ...optional])
  assert.equal(v.warnings.length, 2)
  assert.match(v.warnings[0], /A2/)
  assert.match(v.warnings[1], /A3/)
})

test('judge：人工必过项不自动执行，只登记人工核对提示', () => {
  const v = verdict({ acceptance: [{ ...failedItem, manual: true, ran: false, exitCode: null }] })
  assert.equal(v.finalStatus, 'accepted')
  assert.match(v.warnings.join(' '), /A1.*人工项/)
})

function parseReport(raw) {
  return runTs(`
    import { parseSelfReport } from './scripts/codex/codex-verdict.ts'
    console.log(JSON.stringify(parseSelfReport(${JSON.stringify(raw)})))
  `)
}

test('parseSelfReport：标准 JSON 直接解析', () => {
  assert.deepEqual(parseReport(JSON.stringify(report())), report())
})

test('parseSelfReport：从 markdown 围栏和前后说明中抽取 JSON', () => {
  const expected = report({ status: 'blocked', openQuestions: ['?'] })
  assert.deepEqual(parseReport('说明文字\n```json\n' + JSON.stringify(expected) + '\n```\n结束'), expected)
})

test('parseSelfReport：非 JSON 或空白返回 null，不抛错', () => {
  for (const raw of ['我做完啦!', '', '   ', '{broken']) assert.equal(parseReport(raw), null)
})

test('parseSelfReport：未知 status 归一到 partial', () => {
  const parsed = parseReport(JSON.stringify(report({ status: '随便写的' })))
  assert.equal(parsed.status, 'partial')
})

test('VERDICT_SCHEMA：summary 只讲作用、完成情况和是否需要人处理', () => {
  const description = runTs(`
    import { VERDICT_SCHEMA } from './scripts/codex/codex-verdict.ts'
    console.log(JSON.stringify(VERDICT_SCHEMA.properties.summary.description))
  `)
  for (const phrase of ['不懂代码', '这活是干什么的', '干完了没有', '有没有需要人处理的问题']) {
    assert.ok(description.includes(phrase), phrase)
  }
  assert.match(description, /文件名.*命令.*测试编号.*错误码.*代码符号.*技术术语/)
  assert.ok(description.includes('技术细节放其他字段'))
})
