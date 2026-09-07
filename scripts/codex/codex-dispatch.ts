/**
 * Codex 派单器 CLI(CODEX-BRIDGE-DISPATCH,2026-09-01)。
 *
 * 【定位】Claude(或负责人)派活给 Codex 的唯一入口。一条命令把活派出去,进程后台跑,
 * 立刻返回;干完了另一条命令收结论 —— 收回来的是**派单器自己复核过的判决**,
 * 不是 Codex 的自述。
 *
 * 【为什么存在】两个平台都是订阅制:Claude 额度天天见底,Codex 额度长期闲置。
 * 把机械活派过去是净省。但"能调用"不等于"能派单" —— 派出去的活拿回来只有一句
 * "我做完了",派单方还得自己再读一遍代码,那还不如自己干。本工具补的就是中间这段:
 * 工单格式、红线传导、机器复核、可追溯落盘。
 *
 * 【为什么输出这么短】收结论时只印 20~30 行摘要,过程日志留在磁盘上。
 * 派单是为了省 Claude 的额度,把 Codex 几万 token 的过程输出灌回 Claude 上下文,
 * 等于把省下来的又还回去 —— 这也是当初否掉"把 Codex 挂成 MCP"那条路线的同一个理由。
 *
 * 【用法】
 *   # 看可用的验收作业名(点菜制,工单只能从这张表里点)
 *   npx tsx scripts/codex/codex-dispatch.ts kinds
 *
 *   # 生成一份工单模板,改完再派
 *   npx tsx scripts/codex/codex-dispatch.ts template --slug foo-bar > .codex/jobs/foo-bar.json
 *
 *   # 派单(立刻返回)
 *   npx tsx scripts/codex/codex-dispatch.ts dispatch --task .codex/jobs/foo-bar.json
 *
 *   # 看所有工单在跑到哪
 *   npx tsx scripts/codex/codex-dispatch.ts status
 *
 *   # 收结论(会自己重跑验收断言;跑完才出判决)
 *   npx tsx scripts/codex/codex-dispatch.ts collect foo-bar
 *
 *   # 看原始过程日志尾部(默认不看,出问题才看)
 *   npx tsx scripts/codex/codex-dispatch.ts logs foo-bar --lines 60
 *
 *   # 对已有会话再说一句话,默认只读续聊
 *   npx tsx scripts/codex/codex-dispatch.ts say foo-bar "补充说明"
 *
 *   # 收工:删掉 --worktree 开出来的独立工作区
 *   npx tsx scripts/codex/codex-dispatch.ts end foo-bar
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseTask, acceptanceKindMenu, type CodexTask } from './codex-contract'
import { jobPaths, worktreeFor, JOBS_ROOT, REPO_ROOT } from './codex-paths'
import {
  dispatch as runDispatch,
  isAlive,
  markerPrinted,
  changedSince,
  runAcceptance,
  taskFrozen,
  supervise,
  unlinkNodeModules,
  readJson,
  type JobMeta,
  type JobState,
} from './codex-runner'
import { judge, parseSelfReport, type Judgement, type MachineAcceptance } from './codex-verdict'
import { openWatchPane, probeHerdr } from './codex-herdr'
import { parseSayArgs, readSayMessage, sayToJob } from './codex-say'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'help'

const flag = (name: string): string | null => {
  const i = argv.indexOf('--' + name)
  const value = i >= 0 ? argv[i + 1] : undefined
  return value && !value.startsWith('--') ? value : null
}
const has = (name: string): boolean => argv.includes('--' + name)

/** 位置参数(第 1 个通常是 slug);缺省或看着像选项就当没给。 */
const positional = (index: number): string | null => {
  const value = argv[index]
  return value && !value.startsWith('--') ? value : null
}

// 与 codex-contract 的 fail 同理:必须显式标注**整个函数类型**,
// 只写返回值 `: never` 的话 TS 不会把 `if (!slug) die(...)` 之后当成走不到,
// 后面每个用 slug 的地方都要再补一次判空。
const die: (msg: string) => never = (msg) => {
  process.stderr.write(msg + '\n')
  process.exit(2)
}

