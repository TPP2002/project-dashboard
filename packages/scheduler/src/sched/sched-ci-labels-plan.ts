import deployment from './client/deployment-config.cjs'
/**
 * CI 标签路由的计划层(CI-RUNNER-LABEL-ROUTING-0924 §9)。
 *
 * 输入可用性判定、GitHub 工位清单与台账记忆,输出一笔笔「加/摘某工位的某个标签」的计划,
 * 外加本轮没做成的清单与漂移对账。计划自带五条不变量,另有独立复核函数兜底:
 * 控制器执行前后各查一遍,复核不过的计划一笔都不许落。
 *
 * 铁律:只动 managed-e2e 与 managed-local 两条受管车道;unmanaged-main、unmanaged-night、
 * self-hosted、Windows、X64 永不碰;副机策略固定 pinned,只有主机是 dynamic。
 */
import type { CiAvailabilityParams, CiAvailabilityVerdict } from './sched-ci-availability'

const labelConfig = deployment.getDeploymentConfig().ci.labels
export const CI_LABEL_REPO: string = labelConfig?.repo ?? ''
export const CI_MANAGED_LANES: readonly string[] = labelConfig?.managedLanes ?? []
export type CiLane = string
export const CI_UNTOUCHABLE_LABELS: readonly string[] = labelConfig?.untouchableLabels ?? []
export const CI_RUNNER_BASELINE: readonly { id: number; name: string; machine: string; labels: string[] }[] = labelConfig?.runners ?? []
export const CI_MACHINE_POLICY_DEFAULT: Readonly<Record<string, 'dynamic' | 'pinned'>> = labelConfig?.machinePolicy ?? {}
const CI_EXCLUSIVE_LANE: string = labelConfig?.exclusiveLane ?? ''
/** 单轮最多动几笔;超出部分本轮不做,记入 skipped。 */
export const MAX_OPS_PER_ROUND = 6

export type CiLabelParams = CiAvailabilityParams & {
  /** 摘除后最短持有多久才允许恢复。 */
  minHoldSec: number
  /** 每个工位每小时最多变更几次。 */
  maxChangesPerRunnerPerHour: number
  /** 车道排队饿死多少分钟后进入回退;null 表示不启用。 */
  starvationMinutes: number | null
  /** 漂移对上后同一工位与标签冷却多久。 */
  driftBackoffSec: number
  stripOnBusy: readonly CiLane[]
  stripOnReserved: readonly CiLane[]
  /** 摘标签时给车道留一台真空闲工位(CI-LABEL-LANE-KEEP-IDLE-1010,2026-10-10 拍板默认开)。 */
  keepIdle: boolean
}
export const CI_LABEL_PARAMS_DEFAULT: CiLabelParams = {
  enterBusyRatio: 0.6, exitBusyRatio: 0.35, enterDwellSec: 180, exitDwellSec: 600,
  reservedGraceSec: 120, unknownRestoreSec: 900,
  minHoldSec: 900, maxChangesPerRunnerPerHour: 4, starvationMinutes: 20, driftBackoffSec: 7200,
  stripOnBusy: CI_MANAGED_LANES, stripOnReserved: CI_MANAGED_LANES,
  keepIdle: true,
}

export interface CiRunnerView { id: number; name: string; online: boolean; busy: boolean; labels: string[] }
export type CiRunnersSnapshot = CiRunnerView[]
export type CiStripReason = 'busy' | 'reserved'
export interface CiStrippedEntry { at: string; reason: CiStripReason; state: 'removing' | 'stripped' | 'adding' }

/** 台账记忆:谁家的哪个标签被我们摘了、变更节奏与漂移退避;随状态文件落盘,重启可续。 */
export interface CiLabelMemory {
  stripped: Record<string, Partial<Record<CiLane, CiStrippedEntry>>>
  lastChangeAt: string | null
  changes: Record<string, string[]>
  driftBackoffUntil: Record<string, string>
  fallback: Partial<Record<CiLane, { since: string; emptySince: string | null; reason?: 'starvation' | 'lane-busy' }>>
}

export function emptyLabelMemory(): CiLabelMemory {
  return { stripped: {}, lastChangeAt: null, changes: {}, driftBackoffUntil: {}, fallback: {} }
}

