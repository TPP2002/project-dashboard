/**
 * 作业对象纳管及挂起动作的唯一流程入口。本机包装器与代理使用同一实现。
 * KILL_ON_JOB_CLOSE 意味着控制端与执行树同生共死;因此挂起的一切状态都是短命的,
 * 任何跨死亡的续做都只针对记账,不针对进程。
 * 控制端死亡后离线恢复只核对和收尾；旧树结束、旧执行迁终态及换号重排严格沿用 T3。
 * Windows 接口移植 T-pre 复测工具；禁止用父子链代替作业成员表，确认只认线程挂起计数。
 * SCHED-SUSPEND-FAULT-NO-RECOVERY-0924:执行期拿不准不再一次就永久 faulted——只读查询失败
 * 不触发冻结;改状态/帮手/落盘拿不准先冻结保护并记『暂时拿不准』,此后每拍照判定流重新核实,
 * 树到了该到的状态(CI 空闲=已恢复、CI 在跑=按规则冻着)的那一拍才解除——补挂起核实通过不算恢复;
 * 连续超过 SUSPEND_UNCERTAIN_FAULT_MS 没到该到的状态才升级既有 faulted 交人工路径(对外显示不变)。
 * SCHED-SUSPEND-MEMBER-VANISH-THROW-0924:跑着的树上,成员表列 pid 与逐个描述之间短命进程彻底
 * 退出会让描述带 error;非 suspend 动作先复查该 pid 是否已不在作业成员表,已退出就跳过而不是抛
 * (仍在表里或动作是 suspend 时照旧抛,保持占用)。
 * SCHED-SUSPEND-VERIFY-SPIN-0924:挂起保持态(含 faulted)的例行复核按连续确认次数从 1 秒指数
 * 退避到 60 秒封顶——树已冻住,逐拍全量线程核验让看守宿主常驻吃掉小半核、把操作流水写成海;
 * 显式 operate、保护性补挂起、拿不准期间的解除判据核验一律不退避。
 */
import { createNativeTree, isHostUnavailableFailure, isMutatingNativeFailure, isReadonlyNativeFailure,
  type NativeTree, type TreeMember } from './sched-suspend-native'
import { decideSuspension, emptyCiMemory, type CiObservation } from './sched-suspend-policy'
import { processGone, SuspendStore, type SuspendAction, type SuspendRecord } from './sched-suspend-store'
import { suspendClock } from './sched-suspend-timing'
import type { PermitAuthority } from './sched-permit-authority'

export interface ManagedExecution {
  ticketId: string; attemptId: string; token: string; machine: string; share: string; category: string; ownerPid: number
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv
  /**
   * 许可带 ciAware（UDQ-T4B-2）：这棵树是 CI 在跑期间按余量派出来的。
   * 开跑即整树降到最低优先级、整个生命周期不 restore，CI 原因也不冻它（manual/owner-hold 照旧）。
   * 缺省 false = T4a 老行为，一字不变。只存在于控制端本进程，不落 SuspendRecord。
   */
  ciAware?: boolean
  /** 只经私有控制管道转交，不能复制到 SuspendRecord/环境/日志。 */
  permitAuthority?: PermitAuthority
  /** Remote mode prepares the tree here; only the native ACK/projection/lease gate releases it. */
  remoteStartGate?: true
}
const memberKey = (member: TreeMember): string => `${member.pid}:${member.creationFileTime}`
const UNKNOWN_CI_ALERT = '纯 CI 暂停的未知读数累计超过三小时；交人工处理，不自动恢复'
/**
 * 『暂时拿不准』升级阈值(负责人 0924 拍板【四】【五】):进入暂时拿不准后连续超过该时长仍未核实通过
 * (帮手一直不响应或核实一直失败),才升级成既有 faulted 交人工路径;该路径行为与对外显示不变。
 */
export const SUSPEND_UNCERTAIN_FAULT_MS = 10 * 60_000
/**
 * faulted 自动试恢复的节奏(SCHED-FAULTED-SELF-HEAL-0925,负责人 0925 拍板选项 C,问题 1 选 c):
 * 进入 faulted(交人工)后每 30 分钟按正常判定流重新核实一次,最多 4 次;核实通过(含与首次挂起
 * 同等强度的硬核实)才解除 faulted,4 次都不过就永久退回交人工(等于基点行为),之后不再自动碰。
 * 只影响 faulted 的记录;『暂时拿不准』的自愈流程、UNKNOWN_CI_ALERT 兜底、硬超时豁免口径一字不改。
 */
