/**
 * Codex 派单单的契约与安全闸(CODEX-BRIDGE-DISPATCH,2026-09-01)。
 *
 * 【定位】派单侧(Claude)与判读侧(派单器)共用的**唯一口径**:工单长什么样、合不合法、
 * 每条验收该跑哪条命令。本文件是纯函数,不碰进程、不碰文件系统、不看平台——
 * 平台差异(npm 在 Windows 上要写 npm.cmd)由 codex-runner 解决,放这里会让单测跟着机器漂。
 *
 * 【为什么验收项是"点菜制"】Codex 是**带 workspace-write 权限在本仓库里跑**的,
 * 它能改仓库里任何文件——包括它自己的工单。若验收命令是工单里的一行字符串,
 * 它把那行改成 echo ok 就能自己给自己判过,整套派单的可信度归零。
 * 所以工单只能**点作业名 + 填受限参数**,命令模板写死在下面这张表里;
 * 工单文件本身另有冻结哈希复核(见 codex-verdict.ts)。这条口径与集群工单
 * (scripts/bot/cluster-job.ts)同源,那边的教训是"白名单挡不住 node -e 任意代码"。
 */

/** 工单目录:Codex 永远不许改自己的工单,写死进禁区。 */
export const JOB_DIR_FORBIDDEN = '.codex/jobs/**'

/** 验收作业模板。argv 为 null = 人工核,派单器不自动跑。 */
export const ACCEPTANCE_KINDS: Record<
  string,
  { needsTarget: boolean; argv: ((target?: string) => string[]) | null; desc: string }
> = {
  // 看板仓库的作业菜单(与 来源仓 那份的差别:单测是 node --test 的 .cjs,前端在 web/ 子目录)。
  'test:targeted': {
    needsTarget: true,
    argv: (target) => ['node', '--test', target as string],
    desc: '定向跑指定测试文件(test/xxx.test.cjs)',
  },
  'test:all': {
    needsTarget: false,
    argv: () => ['npm', 'test'],
    desc: '看板全量单测(node --test,与 CI 等价)',
  },
  'web:typecheck': {
    needsTarget: false,
    argv: () => ['npm', '--prefix', 'web', 'run', 'typecheck'],
    desc: '前端类型检查(vue-tsc --noEmit)',
  },
  'web:build': {
    needsTarget: false,
    argv: () => ['npm', '--prefix', 'web', 'run', 'build'],
    desc: '前端打包(vite build,改了前端必跑)',
  },
  'web:no-emoji': {
    needsTarget: false,
    argv: () => ['npm', '--prefix', 'web', 'run', 'check:no-emoji'],
    desc: '界面禁 emoji 扫描(改了 web/src 必跑)',
  },
  manual: {
    needsTarget: false,
    argv: null,
    desc: '人工核对(派单器不自动跑,只登记)',
  },
}

export type AcceptanceKind = keyof typeof ACCEPTANCE_KINDS

export interface AcceptanceItem {
  id: string
  kind: string
  /** 仅 needsTarget 的作业使用;必须是仓库内相对路径,不许越狱、不许夹带 shell 元字符。 */
  target?: string
  /** required=false 的项失败不否决整单,但一律如实登记。 */
  required: boolean
  note?: string
}

export interface CodexTask {
  schemaVersion: 1
  taskId: string
  slug: string
  title: string
  goal: string
  background: string
  allowedPaths: string[]
  forbiddenPaths: string[]
  nonGoals: string[]
  acceptance: AcceptanceItem[]
  expectArtifacts: string[]
  sandbox: 'read-only' | 'workspace-write'
  cwd: string | null
  worktree: boolean
  model: string | null
  timeoutSec: number
}

export const acceptanceKindNames = (): string[] => Object.keys(ACCEPTANCE_KINDS)

export const acceptanceKindMenu = (): string =>
  Object.entries(ACCEPTANCE_KINDS)
    .map(([name, spec]) => '  ' + name.padEnd(18) + ' ' + spec.desc)
    .join('\n')

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/

