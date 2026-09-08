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

function prompt() {
  return runTs(`
    import { parseTask } from './scripts/codex/codex-contract.ts'
    import { renderPrompt } from './scripts/codex/codex-prompt.ts'
    console.log(JSON.stringify(renderPrompt(parseTask({
      schemaVersion: 1, taskId: 'DEMO-CARD', slug: 'demo-card', title: '示例任务',
      goal: '让负责人能快速看懂结果', allowedPaths: ['test/example.test.cjs'],
      forbiddenPaths: ['scripts/**'], nonGoals: ['不改业务逻辑'],
      acceptance: [{ id: 'A1', kind: 'web:typecheck' }],
      expectArtifacts: ['test/example.test.cjs'], worktree: true,
    }))))
  `)
}

test('renderPrompt：必读指路为本仓库 AGENTS.md 和 Codex 派单须知', () => {
  const text = prompt()
  assert.match(text, /AGENTS\.md —— 本仓库给所有 AI 协作者的常驻须知/)
  assert.match(text, /docs\/开工须知-Codex派单\.md —— 本仓库的派单口径/)
  assert.ok(text.includes('看板登记由派单方代做'))
  assert.ok(text.includes('web/src/icons'))
  assert.ok(text.includes('web/src/styles/base.css'))
  assert.ok(text.includes('localStorage 且读回时逐字段校验'))
  assert.ok(text.includes('prefers-reduced-motion'))
})

test('renderPrompt：完工标记逐字绑定工单 slug', () => {
  const marker = runTs(`
    import { completionMarker } from './scripts/codex/codex-prompt.ts'
    console.log(JSON.stringify(completionMarker('demo-card')))
  `)
  assert.equal(marker, 'CODEX-DONE::demo-card')
  assert.ok(prompt().split('\n').some(line => line.trim() === marker))
})

test('renderPrompt：三条硬约束要求禁止 git 写入、零决策和保护工单', () => {
  const text = prompt()
  assert.ok(text.includes('1. **不许做任何 git 写操作**'))
  assert.match(text, /不 commit、不 push、不 checkout\/switch、不 reset/)
  assert.match(text, /不 merge\/rebase、不 stash、不建删分支/)
  assert.ok(text.includes('2. **不许自己拍板**'))
  assert.ok(text.includes('openQuestions,status 交 blocked'))
  assert.ok(text.includes('3. **不许改工单目录 .codex/jobs/**'))
})

test('renderPrompt：summary 只回答三件事，技术证据留在其他字段', () => {
  const text = prompt()
  assert.ok(text.includes('summary 是看板直接给不懂代码的负责人看的'))
  for (const phrase of ['这活是干什么的', '干完了没有', '有没有需要人处理的问题']) {
    assert.ok(text.includes(phrase), phrase)
  }
  assert.match(text, /不要写文件名.*命令.*测试编号.*错误码.*代码符号.*技术术语/)
  assert.ok(text.includes('技术细节放进 changedFiles、acceptanceResults 和 blockers'))
  assert.ok(text.includes('最后一条消息**必须是一个 JSON 对象'))
})
