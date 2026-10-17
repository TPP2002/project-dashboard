import deployment from './client/deployment-config.cjs'
/**
 * CI 标签路由的命令行口子(CI-RUNNER-LABEL-ROUTING-0924 §6.5/§19)。
 *
 * runStatus:看一眼路由状态(状态文件 + 可选对 GitHub 清单复核)。
 * runRestore:一键复原 —— 先把开关切回 off,等派单员的路由确认,再把缺的基线标签补齐;
 *   --exact 连手工多挂的受管标签一起摘(车道地板护栏照守);dry-run 只出清单不动手。
 * 本文件不进代理的 SELF_SOURCES:它是人手动跑的,常驻代理不导入。
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { publishLifecycleFileAtomically } from '../bot/cluster-lifecycle-atomic-file'
import { canonicalJson, schedControlPaths, schedPaths, utcDate } from './sched-contract'
import { GhApiError, productionCiLabelsGithub } from './sched-ci-labels-github'
import type { CiLabelGithubPort } from './sched-ci-labels-github'
import { CI_MANAGED_LANES, CI_RUNNER_BASELINE, CI_LABEL_REPO, restoreCommandsFor } from './sched-ci-labels-plan'
import type { CiLane, CiRunnersSnapshot } from './sched-ci-labels-plan'
import { ciLabelStateDir, ciLabelSwitchPath, parseCiLabelSwitch } from './sched-ci-labels'

const beijing = (at: string): string =>
  new Date(Date.parse(at) + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19).replace('Z', '')
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** 受管车道判定:--exact 只摘受管车道里的多余标签,其余标签一律只给手工命令提示。 */
const isManagedLane = (label: string): label is CiLane => (CI_MANAGED_LANES as readonly string[]).includes(label)

interface SavedState {
  updatedAt: string
  mode: string
  switchStatus: string
  github: { status: string; rateRemaining: number | null; rateResetAt: string | null; lastError: string | null }
  machines: Record<string, { verdict: string; certain: boolean; reason: string }>
  runners: Record<string, { baseline: string[]; live: string[] | null; desired: string[];
    stripped: Record<string, { at: string; reason: string; state: string }> }>
  lanes: Record<string, { onlineLabeled: number; idleLabeled?: number; saturated: boolean; fallback: boolean;
    fallbackReason?: 'starvation' | 'lane-busy' | null; oldestQueuedAt: string | null }>
  driftBackoff: Record<string, string>
  restoreCommands: string[]
  lastInvariantViolation: { code: string; detail: string; at: string } | null
}

const readSavedState = (share: string): SavedState | null => {
  const path = join(ciLabelStateDir(share), 'state.json')
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) as SavedState } catch { return null }
}

