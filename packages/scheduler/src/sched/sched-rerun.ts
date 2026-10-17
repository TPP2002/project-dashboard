/**
 * UDQ-T4B(暂停误伤超时的自动补跑)的纯判定模块:吃计时报告行,产出补跑计划,校验账本里的补跑痕迹。
 * 只依赖 Node 内建类型与 ./sched-contract——不做 I/O、不读钟、不写盘;执行端(cluster-agent)与
 * 派单端(sched-handoff)两侧共用,判据只有这一份。
 *
 * 口径(设计正本 §6.6 d3,负责人拍板):
 *  · 只有「确认挂起期间超时」的用例才补跑:用例主体窗口与**确认**挂起区间有正重叠;
 *    低速(low)区间不算确认挂起,撞上它只如实记账、不补跑。
 *  · 断言失败、共享钩子超时、非超时失败、报告不完整都不补跑。
 *  · 每张单全生命周期最多补跑 1 次(RERUN_BUDGET):占用凭据 = 时间线里 requeued 事件的 rerun 标记。
 */
import {
  CATEGORY_POLICY, fields, integer, list, oneOf, requireHash, text,
  type TicketSnapshot,
} from './sched-contract'

/** 用例身份三元组:文件(仓库相对正斜杠)+ 标题路径 + 同名实例序号;与执行端 timing-contract 同构同键。 */
export interface CaseIdentity { file: string; titlePath: string[]; instanceIndex: number }
export function identityKey(identity: CaseIdentity): string {
  return JSON.stringify([identity.file, identity.titlePath, identity.instanceIndex])
}

/** 计时报告的一行(udq-timing-v1);这里只按形状取字段,不再复刻执行端的类型。 */
export type TimingReportRow = Record<string, unknown>

export interface SuspendInterval { from: number; to: number | null }
export interface SuspendWindowSet { intervals: SuspendInterval[]; slowIntervals: SuspendInterval[] }

/** 一条补跑候选:身份 + 源指纹 + 用于重叠判定的主体窗口与重叠毫秒数。 */
export interface RerunCase {
  identity: CaseIdentity
  sourceSha256: string
  window: { from: number; to: number }
  overlapMs: number
}

export interface RerunPlan {
  complete: boolean
  eligible: RerunCase[]
  /** 低速/普通超时的身份名单(给人看是哪几条;与 eligible 同一口径排序去重)。紧凑记录 RerunPlanRecord 只留条数。 */
  slowTimeouts: CaseIdentity[]
  otherTimeouts: CaseIdentity[]
  retainedFailures: number
  sharedHookTimeouts: number
  notes: string[]
}

const INCOMPLETE_NOTE = '计时报告不完整,本期不补跑'

