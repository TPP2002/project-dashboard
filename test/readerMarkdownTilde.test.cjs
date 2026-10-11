const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

const REPO_ROOT = resolve(__dirname, '..')

/**
 * readerMarkdownTilde.test.cjs —— 锁审阅台正文的波浪号规则(READER-SINGLE-TILDE-STRIKETHROUGH-1012):
 *   · 单波浪号区间写法(「1~5 与 6~9」)按字面输出,不再配对成删除线;
 *   · 成对双波浪号(~~字~~)仍是删除线;
 *   · 行内代码与围栏代码里的波浪号不受影响;
 *   · 导入转换器把 html 删除线写成双波浪号,渲染回来仍是删除线。
 * 渲染/转换模块经 tsx 独立加载,一个子进程把全部样例一次算完,父进程逐条整串断言;
 * 样例全部由父进程 JSON.stringify 注入,免得反引号、换行在代码串里转义出错。
 */
function runTs(code) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  assert.equal(r.status, 0, 'tsx 子进程失败:\n' + r.stderr)
  const line = r.stdout.trim().split(/\r?\n/).pop()
  return JSON.parse(line)
}

const INPUTS = {
  r1: 'a~b 与 c~d',
  r2: '看板卡的 d1~d15 与本文 Q1~Q15 一一对应',
  r3: '140~200 万,Q3~Q5',
  r4: '~单个包住~',
  r5: '| 列 |\n|---|\n| 1~5 与 6~9 |',
  r6: '~~作废~~',
  r7: '前 ~~删掉~~ 后 1~5 与 6~9',
  r8: '`~a~` 与 ~~x~~',
  r9: '~~~\ncode ~a~\n~~~',
  i1: '<p>甲<del>作废</del>乙 <s>旧</s> <strike>老</strike></p>',
  i3: '<p>区间 1~5 与 6~9 不是删除线</p>',
}

const out = runTs(`
  import { renderMarkdown } from './web/src/utils/reader/markdown.ts'
  import { htmlToMd } from './web/src/utils/reportImport/htmlToMd.ts'
  const s = ${JSON.stringify(INPUTS)}
  const render = (md) => renderMarkdown(md).trim()
  const i1 = (await htmlToMd(s.i1)).md
  const i3 = (await htmlToMd(s.i3)).md
  console.log(JSON.stringify({
    r1: render(s.r1), r2: render(s.r2), r3: render(s.r3), r4: render(s.r4), r5: render(s.r5),
    r6: render(s.r6), r7: render(s.r7), r8: render(s.r8), r9: render(s.r9),
    i1, i2: render(i1), i3, i3r: render(i3),
  }))
`)

test('单波浪号按字面输出,不再配对成删除线', () => {
  assert.equal(out.r1, '<p>a~b 与 c~d</p>')
  assert.equal(out.r2, '<p>看板卡的 d1~d15 与本文 Q1~Q15 一一对应</p>')
  assert.equal(out.r3, '<p>140~200 万,Q3~Q5</p>')
  assert.equal(out.r4, '<p>~单个包住~</p>')
  assert.ok(out.r5.includes('<td>1~5 与 6~9</td>'), '表格单元格保持区间写法:\n' + out.r5)
  assert.ok(!out.r1.includes('<del') && !out.r2.includes('<del') && !out.r3.includes('<del')
    && !out.r4.includes('<del') && !out.r5.includes('<del'), '单波浪号不得产生删除线')
})

test('成对双波浪号仍是删除线', () => {
  assert.equal(out.r6, '<p><del>作废</del></p>')
  assert.equal(out.r7, '<p>前 <del>删掉</del> 后 1~5 与 6~9</p>')
})

test('行内代码与围栏代码里的波浪号不受影响', () => {
  assert.equal(out.r8, '<p><code>~a~</code> 与 <del>x</del></p>')
  assert.ok(out.r9.startsWith('<pre><code>code ~a~'), '围栏代码开头:\n' + out.r9)
  assert.ok(out.r9.endsWith('</code></pre>'), '围栏代码结尾:\n' + out.r9)
  assert.ok(!out.r9.includes('<del'), '围栏代码里不得产生删除线')
})

test('导入转换器把删除线写成双波浪号,渲染回来仍是删除线', () => {
  assert.equal(out.i1, '甲~~作废~~乙 ~~旧~~ ~~老~~')
  assert.equal(out.i2, '<p>甲<del>作废</del>乙 <del>旧</del> <del>老</del></p>')
  assert.equal(out.i3, '区间 1~5 与 6~9 不是删除线')
  assert.equal(out.i3r, '<p>区间 1~5 与 6~9 不是删除线</p>')
})