const HELP = `Codex 派单器 —— 把活派给 Codex,收回可验收的判决

  kinds                            打印可用的验收作业名(工单只能从这张表里点)
  template --slug <名字>            打印一份工单模板到 stdout
  dispatch --task <工单.json>       派单(后台跑,立刻返回;加 --watch 顺带开 herdr 窗格)
  status [slug]                    看工单跑到哪
  collect <slug> [--no-rerun]      收结论(默认自己重跑验收断言)
  logs <slug> [--lines N]          看原始过程日志尾部
  say <slug> [<消息>] [--message-file 路径] [--sandbox 模式]
                                   对已有会话补发消息并拿回话(默认 read-only;消息写成单行,多行走 --message-file;在这单自己的工作区里跑)
  watch <slug>                     在 herdr 窗格里跟这一单的事件流(herdr 是可选件)
  herdr                            探一下 herdr 装没装、服务起没起
  end <slug>                       收工:删掉 --worktree 开出来的独立工作区
`

const TEMPLATE = (slug: string): unknown => ({
  schemaVersion: 1,
  taskId: 'PUT-BOARD-CARD-ID-HERE',
  slug,
  title: '一句话说清这一单做什么',
  goal: '大白话目标:做完之后,什么东西会跟现在不一样',
  background: '可选:为什么要做这件事,收单方需要知道的上下文',
  allowedPaths: ['web/src/components/Xxx.vue', 'test/xxx.test.cjs'],
  forbiddenPaths: ['server/**', 'core/**', 'cli/**'],
  nonGoals: ['不改业务逻辑', '不顺手重构'],
  acceptance: [
    { id: 'A1', kind: 'test:targeted', target: 'test/xxx.test.cjs', required: true },
    { id: 'A2', kind: 'web:typecheck', required: true },
    { id: 'A3', kind: 'web:no-emoji', required: true },
  ],
  expectArtifacts: ['test/xxx.test.cjs'],
  sandbox: 'workspace-write',
  worktree: true,
  timeoutSec: 1800,
})

const loadTask = (path: string): CodexTask => {
  if (!existsSync(path)) die('[codex-dispatch] 工单文件不存在:' + path)
  try {
    return parseTask(JSON.parse(readFileSync(path, 'utf8')))
  } catch (err) {
    return die('[codex-dispatch] 工单不合法:\n' + (err as Error).message)
  }
}

const listSlugs = (): string[] => {
  if (!existsSync(JOBS_ROOT)) return []
  return readdirSync(JOBS_ROOT).filter((name) => {
    const dir = join(JOBS_ROOT, name)
    return statSync(dir).isDirectory() && existsSync(join(dir, 'meta.json'))
  })
}

/** 一行状态:够看出死活,不够就去 collect。 */
const oneLineStatus = (slug: string): string => {
  const paths = jobPaths(slug)
  const meta = readJson<JobMeta>(paths.meta)
  const state = readJson<JobState>(paths.state)
  const verdict = readJson<Judgement>(paths.verdict)
  if (!meta) return slug.padEnd(28) + ' (工单目录不完整)'

  const alive = isAlive(state?.pid ?? null)
  const phase = verdict
    ? '已判读:' + verdict.finalStatus
    : alive
      ? '跑着呢(pid ' + String(state?.pid) + ')'
      : markerPrinted(paths.execLog, meta.marker)
        ? '跑完了,待 collect'
        : '进程已退出,待 collect'
  return slug.padEnd(28) + ' ' + phase.padEnd(26) + ' ' + meta.taskId + '  ' + meta.dispatchedAt.slice(0, 16)
}

