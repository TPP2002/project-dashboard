import { mkdirSync, statSync, unlinkSync } from 'node:fs'
import { publishLifecycleFileAtomically } from './cluster-lifecycle-atomic-file'
import { join } from 'node:path'
import {
  IDENTITY_FIELDS, LIFECYCLE_STATES, assertSameIdentity, buildLifecycleIdentity,
  canonicalLifecycleJson, errorMessage, hasCode, identityFrom, lifecyclePayloadSha256,
  productionSources, readJson, requireRecord, requireSafeSegment,
  type LifecycleIdentity, type PublishLifecycleJobOptions, type PublishedLifecycleJob,
  type ReadLifecycleStateOptions, type LifecycleState, type LifecycleStateRecord,
  type TransitionLifecycleJobOptions, type LifecycleSources,
} from './cluster-lifecycle-contract'
import {
  lifecyclePaths, readActiveLifecycleControl, type LifecyclePaths,
} from './cluster-lifecycle-control'
import {
  acquireTransitionLease, assertLeaseMatchesPlan, assertNoActiveTransitionLease,
  createTransitionLeasePlan, inspectTransitionLease,
  type TransitionLeasePlan, type TransitionLeaseRecord,
} from './cluster-lifecycle-lease'
export function ownerLeasePath(ownersDir: string, machine: string): string {
  return join(ownersDir, `${requireSafeSegment(machine, 'owner machine')}.json`)
}
export function ownerGuardPath(ownersDir: string, machine: string): string {
  return join(ownersDir, `${requireSafeSegment(machine, 'owner machine')}.guard.json`)
}
export function writeOwnerJsonExclusive(path: string, value: unknown, label: string): void {
  try {
    publishLifecycleFileAtomically(path, `${canonicalLifecycleJson(value)}\n`, 'create-only')
  } catch (error) {
    throw new Error(`[cluster-owner] ${label} 排他写失败:${path}:${errorMessage(error)}`, { cause: error })
  }
}
export function statePath(paths: LifecyclePaths, state: LifecycleState, submissionId: string): string {
  return join(paths[state], `${requireSafeSegment(submissionId, 'submissionId')}.json`)
}
export function pathExistsFailClosed(path: string): boolean {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error(`[cluster-lifecycle] 生命周期路径不是普通文件:${path}`)
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw new Error(`[cluster-lifecycle] 检查生命周期路径失败:${path}:${errorMessage(error)}`, { cause: error })
  }
}

export function scanLifecycleStates(paths: LifecyclePaths, submissionId: string): LifecycleState[] {
  return LIFECYCLE_STATES.filter(state => pathExistsFailClosed(statePath(paths, state, submissionId)))
}

/**
 * 【SCHED-TRANSITION-RECOVERY-DUAL-STATE-EXIT】同一张工单同时出现在同一台机器的两个状态目录:
 * 执行机刚把单搬进下一态、旧态文件还在等共享盘收走(SMB 删除挂起)的真实形态,几秒内自愈。
 * 这是可分类的并发瞬态,不是全局证据损坏:带上类型让派单员只跳过本拍这一张单,不整个退出;
 * 其余调用方语义不变(仍是普通 Error 体系,消息一字不改)。迁移锁是另一种瞬态,有自己的类型。
 *
 * 类型定义在本状态层(而不是状态扫描那层):状态层要抛它,而状态扫描那层**依赖**状态层,
 * 反向导入会成环。既有的 `cluster-lifecycle-status` 原样转出,调用方的导入路径一字不变。
 */
export class LifecycleStateConflictError extends Error {}

/**
 * 【SCHED-TRANSITION-TAKEOVER-DUAL-STATE-0925】接管支撞上第三态:同样可自愈的瞬态,单独成类。
 *
 * 接管支(盘上留着一把迁移锁,哪怕是过期死锁)在取锁之后扫到 from/to 之外的任何状态——
 * 包括「只剩第三态」的形态(例如锁是 inbox→quarantine、盘上只见 running)。负责人 2026-10-08
 * 拍板(甲):这一格与无锁路径的双态同属瞬态——搬单尾巴(执行机刚建好目标态、旧态文件还在等
 * 共享盘收走)或另一方刚动过这张单,这一拍放弃、下一拍按实物重扫即可自愈,不是 fail-closed 故障。
 *
 * 为什么用子类:交接事务三处 abandonOnStateConflict 只认 LifecycleStateConflictError,子类
 * 不改任何调用方一行代码就同时被认出(放弃本拍、下一拍重扫);消息逐字节与旧文案一致,文案
 * 契约零漂移(agent 侧调用方只按 instanceof Error 与消息判,子类不改它们的行为)。
 */
