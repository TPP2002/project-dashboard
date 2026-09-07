// 派单器 say 的参数解析与工作目录回落：这两处各踩过一次坑（多行消息被截断、续聊在主工位跑被沙箱拒写）。
// 派单器是 TS，测试经 node --import tsx 起一个子进程把纯函数跑一遍，不碰真 Codex。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const REPO_ROOT = resolve(__dirname, '..')

/** 在 tsx 下执行一段 ESM 代码，stdout 只准打一行 JSON。 */
function runTs(code) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  assert.equal(r.status, 0, 'tsx 子进程失败:\n' + r.stderr)
  const line = r.stdout.trim().split(/\r?\n/).pop()
  return JSON.parse(line)
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

test('say 消息：--message-file 保住多行，CR 去掉、首尾空白剪掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-say-'))
  const file = join(dir, 'msg.txt')
  writeFileSync(file, '  第一行\r\n第二行：带"引号"\r\n\n', 'utf8')
  const out = runTs(
    'import { parseSayArgs, readSayMessage } from "./scripts/codex/codex-say.ts";' +
      'console.log(JSON.stringify(readSayMessage(parseSayArgs(["a-b", "--message-file", ' + JSON.stringify(file) + ']))))',
  )
  assert.equal(out, '第一行\n第二行：带"引号"')
})

test('续聊工作目录：meta.json 里的 cwd 存在就用它，缺了或目录没了回落 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-meta-'))
  const wt = join(dir, 'wt'); mkdirSync(wt)
  const good = join(dir, 'good.json'); writeFileSync(good, JSON.stringify({ cwd: wt }))
  const gone = join(dir, 'gone.json'); writeFileSync(gone, JSON.stringify({ cwd: join(dir, 'not-there') }))
  const broken = join(dir, 'broken.json'); writeFileSync(broken, '{oops')
  const out = runTs(
    'import { cwdFromMeta } from "./scripts/codex/codex-say.ts";' +
      'console.log(JSON.stringify([' + [good, gone, broken, join(dir, 'missing.json')].map((p) => 'cwdFromMeta(' + JSON.stringify(p) + ')').join(',') + ']))',
  )
  assert.equal(out[0], wt)
  assert.equal(out[1], null)
  assert.equal(out[2], null)
  assert.equal(out[3], null)
})