/** B1 计时报告(JSONL)解析:空行跳过;坏行当场抛——报告损坏必须显性失败,不能被当空报告吃掉。 */
export function parseTimingReport(content: string): TimingReportRow[] {
  const rows: TimingReportRow[] = []
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('不是对象')
      rows.push(parsed as TimingReportRow)
    } catch (error) {
      throw new Error(`计时报告第 ${index + 1} 行无法解析:${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
  return rows
}

function rowsOf(rows: readonly TimingReportRow[], type: string): TimingReportRow[] {
  return rows.filter(row => row.type === type)
}
function arrayOf(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : [] }
function recordAt(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value !== 'undefined' && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
function errorKind(error: unknown): string {
  const record = recordAt(error)
  return typeof record?.kind === 'string' ? record.kind : 'other'
}
function compareStrings(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }

/** 身份合法性(与 sched-contract 的 requeued.rerun 事件校验同一口径):仓库相对正斜杠、无 ..、非空标题路径。 */
function asIdentity(value: unknown): CaseIdentity | undefined {
  const record = recordAt(value)
  if (record === undefined) return undefined
  const file = record.file
  if (typeof file !== 'string' || file === '' || file.includes('\\') || file.includes('..')
    || file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split('/').some(part => part === '' || part === '.')) {
    return undefined
  }
  const titlePath = record.titlePath
  if (!Array.isArray(titlePath) || titlePath.length === 0
    || titlePath.some(part => typeof part !== 'string' || part === '')) return undefined
  const instanceIndex = record.instanceIndex
  if (typeof instanceIndex !== 'number' || !Number.isSafeInteger(instanceIndex) || instanceIndex < 0) return undefined
  return { file, titlePath: titlePath as string[], instanceIndex }
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** 窗口与区间的正重叠毫秒数;区间右端开放(to=null)视作延伸到窗口末端。0 = 不重叠。 */
function overlapMs(window: { from: number; to: number }, interval: SuspendInterval): number {
  const end = interval.to ?? window.to
  return Math.max(0, Math.min(window.to, end) - Math.max(window.from, interval.from))
}

/**
 * 用例主体窗口(B2):windows 里全部**已闭合**窗口(kind 为 body 或 hook,start/end 都在)的
 * 外包区间 [最早 start.epochMs, 最晚 end.epochMs]。报告行顶层的 start/end 是 stamp 对象
 * (epochMs/monoMs/wallMs),不是可比较的数字;windows 里一个可用窗口都没有才退回
 * frameworkWindow——那是 Vitest 的墙钟近似,与挂起区间不同源,只配当兜底;两者都没有 ⇒ undefined。
 */
function caseWindow(row: TimingReportRow): { from: number; to: number } | undefined {
  let from: number | undefined
  let to: number | undefined
  for (const raw of arrayOf(row.windows)) {
    const window = recordAt(raw)
    if (window === undefined || (window.kind !== 'body' && window.kind !== 'hook')) continue
    const start = recordAt(window.start)
    const end = recordAt(window.end)
    if (start === undefined || typeof start.epochMs !== 'number' || !Number.isFinite(start.epochMs)) continue
    if (end === undefined || typeof end.epochMs !== 'number' || !Number.isFinite(end.epochMs)) continue
    if (from === undefined || start.epochMs < from) from = start.epochMs
    if (to === undefined || end.epochMs > to) to = end.epochMs
  }
  if (from !== undefined && to !== undefined) return { from, to }
  const framework = recordAt(row.frameworkWindow)
  if (framework === undefined) return undefined
  const startEpochMs = framework.startEpochMs
  const endEpochMs = framework.endEpochMs
  if (typeof startEpochMs !== 'number' || typeof endEpochMs !== 'number'
    || !Number.isFinite(startEpochMs) || !Number.isFinite(endEpochMs) || endEpochMs < startEpochMs) {
    return undefined
  }
  return { from: startEpochMs, to: endEpochMs }
}

/** 身份稳定排序:文件 → 标题路径逐元素 → 标题路径长度 → 同名实例序号(eligible 与慢/普通超时名单共用)。 */
function compareIdentity(a: CaseIdentity, b: CaseIdentity): number {
  return compareStrings(a.file, b.file)
    || a.titlePath.length - b.titlePath.length
    || a.titlePath.reduce((diff, part, index) =>
      diff !== 0 ? diff : compareStrings(part, b.titlePath[index] ?? ''), 0)
    || a.instanceIndex - b.instanceIndex
}
function orderedIdentities(identities: Map<string, CaseIdentity>): CaseIdentity[] {
  return [...identities.values()].sort(compareIdentity)
}

/**
 * B2 补跑计划:按行分类计时报告。
 *  · run-start/run-end 不是恰好一条、或 run-end.complete=false ⇒ 整份不完整,全部不补跑;
 *  · scope(组/文件级)报错、run-end 未捕获错误 ⇒ 各计一条保留失败(没有可补跑的身份);
 *  · 祖先作用域(beforeAll/afterAll)有 hook-timeout ⇒ 共享钩子超时,保留不补;用例自己的
 *    beforeEach/afterEach 超时记在该用例的 errors 里,属于超时类失败,照样参与窗口判定;
 *  · 超时类失败 = errorKinds 非空且每一项 ∈ {test-timeout, hook-timeout};
 *    断言失败、混合错误、其他错误 ⇒ 保留不补;
 *  · 超时类且有主体窗口(windows 里已闭合 body/hook 窗口的外包区间,兜底 frameworkWindow)⇒
 *      与确认挂起区间重叠 ⇒ eligible(按身份去重,取重叠更大的一条);
 *      只与低速区间重叠 ⇒ slowTimeouts(身份名单);都不沾 ⇒ otherTimeouts(身份名单);
 *      三类都计入 retainedFailures。
 */
export function planSuspendRerun(rows: readonly TimingReportRow[], windows: SuspendWindowSet): RerunPlan {
  const runStarts = rowsOf(rows, 'run-start')
  const runEnds = rowsOf(rows, 'run-end')
  if (runStarts.length !== 1 || runEnds.length !== 1 || runEnds[0]!.complete !== true) {
    return { complete: false, eligible: [], slowTimeouts: [], otherTimeouts: [],
      retainedFailures: 0, sharedHookTimeouts: 0, notes: [INCOMPLETE_NOTE] }
  }
  const slowTimeouts = new Map<string, CaseIdentity>()
  const otherTimeouts = new Map<string, CaseIdentity>()
  let retainedFailures = 0
  let sharedHookTimeouts = 0
  const eligible = new Map<string, RerunCase>()
  for (const row of rowsOf(rows, 'scope')) {
    retainedFailures += arrayOf(row.errors).length
  }
  retainedFailures += arrayOf(runEnds[0]!.unhandledErrors).length
  for (const row of rowsOf(rows, 'case')) {
    // passed 不用管;skip/todo(身份 allowlist 排除的同文件邻居、todo 占位)没有执行事实,不计任何账;
    // pending 出现在报告里本身就是 complete=false(上面已整份否决)。真正分类的只有跑过且失败的行。
    if (row.state !== 'failed') continue
    const errorKinds = arrayOf(row.errorKinds).filter((kind): kind is string => typeof kind === 'string')
    const identity = asIdentity(row.identity)
    const ancestorHookTimeout = arrayOf(row.ancestorScopes)
      .some(scope => arrayOf(recordAt(scope)?.errors).some(error => errorKind(error) === 'hook-timeout'))
    if (ancestorHookTimeout) { sharedHookTimeouts++; retainedFailures++; continue }
    // 超时类失败:测试闹钟超时,或本用例自己的钩子(beforeEach/afterEach)超时——Vitest 把它记在用例头上。
    const timeoutFailure = errorKinds.length > 0
      && errorKinds.every(kind => kind === 'test-timeout' || kind === 'hook-timeout')
    if (!timeoutFailure) { retainedFailures++; continue }
    const window = caseWindow(row)
    if (window === undefined) { retainedFailures++; continue }
    const suspendOverlap = windows.intervals.reduce((sum, interval) => sum + overlapMs(window, interval), 0)
    const slowOverlap = windows.slowIntervals.reduce((sum, interval) => sum + overlapMs(window, interval), 0)
    if (suspendOverlap > 0) {
      if (identity === undefined || !isSha256(row.sourceSha256)) { retainedFailures++; continue }
      const key = identityKey(identity)
      const existing = eligible.get(key)
      if (existing === undefined || existing.overlapMs < suspendOverlap) {
        eligible.set(key, { identity, sourceSha256: row.sourceSha256, window, overlapMs: suspendOverlap })
      }
      continue
    }
    if (slowOverlap > 0) {
      if (identity !== undefined) slowTimeouts.set(identityKey(identity), identity)
      retainedFailures++; continue
    }
    if (identity !== undefined) otherTimeouts.set(identityKey(identity), identity)
    retainedFailures++
  }
  const notes: string[] = []
  if (slowTimeouts.size > 0) notes.push(`低速期间超时 ${slowTimeouts.size} 条,可能是负载所致,未补跑`)
  const ordered = [...eligible.values()].sort((a, b) => compareIdentity(a.identity, b.identity))
  return { complete: true, eligible: ordered, slowTimeouts: orderedIdentities(slowTimeouts),
    otherTimeouts: orderedIdentities(otherTimeouts), retainedFailures, sharedHookTimeouts, notes }
}

/** 本期只接这三类 vitest 作业;其余作业类型连计时都不开,自然没有补跑。 */
export const RERUN_WORK_TYPES = ['test', 'test:fast', 'test:coverage'] as const
export type RerunWorkType = typeof RERUN_WORK_TYPES[number]

export interface RerunSelectionEntry { identity: CaseIdentity; sourceSha256: string }
/** requeued 事件的 rerun 标记:既是补跑预算的占用凭据,也是下一次执行的用例选择。 */
export interface RerunEventData { reason: string; retainedFailures: number; selection: RerunSelectionEntry[] }

/** 最近一次(自尾向前)携带 rerun 标记的 requeued 事件;不带标记的 requeued 不遮蔽更早的标记。 */
export function rerunSelectionOf(ticket: TicketSnapshot): RerunEventData | undefined {
  for (let index = ticket.timeline.length - 1; index >= 0; index--) {
    const event = ticket.timeline[index]!
    if (event.type !== 'requeued') continue
    const rerun = (event.data as { rerun?: RerunEventData }).rerun
    if (rerun !== undefined) return rerun
  }
  return undefined
}

/**
 * B3 是否该补跑:集群 + 三类 vitest 作业 + 类别策略开了闸 + 报告完整有候选 + 预算未用。
 * 第二参数只读 complete 与 eligible 两个字段 ⇒ 完整计划(RerunPlan)与账本里的紧凑记录
 * (RerunPlanRecord)都能传,两侧共用同一道闸。
 */
export function shouldRerun(ticket: TicketSnapshot,
  plan: { complete: boolean; eligible: readonly unknown[] }): boolean {
  if (ticket.request.execution !== 'cluster') return false
  if (!(RERUN_WORK_TYPES as readonly string[]).includes(ticket.request.work.type)) return false
  if (!CATEGORY_POLICY[ticket.request.category].rerunTimedOutAfterSuspend) return false
  if (!plan.complete || plan.eligible.length === 0) return false
  return rerunSelectionOf(ticket) === undefined
}

/** 账本/事件侧的紧凑补跑候选(不携带窗口明细,窗口留在执行端的计时报告里)。 */
export interface RerunCaseRecord { identity: CaseIdentity; sourceSha256: string; overlapMs: number }
export interface RerunPlanRecord {
  complete: boolean
  eligible: RerunCaseRecord[]
  slowTimeouts: number
  otherTimeouts: number
  retainedFailures: number
  sharedHookTimeouts: number
  notes: string[]
}

/** B5 校验执行端上报的 rerunPlan;不合法一律返回 undefined(按「无补跑计划」处理),绝不抛。 */
export function validateRerunPlan(value: unknown): RerunPlanRecord | undefined {
  try {
    fields(value, {
      complete: oneOf([true, false]),
      eligible: list(item => fields(item, {
        identity: candidate => { if (asIdentity(candidate) === undefined) throw new Error('[sched] 补跑身份不合法') },
        sourceSha256: requireHash,
        overlapMs: candidate => {
          if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
            throw new Error('[sched] overlapMs 必须是非负有限数')
          }
        },
      })),
      slowTimeouts: candidate => { integer(candidate) },
      otherTimeouts: candidate => { integer(candidate) },
      retainedFailures: candidate => { integer(candidate) },
      sharedHookTimeouts: candidate => { integer(candidate) },
      notes: list(text),
    })
  } catch {
    return undefined
  }
  return value as RerunPlanRecord
}