export type CiLabelOpReason = 'busy' | 'reserved' | 'allow' | 'switch-off' | 'floor-repair' | 'starvation' | 'lane-busy'
export interface CiLabelOp { kind: 'add' | 'remove'; runner: string; runnerId: number; machine: string; label: CiLane; reason: CiLabelOpReason }
export type CiSkipWhy = 'floor-guard' | 'min-hold' | 'rate-limit' | 'drift-backoff' | 'uncertain'
  | 'local-conflict' | 'runner-missing' | 'round-cap' | 'lane-busy'
export interface CiDriftNote { runner: string; label: CiLane; kind: 'missing' | 'reappeared' | 'extra'; at: string }
export interface CiPlanInput {
  at: string
  mode: 'off' | 'observe' | 'on'
  view: CiRunnersSnapshot
  verdicts: Record<string, { verdict: CiAvailabilityVerdict; certain: boolean }>
  policies: Readonly<Record<string, 'dynamic' | 'pinned'>>
  params: CiLabelParams
  memory: CiLabelMemory
}
export interface CiPlan {
  /** 清单拿不到或为空:本轮只能空转。 */
  stale: boolean
  ops: CiLabelOp[]
  skipped: { runner: string; label: CiLane; kind: 'add' | 'remove'; why: CiSkipWhy }[]
  drift: CiDriftNote[]
  desired: { runner: string; labels: CiLane[] }[]
}
export interface CiInvariantViolation { code: 'I1' | 'I2' | 'I3' | 'I4' | 'I5'; detail: string }

const clone = (memory: CiLabelMemory): CiLabelMemory => ({
  stripped: Object.fromEntries(Object.entries(memory.stripped).map(([runner, lanes]) => [runner, { ...lanes }])),
  lastChangeAt: memory.lastChangeAt,
  changes: Object.fromEntries(Object.entries(memory.changes).map(([runner, changes]) => [runner, [...changes]])),
  driftBackoffUntil: { ...memory.driftBackoffUntil },
  fallback: { ...memory.fallback },
})

const baselineByName = (): Map<string, (typeof CI_RUNNER_BASELINE)[number]> =>
  new Map(CI_RUNNER_BASELINE.map(runner => [runner.name, runner]))

/**
 * 台账与 GitHub 清单对账。摘了却还在记 reappeared(并进退避),该在却不在记 missing,
 * 记账指向的工位消失了记 extra。对账是纯函数:同样的输入永远报同样的漂移。
 */
export function reconcileMemory(memory: CiLabelMemory, view: CiRunnersSnapshot, at: string,
  params: CiLabelParams): { memory: CiLabelMemory; drift: CiDriftNote[] } {
  const cloned = clone(memory)
  const drift: CiDriftNote[] = []
  const viewByName = new Map(view.map(runner => [runner.name, runner]))
  const baselines = baselineByName()
  const backoffUntil = new Date(Date.parse(at) + params.driftBackoffSec * 1000).toISOString()
  const dropLane = (runner: string, label: CiLane): void => {
    const lanes = { ...cloned.stripped[runner] }
    delete lanes[label]
    if (Object.keys(lanes).length === 0) delete cloned.stripped[runner]
    else cloned.stripped[runner] = lanes
  }
  const settleLane = (runner: string, label: CiLane, entry: CiStrippedEntry): void => {
    cloned.stripped[runner] = { ...cloned.stripped[runner], [label]: entry }
  }
  for (const base of CI_RUNNER_BASELINE) {
    const live = viewByName.get(base.name)
    for (const label of base.labels) {
      const entry = cloned.stripped[base.name]?.[label]
      if (entry === undefined) {
        if (live && !live.labels.includes(label)) drift.push({ runner: base.name, label, kind: 'missing', at })
        continue
      }
      if (!live) { drift.push({ runner: base.name, label, kind: 'extra', at }); continue }
      const present = live.labels.includes(label)
      if (entry.state !== 'stripped') {
        // 写前中间态对账(契约 §9):摘完/挂成或没摘成/没挂成,按实况落定,不留悬账。
        if (present) dropLane(base.name, label)
        else settleLane(base.name, label, { ...entry, state: 'stripped' })
        continue
      }
      if (present) {
        // 摘过的标签又出现了:人手挂回,清账、进退避、记 reappeared(契约 §9)。
        dropLane(base.name, label)
        cloned.driftBackoffUntil[`${base.name}|${label}`] = backoffUntil
        drift.push({ runner: base.name, label, kind: 'reappeared', at })
      }
    }
  }
  for (const [runner, lanes] of Object.entries(cloned.stripped)) {
    if (baselines.has(runner) || viewByName.has(runner)) continue
    for (const label of Object.keys(lanes) as CiLane[]) drift.push({ runner, label, kind: 'extra', at })
  }
  drift.sort((left, right) => left.runner < right.runner ? -1 : left.runner > right.runner ? 1
    : left.label < right.label ? -1 : left.label > right.label ? 1 : 0)
  return { memory: cloned, drift }
}

