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

const acceptance = [
  { id: 'A1', kind: 'test:targeted', target: 'test/example.test.cjs', required: true },
  { id: 'A2', kind: 'test:all', required: true },
  { id: 'A3', kind: 'web:typecheck', required: true },
  { id: 'A4', kind: 'web:build', required: true },
  { id: 'A5', kind: 'web:no-emoji', required: true },
  { id: 'A6', kind: 'manual', required: false, note: '人眼看一下措辞' },
]

function rendered() {
  return runTs(`
    import { parseTask, acceptanceDescription, resolveAcceptanceArgv } from './scripts/codex/codex-contract.ts'
    import { renderPrompt } from './scripts/codex/codex-prompt.ts'
    const task = parseTask({
      schemaVersion: 1, taskId: 'DEMO-CARD', slug: 'demo-card', title: '示例任务',
      goal: '演示验收段怎么渲染', allowedPaths: ['test/example.test.cjs'],
      acceptance: ${JSON.stringify(acceptance)},
    })
    console.log(JSON.stringify({
      prompt: renderPrompt(task), descriptions: task.acceptance.map(acceptanceDescription),
      argv: task.acceptance.map(resolveAcceptanceArgv),
    }))
  `)
}

test('验收指令：整份指令不递出任何完整可执行验收命令', () => {
  const { prompt, argv } = rendered()
  // 描述里允许提工具名；禁止的是可以直接运行的完整验收 argv。
  for (const command of argv.filter(Boolean)) assert.ok(!prompt.includes(command.join(' ')), command.join(' '))
  assert.doesNotMatch(prompt, /npx vitest|npm run typecheck|npm run test:fast|npm run lint/)
})

test('验收指令：明确交派单器统一重跑，施工方一律 ran=false', () => {
  const { prompt } = rendered()
  assert.ok(prompt.includes('这些你不要自己跑'))
  assert.ok(prompt.includes('由派单器在你交活之后统一重跑'))
  assert.ok(prompt.includes('acceptanceResults 一律填 ran=false'))
  assert.ok(prompt.includes('web/node_modules 是指向主工位的目录联接'))
  assert.ok(prompt.includes('沙箱会拦住它的写入'))
  assert.ok(prompt.includes('vue-tsc / vite 起不来'))
})

test('验收指令：禁止验收命令仍保留轻量自查', () => {
  const { prompt } = rendered()
  assert.ok(prompt.includes('这不妨碍你用别的轻量办法自查'))
  assert.ok(prompt.includes('比如读代码、跑一小段 node -e 验算'))
  assert.ok(prompt.includes('禁的只是去跑上面这些验收命令'))
})

test('验收指令：逐条给出编号、必过与否、内容、目标及备注', () => {
  const { prompt } = rendered()
  const lines = prompt.split('\n').filter(line => /^  - \[A\d+\]/.test(line))
  assert.deepEqual(lines, [
    '  - [A1] 必过 · 定向跑指定测试文件(test/xxx.test.cjs):test/example.test.cjs',
    '  - [A2] 必过 · 看板全量单测(node --test,与 CI 等价)',
    '  - [A3] 必过 · 前端类型检查(vue-tsc --noEmit)',
    '  - [A4] 必过 · 前端打包(vite build,改了前端必跑)',
    '  - [A5] 必过 · 界面禁 emoji 扫描(改了 web/src 必跑)',
    '  - [A6] 可选 · 人工核对(派单器不自动跑,只登记)  // 人眼看一下措辞',
  ])
})

test('acceptanceDescription：描述检查内容并保留定向目标', () => {
  assert.deepEqual(rendered().descriptions, [
    '定向跑指定测试文件(test/xxx.test.cjs):test/example.test.cjs',
    '看板全量单测(node --test,与 CI 等价)',
    '前端类型检查(vue-tsc --noEmit)',
    '前端打包(vite build,改了前端必跑)',
    '界面禁 emoji 扫描(改了 web/src 必跑)',
    '人工核对(派单器不自动跑,只登记)',
  ])
})

test('resolveAcceptanceArgv：派单器仍拿到本仓库的真实命令模板', () => {
  assert.deepEqual(rendered().argv, [
    ['node', '--test', 'test/example.test.cjs'],
    ['npm', 'test'],
    ['npm', '--prefix', 'web', 'run', 'typecheck'],
    ['npm', '--prefix', 'web', 'run', 'build'],
    ['npm', '--prefix', 'web', 'run', 'check:no-emoji'],
    null,
  ])
})