export class LifecycleTakeoverConflictError extends LifecycleStateConflictError {}

/**
 * 同单双态的状态冲突。**只**在「恰好两个状态可见、且期待的那一态就在其中」时算可自愈的并发瞬态;
 * 其余一切对不上——一态都没见着、期待的那态不在、三态以上——都是真故障,照旧抛普通 Error,
 * 一个字不放松(fail-closed 不放宽)。
 *
 * 文案逐字节冻结:既有调用方(状态扫描、--wait、既有用例)按 `[cluster-lifecycle] 状态冲突:`
 * 前缀与 `期待唯一 X，实际 Y` 形状识别,改字就是改契约。
 */
function stateConflictError(expected: LifecycleState, visible: readonly LifecycleState[]): Error {
  const message = `[cluster-lifecycle] 状态冲突:期待唯一 ${expected}，实际 ${visible.join(',') || '<none>'}`
  return visible.length === 2 && visible.includes(expected)
    ? new LifecycleStateConflictError(message)
    : new Error(message)
}

function ensureLifecycleDirectories(paths: LifecyclePaths): void {
  for (const path of [
    paths.claims,
    paths.transitionLocks,
    paths.heartbeat,
    paths.owners,
    paths.staging,
    paths.inbox,
    paths.running,
    paths.done,
    paths.failed,
    paths.quarantine,
  ]) mkdirSync(path, { recursive: true })
}
/** 永久 claim 先于 inbox 建立；claim 成功后的任何失败都保留占位，禁止复用 submissionId。 */
export function publishLifecycleJob(options: PublishLifecycleJobOptions): PublishedLifecycleJob {
  /**
   * 不把工单 codeVersion 拿去对卡 control.codeVersion(CLUSTER-PUBLISH-CODEVERSION-FREEZE,
   * 2026-08-31):control.codeVersion 是 cutover 那一刻的历史记录,而工单版本随 main 前进——
   * 在这里对卡等于把集群冻结在切换当天(恢复当天 main 前进两步后的第一单当场被拒,实测)。
   * 运营期的版本对齐只归 agent 领单时的 ensureCodeVersion 闸(对不上=拒跑,不是照跑)。
   */
  const control = readActiveLifecycleControl({
    share: options.share,
    expectedEpoch: options.expectedEpoch,
    machine: options.machine,
  })
  const identity = buildLifecycleIdentity({
    epoch: control.epoch,
    jobId: options.jobId,
    submissionId: options.submissionId,
    machine: options.machine,
    codeVersion: options.codeVersion,
    createdAt: options.createdAt,
    createdBy: options.createdBy,
    payload: options.payload,
    sources: options.sources,
  })
  const paths = lifecyclePaths(options.share, control.epoch, options.machine)
  ensureLifecycleDirectories(paths)
  const claimPath = join(paths.claims, `${identity.submissionId}.json`)
  try {
    publishLifecycleFileAtomically(claimPath, `${canonicalLifecycleJson(identity)}\n`, 'create-only')
  } catch (error) {
    throw new Error(`[cluster-lifecycle] claim 独占发布失败:${claimPath}:${errorMessage(error)}`, { cause: error })
  }

  const occupied = scanLifecycleStates(paths, identity.submissionId)
  if (occupied.length !== 0) {
    throw new Error(`[cluster-lifecycle] claim 已保留，但同 submission 生命周期已占用:${occupied.join(',')}`)
  }

  const record: LifecycleStateRecord = { ...identity, state: 'inbox', payload: options.payload }
  const inboxPath = statePath(paths, 'inbox', identity.submissionId)
  try {
    // ⚠ 暂存面必须给 `_staging`：inbox 那一层被 strictStateFiles 盯着（非 .json 即抛），
    // 其父 machines/<machine> 又被 assertKnownStateDirectories 盯着（非目录即抛）。
    publishLifecycleFileAtomically(inboxPath, `${canonicalLifecycleJson(record)}\n`, 'create-only', paths.staging)
  } catch (error) {
    throw new Error(`[cluster-lifecycle] inbox 独占发布失败，永久 claim 已保留:${inboxPath}:${errorMessage(error)}`, { cause: error })
  }
  const visible = scanLifecycleStates(paths, identity.submissionId)
  if (visible.length !== 1 || visible[0] !== 'inbox') {
    throw new Error(`[cluster-lifecycle] 发布后状态不唯一:${visible.join(',') || '<none>'}`)
  }
  return { identity, claimPath, statePath: inboxPath, record }
}
function validateRecord(raw: Record<string, unknown>, expectedState: LifecycleState,
  expectedIdentity: LifecycleIdentity): LifecycleStateRecord {
  const identity = identityFrom(raw, `${expectedState} record`)
  assertSameIdentity(identity, expectedIdentity, `${expectedState} record`)
  if (raw.state !== expectedState) {
    throw new Error(`[cluster-lifecycle] record.state 漂移:期待 ${expectedState}，实际 ${String(raw.state)}`)
  }
  const payload = requireRecord(raw.payload, `${expectedState} record.payload`)
  if (lifecyclePayloadSha256(payload) !== identity.payloadSha256) {
    throw new Error(`[cluster-lifecycle] ${expectedState} payloadSha256 不匹配`)
  }
  const metadata = raw.metadata === undefined ? undefined : requireRecord(raw.metadata, `${expectedState} metadata`)
  const result = raw.result === undefined ? undefined : requireRecord(raw.result, `${expectedState} result`)
  if (expectedState === 'done' || expectedState === 'failed' || expectedState === 'quarantine') {
    if (result === undefined) throw new Error(`[cluster-lifecycle] ${expectedState} 缺 terminal result`)
    const expectedOk = expectedState === 'done'
    if (result.ok !== expectedOk) throw new Error(`[cluster-lifecycle] ${expectedState} 与 result.ok 矛盾`)
    assertSameIdentity(identityFrom(result, `${expectedState} result`), identity, `${expectedState} result`)
  } else if (result !== undefined) {
    throw new Error(`[cluster-lifecycle] 非终态 ${expectedState} 不应携带 result`)
  }
  return { ...identity, state: expectedState, payload, ...(metadata === undefined ? {} : { metadata }), ...(result === undefined ? {} : { result }) }
}
/**
 * claim 不再拿 control.codeVersion 对卡(CLUSTER-PUBLISH-CODEVERSION-FREEZE,2026-08-31):
 * 那会把状态迁移也冻结在 cutover 时刻的版本上。claim↔record 的版本同源一致性由
 * readStateFile → validateRecord 的逐字段身份对账保证,这里只验读取坐标。
 */