/** 每条受管车道当前在线带标签的工位数、其中空闲(busy=false)台数,以及是否全在忙(车道打满)。 */
export function laneStats(runners: CiRunnersSnapshot): Record<CiLane, { onlineLabeled: number; idleLabeled: number; saturated: boolean }> {
  const stats = Object.fromEntries(CI_MANAGED_LANES.map(lane => [lane, { onlineLabeled: 0, idleLabeled: 0, saturated: false }])) as Record<CiLane, { onlineLabeled: number; idleLabeled: number; saturated: boolean }>
  for (const label of CI_MANAGED_LANES) {
    const holders = runners.filter(runner => runner.online && runner.labels.includes(label))
    stats[label] = { onlineLabeled: holders.length, idleLabeled: holders.filter(runner => !runner.busy).length,
      saturated: holders.length > 0 && holders.every(runner => runner.busy) }
  }
  return stats
}

/** 基线缺什么补什么;返回单标签 POST 命令,供一键复原与状态文件展示。 */
export function restoreCommandsFor(view: CiRunnersSnapshot): string[] {
  const byName = new Map(view.map(runner => [runner.name, runner]))
  const commands: string[] = []
  for (const base of [...CI_RUNNER_BASELINE].sort((left, right) => left.id - right.id)) {
    const live = byName.get(base.name)
    for (const label of base.labels) {
      if (live?.labels.includes(label)) continue
      commands.push(`gh api --method POST repos/${CI_LABEL_REPO}/actions/runners/${base.id}/labels -f 'labels[]=${label}'`)
    }
  }
  return commands
}