export const SUSPEND_FAULT_HEAL_INTERVAL_MS = 30 * 60_000
/** faulted 自动试恢复的总次数上限(SCHED-FAULTED-SELF-HEAL-0925):整次执行累计、不清零。 */
export const SUSPEND_FAULT_HEAL_MAX_ATTEMPTS = 4
/**
 * 总开关的环境变量读法(SCHED-FAULTED-SELF-HEAL-0925):SCHED_SUSPEND_FAULT_HEAL=off(仅这一个取值)
 * 等价于 faultHeal.enabled=false,是紧急关闸,免得出事时要改代码;其余任何取值(含未设)都是开着。
 */
export function faultHealEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env.SCHED_SUSPEND_FAULT_HEAL !== 'off'
}
/**
 * 挂起保持态例行复核的退避节奏(SCHED-SUSPEND-VERIFY-SPIN-0924):树已冻住,逐拍全量线程核验
 * 让看守宿主常驻吃掉小半核、把 native-operations.jsonl 写成海;按连续确认次数从基准间隔指数
 * 退避,封顶到分钟级。只作用于 tick 保持态的例行复核;节奏只活在内存——控制端与树同生共死,
 * 重启后从最密一档重起,不影响安全语义。
 */
export const SUSPEND_VERIFY_SPIN_BASE_MS = 1_000
export const SUSPEND_VERIFY_SPIN_MAX_MS = 60_000
/** 单次操作在控制器内的核对轮数与毫秒预算(拍板【五】具名;与原生单请求超时同量级,不再散落字面量)。 */
const OPERATION_VERIFY_PASSES = 20
const OPERATION_VERIFY_BUDGET_MS = 12_000
/** 暂停账/本机落盘失败(EPERM 等带 errno 的 IO 错)按拿不准处置:先冻结保护,再等改名恢复后续写。 */
function isRecordIoFailure(error: unknown): boolean {
  return typeof (error as NodeJS.ErrnoException)?.code === 'string'
}
const closeInterval = (intervals: SuspendRecord['intervals'], at: number): void => {
  const open = intervals.at(-1)
  if (open?.to === null) open.to = at
}

export class SuspensionController {
  private record!: SuspendRecord
  private readonly native: NativeTree
  private readonly now: () => number
  private inFlight: Promise<boolean> | undefined
  private dirty = false
  /** 本次纳管的执行是不是 CI 期间按余量派出来的（只活在本进程，见 ManagedExecution.ciAware）。 */
  private ciAware = false
  private remoteStartGate = false
  /** 同一段只读查询失败的告警去重(拍板【三】『只记一次告警』);核实通过即复位。 */
  private lastReadonlyWarn: string | undefined
  /** 暂时拿不准期间挂起保护失败的告警去重;核实通过即复位。 */
  private lastUncertainWarn: string | undefined
  /** 本次『暂时拿不准』是不是改状态一档(第二轮拍板【三】):改状态/帮手/落盘失败置真,只读失败置假
   *  (已真不降档)。改状态一档期间只读应答与核实成功都不解除、不重置升级钟,必须等树到该到的状态;
   *  只读一档帮手应答即可解除。只活在内存,解除时复位。 */
  private uncertainMutating = false
  /** 例行复核退避账(SCHED-SUSPEND-VERIFY-SPIN-0924,只活在内存):连续确认次数与下次复核时刻。 */
  private routineVerifyCount = 0
  private routineVerifyDueAt: number | null = null
  /** faulted 自动试恢复配置(SCHED-FAULTED-SELF-HEAL-0925):缺省开、30 分钟一试、最多 4 次。 */
  private readonly faultHeal: { enabled: boolean; intervalMs: number; maxAttempts: number }
  constructor(private readonly options: { store: SuspendStore; native?: NativeTree; now?: () => number; warn: (message: string) => void
    faultHeal?: { enabled?: boolean; intervalMs?: number; maxAttempts?: number } }) {
    this.native = options.native ?? createNativeTree(); this.now = options.now ?? suspendClock
    this.faultHeal = { enabled: options.faultHeal?.enabled ?? faultHealEnabledFromEnv(process.env),
      intervalMs: options.faultHeal?.intervalMs ?? SUSPEND_FAULT_HEAL_INTERVAL_MS,
      maxAttempts: options.faultHeal?.maxAttempts ?? SUSPEND_FAULT_HEAL_MAX_ATTEMPTS }
  }
  get snapshot(): SuspendRecord { return structuredClone(this.record) }
  private save(initial = false): void {
    this.record.sequence++; this.record.at = this.now(); this.dirty = true
    if (initial) this.options.store.create(this.record)
    else this.options.store.write(this.record)
    this.dirty = false
  }