function readClaimIdentity(paths: LifecyclePaths, submissionId: string, epoch: string,
  machine: string): LifecycleIdentity {
  const claim = identityFrom(readJson(join(paths.claims, `${submissionId}.json`), 'permanent claim'), 'permanent claim')
  if (claim.epoch !== epoch || claim.machine !== machine || claim.submissionId !== submissionId) {
    throw new Error('[cluster-lifecycle] claim 与读取坐标不匹配')
  }
  return claim
}

function readStateFile(paths: LifecyclePaths, state: LifecycleState, submissionId: string,
  identity: LifecycleIdentity): LifecycleStateRecord {
  return validateRecord(readJson(statePath(paths, state, submissionId), `${state} state`), state, identity)
}

/** 读取一态时以 transition lease 作前后只读屏障，再校验五态、claim、control 与 payload。 */
export function readLifecycleStateRecord(options: ReadLifecycleStateOptions): LifecycleStateRecord {
  const control = readActiveLifecycleControl({ share: options.share, expectedEpoch: options.epoch, machine: options.machine })
  const paths = lifecyclePaths(options.share, control.epoch, options.machine)
  assertNoActiveTransitionLease(paths, options.submissionId)
  const visible = scanLifecycleStates(paths, options.submissionId)
  if (visible.length !== 1 || visible[0] !== options.state) {
    throw stateConflictError(options.state, visible)
  }
  const claim = readClaimIdentity(paths, options.submissionId, control.epoch, options.machine)
  const record = readStateFile(paths, options.state, options.submissionId, claim)
  assertNoActiveTransitionLease(paths, options.submissionId)
  return record
}

const ALLOWED_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  inbox: ['running', 'quarantine'],
  running: ['inbox', 'done', 'failed', 'quarantine'],
  done: [],
  failed: [],
  quarantine: [],
}

