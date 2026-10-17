/** 调度与现行信箱的契约适配；不追加台账，不启动进程。 */
import { readFileSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import {
  buildLifecycleIdentity, lifecyclePaths, readActiveLifecycleControl, readLifecycleStateRecord, scanLifecycleStates,
  type LifecycleIdentity, type LifecycleStateRecord, type PublishLifecycleJobOptions,
} from '../bot/cluster-lifecycle'
import { hasCode, identityFrom, assertSameIdentity } from '../bot/cluster-lifecycle-contract'
import { assertNoActiveTransitionLease, TransitionLeaseBarrierError } from '../bot/cluster-lifecycle-lease'
import { clusterJobPayload, JOB_TYPES, validateJob, type ClusterJob } from '../bot/cluster-job'
import { defaultRequestedCores, submissionId, type Category, type CodeRef, type DispatchIntent, type TicketSnapshot } from './sched-contract'
import { rerunSelectionOf } from './sched-rerun'
import { elasticFloorCores } from './sched-elastic'

/**
 * 集群 CLI 已校验作业和显式 workers；申请实际并发量，不能把配额上限当作需求。
 * mutation-test 与 unit-test/e2e-test 同列:它的 quotaInject 是 false(stryker.config.json 的
 * concurrency:8 刻意钉死,不许配额注入顶掉),但它不是单进程作业——真机试派时执行侧的许可自检
 * (schedMutationInvocation.ts 按 stryker 配置算出实际要用的 worker 数)要求许可覆盖那个数,
 * 落进下面"quotaInject 非 true 一律申请 1 核"那一支会申请不够而被自拒(SCHED-CLUSTER-MUTATION-
 * REQUESTED-CORES-TOO-LOW)。CATEGORY_POLICY 里 'mutation-test' 的 defaultCores 就是 8,与
 * stryker 配置同源钉死,故走 defaultRequestedCores 取值,不使用下面的单进程兜底。
 */
export function clusterRequestedCores(kind: string, category: Category, quotaCores?: number, workers?: number): number {
  if (workers !== undefined) return workers
  if (category === 'unit-test') return elasticFloorCores(quotaCores)
  if (category === 'e2e-test' || category === 'mutation-test') {
    return defaultRequestedCores(category, quotaCores)
  }
  const spec = JOB_TYPES[kind]
  if (spec === undefined) throw new Error(`[sched] 集群作业不在册:${kind}`)
  if (spec.quotaInject !== true) return 1
  if (quotaCores === undefined || !Number.isSafeInteger(quotaCores) || quotaCores < 1) {
    throw new Error('[sched] 缺少允许机器的有效配额读数，无法确定申请核数')
  }
  return Math.min(quotaCores, 4)
}

/**
 * 提交工单的分片格式 's<i>of<n>' → 集群作业契约的 '<i>/<n>'(cluster-job 的 SHARD_OK 与
 * 产品端按片号命名的正则都只认 '<i>/<n>')。全仓唯一的翻译实现:派单员构造预检与交接共用,
 * 不许再在各处手写同一段正则。输入必须已过 validateSubmission 的 shardTag;这里对非法输入
 * 照样抛错,给直接调用者兜底。
 */
export function calibShardToJobShard(shard: string): string {
  const match = /^s(0|[1-9]\d*)of([1-9]\d*)$/.exec(shard)
  if (match === null) throw new Error(`[sched] 非法的跑分分片:${shard}`)
  if (Number(match[1]) >= Number(match[2])) throw new Error(`[sched] 跑分分片越界:${shard}`)
  return `${match[1]}/${match[2]}`
}

/**
 * 【SCHED-PAYLOAD-FIELD-PROTOCOL-GATE】可选载荷字段 → 接收端最低代理协议号。
 * 发布前按被授予机器心跳里的 protocol 决定带不带:协议号到不了最低线(或读不到 ⇒ undefined)
 * 就省略该字段——省略后的形状必须仍是旧代理认得的载荷(legacyPayloadShapes 的旧形状之一),
 * 否则换代对账会误判身份漂移。null = 不设闸,该字段总是带(与改前逐字节一致)。
 * gate 不传(旧调用方/直调测试)= 旧行为,一字不变。新增可选字段必须在这里登记(结构性用例盯防)。
 * **闸只用于发布**(handoffPublication 带 gate 的那条链路);观察在飞实物(observeHandoff)与撤单租约
 * 对账一律不加闸、按全形状重建期望——见 observeHandoff 的注释,读数抖动时不许收窄「期望」。
 */
export interface PayloadProtocolGate { agentProtocol: number | undefined }
export const PAYLOAD_FIELD_MIN_AGENT_PROTOCOL: Readonly<Record<string, number | null>> = {
  ciAware: 30,
  queueRank: 58,
  // grantedCores 是协议记账时代之前的老字段(AGENT_PROTOCOL_MIN=13 那一代就有;手动与 auto 工单都必带,
  // 执行端拿它当 quotaInject 的缺省并发):所有有协议号的代理都认识,按「老字段=null 不设闸」登记在账。
  grantedCores: null,
  target: null,
  workers: null,
  round: null,
  shard: null,
  rerun: null,
  lifecycleActivation: null,
  lifecycleCanary: null,
}

/** 交接目标的执行端协议读数;读不到(缺心跳/不在快照)= undefined ⇒ 闸保守省略后加字段。 */
export function payloadProtocolGate(agentProtocols: ReadonlyMap<string, number | undefined> | undefined,
  machine: string): PayloadProtocolGate {
  return { agentProtocol: agentProtocols?.get(machine) }
}

/** 按闸摘掉接收端读不懂的可选字段后重过一次白名单校验;其余字段一字不动。 */
function gatedClusterJob(job: ClusterJob, gate: PayloadProtocolGate): ClusterJob {
  const drop = new Set(Object.entries(PAYLOAD_FIELD_MIN_AGENT_PROTOCOL)
    .filter(entry => entry[1] !== null && (gate.agentProtocol === undefined || gate.agentProtocol < entry[1]))
    .map(entry => entry[0]))
  if (drop.size === 0) return job
  const stripped = Object.fromEntries(Object.entries(job).filter(entry => !drop.has(entry[0]))) as ClusterJob
  const valid = validateJob(stripped)
  if (!valid.ok) throw new Error(`[sched] 集群工单不合法:${valid.reason}`)
  return stripped
}

/** 授予核数绑定进 payload，仅作为 quotaInject 工具的缺省并发；显式 workers 与工具固定配置优先。 */
export function clusterJobForTicket(ticket: TicketSnapshot, gate?: PayloadProtocolGate): ClusterJob {
  const active = ticket.attempts.at(-1)!
  if (ticket.request.execution === 'auto') return autoClusterJobForTicket(ticket)
  if (ticket.request.execution !== 'cluster' || ticket.request.codeRef.kind !== 'commit' || !active.permit) {
    throw new Error('[sched] 集群交接需要提交版本与有效许可')
  }
  const kind = ticket.request.work.type
  const spec = JOB_TYPES[kind]
  const targets = ticket.request.work.targetPaths
  // 补跑选择(UDQ-T4B d3)随 payload 下发:执行端按这份名单换目标文件并只放行这些身份。
  // 预算占用凭据在票据时间线的 requeued.rerun 里,payload 只带执行所需的选择本身。
  const rerun = rerunSelectionOf(ticket)
  const job: ClusterJob = {
    ticketId: ticket.ticketId, jobId: submissionId(ticket.ticketId, active.attemptId), kind,
    codeVersion: ticket.request.codeRef.value, grantedCores: active.permit.grantedCores,
    // CI 共存标(T4B-2b)从许可原样透传进 protocol 12 payload:领单口据它放行,执行侧另从许可快照读同一标记。
    ...(active.permit.ciAware === true ? { ciAware: true } : {}),
    // 【卡2 T2】排队名次随 payload 下发:同一拍授予的多张单 createdAt 相同,信箱排序读不出先后;
    // 带 band+queuedAt(与调度台排队投影同向同键)让执行端按真排队顺序领单。auto 路径不带。
    queueRank: { band: ticket.band, queuedAt: ticket.queuedAt },
    ...(spec?.acceptsTarget && !(targets.length === 1 && targets[0] === '.') ? { target: targets.join(' ') } : {}),
    ...(ticket.request.work.workers === undefined ? {} : { workers: ticket.request.work.workers }),
    // 跑分(UDQ-T5-BLOCKS-CLUSTER-AGENT-ON-HOST):round 原样透传,shard 从提交格式翻成契约格式;
    // 非 calib 工单不带这两个键,输出与旧行为逐字节一致(成对规则由 validateJob 兜底)。
    ...(ticket.request.work.round === undefined ? {} : { round: ticket.request.work.round }),
    ...(ticket.request.work.shard === undefined ? {} : { shard: calibShardToJobShard(ticket.request.work.shard) }),
    ...(rerun === undefined ? {} : { rerun: { selection: rerun.selection } }),
  }
  const valid = validateJob(job)
  if (!valid.ok) throw new Error(`[sched] 集群工单不合法:${valid.reason}`)
  return gate === undefined ? job : gatedClusterJob(job, gate)
}

/** 只读票据投影；坏挂号输入不得拖垮派单员。 */
export function autoClusterJobCandidate(ticket: TicketSnapshot): { ok: true; job: ClusterJob } | { ok: false; reason: string } {
  try {
    const active = ticket.attempts.at(-1)
    const { request } = ticket
    if (request.execution !== 'auto' || request.codeRef.kind !== 'commit' || !request.origin || !request.menu
      || !active?.permit || active.permit.machine === request.origin || !active.snapshotReady) {
      return { ok: false, reason: 'auto 单交接需要快照就绪与跨机许可' }
    }
    const ready = active.snapshotReady
    const job: ClusterJob = {
      ticketId: ticket.ticketId, jobId: submissionId(ticket.ticketId, active.attemptId), kind: request.menu.item,
      codeVersion: ready.commit, grantedCores: active.permit.grantedCores,
      ...(active.permit.ciAware === true ? { ciAware: true } : {}),
      auto: { project: request.project, item: request.menu.item, args: [...request.menu.args],
        bundle: ready.bundle, commit: ready.commit, base: ready.base },
    }
    const valid = validateJob(job)
    return valid.ok ? { ok: true, job } : { ok: false, reason: valid.reason ?? 'auto 单字段不合法' }
  } catch { return { ok: false, reason: 'auto 单交接需要快照就绪与跨机许可' } }
}

export function autoClusterJobForTicket(ticket: TicketSnapshot): ClusterJob {
  const result = autoClusterJobCandidate(ticket)
  if (!result.ok) throw new Error(`[sched] auto 工单不合法:${result.reason}`)
  return result.job
}

export function autoIntentCodeRef(ticket: TicketSnapshot): CodeRef {
  return { kind: 'commit', value: ticket.attempts.at(-1)!.snapshotReady!.commit }
}

export function handoffPublication(share: string, ticket: TicketSnapshot, intent: DispatchIntent,
  gate?: PayloadProtocolGate): PublishLifecycleJobOptions {
  const job = clusterJobForTicket(ticket, gate)
  return { share, machine: intent.machine, jobId: intent.submissionId, submissionId: intent.submissionId,
    codeVersion: intent.codeRef.value, createdAt: intent.createdAt, createdBy: ticket.request.submitter,
    payload: clusterJobPayload(job) }
}

export type HandoffObservation = { kind: 'absent'; identity: LifecycleIdentity }
  | { kind: 'unknown' }
  | { kind: 'claim-only'; identity: LifecycleIdentity } | { kind: 'transition'; identity: LifecycleIdentity }
  | { kind: 'record'; identity: LifecycleIdentity; record: LifecycleStateRecord }

/**
 * 【载荷后加字段 · 换代兼容 · 落日待删】同一类事故的第二次:0925 10:21 第二批整合(#895)让 clusterJobForTicket
 * 无条件给载荷加 queueRank,换代瞬间账里唯一那张在飞的旧单(<historical-ticket>,typecheck,被 CI 冻着)的 claim/记录
 * 哈希按无名次旧载荷算,新派单员重建载荷哈希对不上,同样判「身份漂移」整个退出,看护每 30/120 秒重拉照样崩,调度台停摆。
 * 通则:凭证哈希与新身份不符、却与某个旧载荷形状(新载荷去掉「后加字段」的任一非空子集)的哈希相符 ⇒ 按那个旧身份继续观察
 * (旧身份才与执行机手里的实物一致);与所有形状都不符 ⇒ 仍返回新身份,交给 assertSameIdentity 照旧抛漂移(篡改/错配一样拦得住)。
 * 在飞的旧形状单据清零后删除。
 */
export function reconcileLegacyClaimIdentities(claim: LifecycleIdentity, identity: LifecycleIdentity,
  legacy: readonly LifecycleIdentity[]): LifecycleIdentity {
  if (claim.payloadSha256 === identity.payloadSha256) return identity
  return legacy.find(candidate => candidate.payloadSha256 === claim.payloadSha256) ?? identity
}

/**
 * 【0914 兼容 · 落日待删】#712 之前的派单员写的交接凭证不带 ciAware(T4B-2b 新加进 protocol 12 载荷的字段);
 * 升级瞬间在飞的带标票据,其 claim / 生命周期记录 / 信箱工单的哈希都按旧载荷算。凭证哈希与新算法不符、
 * 却与「去掉 ciAware 的载荷」相符时,按旧身份继续观察(旧身份才与执行机手里的实物一致);其它任何漂移照旧抛。
 * 不这么做新派单员会整个退出、看护每 120 秒重拉照样崩(0914 13:43 真机 <historical-ticket>,调度台停摆)。在飞的带标票据清零后删除。
 * 这是单候选形态,派单员现在走 reconcileLegacyClaimIdentities(多候选);本函数留给 0914 的单测。
 */
export function reconcileLegacyClaimIdentity(claim: LifecycleIdentity, identity: LifecycleIdentity,
  legacy: LifecycleIdentity | undefined): LifecycleIdentity {
  return reconcileLegacyClaimIdentities(claim, identity, legacy === undefined ? [] : [legacy])
}

/** 进 payload 摘要的「后加字段」:ciAware(T4B-2b,0914)、queueRank(卡2 T2,0925)。往 clusterJobPayload 白名单再加可选字段时同步加进这里。 */
const LATE_PAYLOAD_KEYS: readonly string[] = ['ciAware', 'queueRank']

/** 新载荷去掉「后加字段」的每个非空子集 = 全部可能的旧载荷形状;载荷里本来就没有的键不参与,没有后加字段则返回空。 */
export function legacyPayloadShapes(payload: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
  let subsets: string[][] = [[]]
  for (const key of LATE_PAYLOAD_KEYS.filter(candidate => Object.hasOwn(payload, candidate))) {
    subsets = subsets.flatMap(subset => [subset, [...subset, key]])
  }
  return subsets.filter(subset => subset.length > 0)
    .map(dropped => Object.fromEntries(Object.entries(payload).filter(([key]) => !dropped.includes(key))))
}

/** 每个旧载荷形状对应的身份(发布参数不变,只换载荷)。只在凭证与新身份对不上时才用,平时不多算哈希。 */
export function legacyHandoffIdentities(publication: PublishLifecycleJobOptions, epoch: string): LifecycleIdentity[] {
  return legacyPayloadShapes(publication.payload).map(payload => buildLifecycleIdentity({ ...publication, epoch, payload }))
}

/**
 * 活的迁移锁只代表正在搬运；坏 claim、过期锁、双态和身份漂移均不伪装成“尚未发布”。
 *
 * 观察**一律不加闸**、按不加闸的全形状重建期望(SCHED-PAYLOAD-FIELD-PROTOCOL-GATE 第三轮修正):
 * 闸只管「第一次发布」。在飞的 claim/记录是更早发布的,当时的协议号读数可能更高(全形状在档);
 * 而读数随时会抖——执行机重启、心跳缺失 ⇒ 闸保守省略 ⇒ 收窄后的重建期望比实物**短**,
 * legacyPayloadShapes 只会往更短摘、永远摘不出比期望更长的实物 ⇒ 必判身份漂移把派单员拽退出。
 * 全形状期望 + legacyHandoffIdentities 的旧形状对账,全形状与任何更短形状的实物都认得。
 */
export function observeHandoff(share: string, ticket: TicketSnapshot, intent: DispatchIntent, at: string): HandoffObservation {
  const publication = handoffPublication(share, ticket, intent)
  const control = readActiveLifecycleControl({ share, machine: intent.machine })
  let identity = buildLifecycleIdentity({ ...publication, epoch: control.epoch })
  const paths = lifecyclePaths(share, control.epoch, intent.machine)
  try {
    assertNoActiveTransitionLease(paths, intent.submissionId)
    const states = scanLifecycleStates(paths, intent.submissionId)
    let claimed = false
    try {
      const claim = identityFrom(JSON.parse(readFileSync(join(paths.claims, `${intent.submissionId}.json`), 'utf8')), 'sched claim')
      if (claim.payloadSha256 !== identity.payloadSha256) {
        identity = reconcileLegacyClaimIdentities(claim, identity, legacyHandoffIdentities(publication, control.epoch))
      }
      assertSameIdentity(claim, identity, 'sched claim')
      claimed = true
    } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
    if (states.length > 1 || (states.length > 0 && !claimed)) throw new Error('[sched] 交接实物身份不唯一或缺 claim')
    if (states.length === 0) return { kind: claimed ? 'claim-only' : 'absent', identity }
    const record = readLifecycleStateRecord({ share, epoch: control.epoch, machine: intent.machine,
      submissionId: intent.submissionId, state: states[0]! })
    assertSameIdentity(record, identity, 'sched lifecycle record')
    return { kind: 'record', record, identity }
  } catch (error) {
    if (error instanceof TransitionLeaseBarrierError && error.isLiveAt(Date.parse(at))) return { kind: 'transition', identity }
    throw error
  }
}

/** 日志坐标只许相对共享盘，不能把执行机盘符传播给等待方。 */
export function handoffLogPath(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value || win32.parse(value).root !== '' || posix.isAbsolute(value)
    || value.replaceAll('\\', '/').split('/').includes('..')) throw new Error('[sched] 结果日志不是共享盘相对路径')
  return value.replaceAll('\\', '/')
}