  /** 在执行第一次放行前完成纳管和本机落盘。已有同执行的记录不许被新控制端覆盖。 */
  async manage(input: ManagedExecution, intent: { manual: boolean; ownerHold: boolean; ciCoexist?: boolean } = { manual: false, ownerHold: false },
    observe: () => CiObservation = () => ({ state: 'unknown', observedAt: this.now() })): Promise<TreeMember> {
    if (this.options.store.read()) throw new Error('[sched] 同执行已有本机记录，拒绝重复启动')
    this.ciAware = input.ciAware === true
    this.remoteStartGate = input.remoteStartGate === true || input.env.SCHED_MODE === 'remote'
    if (this.remoteStartGate && !this.options.native) throw new Error('[sched] 远程执行必须提供受租约约束的原生树')
    this.record = { schema: 1, ticketId: input.ticketId, attemptId: input.attemptId, token: input.token,
      machine: input.machine, share: input.share, category: input.category, ownerPid: input.ownerPid,
      root: null, host: null, ended: false, sequence: 0, at: this.now(), mode: 'running', reasons: [],
      manual: false, ownerHold: false, memory: emptyCiMemory(), ciPausedSince: null, priorityLow: false,
      operation: null, operations: [], intervals: [], slowIntervals: [], alert: null, uncertainSince: null }
    this.save(true)
    try {
      const launched = await this.native.launch({ ...input, at: this.now(), directory: `${this.options.store.file}.native`,
        recordHost: host => { this.record.host = host; this.save() },
        env: { ...input.env, SCHED_SUSPEND_RECORD: this.options.store.file } })
      this.record.root = launched.root; this.record.host = launched.host; this.save()
      // ciAware 的执行一开跑就整树降到最低优先级，且整个生命周期不复原；降不动按既有口径保持挂起交人工。
      if (this.ciAware && !await this.operate('lower')) await this.holdAfterUncertainty('降优先级未确认')
      // 原生宿主编译/启动期间 CI 也可能出现；放行初始线程前再消费最新读数。
      await this.tick(observe(), intent)
      if (!this.remoteStartGate) await this.native.release()
      return launched.root
    } catch (error) { await this.native.close(); throw error }
  }