/**
 * slug 合法性单独导出:它会被拼进目录名、分支名,以及 herdr 外壳里的 shell 命令。
 * 凡是从 argv 直接拿到 slug 的入口(不走 parseTask 的那些),用它先卡一道。
 */
export const isValidSlug = (slug: unknown): slug is string =>
  typeof slug === 'string' && SLUG_RE.test(slug)

/** 只放行"看起来像仓库内相对路径"的字符,把 shell 元字符、绝对路径、越狱一次挡掉。 */
const TARGET_RE = /^[A-Za-z0-9._/-]+$/

// 必须**显式标注整个函数类型**(而不是只写返回值 `: never`):
// 只有这样 TS 才会把 `if (!spec) fail(...)` 之后的分支当成走不到,
// 后面用 spec 才不用再补一次判空。这是 noUncheckedIndexedAccess 下的必需写法。
const fail: (msg: string) => never = (msg) => {
  throw new Error('[codex-contract] ' + msg)
}

const asStringArray = (value: unknown, field: string): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(field + ' 必须是字符串数组')
  }
  return (value as string[]).map((s) => s.trim()).filter((s) => s.length > 0)
}

/** 校验单条验收项;target 的安全闸也在这里。 */
const parseAcceptanceItem = (raw: unknown, index: number): AcceptanceItem => {
  if (typeof raw !== 'object' || raw === null) fail('acceptance[' + index + '] 必须是对象')
  const item = raw as Record<string, unknown>
  const id = typeof item.id === 'string' ? item.id.trim() : ''
  if (!id) fail('acceptance[' + index + '].id 不能为空')

  const kind = typeof item.kind === 'string' ? item.kind.trim() : ''
  const spec = ACCEPTANCE_KINDS[kind]
  if (!spec) {
    fail(
      'acceptance[' + index + '].kind="' + kind + '" 不是可用作业名。可用清单:\n' + acceptanceKindMenu(),
    )
  }

  let target: string | undefined
  if (spec.needsTarget) {
    target = typeof item.target === 'string' ? item.target.trim() : ''
    if (!target) fail('acceptance[' + index + '](' + kind + ') 缺 target')
    if (!TARGET_RE.test(target)) {
      fail('acceptance[' + index + '].target="' + target + '" 含非法字符(只许 A-Za-z0-9._/-)')
    }
    if (target.startsWith('/') || target.startsWith('.') || target.includes('..')) {
      fail('acceptance[' + index + '].target="' + target + '" 必须是仓库内相对路径,不许绝对路径或 ..')
    }
  }

  // 注意:工单里若夹带 command 字段,这里**直接无视**——命令一律由 ACCEPTANCE_KINDS 模板产出。
  return {
    id,
    kind,
    ...(target ? { target } : {}),
    required: item.required !== false,
    ...(typeof item.note === 'string' && item.note.trim() ? { note: item.note.trim() } : {}),
  }
}

/**
 * 把一条验收项翻成「要检查什么」的人话。
 *
 * 【为什么要跟 resolveAcceptanceArgv 分开】发给 Codex 的指令里**只放这个,不放命令**。
 * 命令字符串本身就是一句邀请:它一看见 `npx vitest run xxx` 就会去跑,而它在自己的沙箱里
 * 根本跑不动(见 docs/开工须知-Codex派单.md 第 5 节),于是陷进「试→失败→重读上下文→再试」
 * 的循环里烧额度。可执行 argv 只有派单器需要,那边照旧走 resolveAcceptanceArgv。
 */
export const acceptanceDescription = (item: AcceptanceItem): string => {
  const spec = ACCEPTANCE_KINDS[item.kind]
  if (!spec) fail('未知作业名 ' + item.kind)
  if (!spec.argv) return spec.desc
  return item.target ? spec.desc + ':' + item.target : spec.desc
}