export function planCiLabels(input: CiPlanInput): CiPlan {
  const { memory: reconciled, drift } = reconcileMemory(input.memory, input.view, input.at, input.params)
  const skipped: CiPlan['skipped'] = []
  if (input.view.length === 0) {
    return { stale: true, ops: [], skipped, drift, desired: CI_RUNNER_BASELINE.map(runner =>
      ({ runner: runner.name, labels: [...runner.labels] })) }
  }
  const baselines = baselineByName()
  const viewByName = new Map(input.view.map(runner => [runner.name, runner]))
  const strippedKeys = new Set(Object.entries(reconciled.stripped).flatMap(([runner, lanes]) =>
    Object.keys(lanes).map(label => `${runner}|${label}`)))
  const backoff = (runner: string, label: CiLane): boolean => {
    const until = reconciled.driftBackoffUntil[`${runner}|${label}`]
    return until !== undefined && Date.parse(until) > Date.parse(input.at)
  }
  const changeCount = (runner: string): number => (reconciled.changes[runner] ?? [])
    .filter(at => Date.parse(input.at) - Date.parse(at) < 3_600_000).length
  const mayChange = (runner: string): boolean => changeCount(runner) < input.params.maxChangesPerRunnerPerHour
  const localConflict = (baseName: string, machine: string, pending: readonly CiLabelOp[]): boolean =>
    input.view.some(runner => runner.name !== baseName && baselines.get(runner.name)?.machine === machine
      && runner.online && runner.labels.includes(CI_EXCLUSIVE_LANE))
    || pending.some(op => op.kind === 'add' && op.label === CI_EXCLUSIVE_LANE && op.machine === machine && op.runner !== baseName)

  // 第一步:补地板。该在却不在的基线标签直接加回;豁免最短持有与限速,漂移退避也不挡补缺。
  const repairAdds: CiLabelOp[] = []
  for (const base of CI_RUNNER_BASELINE) {
    const live = viewByName.get(base.name)
    if (!live) continue
    for (const label of base.labels) {
      if (strippedKeys.has(`${base.name}|${label}`) || live.labels.includes(label)) continue
      repairAdds.push({ kind: 'add', runner: base.name, runnerId: base.id, machine: base.machine, label, reason: 'floor-repair' })
    }
  }
  // 第二步:模式规则。off 只恢复;observe 与 on 用同一套规则,落不落笔由控制器把关。
  const recoveryAdds: CiLabelOp[] = []
  const removes: CiLabelOp[] = []
  if (input.mode === 'off') {
    for (const base of CI_RUNNER_BASELINE) {
      const lanes = reconciled.stripped[base.name]
      if (!lanes) continue
      for (const label of CI_MANAGED_LANES) {
        const entry = lanes[label]
        if (entry === undefined || entry.state === 'adding') continue
        recoveryAdds.push({ kind: 'add', runner: base.name, runnerId: base.id, machine: base.machine, label, reason: 'switch-off' })
      }
    }
  } else {
    for (const base of CI_RUNNER_BASELINE) {
      const live = viewByName.get(base.name)
      const verdict = input.verdicts[base.machine]
      if (!live || (input.policies[base.machine] ?? 'pinned') !== 'dynamic' || !verdict?.certain) continue
      if (verdict.verdict === 'allow') {
        for (const label of CI_MANAGED_LANES) {
          const entry = reconciled.stripped[base.name]?.[label]
          if (entry === undefined || entry.state === 'adding') continue
          if (backoff(base.name, label)) { skipped.push({ runner: base.name, label, kind: 'add', why: 'drift-backoff' }); continue }
          if (!mayChange(base.name)) { skipped.push({ runner: base.name, label, kind: 'add', why: 'rate-limit' }); continue }
          if (Date.parse(input.at) - Date.parse(entry.at) < input.params.minHoldSec * 1000) {
            skipped.push({ runner: base.name, label, kind: 'add', why: 'min-hold' }); continue
          }
          if (label === CI_EXCLUSIVE_LANE && localConflict(base.name, base.machine, recoveryAdds)) {
            skipped.push({ runner: base.name, label, kind: 'add', why: 'local-conflict' }); continue
          }
          recoveryAdds.push({ kind: 'add', runner: base.name, runnerId: base.id, machine: base.machine, label, reason: 'allow' })
        }
        continue
      }
      const targets = verdict.verdict === 'busy' ? input.params.stripOnBusy : input.params.stripOnReserved
      for (const label of targets) {
        if (!live.labels.includes(label) || strippedKeys.has(`${base.name}|${label}`)) continue
        if (backoff(base.name, label)) { skipped.push({ runner: base.name, label, kind: 'remove', why: 'drift-backoff' }); continue }
        removes.push({ kind: 'remove', runner: base.name, runnerId: base.id, machine: base.machine, label, reason: verdict.verdict })
      }
    }
  }
  // 第三步:车道地板护栏。全摘会清零的车道保住编号最小的工位(floor-guard 原样);
  // keepIdle(1010 拍板默认开)再加一层「车道留空闲」:幸存者全忙的车道保住一台空闲优先的候选
  // 不摘(skip 理由 lane-busy),别把排队晾在没人接活的车道上。keepIdle=false 时这层整体不生效,与改前一致。
  const keptRemoves: CiLabelOp[] = []
  for (const label of CI_MANAGED_LANES) {
    const laneRemoves = removes.filter(op => op.label === label)
    if (laneRemoves.length === 0) continue
    const removeNames = new Set(laneRemoves.map(op => op.runner))
    const survivors = input.view.filter(runner => runner.online && runner.labels.includes(label)
      && !removeNames.has(runner.name) && baselines.has(runner.name))
    if (survivors.length > 0 && input.params.keepIdle && survivors.every(runner => runner.busy)) {
      // 候选里空闲的按 runnerId 最小者优先;没有空闲候选就取 runnerId 最小者。
      const idleCandidates = laneRemoves.filter(op => viewByName.get(op.runner)?.busy === false)
      const pool = idleCandidates.length > 0 ? idleCandidates : laneRemoves
      const spare = [...pool].sort((left, right) => left.runnerId - right.runnerId)[0]!
      for (const op of laneRemoves) {
        if (op.runner === spare.runner) skipped.push({ runner: op.runner, label: op.label, kind: 'remove', why: 'lane-busy' })
        else keptRemoves.push(op)
      }
      continue
    }
    if (survivors.length > 0) { keptRemoves.push(...laneRemoves); continue }
    const spare = [...laneRemoves].sort((left, right) => left.runnerId - right.runnerId)[0]!
    for (const op of laneRemoves) {
      if (op.runner === spare.runner) skipped.push({ runner: op.runner, label: op.label, kind: 'remove', why: 'floor-guard' })
      else keptRemoves.push(op)
    }
  }
  // 第四步:先加后摘、工位按台账序、标签按字典序;超出一轮上限的记入 skipped。
  const orderIndex = (runner: string): number => {
    const index = CI_RUNNER_BASELINE.findIndex(base => base.name === runner)
    return index === -1 ? CI_RUNNER_BASELINE.length : index
  }
  const ordered = [...repairAdds, ...recoveryAdds, ...keptRemoves].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'add' ? -1 : 1
    return orderIndex(left.runner) - orderIndex(right.runner)
      || (left.label < right.label ? -1 : left.label > right.label ? 1 : 0)
  })
  const ops = ordered.slice(0, MAX_OPS_PER_ROUND)
  for (const op of ordered.slice(MAX_OPS_PER_ROUND)) skipped.push({ runner: op.runner, label: op.label, kind: op.kind, why: 'round-cap' })
  const desired = CI_RUNNER_BASELINE.map(base => ({
    runner: base.name,
    labels: base.labels.filter(label => {
      // desired 是「本轮计划全部执行完后」应有的标签(契约 §9 第 9 步):本轮要摘的不算,欠账已还的才算。
      if (ops.some(op => op.kind === 'remove' && op.runner === base.name && op.label === label)) return false
      const entry = reconciled.stripped[base.name]?.[label]
      if (entry === undefined) return true
      return ops.some(op => op.kind === 'add' && op.runner === base.name && op.label === label)
    }),
  }))
  return { stale: false, ops, skipped, drift, desired }
}