  /** 一次操作最多做 T-pre 的20轮核对；未确认保留同操作号，交下一拍继续，不无界占主循环。
   *  options.routine(SCHED-SUSPEND-VERIFY-SPIN-0924):标记这是 tick 保持态的例行复核,允许按
   *  连续确认指数退避;缺省 false 的调用(显式操作、保护性补挂起)每次都真核。 */
  operate(action: SuspendAction, options?: { routine?: boolean }): Promise<boolean> {
    if (this.inFlight) return this.inFlight
    const work = this.apply(action, options?.routine === true)
    this.inFlight = work
    void work.finally(() => { if (this.inFlight === work) this.inFlight = undefined }).catch(() => {})
    return work
  }
  private async apply(action: SuspendAction, routine = false): Promise<boolean> {
    if (this.record.ended) throw new Error('[sched] 已结束执行不能操作进程')
    if (this.dirty) this.save()
    if (this.record.operation?.status === 'pending' && this.record.operation.action !== action) {
      this.options.warn('[sched] 前一操作尚未确认，保持原操作号及占用'); return false
    }
    if (this.record.operation?.status === 'confirmed' && this.record.operation.action === action) {
      // SCHED-SUSPEND-VERIFY-SPIN-0924 的免核拍:tick 保持态的例行挂起复核、无拿不准在身(或已
      // faulted——解除判据流不再经此)且退避未到点时,本拍不触宿主、不写流水,直接按已确认放行。
      if (routine && action === 'suspend' && !this.uncertainMutating
        && (this.record.faulted || this.record.uncertainSince == null)
        && this.routineVerifyDueAt !== null && this.now() < this.routineVerifyDueAt) return true
      const members = await this.native.members()
      if (members.length > 0 && members.every(member => this.record.operation!.results[memberKey(member)]?.status === 'confirmed')) {
        // 逐个串行问，不再一次性 Promise.all 塞给原生宿主：宿主是单进程串行处理请求，而 12 秒超时
        // 从写进管道那一刻起算，成员一多、机器一忙，排在队尾的 check 还没轮到就超时，
        // 会被 cycle 当成「状态未确认」永久挂起（0924 全量单测实测三次）。遇到第一个未确认即停。
        let checksPassed = true
        for (const member of members) {
          const check = await this.native.check(action, member, this.record.operation!.id)
          if (!check.confirmed) { checksPassed = false; break }
        }
        const finalMembers = await this.native.members(), identities = new Set(members.map(memberKey))
        // 第二轮拍板【一】:操作核实通过只证明树确实处于该操作之后的状态,不解除『暂时拿不准』——
        // 拿不准期间补挂起的保护性冻结核实通过≠恢复;解除只认判定流里「树到了该到的状态」的那一拍(step 收口)。
        if (checksPassed && finalMembers.length === members.length
          && finalMembers.every(member => !member.error && identities.has(memberKey(member)))) {
          this.noteRoutineVerifyDone(routine, action)
          return true
        }
      }
    }
    if (!this.record.operation || this.record.operation.status !== 'pending') {
      if (this.record.operation) this.record.operations.push(structuredClone(this.record.operation))
      this.record.operation = { id: (this.record.operation?.id ?? this.record.operations.at(-1)?.id ?? 0) + 1, action, at: this.now(), status: 'pending', results: {} }
      // 重开操作号说明保持态已被打破(新动作/复核未过),退避账清零,重新挂起后从最密一档重起。
      this.routineVerifyCount = 0; this.routineVerifyDueAt = null
      // 发出首个恢复调用前停止扣时；部分恢复期间不能冒充整树仍被冻结。
      if (action === 'resume') {
        const at = this.now()
        closeInterval(this.record.intervals, at)
        // 首个成员放行后就可能产出样本；低速不可比窗口也必须先落盘，不能等最后一个成员确认。
        if (this.record.priorityLow && this.record.slowIntervals.at(-1)?.to !== null) this.record.slowIntervals.push({ from: at, to: null })
      }
      this.save()
    }
    const op = this.record.operation, began = this.now()
    for (let pass = 0; pass < OPERATION_VERIFY_PASSES && this.now() - began < OPERATION_VERIFY_BUDGET_MS; pass++) {
      const members = await this.native.members()
      for (const member of members) {
        const key = memberKey(member)
        if (member.error || !member.creationFileTime) {
          // SCHED-SUSPEND-MEMBER-VANISH-THROW-0924:跑着的树上,成员表列 pid 与逐个描述之间短命
          // 进程彻底退出会让描述带 error。非 suspend 动作先复查该 pid 是否已不在作业成员表:
          // 已退出就跳过(无需也不应对它 act);仍在表里读不出身份才抛,保持占用交人工。
          // suspend 是保护性冻结,不跳过——宁可多冻结保护一轮,也不漏冻任何存疑成员。
          if (action !== 'suspend' && await this.memberVanished(member.pid)) continue
          throw new Error('[sched] 成员身份不可读，保持占用')
        }
        // 调用已发生但结果尚未刷回也可能中断；先核对，原生计数已经满足便不再增加一层。
        if (op.results[key]) {
          const check = await this.native.check(action, member, op.id)
          if (check.confirmed) { op.results[key] = { member, status: 'confirmed', detail: check }; this.save(); continue }
        }
        op.results[key] = { member, status: 'pending' }; this.save()
        const result = await this.native.act(action, member, op.id)
        op.results[key] = { member, status: result.status, detail: result }; this.save()
      }
      const after = await this.native.members()
      let confirmed = after.length > 0
      for (const member of after) {
        const key = memberKey(member)
        const check = await this.native.check(action, member, op.id)
        // suspend 的树已经冻住、不会再生孩子，故仍旧坚持「本轮开头枚举到且被 act 过」这条附加条件，
        // 防止暂停时漏掉新生儿；resume/lower/restore 一放行树就在跑，全量单测里大量短命子进程
        // 每一轮枚举之间都在出生退出，这条附加条件对跑着的树永远不成立，只保留真判据
        // （原生侧 check：resume 看我们是否还压着层、lower/restore 看实际优先级）。
        const ok = action === 'suspend' ? !member.error && check.confirmed && op.results[key] !== undefined
          : !member.error && check.confirmed
        op.results[key] = { member, status: ok ? 'confirmed' : 'unconfirmed', detail: check }; this.save()
        confirmed &&= ok
      }
      const finalMembers = await this.native.members()
      const verified = new Set(after.map(memberKey))
      if (action === 'suspend') {
        confirmed &&= finalMembers.length === after.length && finalMembers.every(member => !member.error && verified.has(memberKey(member)))
      } else {
        // 已退出的成员（在 after 里、不在 finalMembers 里）不管；收尾才出生、从未被本操作 act 过的成员
        // 逐个串行补问一次：没被我们冻过/降过的成员 check 天然成立，真被压着没放掉的 check 照样不成立。
        for (const member of finalMembers) {
          const key = memberKey(member)
          if (verified.has(key)) continue
          const check = await this.native.check(action, member, op.id)
          const ok = !member.error && check.confirmed
          op.results[key] = { member, status: ok ? 'confirmed' : 'unconfirmed', detail: check }; this.save()
          confirmed &&= ok
        }
      }
      if (confirmed) {
        const at = this.now()
        op.status = 'confirmed'
        // 第二轮拍板【一】:确认不解除『暂时拿不准』(补挂起也一样),uncertainSince 挂着时连随行告警
        // 也不清,免得升级钟被当拍清零。既有的「清核对预算用尽类告警」行为保留(仅限未拿不准时)。
        if (!this.record.faulted && this.record.alert !== UNKNOWN_CI_ALERT && this.record.uncertainSince == null) this.record.alert = null
        if (action === 'suspend') {
          if (this.record.intervals.at(-1)?.to !== null) this.record.intervals.push({ from: at, to: null })
          closeInterval(this.record.slowIntervals, at); this.record.mode = 'paused'
          if (this.record.reasons.length === 1 && this.record.reasons[0] === 'ci') this.record.ciPausedSince ??= at
        } else if (action === 'resume') {
          this.record.mode = this.record.priorityLow ? 'slow' : 'running'
          if (this.record.priorityLow && this.record.slowIntervals.at(-1)?.to !== null) this.record.slowIntervals.push({ from: at, to: null })
        } else if (action === 'lower') this.record.priorityLow = true
        else { this.record.priorityLow = false; closeInterval(this.record.slowIntervals, at); if (this.record.mode === 'slow') this.record.mode = 'running' }
        this.save(); return true
      }
      if (after.length === 0) return false
    }
    this.record.alert = '整棵树尚未确认，保持挂起与占用，等待人工核对'
    this.save(); this.options.warn(`[sched] ${this.record.alert}`); return false
  }