/** 收结论:机器复核 + 判决 + 短摘要。 */
const collect = (slug: string, rerun: boolean): number => {
  const paths = jobPaths(slug)
  const meta = readJson<JobMeta>(paths.meta)
  if (!meta) return die('[codex-dispatch] 没有这个工单:' + slug) as never
  const state = readJson<JobState>(paths.state)

  if (isAlive(state?.pid ?? null)) {
    process.stdout.write('还在跑(pid ' + String(state?.pid) + ')。等它退出再 collect,或先看 logs。\n')
    return 3
  }

  const task = parseTask(JSON.parse(readFileSync(paths.task, 'utf8')))
  const selfReport = existsSync(paths.lastMessage)
    ? parseSelfReport(readFileSync(paths.lastMessage, 'utf8'))
    : null
  const changedFiles = changedSince(meta.cwd, meta.baselineDirty)
  const acceptance: MachineAcceptance[] = rerun
    ? runAcceptance(task, meta.cwd, paths.acceptanceLogDir)
    : task.acceptance.map((a) => ({ id: a.id, required: a.required, ran: false, passed: false, exitCode: null }))

  const verdict = judge({
    slug,
    taskId: meta.taskId,
    allowedPaths: task.allowedPaths,
    forbiddenPaths: task.forbiddenPaths,
    expectArtifacts: task.expectArtifacts,
    taskFrozen: taskFrozen(paths.task, meta.taskHash),
    exitCode: state?.exitCode ?? null,
    timedOut: state?.timedOut ?? false,
    markerPrinted: markerPrinted(paths.execLog, meta.marker),
    changedFiles,
    existingArtifacts: task.expectArtifacts.filter((a) => existsSync(join(meta.cwd, a))),
    acceptance,
    selfReport,
  })
  writeFileSync(paths.verdict, JSON.stringify(verdict, null, 2) + '\n', 'utf8')

  const icon = { accepted: '✔', rejected: '✖', blocked: '⏸', crashed: '💥' }[verdict.finalStatus]
  const lines = [
    icon + ' ' + slug + ' → ' + verdict.finalStatus + '   (卡 ' + meta.taskId + ')',
    '  它说:' + (selfReport?.summary || '(没交回结论)').slice(0, 200),
    '  改动:' + (changedFiles.length ? changedFiles.slice(0, 12).join(', ') + (changedFiles.length > 12 ? ' 等 ' + changedFiles.length + ' 个' : '') : '无'),
    '  验收(派单器自己跑的):' +
      (acceptance.length
        ? acceptance
            .map((a) => a.id + '=' + (a.manual ? '人工' : a.ran ? (a.passed ? '过' : '红') : '没跑起来'))
            .join(' ')
        : '无'),
  ]
  if (verdict.openQuestions.length) lines.push('  ❓待拍板:' + verdict.openQuestions.map((q) => '\n     · ' + q).join(''))
  if (verdict.reasons.length) lines.push('  判据:' + verdict.reasons.map((r) => '\n     · ' + r).join(''))
  if (verdict.warnings.length) lines.push('  提醒:' + verdict.warnings.map((w) => '\n     · ' + w).join(''))
  lines.push('  证据留在:' + paths.dir.replace(REPO_ROOT, '.') + '  (原始日志 exec.jsonl / 验收输出 acceptance/)')
  process.stdout.write(lines.join('\n') + '\n')

  return verdict.finalStatus === 'accepted' ? 0 : 1
}