/** 不变量的独立复核:不信任计划层,把 ops 应用到清单副本上重算一遍。 */
export function checkPlanInvariants(input: CiPlanInput, ops: readonly CiLabelOp[]): CiInvariantViolation[] {
  const violations: CiInvariantViolation[] = []
  const baselines = baselineByName()
  const applied = new Map(input.view.map(runner => [runner.name, new Set(runner.labels)]))
  for (const op of ops) {
    if ((CI_UNTOUCHABLE_LABELS as readonly string[]).includes(op.label)) {
      violations.push({ code: 'I2', detail: `不可碰的标签进了计划:${op.label}` })
    }
    const target = applied.get(op.runner)
    if (target === undefined) { violations.push({ code: 'I5', detail: `工位不在清单:${op.runner}` }); continue }
    if (op.kind === 'add') { target.add(op.label); continue }
    const machine = baselines.get(op.runner)?.machine
    if (machine !== undefined && (input.policies[machine] ?? 'pinned') !== 'dynamic') {
      violations.push({ code: 'I3', detail: `pinned 机器上的工位不得摘除:${op.runner}:${op.label}` })
    }
    target.delete(op.label)
  }
  if (ops.length > MAX_OPS_PER_ROUND) {
    violations.push({ code: 'I5', detail: `单轮 ${ops.length} 笔超出上限 ${MAX_OPS_PER_ROUND}` })
  }
  for (const label of CI_MANAGED_LANES) {
    const holders = input.view.filter(runner => runner.online && applied.get(runner.name)!.has(label))
    if (holders.length === 0) violations.push({ code: 'I1', detail: `应用计划后车道 ${label} 无人在线带标签` })
  }
  const locals = new Map<string, string[]>()
  for (const runner of input.view) {
    if (!applied.get(runner.name)!.has(CI_EXCLUSIVE_LANE)) continue
    const machine = baselines.get(runner.name)?.machine
    if (machine === undefined) continue
    locals.set(machine, [...(locals.get(machine) ?? []), runner.name])
  }
  for (const [machine, runners] of locals) {
    if (runners.length <= 1) continue
    violations.push({ code: 'I4', detail: `${machine} 上带 managed-local 的工位有 ${runners.length} 个:${runners.join('、')}` })
  }
  return violations
}