export function runStatus(options: { share: string; json?: boolean; github?: () => CiLabelGithubPort | null;
  now?: () => string; out?: (message: string) => void }): number {
  const out = options.out ?? (message => console.log(message))
  const at = (options.now ?? (() => new Date().toISOString()))()
  const state = readSavedState(options.share)
  if (state === null) {
    out(`[ci-labels] 还没有路由状态文件(${join(ciLabelStateDir(options.share), 'state.json')})。`)
    out('开关没开过,或派单员还没跑过一轮;这不是故障。')
    return 2
  }
  if (options.json === true) { out(canonicalJson(state)); return 0 }
  const heartbeat = schedControlPaths(options.share).heartbeat
  const beat = existsSync(heartbeat) ? JSON.parse(readFileSync(heartbeat, 'utf8')) as { at?: string } : null
  const beatAge = beat?.at === undefined ? null : Date.parse(at) - Date.parse(beat.at)
  out(`状态(截至 ${beijing(state.updatedAt)} 北京时间):模式 ${state.mode},开关 ${state.switchStatus},GitHub 通道 ${state.github.status}`
    + (state.github.rateRemaining === null ? '' : `,配额余 ${state.github.rateRemaining}`))
  if (beatAge !== null) out(`派单员心跳:${beatAge <= 120_000 ? '活着' : `已停更 ${Math.round(beatAge / 60_000)} 分钟`}(路由只在派单员在跑时动标签)`)
  for (const [machine, view] of Object.entries(state.machines)) {
    out(`机器 ${machine}:${view.verdict}${view.certain ? '' : '(读数拿不准)'} ${view.reason}`)
  }
  for (const [runner, view] of Object.entries(state.runners)) {
    const stripped = Object.entries(view.stripped).map(([lane, entry]) => `${lane}(${entry.state},${entry.reason})`)
    out(`工位 ${runner}:现挂 ${view.live === null ? '(清单里没有)' : view.live.length > 0 ? view.live.join('+') : '(无受管标签)'}`
      + ` / 应挂 ${view.desired.length > 0 ? view.desired.join('+') : '(无)'}`
      + (stripped.length > 0 ? ` / 已摘 ${stripped.join('、')}` : ''))
  }
  for (const [lane, laneView] of Object.entries(state.lanes)) {
    // 空闲台数与回退原因都是 1010 新增字段:旧状态文件没有时按 0 台 / 饿死回退展示,不误报。
    const fallbackReason = laneView.fallbackReason ?? 'starvation'
    out(`车道 ${lane}:在线带标签 ${laneView.onlineLabeled} 台 / 空闲 ${laneView.idleLabeled ?? 0} 台${laneView.saturated ? '(全忙)' : ''}`
      + (laneView.fallback ? (fallbackReason === 'lane-busy' ? '(打满回退中)' : '(饿死回退中)') : ''))
  }
  if (state.lastInvariantViolation !== null) {
    out(`最近一次不变量告警:${state.lastInvariantViolation.code} ${state.lastInvariantViolation.detail}`
      + `(${beijing(state.lastInvariantViolation.at)})`)
  }
  if (Object.keys(state.driftBackoff).length > 0) out(`漂移退避中的组合:${Object.keys(state.driftBackoff).join('、')}`)
  if (state.restoreCommands.length > 0) {
    out(`与 0925 基线相比缺 ${state.restoreCommands.length} 个标签,手工补齐命令:`)
    for (const command of state.restoreCommands) out(`  ${command}`)
  }
  const port = options.github?.() ?? null
  if (port !== null) {
    try {
      void port.listRunners().then(snapshot => {
        const missing = restoreCommandsFor(snapshot)
        out(missing.length === 0 ? `GitHub 复核:五个工位受管标签齐全(${beijing(at)})。`
          : `GitHub 复核:当前缺 ${missing.length} 个标签:\n  ${missing.join('\n  ')}`)
        port.close()
      }, error => {
        out(`GitHub 复核失败:${messageOf(error)}`)
        port.close()
      })
    } catch (error) { out(`GitHub 复核失败:${messageOf(error)}`) }
  }
  return 0
}

const auditCli = (share: string, entry: Record<string, unknown>): void => {
  const dir = join(ciLabelStateDir(share), 'audit')
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, `${utcDate(String(entry.at))}--cli.jsonl`), `${canonicalJson(entry)}\n`)
}

const writeSwitchOff = (share: string, at: string, out: (message: string) => void): boolean => {
  const path = ciLabelSwitchPath(share)
  let next: Record<string, unknown> = { formatVersion: 1, mode: 'off' }
  try {
    if (existsSync(path)) {
      const parsed = parseCiLabelSwitch(readFileSync(path, 'utf8')) as unknown as Record<string, unknown>
      // parseCiLabelSwitch 的返回不带 formatVersion,要补回去,否则写出的开关被路由判无效、改回 on 也不生效。
      next = { formatVersion: 1, ...parsed, mode: 'off' }
    }
  } catch { next = { formatVersion: 1, mode: 'off' } }
  next.note = `命令行复原于 ${beijing(at)} 北京时间`
  try {
    mkdirSync(schedPaths(share).staging, { recursive: true })
    publishLifecycleFileAtomically(path, canonicalJson(next), 'replace', schedPaths(share).staging)
  } catch (error) {
    out(`[ci-labels] 复原开关写不进去,先手工把 ${path} 的 mode 改成 off:${messageOf(error)}`)
    return false
  }
  out(`[ci-labels] 开关已切回 off(${path})。`)
  return true
}