function assertResultIdentityDoesNotDrift(result: Record<string, unknown>, identity: LifecycleIdentity): void {
  for (const field of IDENTITY_FIELDS) {
    if (result[field] !== undefined && result[field] !== identity[field]) {
      throw new Error(`[cluster-lifecycle] result.${field} 试图覆盖提交身份`)
    }
  }
}

function buildNextRecord(current: LifecycleStateRecord, to: LifecycleState,
  metadata?: Record<string, unknown>, requestedResult?: Record<string, unknown>): LifecycleStateRecord {
  const terminal = to === 'done' || to === 'failed' || to === 'quarantine'
  if (terminal !== (requestedResult !== undefined)) throw new Error(`[cluster-lifecycle] ${to} result 存在性与终态矛盾`)
  let result: Record<string, unknown> | undefined
  if (requestedResult !== undefined) {
    const expectedOk = to === 'done'
    if (requestedResult.ok !== undefined && requestedResult.ok !== expectedOk) {
      throw new Error(`[cluster-lifecycle] ${to} 与调用方 result.ok 矛盾`)
    }
    assertResultIdentityDoesNotDrift(requestedResult, current)
    result = { ...requestedResult, ...IDENTITY_FIELDS.reduce<Record<string, unknown>>((copy, field) => {
      copy[field] = current[field]
      return copy
    }, {}), ok: expectedOk }
  }
  return {
    ...IDENTITY_FIELDS.reduce<Record<string, unknown>>((copy, field) => {
      copy[field] = current[field]
      return copy
    }, {}) as unknown as LifecycleIdentity,
    state: to,
    payload: current.payload,
    ...((current.metadata !== undefined || metadata !== undefined)
      ? { metadata: { ...current.metadata, ...metadata } }
      : {}),
    ...(result === undefined ? {} : { result }),
  }
}

function recordWithHash(paths: LifecyclePaths, state: LifecycleState,
  lease: TransitionLeaseRecord, expectedHash: string): LifecycleStateRecord {
  const record = readStateFile(paths, state, lease.identity.submissionId, lease.identity)
  if (lifecyclePayloadSha256(record) !== expectedHash) {
    throw new Error(`[cluster-lifecycle] ${state} record 与 transition lease 内容冲突`)
  }
  return record
}