/** 把一条验收项翻成可执行 argv;人工项返回 null。平台差异不在这里处理。 */
export const resolveAcceptanceArgv = (item: AcceptanceItem): string[] | null => {
  const spec = ACCEPTANCE_KINDS[item.kind]
  if (!spec) fail('未知作业名 ' + item.kind)
  if (!spec.argv) return null
  return spec.argv(item.target)
}

/** 解析 + 校验一份工单。任何不合法当场抛错,不许带病落盘。 */
export const parseTask = (raw: unknown): CodexTask => {
  if (typeof raw !== 'object' || raw === null) fail('工单必须是 JSON 对象')
  const t = raw as Record<string, unknown>

  if (t.schemaVersion !== 1) fail('schemaVersion 只支持 1,收到 ' + String(t.schemaVersion))

  const slug = typeof t.slug === 'string' ? t.slug.trim() : ''
  if (!SLUG_RE.test(slug)) {
    fail('slug="' + slug + '" 非法:只许小写字母数字连字符、2~49 字符(它会变成目录名和分支名)')
  }

  const taskId = typeof t.taskId === 'string' ? t.taskId.trim() : ''
  if (!taskId) fail('taskId 不能为空(填看板卡 id,派回来才对得上账)')

  const title = typeof t.title === 'string' ? t.title.trim() : ''
  if (!title) fail('title 不能为空')

  const goal = typeof t.goal === 'string' ? t.goal.trim() : ''
  if (!goal) fail('goal 不能为空——派了个寂寞')

  const sandbox = t.sandbox === undefined ? 'workspace-write' : t.sandbox
  if (sandbox !== 'read-only' && sandbox !== 'workspace-write') {
    fail(
      'sandbox="' + String(sandbox) + '" 不许:只在 read-only / workspace-write 里选。' +
        'danger-full-access 永远不由派单器放出去(无沙箱的 Codex 能碰仓库外的任何东西)。',
    )
  }

  const allowedPaths = asStringArray(t.allowedPaths, 'allowedPaths')
  if (allowedPaths.length === 0) fail('allowedPaths 为空 = 没圈施工面,Codex 会漫无边际地改')

  // 工单目录永远进禁区:Codex 不许改自己的工单(否则可自判验收通过)。
  const forbiddenPaths = asStringArray(t.forbiddenPaths, 'forbiddenPaths')
  if (!forbiddenPaths.includes(JOB_DIR_FORBIDDEN)) forbiddenPaths.push(JOB_DIR_FORBIDDEN)

  const rawAcceptance = t.acceptance
  if (!Array.isArray(rawAcceptance) || rawAcceptance.length === 0) {
    fail('acceptance 至少要一条——没有验收断言,"干完了"无从判定')
  }
  const acceptance = (rawAcceptance as unknown[]).map(parseAcceptanceItem)
  const ids = new Set<string>()
  for (const item of acceptance) {
    if (ids.has(item.id)) fail('acceptance.id 重复:' + item.id)
    ids.add(item.id)
  }

  const timeoutSec =
    typeof t.timeoutSec === 'number' && Number.isFinite(t.timeoutSec) ? Math.floor(t.timeoutSec) : 900
  if (timeoutSec < 30 || timeoutSec > 21600) fail('timeoutSec=' + timeoutSec + ' 超出 30~21600 秒')

  return {
    schemaVersion: 1,
    taskId,
    slug,
    title,
    goal,
    background: typeof t.background === 'string' ? t.background.trim() : '',
    allowedPaths,
    forbiddenPaths,
    nonGoals: asStringArray(t.nonGoals, 'nonGoals'),
    acceptance,
    expectArtifacts: asStringArray(t.expectArtifacts, 'expectArtifacts'),
    sandbox,
    cwd: typeof t.cwd === 'string' && t.cwd.trim() ? t.cwd.trim() : null,
    worktree: t.worktree === true,
    model: typeof t.model === 'string' && t.model.trim() ? t.model.trim() : null,
    timeoutSec,
  }
}