  /** 人工意图与自动原因分开保存；重排后的人工意图由逻辑单快照重新提供。
   *  0924 拍板【一】~【四】(第二轮复核修订):执行期拿不准不再一次就永久 faulted——只读查询失败不触发
   *  冻结只告警一次;改状态调用/帮手整体不可用/暂停账落盘失败先冻结保护 CI 并记『暂时拿不准』起点。
   *  解除只认「帮手有响应+核实成功+树到了该到的状态」的那一拍(补挂起核实通过不算恢复);改状态一档
   *  期间只读应答不重置升级钟;连续超过 SUSPEND_UNCERTAIN_FAULT_MS 没到该到的状态才升级交人工。 */
  async tick(observation: CiObservation, intent: { manual: boolean; ownerHold: boolean; ciCoexist?: boolean }): Promise<void> {
    // faulted 保持态:例行复核走退避(SCHED-SUSPEND-VERIFY-SPIN-0924),不再每拍全量核验空转;
    // 自动出路按负责人 0925 拍板选项 C(SCHED-FAULTED-SELF-HEAL-0925):总开关关闭或次数用尽时
    // 行为与基点一字不变(只补挂起,永不试恢复);到点才进一次自愈尝试,平时保持交人工。
    if (this.record.faulted) {
      const attempts = this.record.healAttempts ?? 0
      if (!this.faultHeal.enabled || attempts >= this.faultHeal.maxAttempts) { await this.operate('suspend', { routine: true }); return }
      const faultedAt = this.record.faultedAt ?? this.now()
      if (this.record.faultedAt == null) { this.record.faultedAt = faultedAt; this.save() }
      if (this.now() - Math.max(this.record.healLastAt ?? 0, faultedAt) < this.faultHeal.intervalMs) {
        await this.operate('suspend', { routine: true }); return
      }
      await this.attemptFaultHeal(observation, intent)
      return
    }
    const uncertainSince = this.record.uncertainSince ?? null
    if (uncertainSince !== null && this.now() - uncertainSince >= SUSPEND_UNCERTAIN_FAULT_MS) {
      // 拍板【四】:升级走既有 faulted 路径,行为与对外显示不变。
      await this.holdAfterUncertainty(`连续 ${SUSPEND_UNCERTAIN_FAULT_MS / 60_000} 分钟拿不准，帮手未恢复或核实未通过`)
      return
    }
    try {
      await this.step(observation, intent)
      this.lastReadonlyWarn = undefined
    } catch (error) {
      if (isReadonlyNativeFailure(error)) { this.noteReadonlyFailure(error); return }
      if (isHostUnavailableFailure(error) || isMutatingNativeFailure(error) || isRecordIoFailure(error)) {
        await this.protectAfterUncertainty(String(error))
        return
      }
      throw error
    }
  }
  /** faulted 自动试恢复的一次尝试(SCHED-FAULTED-SELF-HEAL-0925,选项 C):先记账再动手,摘下 faulted
   *  走与「没 faulted」完全相同的正常判定流,之后做一次与首次挂起同等强度的硬核实,通过才解除 faulted;
   *  未通过一律走既有 holdAfterUncertainty 重新交人工并冻住整树。任何路径退出时「未通过则 faulted 必真」
   *  由 try/finally 保证。healAttempts 整次执行累计、通过也不清零——「通过→去抖后恢复失败→再 faulted」
   *  的循环必须被总上限管住,否则冻着的树永远占核且从不退回人工。 */
  private async attemptFaultHeal(observation: CiObservation, intent: { manual: boolean; ownerHold: boolean; ciCoexist?: boolean }): Promise<void> {
    const n = (this.record.healAttempts ?? 0) + 1, limit = this.faultHeal.maxAttempts
    // a. 先记账再动手:healAttempts+1、healLastAt=now()、save();中途崩溃/超时也不会无限重试。
    this.record.healAttempts = n; this.record.healLastAt = this.now(); this.save()
    this.options.warn(`[sched] faulted 自动恢复第 ${n}/${limit} 次尝试:按正常判定流重新核实，通过才解除`)
    // b. 把例行复核退避账清零,保证本次尝试里的挂起核验是真核,不被「免核拍」跳过。
    this.routineVerifyCount = 0; this.routineVerifyDueAt = null
    // c. 暂时摘下 faulted 与 uncertainSince(旧值不再复原:未通过会重新置回/置起),让 step 走正常判定流。
    this.record.faulted = false; this.record.uncertainSince = null
    let passed = false, reason = '判定流走了保护(树未到该到的状态)'
    try {
      try {
        await this.step(observation, intent)
        // d. step 走了 protectAfterUncertainty(uncertainSince 被置起)或抛任何错误,统统算未通过。
        if (this.record.uncertainSince == null) {
          // e. 通过 step 后再做一次硬核实:paused 就真核每个成员线程仍冻结,非 paused 就真核
          // 没有任何成员还被我们压着(专治 faulted 时补挂起没确认、账上仍是 running 的部分冻结树)。
          if (this.record.mode === 'paused' ? await this.operate('suspend') : await this.operate('resume')) passed = true
          else reason = '硬核实未确认'
        }
      } catch (error) { reason = String(error) }
      if (!passed) {
        // g. 未通过:走既有 holdAfterUncertainty——重新置 faulted、写告警、中断操作收尾成 unconfirmed、补挂起冻住整树。
        const exhausted = n >= limit ? ';已用完 4 次，不再自动尝试，请人工撤单' : ''
        await this.holdAfterUncertainty(`自动恢复第 ${n}/${limit} 次未通过:${reason}${exhausted}`)
      }
    } finally {
      // h. 不变量:任何路径(含抛错)退出自愈尝试时,只要没通过,record.faulted 必为 true。
      if (!passed && !this.record.faulted) {
        this.record.faulted = true
        if (this.record.faultedAt == null) this.record.faultedAt = this.now()
        try { this.save() } catch { /* 落盘失败保留内存态,与既有保护口径一致 */ }
      }
    }
    if (!passed) return
    // f. 通过:faulted=false、uncertainSince=null、uncertainMutating=false;告警只在「状态未确认」开头
    // (faulted/拿不准类)时清成 null,别的告警(如 UNKNOWN_CI_ALERT)原样保留;faultedAt 与 healLastAt
    // 清空;healAttempts 不清零(整次执行合计最多 limit 次);例行告警去重账复位。
    this.record.faulted = false; this.record.uncertainSince = null; this.uncertainMutating = false
    if (this.record.alert?.startsWith('状态未确认')) this.record.alert = null
    this.record.faultedAt = null; this.record.healLastAt = null
    this.lastReadonlyWarn = undefined; this.lastUncertainWarn = undefined
    this.save()
    this.options.warn(`[sched] faulted 已自动恢复(第 ${n} 次尝试)，回到正常判定流`)
  }
  /** tick 的正常判定流:消费 CI 读数,先补完中断中的操作,再按决定挂起/降速/恢复。 */
  private async step(observation: CiObservation, intent: { manual: boolean; ownerHold: boolean; ciCoexist?: boolean }): Promise<void> {
    const decision = decideSuspension({ now: this.now(), observation, memory: this.record.memory,
      reasons: this.record.reasons, category: this.record.category, pausedSince: this.record.ciPausedSince,
      ciAware: this.ciAware, ...intent })
    this.record.memory = decision.memory; this.record.reasons = decision.reasons
    this.record.manual = intent.manual; this.record.ownerHold = intent.ownerHold
    if (decision.reasons.length !== 1 || decision.reasons[0] !== 'ci') this.record.ciPausedSince = null
    else if (this.record.mode === 'paused') this.record.ciPausedSince ??= this.now()
    if (decision.alert) {
      if (this.record.alert !== UNKNOWN_CI_ALERT) this.options.warn(`[sched] ${UNKNOWN_CI_ALERT}`)
      this.record.alert = UNKNOWN_CI_ALERT
    } else if (this.record.alert === UNKNOWN_CI_ALERT) this.record.alert = null
    this.save()
    if (this.record.operation?.status === 'pending') {
      if (!await this.operate(this.record.operation.action)) { await this.protectAfterUncertainty('中断操作仍未确认'); return }
    }
    if (decision.mode === 'paused') {
      // 即使账上已 paused，也逐拍核对新成员；原生 OwnsSuspend 防止重复增加挂起层数。
      // 保持态的例行复核允许退避(SCHED-SUSPEND-VERIFY-SPIN-0924);未确认/首次挂起照旧真核。
      if (!await this.operate('suspend', { routine: true })) { await this.protectAfterUncertainty('挂起未确认'); return }
      // CI 在跑,该到的状态就是按规则冻着:本拍核实通过即满足第二轮拍板【一】的三条,在此解除。
      this.settleUncertainty()
    } else if (decision.mode === 'slow') {
      if (!await this.operate('lower')) { await this.protectAfterUncertainty('降优先级未确认'); return }
      if (this.record.mode === 'paused' && !await this.operate('resume')) { await this.protectAfterUncertainty('恢复未确认'); return }
      this.settleUncertainty()
    } else {
      // ciAware 的 low 是授予时就定下的运行口径(不是 CI 暂停的临时降速),整个生命周期都不复原;
      // 它靠 resume 之后 record.mode 记为 slow、priorityLow 保持 true,所以这里必须对「非 slow 就 restore」短路。
      if (this.record.priorityLow && !this.ciAware && !await this.operate('restore')) { await this.protectAfterUncertainty('恢复优先级未确认'); return }
      if (this.record.mode === 'paused') {
        // CI 空闲,该到的状态是已恢复:本拍 resume 核实通过才算解除,失败照旧冻结保护。
        if (!await this.operate('resume')) { await this.protectAfterUncertainty('恢复未确认'); return }
        this.settleUncertainty()
      } else {
        // 账上本就 running 且无悬着的操作:树按账即目标态,只读探一遍成员表,帮手应答即核实;
        // 应答失败原样抛给 tick 归类(只读/改状态),拿不准保持、升级钟不重置。
        await this.probeAndSettleUncertainty()
      }
    }
  }
  /** 第二轮拍板【一】的解除收口:uncertainSince 与随行告警只在这里清(faulted 与三小时未知兜底不动)。
   *  只在判定流已把树带到该到的状态、帮手有响应且核实成功的那一拍调用;无拿不准时是空操作。 */
  private settleUncertainty(): void {
    if (this.record.faulted || this.record.uncertainSince == null) return
    this.record.uncertainSince = null
    if (this.record.alert !== UNKNOWN_CI_ALERT) this.record.alert = null
    this.uncertainMutating = false
    this.lastReadonlyWarn = undefined; this.lastUncertainWarn = undefined
    this.save()
  }
  /** 例行复核真核通过后推进退避账(SCHED-SUSPEND-VERIFY-SPIN-0924);非例行路径、非挂起动作、
   *  或拿不准在身时清账——保护动作与解除判据核验后都从最密一档重起,不继承旧节奏。 */
  private noteRoutineVerifyDone(routine: boolean, action: SuspendAction): void {
    if (!routine || action !== 'suspend' || this.uncertainMutating
      || (!this.record.faulted && this.record.uncertainSince != null)) {
      this.routineVerifyCount = 0; this.routineVerifyDueAt = null
      return
    }
    this.routineVerifyCount++
    this.routineVerifyDueAt = this.now()
      + Math.min(SUSPEND_VERIFY_SPIN_BASE_MS * 2 ** (this.routineVerifyCount - 1), SUSPEND_VERIFY_SPIN_MAX_MS)
  }
  /** 复查一个描述失败的 pid 是否已不在作业成员表(SCHED-SUSPEND-MEMBER-VANISH-THROW-0924):
   *  短命进程在成员表列点与逐个描述之间彻底退出时,复查枚举里不再有它。复查本身失败原样抛,
   *  交由 tick 按只读/宿主失败归类,不在这里吞。 */
  private async memberVanished(pid: number): Promise<boolean> {
    const listed = await this.native.members()
    return !listed.some(member => member.pid === pid)
  }
  /** running 目标且账上已 running(本拍无需 resume)时的核实:只读探成员表,帮手应答即解除。 */
  private async probeAndSettleUncertainty(): Promise<void> {
    if (this.record.faulted || this.record.uncertainSince == null || this.record.operation?.status === 'pending') return
    await this.native.members()
    this.settleUncertainty()
  }
  /** 拍板【三】:只读查询(成员表/线程状态/退出状态)失败不触发冻结,同一故障只告警一次,下一拍再查;
   *  同时记『暂时拿不准』起点(只读一档:帮手应答即可解除,见 poll 与判定流收口),帮手连续不响应
   *  照样受 10 分钟升级兜底管住。已在改状态一档拿不准时只记账不降档、不挪起点。 */
  private noteReadonlyFailure(error: unknown): void {
    if (this.record.uncertainSince == null) {
      this.record.uncertainSince = this.now(); this.uncertainMutating = false
      try { this.save() } catch (saveError) { this.options.warn(`[sched] 暂时拿不准记账未落盘，保留内存态:${String(saveError)}`) }
    }
    const message = `[sched] 只读查询失败，不触发冻结，下一拍再查:${String(error)}`
    if (this.lastReadonlyWarn !== message) { this.options.warn(message); this.lastReadonlyWarn = message }
  }
  /** 拍板【一】(第二轮修订):执行期拿不准先补挂起把整棵树冻住保护 CI,记『暂时拿不准』起点,不再
   *  永久 faulted;中断中的非挂起操作单独收尾成 unconfirmed,好让补挂起开新操作号。本拍补挂起核实
   *  通过也不解除——那只是保护到位,不是树到了该到的状态;升级钟从第一次失败起算,此后重试期间只读
   *  应答与核实成功都不重置它,连续超限没到该到的状态才升级 holdAfterUncertainty 交人工。 */
  private async protectAfterUncertainty(detail: string): Promise<void> {
    const entered = this.record.uncertainSince == null
    if (entered) this.record.uncertainSince = this.now()
    this.uncertainMutating = true
    this.record.alert = `状态未确认，已先行挂起保护，帮手恢复后重新核实:${detail}`
    if (this.record.operation?.status === 'pending' && this.record.operation.action !== 'suspend') {
      this.record.operation.status = 'unconfirmed'; this.record.operations.push(this.record.operation); this.record.operation = null
    }
    try { this.save() } catch (error) { this.options.warn(`[sched] 暂时拿不准记账未落盘，保留内存态:${String(error)}`) }
    if (entered) this.options.warn(`[sched] ${this.record.alert}`)
    try { await this.operate('suspend') }
    catch (error) {
      const message = `[sched] 挂起保护未确认，保留占用:${String(error)}`
      if (this.lastUncertainWarn !== message) { this.options.warn(message); this.lastUncertainWarn = message }
    }
  }
  /** 部分恢复不能冒充冻结；补发挂起保护存活成员，随后只告警，人工可撤单后重新执行。
   *  0924 起这是『拿不准升级后』与外部调用方的显式交人工入口;tick 内部先走 protectAfterUncertainty。 */
  async holdAfterUncertainty(detail: string): Promise<void> {
    // SCHED-FAULTED-SELF-HEAL-0925:faultedAt 只在还没有值时写入——重复调用不刷新起点、不动 healAttempts;
    // 自愈通过清空后再次 faulted 才重新从 intervalMs 计时。
    if (this.record.faultedAt == null) this.record.faultedAt = this.now()
    this.record.faulted = true; this.record.alert = `状态未确认，保持挂起并交人工:${detail}`
    if (this.record.operation?.status === 'pending' && this.record.operation.action !== 'suspend') {
      this.record.operation.status = 'unconfirmed'; this.record.operations.push(this.record.operation); this.record.operation = null
    }
    this.save(); this.options.warn(`[sched] ${this.record.alert}`)
    await this.operate('suspend')
  }
  /** 宿主意外死亡但外层代理尚活着：只在宿主与根都不存在时收尾，不执行任何进程操作。 */
  settleLostTree(): boolean {
    // Remote observations require the full native identity and owned JobObject.
    // Numeric PID probes are never enough to release a remote reservation.
    if (this.remoteStartGate) return false
    if (!this.record.host || !this.record.root || !processGone(this.record.host.pid) || !processGone(this.record.root.pid)) return false
    this.endRecord(); return true
  }
  members(): Promise<TreeMember[]> { return this.native.members() }
  /** 查退出状态是只读查询(拍板【三】):失败不冻结不交人工,查不清就当树还在,下一拍再查。 */
  async poll(): ReturnType<NativeTree['poll']> {
    try {
      const polled = await this.native.poll()
      this.lastReadonlyWarn = undefined
      // 帮手已应答只读查询:仅只读一档且账上没有任何操作(含已确认的补挂起)时解除『暂时拿不准』。
      // 改状态一档期间只读应答不解除、不重置升级钟(第二轮拍板【三】),钟必须从第一次失败连续走满。
      if (this.record && !this.record.faulted && !this.uncertainMutating && this.record.uncertainSince != null
        && this.record.operation == null) {
        this.record.uncertainSince = null
        this.save()
      }
      return polled
    } catch (error) {
      if (isReadonlyNativeFailure(error)) {
        this.noteReadonlyFailure(error)
        return { empty: false, exitCode: null }
      }
      throw error
    }
  }
  async kill(): Promise<void> { await this.native.kill() }
  async finish(): Promise<void> {
    try { await this.native.kill() } finally { await this.native.close() }
    if (!this.record) return
    this.endRecord()
  }
  private endRecord(): void {
    const at = this.now()
    closeInterval(this.record.intervals, at); closeInterval(this.record.slowIntervals, at)
    this.record.ended = true; this.record.recoveryReportPending = true
    for (const operation of [...this.record.operations, ...(this.record.operation ? [this.record.operation] : [])]) {
      if (operation.status === 'pending' || operation.status === 'unconfirmed') operation.status = 'incomplete-tree-gone'
    }
    this.save()
  }
}