/** 唯一迁移原语：原子 lease fencing 内只按精确 source/destination 内容推进或恢复。 */
export function transitionLifecycleJob(options: TransitionLifecycleJobOptions): LifecycleStateRecord {
  if (!ALLOWED_TRANSITIONS[options.from].includes(options.to)) {
    throw new Error(`[cluster-lifecycle] 禁止状态迁移:${options.from}->${options.to}`)
  }
  const control = readActiveLifecycleControl({ share: options.share, expectedEpoch: options.epoch, machine: options.machine })
  const paths = lifecyclePaths(options.share, control.epoch, options.machine)
  mkdirSync(paths.transitionLocks, { recursive: true })
  const sources = options.sources ?? productionSources
  const observed = inspectTransitionLease(paths, options.submissionId, sources.now())
  const claim = readClaimIdentity(paths, options.submissionId, control.epoch, options.machine)
  let plan: TransitionLeasePlan
  if (observed === undefined) {
    // 双态(期待的那一态在)抛可识别类型:调用方只放弃这一拍,不动任何状态;其余对不上照旧普通 Error。
    const visible = scanLifecycleStates(paths, options.submissionId)
    if (visible.length !== 1 || visible[0] !== options.from) {
      throw stateConflictError(options.from, visible)
    }
    const current = readStateFile(paths, options.from, options.submissionId, claim)
    plan = createTransitionLeasePlan(current,
      buildNextRecord(current, options.to, options.metadata, options.result), options)
  } else {
    assertSameIdentity(observed.identity, claim, 'transition lease claim')
    plan = { ...observed, metadata: options.metadata, result: options.result }
    assertLeaseMatchesPlan(observed, plan)
  }
  const handle = acquireTransitionLease({
    paths, plan, observed, sources, leaseDurationMs: options.leaseDurationMs,
  })
  let operationResult!: LifecycleStateRecord
  let operationError: unknown
  try {
    options.hooks?.afterLeaseAcquire?.({ token: handle.lease.token, renewLease: handle.renewLease })
    handle.assertOwned()
    const states = scanLifecycleStates(paths, options.submissionId)
    const sourceVisible = states.includes(options.from)
    const destinationVisible = states.includes(options.to)
    // 先判第三态:只要出现 from/to 之外的任何状态(哪怕只剩第三态,例如锁是 inbox→quarantine、
    // 盘上只见 running)都算第三态瞬态——负责人 2026-10-08 拍板(甲):可自愈,抛可识别子类,
    // 调用方只放弃本拍、下一拍重扫。消息逐字节与旧文案一致。
    if (states.some(state => state !== options.from && state !== options.to)) {
      throw new LifecycleTakeoverConflictError(`[cluster-lifecycle] stale transition 出现第三态:${states.join(',')}`)
    }
    // 走到这里已无第三态:source/destination 都不存在 = 五态皆空,真故障,照旧普通 Error 不放宽。
    if (!sourceVisible && !destinationVisible) throw new Error('[cluster-lifecycle] stale transition source/destination 均不存在')
    let destination: LifecycleStateRecord
    if (sourceVisible) {
      const source = recordWithHash(paths, options.from, handle.lease, handle.lease.sourceRecordSha256)
      destination = buildNextRecord(source, options.to, handle.lease.metadata, handle.lease.result)
      if (lifecyclePayloadSha256(destination) !== handle.lease.destinationRecordSha256) {
        throw new Error('[cluster-lifecycle] 重建 destination 与 transition lease 内容冲突')
      }
    } else {
      destination = recordWithHash(paths, options.to, handle.lease, handle.lease.destinationRecordSha256)
    }
    const sourcePath = statePath(paths, options.from, options.submissionId)
    const destinationPath = statePath(paths, options.to, options.submissionId)
    if (sourceVisible && !destinationVisible) {
      handle.assertOwned()
      options.hooks?.beforeDestinationCreate?.({ sourcePath, destinationPath })
      handle.assertOwned()
      publishLifecycleFileAtomically(destinationPath,
        `${canonicalLifecycleJson(destination)}\n`, 'create-only', paths.staging)
    } else if (sourceVisible) {
      recordWithHash(paths, options.to, handle.lease, handle.lease.destinationRecordSha256)
    }
    if (sourceVisible) {
      handle.assertOwned()
      unlinkSync(sourcePath)
    }
    const visible = scanLifecycleStates(paths, options.submissionId)
    if (visible.length !== 1 || visible[0] !== options.to) {
      throw new Error(`[cluster-lifecycle] 迁移后状态不唯一:${visible.join(',') || '<none>'}`)
    }
    operationResult = recordWithHash(paths, options.to, handle.lease, handle.lease.destinationRecordSha256)
  } catch (error) {
    operationError = error
  }
  let releaseError: unknown
  try {
    options.hooks?.beforeLeaseRelease?.({ token: handle.lease.token, retirementPath: handle.retirementPath })
    handle.release()
  } catch (error) {
    releaseError = error
  }
  if (operationError !== undefined) throw operationError
  if (releaseError !== undefined) {
    throw new Error(`[cluster-lifecycle] transition lease 释放失败，后续读写将 fail-closed:${errorMessage(releaseError)}`, { cause: releaseError })
  }
  return operationResult
}

/** 在跑记录缺失补记的坐标与内容(CLUSTER-RUNNING-RECORD-VANISHED-0911)。 */
export interface ArchiveVanishedRunningOptions {
  share: string
  epoch: string
  machine: string
  submissionId: string
  /** 领单时刚写下的那份在跑记录(调用方内存里的)。 */
  running: LifecycleStateRecord
  to: 'done' | 'failed'
  result: Record<string, unknown>
  sources?: LifecycleSources
  leaseDurationMs?: number
}

/**
 * 在跑记录是不是「凭空消失」了:五个状态里都找不到这张单,而且没挂着迁移锁。
 * 挂着迁移锁说明有一次迁移没走完,交给唯一迁移原语去续做或 fail-closed,这里不猜。
 */
export function isRunningRecordVanished(options: {
  share: string
  epoch: string
  machine: string
  submissionId: string
  sources?: LifecycleSources
}): boolean {
  const control = readActiveLifecycleControl({ share: options.share, expectedEpoch: options.epoch, machine: options.machine })
  const paths = lifecyclePaths(options.share, control.epoch, options.machine)
  const sources = options.sources ?? productionSources
  if (inspectTransitionLease(paths, options.submissionId, sources.now()) !== undefined) return false
  return scanLifecycleStates(paths, options.submissionId).length === 0
}

