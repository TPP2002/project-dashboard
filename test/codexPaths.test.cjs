const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { join, resolve, sep } = require('node:path')

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

test('jobPaths：所有产物落在工单目录且文件名固定，包括续聊记录', () => {
  // 只比较路径字符串，不检查或创建真实工单目录。
  const out = runTs(`
    import { REPO_ROOT, JOBS_ROOT, jobPaths } from './scripts/codex/codex-paths.ts'
    console.log(JSON.stringify({ root: REPO_ROOT, jobs: JOBS_ROOT, paths: jobPaths('paths-unit-test') }))
  `)
  assert.equal(resolve(out.root), REPO_ROOT)
  assert.equal(resolve(out.jobs), join(REPO_ROOT, '.codex', 'jobs'))
  const dir = join(REPO_ROOT, '.codex', 'jobs', 'paths-unit-test')
  const names = {
    task: 'task.json', meta: 'meta.json', prompt: 'prompt.txt', execLog: 'exec.jsonl',
    lastMessage: 'last-message.json', verdict: 'verdict.json', state: 'state.json',
    chatLog: 'chat.jsonl', acceptanceLogDir: 'acceptance',
  }
  assert.deepEqual(Object.keys(out.paths).sort(), ['dir', ...Object.keys(names)].sort())
  assert.equal(resolve(out.paths.dir), dir)
  for (const [key, filename] of Object.entries(names)) assert.equal(resolve(out.paths[key]), join(dir, filename), key)
})

// 工作区根**不许**再落在 .codex 底下：Codex 沙箱把「工作目录里的 .codex」当自己的配置目录，
// 给沙箱用户加一条继承式拒写 ACE，工作区建在它底下会被自己锁住（0908 aud-notify-fresh 实踩）。
// 这条断言就是那根钉子：谁把根挪回 .codex 里，这里当场红。
test('worktreeFor：工作区根在 .codex 之外、仍在仓库根下，分支固定为 codex/<slug>', () => {
  const out = runTs(`
    import { CODEX_WORKTREES_ROOT, worktreeFor } from './scripts/codex/codex-paths.ts'
    console.log(JSON.stringify({ root: CODEX_WORKTREES_ROOT, worktree: worktreeFor('paths-unit-test') }))
  `)
  assert.equal(resolve(out.root), join(REPO_ROOT, '.codex-worktrees'))
  assert.equal(resolve(out.worktree.path), join(REPO_ROOT, '.codex-worktrees', 'paths-unit-test'))
  assert.equal(out.worktree.branch, 'codex/paths-unit-test')

  const dotCodex = join(REPO_ROOT, '.codex')
  assert.ok(!resolve(out.root).startsWith(dotCodex + sep), '工作区根不许在 .codex 底下：' + out.root)
  // 仍要留在仓库根下，否则看板的 Codex 会话面板认不出这条会话属于哪个项目。
  assert.ok(resolve(out.root).startsWith(REPO_ROOT + sep), '工作区根要留在仓库根下：' + out.root)
})

test('legacyWorktreePathFor：老根下的路径还认得出来，好让改根之前派出去的单收得掉', () => {
  const out = runTs(`
    import { LEGACY_CODEX_WORKTREES_ROOT, legacyWorktreePathFor } from './scripts/codex/codex-paths.ts'
    console.log(JSON.stringify({ root: LEGACY_CODEX_WORKTREES_ROOT, path: legacyWorktreePathFor('paths-unit-test') }))
  `)
  assert.equal(resolve(out.root), join(REPO_ROOT, '.codex', 'worktrees'))
  assert.equal(resolve(out.path), join(REPO_ROOT, '.codex', 'worktrees', 'paths-unit-test'))
})