export async function runRestore(options: { share: string; exact?: boolean; dryRun?: boolean; noSwitch?: boolean;
  github?: () => CiLabelGithubPort | null; now?: () => string; sleep?: (ms: number) => Promise<void>;
  out?: (message: string) => void }): Promise<number> {
  const out = options.out ?? (message => console.log(message))
  const now = options.now ?? (() => new Date().toISOString())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const at = now()
  const ops: { kind: 'add' | 'remove'; runner: string; runnerId: number; label: string }[] = []

  // 第一步:开关切回 off,让常驻路由自己先把摘掉的加回来。
  if (!options.noSwitch && !options.dryRun) {
    if (!writeSwitchOff(options.share, at, out)) return 1
    const heartbeatPath = schedControlPaths(options.share).heartbeat
    let dispatcherAlive = false
    if (existsSync(heartbeatPath)) {
      try {
        const beat = JSON.parse(readFileSync(heartbeatPath, 'utf8')) as { at?: string }
        dispatcherAlive = beat.at !== undefined && Date.parse(at) - Date.parse(beat.at) <= 120_000
      } catch { dispatcherAlive = false }
    }
    if (dispatcherAlive) {
      out('[ci-labels] 派单员在跑,等路由确认关闸(最多 30 秒)……')
      for (let waited = 0; waited < 30_000; waited += 2_000) {
        await sleep(2_000)
        const state = readSavedState(options.share)
        if (state !== null && state.updatedAt >= at && state.mode === 'off') break
      }
    } else out('[ci-labels] 派单员心跳已停,跳过等待,直接手工补标签。')
  } else if (options.dryRun) out('[ci-labels] dry-run:开关、标签都不会动,只列要做的活。')

  // 第二步:拉清单,补基线缺的,--exact 再摘手工多挂的;不可碰的标签只出手工命令。
  const port = options.github?.() ?? null
  if (port === null) {
    out('[ci-labels] GitHub 端口起不来,无法补标签;确认 gh 已装并已 gh auth login。')
    return 2
  }
  let snapshot: CiRunnersSnapshot
  try { snapshot = await port.listRunners() } catch (error) {
    out(`[ci-labels] runner 清单拉不到(${messageOf(error)});gh 没登录或网络不通时先解决凭据。`)
    port.close()
    return 2
  }
  const byName = new Map(snapshot.map(runner => [runner.name, runner]))
  const adds: { runner: string; runnerId: number; label: CiLane }[] = []
  const extras: { runner: string; runnerId: number; label: CiLane }[] = []
  const manual: string[] = []
  for (const base of CI_RUNNER_BASELINE) {
    const live = byName.get(base.name)
    if (live === undefined) {
      out(`[ci-labels] 工位 ${base.name}(#${base.id})不在 GitHub 清单里,跳过;它回来后重跑本命令。`)
      continue
    }
    for (const label of base.labels) if (!live.labels.includes(label)) adds.push({ runner: base.name, runnerId: base.id, label })
    for (const label of live.labels) {
      if ((base.labels as readonly string[]).includes(label)) continue
      if (!isManagedLane(label)) {
        if (deployment.getDeploymentConfig().ci.labels?.untouchableLabels.includes(label) === true) {
          manual.push(`gh api --method DELETE repos/${CI_LABEL_REPO}/actions/runners/${base.id}/labels/${label}`)
          out(`[ci-labels] 工位 ${base.name} 挂着不该由本卡动的标签 ${label},本命令不碰;确认要摘就手工执行:\n  ${manual.at(-1)}`)
        }
        continue
      }
      if (options.exact === true) extras.push({ runner: base.name, runnerId: base.id, label })
      else out(`[ci-labels] 工位 ${base.name} 多挂了 ${label};要摘加 --exact。`)
    }
  }
  // 车道地板护栏:--exact 摘多余标签时,每条受管车道至少留一台在线带标签的工位。
  const keptRemoves = new Set<string>()
  if (options.exact === true) {
    for (const lane of CI_MANAGED_LANES) {
      const holders = snapshot.filter(runner => runner.online && runner.labels.includes(lane))
      const removing = extras.filter(item => item.label === lane)
      const survivors = holders.filter(runner => !removing.some(item => item.runner === runner.name))
      if (survivors.length > 0 || removing.length === 0) continue
      const spare = removing.reduce((left, right) => left.runnerId <= right.runnerId ? left : right)
      keptRemoves.add(`${spare.runner}|${spare.label}`)
      out(`[ci-labels] 车道 ${lane} 全靠 ${spare.runner} 一台撑着,${spare.runner} 的 ${lane} 这次不摘。`)
    }
  }
  const planned = [
    ...adds.map(item => ({ kind: 'add' as const, ...item })),
    ...extras.filter(item => !keptRemoves.has(`${item.runner}|${item.label}`)).map(item => ({ kind: 'remove' as const, ...item })),
  ]
  if (options.dryRun) {
    out(planned.length === 0 ? '[ci-labels] dry-run 结论:五个工位与 0925 基线一致,没有活要干。'
      : `[ci-labels] dry-run 结论:将执行 ${planned.length} 笔:\n${planned.map(op =>
        `  ${op.kind === 'add' ? '加' : '摘'} ${op.runner}(#${op.runnerId})${op.label}`).join('\n')}`)
    port.close()
    return 0
  }
  let failed = 0
  for (const op of planned) {
    try {
      if (op.kind === 'add') await port.addLabel(op.runnerId, op.label)
      else await port.removeLabel(op.runnerId, op.label)
      ops.push(op)
      out(`[ci-labels] ${op.kind === 'add' ? '已加' : '已摘'} ${op.runner}(#${op.runnerId})${op.label}。`)
    } catch (error) {
      failed += 1
      const kind = error instanceof GhApiError ? error.kind : 'unavailable'
      out(`[ci-labels] ${op.kind === 'add' ? '加' : '摘'} ${op.runner}(#${op.runnerId})${op.label} 失败(${kind}):${messageOf(error)}`)
      if (kind === 'no-cli' || kind === 'no-credential' || kind === 'no-permission') break
    }
  }
  // 第三步:重拉清单核验,报最终差。
  let final: CiRunnersSnapshot
  try { final = await port.listRunners() } catch { final = [] }
  const stillMissing = restoreCommandsFor(final)
  try {
    auditCli(options.share, { at, writer: 'cli', ops, failed,
      outcome: stillMissing.length === 0 && failed === 0 ? 'done' : 'partial', exact: options.exact === true })
  } catch { /* 审计写失败不拦复原结论 */ }
  port.close()
  if (failed > 0) {
    out(`[ci-labels] 复原有 ${failed} 笔没做成,重跑本命令可续;仍缺的标签:\n  ${stillMissing.join('\n  ')}`)
    return 1
  }
  if (stillMissing.length > 0) {
    out(`[ci-labels] 复原后与 0925 基线仍差 ${stillMissing.length} 个标签:\n  ${stillMissing.join('\n  ')}`)
    return 1
  }
  out('[ci-labels] 复原完成:五个工位受管标签已与 0925 基线一致。')
  return 0
}

/** 直接运行入口:npx tsx scripts/sched/sched-ci-labels-cli.ts --share <共享盘> [--json|--exact|--dry-run|--no-switch] status|restore */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const command = args.at(-1)
  const flag = (name: string): boolean => args.includes(name)
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const share = value('--share')
  if (share === undefined || (command !== 'status' && command !== 'restore')) {
    console.log('用法:npx tsx scripts/sched/sched-ci-labels-cli.ts --share <共享盘> [--json|--exact|--dry-run|--no-switch] status|restore')
  } else if (command === 'status') {
    process.exitCode = runStatus({ share, json: flag('--json'), github: productionCiLabelsGithub })
  } else {
    void runRestore({ share, exact: flag('--exact'), dryRun: flag('--dry-run'), noSwitch: flag('--no-switch'),
      github: productionCiLabelsGithub })
      .then(code => { process.exitCode = code })
  }
}