/**
 * 在跑记录凭空消失时的终态补记(CLUSTER-RUNNING-RECORD-VANISHED-0911)。
 *
 * 【为什么要有】0910 副机一张工单的在跑记录在作业期间没了(没有迁移锁、没有日志,谁动的至今查不出),
 * 作业照跑成功,归档却因「期待唯一 running,实际 <none>」fail-closed:结果从未落进终态,派活方永远等不到,
 * 代理还崩了一次 —— 一张跑成功的活被判成了事故。
 *
 * 【凭什么可信】终态完全由领单时那份在跑记录推出,与正常迁移用同一个 buildNextRecord。补记前要求:
 * ① 永久领取记录在,且与内存记录逐字段一致、payload 指纹对得上(validateRecord);
 * ② 五个状态里都没有这张单、没挂着迁移锁;③ 同样在迁移锁里写,取锁后再核一遍状态,只建不覆盖。
 * 任何一条不满足就抛错,交回调用方照旧 fail-closed。终态 metadata 里注明是补记。
 */
export function archiveVanishedRunningJob(options: ArchiveVanishedRunningOptions): LifecycleStateRecord {
  const control = readActiveLifecycleControl({ share: options.share, expectedEpoch: options.epoch, machine: options.machine })
  const paths = lifecyclePaths(options.share, control.epoch, options.machine)
  mkdirSync(paths.transitionLocks, { recursive: true })
  const sources = options.sources ?? productionSources
  if (inspectTransitionLease(paths, options.submissionId, sources.now()) !== undefined) {
    throw new Error('[cluster-lifecycle] 在跑记录缺失补记:这张单还挂着迁移锁,交给唯一迁移原语收尾,不补记')
  }
  const claim = readClaimIdentity(paths, options.submissionId, control.epoch, options.machine)
  const running = validateRecord(options.running as unknown as Record<string, unknown>, 'running', claim)
  const before = scanLifecycleStates(paths, options.submissionId)
  if (before.length !== 0) {
    throw new Error(`[cluster-lifecycle] 在跑记录缺失补记只处理「五个状态里都没有这张单」,实际 ${before.join(',')}`)
  }
  const metadata = {
    runningRecordVanished: {
      detectedAt: sources.now(),
      note: '作业期间在跑记录凭空消失;终态依据领单时那份在跑记录补记,已与永久领取记录逐字段核对',
    },
  }
  const destination = buildNextRecord(running, options.to, metadata, options.result)
  const plan = createTransitionLeasePlan(running, destination, {
    share: options.share, epoch: control.epoch, machine: options.machine, submissionId: options.submissionId,
    from: 'running', to: options.to, metadata, result: options.result,
  })
  const handle = acquireTransitionLease({ paths, plan, sources, leaseDurationMs: options.leaseDurationMs })
  let operationResult!: LifecycleStateRecord
  let operationError: unknown
  try {
    handle.assertOwned()
    const states = scanLifecycleStates(paths, options.submissionId)
    if (states.length !== 0) {
      throw new Error(`[cluster-lifecycle] 在跑记录缺失补记:取锁后状态已变,实际 ${states.join(',')}`)
    }
    handle.assertOwned()
    publishLifecycleFileAtomically(statePath(paths, options.to, options.submissionId),
      `${canonicalLifecycleJson(destination)}\n`, 'create-only', paths.staging)
    const visible = scanLifecycleStates(paths, options.submissionId)
    if (visible.length !== 1 || visible[0] !== options.to) {
      throw new Error(`[cluster-lifecycle] 补记后状态不唯一:${visible.join(',') || '<none>'}`)
    }
    operationResult = recordWithHash(paths, options.to, handle.lease, handle.lease.destinationRecordSha256)
  } catch (error) {
    operationError = error
  }
  let releaseError: unknown
  try {
    handle.release()
  } catch (error) {
    releaseError = error
  }
  if (operationError !== undefined) throw operationError
  if (releaseError !== undefined) {
    throw new Error(`[cluster-lifecycle] transition lease 释放失败,后续读写将 fail-closed:${errorMessage(releaseError)}`, { cause: releaseError })
  }
  return operationResult
}