switch (command) {
  case 'kinds': {
    process.stdout.write('可用验收作业(工单的 acceptance[].kind 只能从这里点):\n' + acceptanceKindMenu() + '\n')
    break
  }

  case 'template': {
    const slug = flag('slug') ?? 'change-me'
    process.stdout.write(JSON.stringify(TEMPLATE(slug), null, 2) + '\n')
    break
  }

  case 'dispatch': {
    const taskPath = flag('task')
    if (!taskPath) die('用法:dispatch --task <工单.json>')
    const task = loadTask(taskPath as string)
    const { dir, pid, cwd } = runDispatch(task)
    process.stdout.write(
      '✔ 已派单 ' + task.slug + '(卡 ' + task.taskId + ',pid ' + String(pid) + ')\n' +
        '  工作目录:' + cwd + '\n' +
        '  工单目录:' + dir.replace(REPO_ROOT, '.') + '\n' +
        '  收结论:npx tsx scripts/codex/codex-dispatch.ts collect ' + task.slug + '\n',
    )
    if (has('watch')) openWatchPane(task.slug)
    break
  }

  case 'say': {
    const parsed = parseSayArgs(argv.slice(1))
    if (parsed.error || !parsed.slug) {
      die('用法:say <slug> [<消息>] [--message-file <路径>] [--sandbox <模式>]\n' + (parsed.error ?? ''))
    }
    let message: string
    try {
      message = readSayMessage(parsed)
    } catch (err) {
      die('读不到消息文件:' + (err as Error).message)
    }
    const slug = parsed.slug
    const result = sayToJob(slug, message, parsed.sandbox ? { sandbox: parsed.sandbox } : undefined)
    if (!result.ok) {
      process.stderr.write('✖ 续聊失败 ' + slug + ':' + (result.error ?? '未知错误') + '\n')
      process.exit(1)
    }
    process.stdout.write(
      '✔ 已续聊 ' + slug + '(thread ' + String(result.threadId) + ')\n' +
        (result.reply || '(Codex 没有输出文字)') + '\n',
    )
    break
  }

  // 可选件:herdr 装了才有用,没装只打一行提示,绝不让派单失败。
  case 'watch': {
    const slug = positional(1)
    if (!slug) die('用法:watch <slug>')
    openWatchPane(slug)
    break
  }

  case 'herdr': {
    const probe = probeHerdr()
    process.stdout.write(
      'herdr:' + (probe.bin ?? '(没找到)') +
        '\n  服务:' + (probe.serverRunning ? '在跑' : '没起') +
        '\n  ' + probe.hint + '\n',
    )
    break
  }

  // 内部命令:由 dispatch 以后台进程拉起,同步等 codex 收场并记下退出码/超时。
  // 不在 HELP 里列出 —— 人不该直接调它。
  case '_supervise': {
    const slug = positional(1)
    if (!slug) die('_supervise 需要 slug')
    await supervise(slug)
    break
  }

  case 'status': {
    const only = positional(1)
    const slugs = only ? [only] : listSlugs()
    if (slugs.length === 0) {
      process.stdout.write('没有工单。\n')
      break
    }
    process.stdout.write(slugs.map(oneLineStatus).join('\n') + '\n')
    break
  }

  case 'collect': {
    const slug = positional(1)
    if (!slug) die('用法:collect <slug> [--no-rerun]')
    process.exit(collect(slug, !has('no-rerun')))
    break
  }

  case 'logs': {
    const slug = positional(1)
    if (!slug) die('用法:logs <slug> [--lines N]')
    const paths = jobPaths(slug)
    if (!existsSync(paths.execLog)) die('没有日志:' + paths.execLog)
    const lines = Number(flag('lines') ?? '40')
    const all = readFileSync(paths.execLog, 'utf8').split(/\r?\n/)
    process.stdout.write(all.slice(-lines).join('\n') + '\n')
    break
  }

  case 'end': {
    const slug = positional(1)
    if (!slug) die('用法:end <slug>')
    const { path, branch } = worktreeFor(slug)
    if (!existsSync(path)) {
      process.stdout.write('没有 worktree 要收(这一单没用 --worktree,或已收过)。\n')
      break
    }
    // 先摘 node_modules 联接再删 worktree:git 递归删目录时若跟着 junction 走,
    // 会把主工位真正的 node_modules 一起删光(本机踩过,见开工须知环境坑)。
    unlinkNodeModules(path)
    const r = spawnSync('git', ['worktree', 'remove', path, ...(has('force') ? ['--force'] : [])], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    if (r.status !== 0) {
      process.stdout.write(
        '⚠ worktree 没删成(多半是里面还有未提交改动,这是保护不是故障):\n' +
          (r.stderr || '') + '\n确认成果已经收走后,加 --force 再来一次。分支 ' + branch + ' 保留。\n',
      )
      process.exit(1)
    }
    process.stdout.write('✔ 已收工:' + path + '(分支 ' + branch + ' 保留,自己按需删)\n')
    break
  }

  default:
    process.stdout.write(HELP)
}
