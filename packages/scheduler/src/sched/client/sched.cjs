#!/usr/bin/env node
/* eslint-disable-next-line no-redeclare -- 发行件保留 Node 全局声明，仓库配置也声明了这些全局 */
/* global require, module, process, console, __dirname */
/* eslint @typescript-eslint/no-require-imports: "off" */
'use strict'

/**
 * T2 单文件发行件：常规路径只依赖 Node 内建模块；契约正本为 sched-contract.ts，金样测试防漂移。
 * 可搬路径另需同目录 sched-projects.cjs、sched-menu.cjs、sched-hub-switch.cjs、sched-snapshot.cjs，由 sched-publish.ts 一并发布。
 * 按工单保留单文件（不是按行数拆分的模块）；内部按契约、磁盘、用例、本机许可分区。
 * CLI: node sched.cjs <submit|wait|run|cancel|finish|status> [--share ROOT] ...
 * share 取 --share / SCHED_SHARE；发布在 <share>/sched/bin 时也可从自身位置推导。
 * 库函数不退出进程；返回结果包含 exitCode，输入/共享盘错误抛 ClientError(exitCode)。
 * now/monotonic/sleep/nonce 可注入，生产墙钟与随机只在此 I/O 边界生成。
 * engine? 记录实际施工平台，与 submitter 分开；只校验 1–24 位小写字母、数字或连字符，缺省不补字段。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash, randomUUID } = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')
const { stripVTControlCharacters } = require('node:util')
const { inflateRawSync } = require('node:zlib')
const { performance } = require('node:perf_hooks')
const { setTimeout, clearTimeout, setInterval, clearInterval } = require('node:timers')
const { isUtf8 } = require('node:buffer')

const deployment = require('./deployment-config.cjs')
const CLIENT_VERSION = 1
const SCHED_FORMAT_VERSION = 1
const HOST_SMALL_JOB_POOL_CORES = 4
// 正式派单员一拍 2 秒，封顶 3 秒以容忍本拍心跳写失败、下一拍补上。
const QUEUE_POSITION_FRESH_WAIT_MS = 3_000
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/
const SHA1 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const CATEGORIES = ['unit-test', 'e2e-test', 'calib-run', 'perf-bench', 'mutation-test', 'codex-build', 'codex-acceptance', 'other']
// 可搬 auto 单(SCHED-HUB6-REMOTE-FOLLOW-0924)允许的类别与菜单参数上限:sched-contract.ts:233-235 逐项副本。
const AUTO_CATEGORIES = ['unit-test', 'e2e-test', 'other']
const CLIENT_INFRA_SOURCE_PREFIXES = [
  'scripts/bot/cluster-agent', 'scripts/bot/cluster-lifecycle', 'scripts/bot/cluster-job.ts',
  'scripts/bot/cluster-owner.ts', 'scripts/sched/', 'scripts/lib/cpuLease.ts',
  'scripts/lib/testCpuBudget.ts', 'scripts/lib/sched',
]
const MENU_ARGS_MAX = 64
const MENU_ARG_MAX_LENGTH = 200
const TERMINAL_STATES = ['passed', 'failed', 'cancelled', 'voided']
// 派单员本机回收「授予后未开跑」单子的终局原因原文(sched-reclaim.ts GRANTED_NEVER_STARTED_REASON 的
// 客户端副本;发行件不 import TS 契约)。run 撞上这种终态时给出「重新挂号」提示(SCHED-GRANTED-NEVER-STARTED-RECLAIM)。
const RECLAIMED_UNSTARTED_REASON = '授予后未开跑且无存活信号，按挂号端没来领回收(本机回收)'
// 等待心跳(SCHED-QUEUED-ORPHAN-LIVENESS-1009):间隔与派单员按心跳停更回收的两个终局原因,
// 均为 sched-contract.ts / sched-waiting.ts 的逐字副本(发行件不 import TS 契约),测试核对相等。
const WAITING_BEAT_INTERVAL_MS = 10_000
const WAITING_ABANDONED_REASON = '挂号端已不在(等待心跳停更超过 2 分钟，本机回收)'
const GRANTED_WAITING_ABANDONED_REASON = '授予后挂号端等待心跳停更，按挂号端已不在回收(本机回收)'
const RESERVATION_LEVELS = [0, 5, 10, 15]
const STATES = ['queued', 'granted', 'running', 'paused', 'slow', 'unsatisfiable', ...TERMINAL_STATES]
// 并发读写同一文件时的整组竞争性 I/O 错误码:读方与删方在同一文件上撞车,Windows 给的是
// EPERM/EBUSY 而非 ENOENT。原 permitIoUnavailable 与 main 退出码映射各持一份相同字面量,
// 锁竞争热路径(SCHED-SMALLPOOL-EPERM)也要用同一组,抽成单一事实源,避免三处各自漂移。
const IO_CONTENTION_CODES = ['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'ENETDOWN', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET']
// 零依赖发行件的副本；测试与 cluster-lifecycle-atomic-file.ts 逐项对账。
const RENAME_RETRY_DELAYS_MS = [
  ...Array.from({ length: 50 }, () => 2),
  ...Array.from({ length: 25 }, () => 200),
]
const BEAT_FAILURE_TOLERANCE_MS = 30_000

class ClientError extends Error {
  constructor(message, exitCode = 2, cause) { super(message, { cause }); this.exitCode = exitCode }
}
function requireRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`[cluster-lifecycle] ${label} 必须是 JSON object`)
  return value
}
function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`[cluster-lifecycle] ${label} 必须是非空字符串`)
  return value
}
const text = value => { requireText(value, '文本') }
function segment(value) {
  const result = requireText(value, '路径段')
  if (!SAFE_SEGMENT.test(result)) throw new Error(`[cluster-lifecycle] 路径段 含不允许的路径字符:${result}`)
  if (result === '.' || result === '..') throw new Error('[sched] 路径段不能是 . 或 ..')
  return result
}
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error('[sched] 必须是范围内的安全整数')
  return value
}
// 跑分分片的提交格式 's<i>of<n>'(0 ≤ i < n;进集群契约时另由 sched-cluster-job 翻成 '<i>/<n>')。
// 与 sched-contract 的 shardTag 判据逐字相同:收单处与本客户端对同一份请求必须给同一个结论。
function shardTag(value) {
  const tag = segment(value)
  const match = /^s(0|[1-9]\d*)of([1-9]\d*)$/.exec(tag)
  if (match === null || Number(match[1]) >= Number(match[2])) throw new Error('[sched] 分片必须是 s<i>of<n>(0 ≤ i < n): shard')
  return tag
}
function isoTime(value) {
  const result = requireText(value, 'ISO 时间')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error('[sched] 时间必须为 UTC 毫秒 ISO')
  return result
}
function oneOf(values) { return value => { if (!values.includes(value)) throw new Error(`[sched] 枚举值不合法:${String(value)}`) } }
function list(check, minimum = 0, unique = false) {
  return value => {
    if (!Array.isArray(value) || value.length < minimum) throw new Error('[sched] 数组不合法')
    value.forEach(item => check(item))
    if (unique && new Set(value).size !== value.length) throw new Error('[sched] 数组含重复项')
  }
}
function fields(value, required, optional = {}) {
  const record = requireRecord(value, '对象')
  for (const [name, check] of Object.entries(required)) check(record[name])
  for (const name of Object.keys(record)) {
    if (Object.hasOwn(required, name)) continue
    const check = Object.hasOwn(optional, name) ? optional[name] : undefined
    if (!check) throw new Error(`[sched] 未知字段:${name}`)
    check(record[name])
  }
}
function ticketId(value) {
  const result = requireText(value, 'ticketId')
  if (!/^tk-[0-9a-f]{20}$/.test(result)) throw new Error('[sched] 单号不合法')
  return result
}
function attemptId(value) {
  const result = requireText(value, 'attemptId')
  if (!/^a[1-9]\d*$/.test(result)) throw new Error('[sched] 执行号不合法')
  integer(Number(result.slice(1)), 1)
  return result
}
function validateCodeRef(value) {
  fields(value, { kind: oneOf(['commit', 'content']), value: text })
  if (!(value.kind === 'commit' ? SHA1 : SHA256).test(value.value)) throw new Error('[sched] 代码版本不合法')
}
function canonicalJson(value) {
  const inspect = item => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (Array.isArray(item)) { for (const child of item) inspect(child); return }
    if (typeof item === 'object' && item !== null && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      for (const [key, child] of Object.entries(item)) {
        if (key === '__proto__') throw new Error('[sched] 禁止 __proto__ 字段')
        inspect(child)
      }
      return
    }
    throw new Error('[sched] 仅接受完整 JSON 值')
  }
  const canonicalize = item => {
    if (Array.isArray(item)) return item.map(canonicalize)
    if (typeof item === 'object' && item !== null) {
      const sorted = {}
      for (const key of Object.keys(item).sort()) sorted[key] = canonicalize(item[key])
      return sorted
    }
    return item
  }
  inspect(value)
  return JSON.stringify(canonicalize(value))
}
function rawContentHash(value) { return createHash('sha256').update(value).digest('hex') }
function contentHash(value) { return rawContentHash(canonicalJson(value)) }
function deriveTicketId(project, key) { text(project); segment(key); return `tk-${contentHash([project, key]).slice(0, 20)}` }
function validateSubmission(value) {
  fields(value, {
    idempotencyKey: segment, project: text, submitter: text, category: oneOf(CATEGORIES), title: text,
    // work 可选字段与 sched-contract 同判据(UDQ-T5-BLOCKS-CLUSTER-AGENT-ON-HOST /
    // SCHED-FULL-QUOTA-TICKET-NEVER-FITS 两单独立发现同一根因):workers/round/shard。
    // 此前手写契约漏了 workers,集群派出的带 workers 工单在执行机上被 readTicket→validateSubmission
    // 按「未知字段」整份拒读,许可校验跟着失败(<historical-ticket>);round/shard 是本次
    // 跑分改走队列新增的,成对与「集群 calib 必带」规则和 TS 版逐字相同,两侧结论必须一致。
    work: item => {
      fields(item, { type: workType, targetPaths: list(text, 1) },
        { workers: v => { integer(v, 1) }, round: segment, shard: shardTag })
      if (value.execution === 'auto' && (item.workers !== undefined || item.round !== undefined || item.shard !== undefined)) {
        throw new Error('[sched] auto 单 work 只许 type 与 targetPaths')
      }
      if (item.round !== undefined || item.shard !== undefined) {
        if (deployment.getDeploymentConfig().jobs[item.type]?.needsRound !== true) throw new Error('[sched] round/shard 仅 calib 作业可携带: work')
        if (item.round === undefined || item.shard === undefined) throw new Error('[sched] round 与 shard 必须成对出现: work')
      }
      if (value.execution === 'cluster' && deployment.getDeploymentConfig().jobs[item.type]?.needsRound === true && (item.round === undefined || item.shard === undefined)) {
        throw new Error('[sched] 集群跑分作业必须携带 round 与 shard: work')
      }
    },
    requestedCores: item => { integer(item) }, allowedMachines: list(segment, 1, true), codeRef: validateCodeRef,
    resources: item => fields(item, { exclusive: list(oneOf(['screen', 'word-com']), 0, true) }), createdAt: isoTime,
  // execution 与派单员正本 SubmissionRequest 同口径(验收去副机 #694 加的可选字段):缺省 local;
  // 手写契约漏了它会让集群跑的验收单在执行机上被 T5 闸整份拒读(SCHED-CLIENT-TICKET-REQUEST-EXECUTION-FIELD)。
  // resident 同理(SCHED-MR5-RESIDENT-LEASE-0924):正本是 SubmissionRequest.resident?: true,只认字面 true。
  // SCHED-HUB6-REMOTE-FOLLOW-0924:execution 认 'auto',origin 与 menu 两个可选字段与判据、报错原文
  // 逐条照抄 sched-contract.ts 的 validateSubmission/assertAutoShape/validateMenuRef,两侧结论必须一致。
  }, { parentTicketId: ticketId, engine: engineId, execution: oneOf(['local', 'cluster', 'auto']), resident: oneOf([true]),
    origin: v => { try { segment(v) } catch { throw new Error('[sched] auto 单 origin 不合法') } }, menu: validateMenuRef,
    // 用量历史键与原申请(SCHED-CORES-HISTORY-AUTOCORRECT-1010):旧请求不带照常;判据与报错原文
    // 和 sched-contract.ts 的 validateSubmission 逐字相同,两侧结论必须一致。
    usageKey: v => { if (typeof v !== 'string' || v.length === 0 || v.length > 120) throw new Error('[sched] usageKey 必须是 1–120 字符') },
    requestedCoresOriginal: v => { if (!Number.isSafeInteger(v) || v < 1) throw new Error('[sched] requestedCoresOriginal 必须是正整数') } })
  if (value.requestedCoresOriginal !== undefined && value.requestedCoresOriginal < value.requestedCores) {
    throw new Error('[sched] requestedCoresOriginal 必须不小于 requestedCores')
  }
  if (value.category === 'codex-build' ? value.requestedCores !== 0 : value.requestedCores < 1) throw new Error('[sched] 类别与申请核数不一致')
  assertAutoShape(value)
  assertResidentShape(value)
  canonicalJson(value)
  deployment.assertDeploymentSubmission(value)
  return value
}
/**
 * 长期占用单的形状(sched-contract.ts 的 assertResidentShape 逐条对照手写一遍)：
 * 登记的是「这台机器上已经在跑的服务」，所以必须是本机单、恰好一台机器(账按机器扣,不能跨机摊)、
 * 至少占 1 核、不许用只管登记的 codex-build 类别。缺省(旧请求)一律不判——两侧结论必须一致，
 * 派单员与执行端都要按同一份手写契约读同一张票。
 */
function assertResidentShape(value) {
  if (value.resident !== true) return
  if (value.execution !== undefined) throw new Error('[sched] 长期占用单只许本机单(execution 缺省)')
  if (value.allowedMachines.length !== 1) throw new Error('[sched] 长期占用单必须恰好指定一台机器')
  // 类别在前、核数在后,与 sched-contract.ts 的 assertResidentShape 逐条同序(理由见那边的注释)。
  if (value.category === 'codex-build') throw new Error('[sched] 长期占用单不许用只登记类别(codex-build)')
  if (value.requestedCores < 1) throw new Error('[sched] 长期占用单至少要占 1 核')
}
/** menu 引用(SCHED-HUB6-REMOTE-FOLLOW-0924):sched-contract.ts 的 validateMenuRef 逐字对照手写,报错原文一字不差。 */
function validateMenuRef(value) {
  try {
    fields(value, { item: v => {
      if (typeof v !== 'string' || !/^[A-Za-z0-9:._-]{1,64}$/.test(v)) throw new Error('菜单项不合法')
    }, args: v => {
      if (!Array.isArray(v) || v.length > MENU_ARGS_MAX || v.some(arg => typeof arg !== 'string' || arg.length === 0 || arg.length > MENU_ARG_MAX_LENGTH)) {
        throw new Error('受限参数不合法')
      }
    } }, { elastic: oneOf([true]) })
  } catch (error) { throw new Error(`[sched] auto 单 menu 不合法:${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
}
/** auto 单形状(SCHED-HUB6-REMOTE-FOLLOW-0924):sched-contract.ts 的 assertAutoShape 逐条对照手写,报错原文一字不差。 */
function assertAutoShape(value) {
  if (value.execution !== 'auto') {
    if (value.origin !== undefined || value.menu !== undefined) throw new Error('[sched] auto 单专用字段 origin/menu 不许出现在非 auto 单')
    return
  }
  if (!value.origin || !value.menu) throw new Error('[sched] auto 单必须带 origin 与 menu')
  if (!value.allowedMachines.includes(value.origin)) throw new Error('[sched] auto 单 origin 必须在 allowedMachines 中')
  if (!AUTO_CATEGORIES.includes(value.category)) throw new Error('[sched] auto 单 category 不允许')
  if (value.menu.item !== value.work.type) throw new Error('[sched] auto 单 menu.item 必须等于 work.type')
  if (value.work.workers !== undefined || value.work.round !== undefined || value.work.shard !== undefined) throw new Error('[sched] auto 单 work 只许 type 与 targetPaths')
  if (value.resources.exclusive.length !== 0) throw new Error('[sched] auto 单 resources.exclusive 必须为空')
  if (value.codeRef.kind !== 'commit') throw new Error('[sched] auto 单 codeRef 必须是 commit')
  if (value.menu.elastic === true && value.category !== 'unit-test') throw new Error('[sched] auto 单只有 unit-test 可带 elastic')
}
function engineId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 24 || /[^a-z0-9-]/.test(value)) {
    throw new Error('[sched] engine 必须为 1–24 位小写字母、数字或连字符')
  }
}
/** 与 sched-contract 的 workType 逐字相同:作业名含 test:fast 等冒号名,不是路径段(只做相等比较、不拼路径),仍不接受空格及命令字符。 */
function workType(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error('[sched] 作业名不合法')
}
function validateCommand(value) {
  const data = {
    'jump-queue': v => fields(v, { ticketId }), cancel: v => fields(v, { ticketId }, { reason: text }),
    finish: v => fields(v, { ticketId, result: oneOf(['passed', 'failed']) }, { reason: text }),
    'pause-one': v => fields(v, { ticketId }), 'resume-one': v => fields(v, { ticketId }),
    reserve: v => fields(v, { machine: segment, requestedCores: oneOf(RESERVATION_LEVELS) }, { durationMinutes: oneOf([60, 180]) }),
    'owner-hold': v => fields(v, { machine: segment }), 'owner-release': v => fields(v, { machine: segment }),
  }
  fields(value, { commandId: segment, kind: oneOf(Object.keys(data)), data: v => { requireRecord(v, '指令 data') }, submitter: text, createdAt: isoTime, expiresAt: isoTime })
  data[value.kind](value.data)
  if (value.kind === 'reserve' && value.data.requestedCores === 0 && value.data.durationMinutes !== undefined) throw new Error('[sched] 零核预留不能带期限')
  if (value.expiresAt < value.createdAt) throw new Error('[sched] 指令期限早于创建时间')
  return value
}
function validateReport(value) {
  const record = requireRecord(value, '回报')
  oneOf(['started', 'finished'])(record.phase)
  fields(value, { ticketId, attemptId, phase: text, token: text, machine: segment, at: isoTime,
    ...(record.phase === 'started' ? { pid: v => { integer(v, 1) }, codeRef: validateCodeRef }
      : { result: oneOf(TERMINAL_STATES), reason: text }),
  }, record.phase === 'started' ? { creationFileTime: text, createdAt: text, verifier: validatePermitVerifier } : {})
  canonicalJson(value)
  return value
}
function reportName(report) {
  oneOf(['started', 'finished'])(report.phase)
  return `${ticketId(report.ticketId)}--${attemptId(report.attemptId)}--${report.phase}.json`
}
function validatePermitVerifier(value) {
  fields(value, { pipe: segment, publicKey: text })
  if (!/^sched-permit-[0-9a-f]{48}$/.test(value.pipe) || value.publicKey.length > 4096) throw new Error('[sched] 归属核验端格式非法')
}
function assertWritableFormat(value) {
  const record = requireRecord(value, 'format')
  if (integer(record.formatVersion, 1) > SCHED_FORMAT_VERSION) throw new Error('[sched] 共享盘格式比本代码新，拒绝写入')
  fields(value, { formatVersion: oneOf([SCHED_FORMAT_VERSION]), capabilities: list(text, 0, true), createdAt: isoTime })
  return value
}

// ---- I/O 边界：不创建共享盘目录；每次写都重新检查格式。 ----
function runtime(options = {}, needsShare = true) {
  const env = options.env ?? process.env
  const inferred = path.basename(__dirname) === 'bin' && path.basename(path.dirname(__dirname)) === 'sched' ? path.resolve(__dirname, '../..') : undefined
  const share = options.share ?? env.SCHED_SHARE ?? inferred
  if (needsShare && !share) throw new ClientError('必须指定 --share 或 SCHED_SHARE', 3)
  return {
    ...options, share: share ? path.resolve(share) : undefined, env,
    now: options.now ?? (() => new Date().toISOString()),
    monotonic: options.monotonic ?? (() => performance.now()),
    nonce: options.nonce ?? randomUUID,
    sleep: options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
    output: options.output ?? (line => console.log(line)),
    notice: options.notice ?? (line => process.stderr.write(`${line}\n`)),
    remoteOutput: options.remoteOutput ?? (bytes => process.stdout.write(bytes)),
    pollMs: options.pollMs ?? 200,
    // 仅供测试注入心跳发布故障；缺省仍同步执行真实发布。
    testOnlyPublishBeat: options.testOnlyPublishBeat ?? (publishBeat => publishBeat()),
    // 等待心跳的间隔与发布故障注入(SCHED-QUEUED-ORPHAN-LIVENESS-1009);缺省 10 秒、同步真实发布。
    waitingBeatMs: options.waitingBeatMs ?? WAITING_BEAT_INTERVAL_MS,
    testOnlyPublishWaitingBeat: options.testOnlyPublishWaitingBeat ?? (publishWaitingBeat => publishWaitingBeat()),
  }
}
function timestamp(ctx) {
  const value = ctx.now()
  return isoTime(typeof value === 'number' ? new Date(value).toISOString() : value)
}
function paths(share) {
  const root = path.join(share, 'sched')
  return { root, staging: path.join(root, '_staging'), format: path.join(root, '_control', 'format.json'),
    tickets: path.join(root, 'tickets'), submit: path.join(root, 'submit'), commands: path.join(root, 'commands'),
    reports: path.join(root, 'reports'), beats: path.join(root, 'beats'),
    // 长期占用单的续约凭据(SCHED-MR5-RESIDENT-LEASE-0924)：目录由 initializeScheduler 建，
    // 这里只写文件；旧共享盘没有它时报错信息与普通缺目录一致。
    leases: path.join(root, 'leases'),
    // 挂号端等待心跳(SCHED-QUEUED-ORPHAN-LIVENESS-1009):旧共享盘没有这个目录,写前补建(见 startWaitingBeat)。
    waiting: path.join(root, 'waiting') }
}
function readJson(file, optional = false) {
  try {
    const bytes = fs.readFileSync(file)
    if (!isUtf8(bytes)) throw new Error('不是合法 UTF-8')
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (optional && error.code === 'ENOENT') {
      // 父目录丢失不是“文件尚未出现”，不能无限等一份新的空队列。
      try { fs.readdirSync(path.dirname(file)); return null } catch (directoryError) {
        throw new ClientError(`共享盘不可读:${file}:${directoryError.message}`, 3, directoryError)
      }
    }
    throw new ClientError(`文件不可读:${file}:${error.message}`, 3, error)
  }
}
/** 新通道目录尚未由任何写者创建时，读者按文件未出现处理。 */
function readOptionalNewChannelJson(file) {
  try { return readJson(file, true) }
  catch (error) { if (error.cause?.code === 'ENOENT') return null; throw error }
}
function checkFormat(ctx) {
  try { return assertWritableFormat(readJson(paths(ctx.share).format)) } catch (error) {
    throw new ClientError(`拒绝写入:${error.message}`, 3, error)
  }
}
function unlinkIfPresent(file) {
  try { fs.unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
}
function renameWithRetry(source, target, rename = fs.renameSync,
  sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  let retries = 0, sleptMs = 0
  for (;;) {
    try { rename(source, target); return } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code) || retries >= RENAME_RETRY_DELAYS_MS.length) {
        // 保留原始 errno 与异常身份，心跳分流仍能识别竞争错误。
        if (retries > 0) error.message = `已退避重试 ${retries} 次、请求睡眠合计 ${sleptMs}ms:${error.message}`
        throw error
      }
      const delayMs = RENAME_RETRY_DELAYS_MS[retries]
      sleep(delayMs)
      retries++; sleptMs += delayMs
    }
  }
}
function publish(ctx, file, value, mode = 'create-only') {
  checkFormat(ctx)
  const staged = path.join(paths(ctx.share).staging, `.lifecycle-publish-${segment(ctx.nonce())}.tmp`)
  fs.writeFileSync(staged, canonicalJson(value), { encoding: 'utf8', flag: 'wx' })
  try {
    if (mode === 'create-only') fs.linkSync(staged, file)
    else renameWithRetry(staged, file)
  } finally { unlinkIfPresent(staged) }
}
function createSame(ctx, file, value) {
  try { publish(ctx, file, value) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (canonicalJson(readJson(file)) !== canonicalJson(value)) throw new ClientError(`编号已被不同内容占用:${path.basename(file)}`, 2)
  }
}
function readTicket(ctx, id, optional = true) {
  checkFormat(ctx)
  const ticket = readJson(path.join(paths(ctx.share).tickets, `${ticketId(id)}.json`), optional)
  if (!ticket) return null
  if (ticket.formatVersion !== 1 || ticket.ticketId !== id || !STATES.includes(ticket.state) || !Array.isArray(ticket.attempts)
    || !Array.isArray(ticket.timeline) || typeof ticket.cancelRequested !== 'boolean') throw new ClientError('快照身份或状态不合法', 3)
  validateSubmission(ticket.request)
  if (deriveTicketId(ticket.request.project, ticket.request.idempotencyKey) !== id || contentHash(ticket.request) !== ticket.contentHash
    || ticket.currentAttemptId !== ticket.attempts.at(-1)?.attemptId) throw new ClientError('快照挂号或执行身份不符', 3)
  attemptId(ticket.currentAttemptId)
  // 超用标记(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925)是可丢失的展示缓存:只认在管四态里
  // 与当前执行一致的那张。写坏只当没有标记、照常返回——本机 run 的 pulse 读票抛非 IO 错误
  // 会走 monitoringError → stopTree,一个展示字段坏不该杀在跑的活(派单员写盘自检 parseSnapshot
  // 仍严格拒收,这里兜的是共享盘上被人写坏的存量)。身份/格式错误仍在上面照旧抛。
  if (ticket.overuse !== undefined) {
    let bad = true
    try {
      overuseCheck(ticket.overuse)
      bad = !['granted', 'running', 'paused', 'slow'].includes(ticket.state)
        || ticket.overuse.attemptId !== ticket.currentAttemptId
    } catch { /* 坏标记只当没有 */ }
    if (bad) delete ticket.overuse
  }
  return ticket
}
function activeAttempt(ticket) { return ticket.attempts.find(value => value.attemptId === ticket.currentAttemptId) }
function resultCode(state) { return state === 'passed' ? 0 : state === 'failed' ? 1 : ['cancelled', 'voided'].includes(state) ? 5 : 0 }
async function poll(ctx, inspect, timeoutMs = 30_000) {
  if (!Number.isFinite(timeoutMs) && timeoutMs !== Infinity || timeoutMs < 0) throw new ClientError('超时时间不合法')
  const began = ctx.monotonic()
  for (;;) {
    const found = inspect()
    if (found !== null && found !== undefined) return found
    if (ctx.monotonic() - began >= timeoutMs) throw new ClientError('等待超时', 4)
    await ctx.sleep(Math.min(ctx.pollMs, Math.max(0, timeoutMs - (ctx.monotonic() - began))))
  }
}

/**
 * targets 为 root 内文件或目录；重复目标去重，链接及其内部内容从未读取。返回 CodeRef。
 * onEntry(可选)每走到一个条目回调一次、不影响结果:授予后同步扫描期间给等待心跳补拍(见 startWaitingBeat)。
 */
function contentFingerprint(root, targets, onEntry) {
  const base = path.resolve(root)
  list(text, 1)(targets)
  const entries = new Map()
  const walk = file => {
    onEntry?.()
    const relative = path.relative(base, file)
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new ClientError('内容指纹目标必须在 root 内')
    const parts = relative.split(path.sep).filter(Boolean)
    if (parts.some(part => part === '.git' || part === 'node_modules')) return
    // 显式指向 symlink 下的文件时同样跳过，不能只检查最终文件。
    let ancestor = base
    if (fs.lstatSync(base).isSymbolicLink()) return
    for (const part of parts) { ancestor = path.join(ancestor, part); if (fs.lstatSync(ancestor).isSymbolicLink()) return }
    const stat = fs.lstatSync(file)
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name))
    else if (stat.isFile()) entries.set(relative.split(path.sep).join('/'), rawContentHash(fs.readFileSync(file)))
  }
  for (const target of targets) walk(path.resolve(base, target))
  return { kind: 'content', value: contentHash([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }
}

// ---- SCHED-TEST-CATEGORY-MISMATCH-FAILFAST:单测作业类型挂错类别在挂号前当场拒。 ----
// 这四个作业类型只有 unit-test 一个类别有许可(LOCAL_WORK 的 unit 对);挂到别的类别下,即便
// 排上队也会在入口闸被「许可类别不符」拒掉,白等一轮。与其让票在队里死,不如挂号时就说清楚
// 怎么重挂。口径与入口闸一致、不放宽也不收紧(validateSubmission 的类别清单一字未动)。
const TEST_LIKE_WORK_TYPES = ['test', 'unit-test', 'test:fast', 'test:coverage']
/** 作业类型属于单测而类别不是 unit-test 时抛 ClientError;消息带上可直接复制的重挂形式。 */
function assertCategoryMatchesWorkType(category, workType) {
  if (!TEST_LIKE_WORK_TYPES.includes(workType) || category === 'unit-test') return
  throw new ClientError(`作业类型 ${workType} 属于单测，挂号类别却是 ${category}；请撤掉旧单（或换幂等键）后按 --category unit-test --work-type ${workType} 重新挂号`)
}

// ---- SCHED-CORES-HISTORY-AUTOCORRECT-1010:按同类活历史实测自动改小申请核数 ----
// 以下纯函数与派单员侧 scripts/sched/sched-usage-history.ts 同名同逻辑各写一份(零依赖),
// 同一张表驱动用例钉着两边逐项一致(照 overuseCheck「零依赖侧与 sched-contract 同判据」的先例)。
const USAGE_HISTORY_CAPABILITY = 'usage-history-v1'
const USAGE_KEY_MAX_LENGTH = 120
const USAGE_COMMAND_SUFFIX = /\.(exe|cmd|bat|py|js|cjs|mjs|ts)$/i
const USAGE_PURE_NUMBER = /^\d+$/
/** ≥7 位十六进制:提交哈希、单号碎片这类噪声词。 */
const USAGE_HEX_WORD = /^[0-9a-fA-F]{7,}$/
/** 以 - 开头、后接 ≥7 位十六进制的旗标(携带哈希值的参数)同样是噪声;阈值与 USAGE_HEX_WORD 同一把尺,
 *  只有 1 位十六进制的短旗标(如 python 的 -m)是稳定语义,保留。 */
const USAGE_HEX_FLAG = /^-[0-9a-fA-F]{7,}$/
/** 命令头里的一个词:只留文件名部分(去目录,正反斜杠都认)、去可执行/脚本后缀;噪声词返回 null。 */
function usageKeyWord(word) {
  let name = word
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  if (slash >= 0) name = name.slice(slash + 1)
  name = name.replace(USAGE_COMMAND_SUFFIX, '')
  if (name === '' || USAGE_PURE_NUMBER.test(name) || USAGE_HEX_WORD.test(name) || USAGE_HEX_FLAG.test(name)) return null
  return name
}
/** 同类活的统计键:`${project}|${workType}` + (有命令时 '|' + 命令头);总长封顶 120 字符(与请求字段同判据)。 */
function usageKeyFor(input) {
  let key = `${input.project}|${input.workType}`
  if (input.command !== undefined) {
    const head = [input.command, ...(input.args ?? [])].slice(0, 3)
      .map(usageKeyWord)
      .filter(word => word !== null)
      .join(' ')
    key += `|${head}`
  }
  return key.length > USAGE_KEY_MAX_LENGTH ? key.slice(0, USAGE_KEY_MAX_LENGTH) : key
}
/** 最近邻秩 90 分位:升序第 ceil(0.9×n) 个;空表没有分位,返回 null。 */
function nearestRankP90(values) {
  const sorted = [...values].sort((left, right) => left - right)
  if (!sorted.length) return null
  const rank = Math.min(sorted.length, Math.ceil(0.9 * sorted.length))
  return sorted[rank - 1]
}
/** 核数显示:整数不带小数点,非整数保留一位小数(读数本来就是 0.1 核粒度)。 */
function formatCores(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10)
}
/**
 * 按历史实测判断申请核数要不要改小:历史不足 minHistory(缺省 3)个、带 strict、或申请没有超过
 * 2×p90 且高出不足 2 核时原申请放行;否则改成 max(1, ceil(p90)+1)。只改小不改大;
 * changed 时 reason 是给 stdout 的提醒行原文(带 [sched] 前缀),否则为 null。
 */
function suggestCores(input) {
  const minHistory = input.minHistory ?? 3
  if (input.strict === true || input.peaks.length < minHistory) {
    return { cores: input.requested, changed: false, p90: null, reason: null }
  }
  const p90 = nearestRankP90(input.peaks)
  if (!(input.requested > 2 * p90 && input.requested - p90 >= 2)) {
    return { cores: input.requested, changed: false, p90, reason: null }
  }
  const cores = Math.max(1, Math.ceil(p90) + 1)
  return { cores, changed: true, p90, reason: `[sched] 申请 ${formatCores(input.requested)} 核超过同类活(${input.label ?? ''})`
    + `最近 ${input.peaks.length} 单实测 90 分位 ${formatCores(p90)} 核的 2 倍,已改为 ${formatCores(cores)} 核;`
    + `要保留原申请加 --cores-strict` }
}
/** 统计文件 <share>/sched/_stats/cores-usage.json(派单员写的滚动缓存)。 */
function usageStatsFile(share) { return path.join(share, 'sched', '_stats', 'cores-usage.json') }
/** 读同键最近 limit 个执行的 peakCores;文件缺失、内容坏、键不存在都返回空表。 */
function readUsagePeaks(share, key, limit = 10) {
  let list
  try {
    const parsed = JSON.parse(fs.readFileSync(usageStatsFile(share), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.formatVersion !== 1
      || parsed.groups === null || typeof parsed.groups !== 'object' || Array.isArray(parsed.groups)) return []
    list = parsed.groups[key]
  } catch { return [] }
  if (!Array.isArray(list)) return []
  return list.slice(-Math.max(0, limit))
    .filter(entry => typeof entry === 'object' && entry !== null && Number.isFinite(entry.peakCores))
    .map(entry => entry.peakCores)
}
/**
 * 挂号前算 usageKey 并按同类活历史实测判断要不要改小申请核数。开关关(hub.json 读不到或坏值
 * 全关)或共享盘能力位缺 usage-history-v1:不发 usageKey、原申请放行、一个字不打;
 * --cores-strict:只发 usageKey 不改核;resident 单只记键不纠正(常驻单不参与纠正)。
 */
function usageCorrection(ctx, input) {
  const key = usageKeyFor({ project: input.project, workType: input.workType,
    ...(input.command === undefined ? {} : { command: input.command, args: input.args ?? [] }) })
  let switchOn = false
  try {
    const bytes = fs.readFileSync(path.join(ctx.share, 'sched', '_control', 'hub.json'))
    // 第零步零加载(HUB6-9):先轻量看一眼字面值,不是 true 就不碰 sched-hub-switch.cjs(它连带加载
    // sched-projects.cjs);全关的四种形态(缺文件 / 坏 JSON / 旧 schema / 关着)一个模块都不多载。
    const body = bytes.toString('utf8')
    const raw = JSON.parse(body.charCodeAt(0) === 0xfeff ? body.slice(1) : body)
    if (raw !== null && typeof raw === 'object' && raw.coresHistoryCorrect === true) {
      switchOn = require('./sched-hub-switch.cjs').parseHubSwitch(bytes).value.coresHistoryCorrect === true
    }
  } catch { /* hub.json 读不到或坏值 = 开关关,沿用初值 */ }
  if (!switchOn) return { cores: input.cores }
  if (!checkFormat(ctx).capabilities.includes(USAGE_HISTORY_CAPABILITY)) return { cores: input.cores }
  if (input.coresStrict === true || input.correctable === false) return { usageKey: key, cores: input.cores }
  // 提醒行里「同类活(...)」的括号内容:有命令头用命令头,没有就用作业名。
  const parts = key.split('|')
  const label = parts.length > 2 ? parts.slice(2).join('|') : input.workType
  const suggestion = suggestCores({ requested: input.cores, peaks: readUsagePeaks(ctx.share, key), label })
  if (!suggestion.changed) return { usageKey: key, cores: input.cores }
  try { ctx.output(suggestion.reason) } catch { /* 提醒行打不出来不影响挂号 */ }
  return { usageKey: key, cores: suggestion.cores, requestedCoresOriginal: input.cores }
}

/** 精确请求重传保留 createdAt；高级参数形式从原请求/快照取创建时刻，其他字段仍重新比较。 */
async function submit(options) {
  const ctx = runtime(options); checkFormat(ctx)
  let request = options.request
  if (!request) {
    const id = deriveTicketId(options.project, options.key)
    const previous = readJson(path.join(paths(ctx.share).submit, `${segment(options.key)}.json`), true)
      ?? readTicket(ctx, id)?.request
    const codeRef = options.codeRef === 'content:auto' ? contentFingerprint(options.root ?? process.cwd(), options.targets)
      : typeof options.codeRef === 'string' ? { kind: 'commit', value: options.codeRef.replace(/^commit:/, '') } : options.codeRef
    // 按同类活历史实测自动改小申请核数(SCHED-CORES-HISTORY-AUTOCORRECT-1010):开关关/能力位缺
    // 原申请放行、一个字不打;--cores-strict 只发键不改核;resident/hold 单只记键不纠正
    // (usageCorrection 里 correctable 由调用方带进来)。精确重传(options.request)不走这里。
    const correction = usageCorrection(ctx, { project: options.project, workType: options.workType, cores: options.cores,
      command: options.command, args: options.args, coresStrict: options.coresStrict, correctable: options.resident !== true })
    request = { idempotencyKey: options.key, project: options.project, submitter: options.submitter ?? os.hostname(), category: options.category,
      title: options.title, work: { type: options.workType, targetPaths: options.targets }, requestedCores: correction.cores,
      allowedMachines: options.machines ?? [os.hostname()], codeRef, resources: { exclusive: options.exclusive ?? [] },
      createdAt: options.createdAt ?? previous?.createdAt ?? timestamp(ctx),
      ...(options.parent ? { parentTicketId: options.parent } : {}),
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      // 长期占用单(SCHED-MR5-RESIDENT-LEASE-0924)：只登记占用、不派发；先造请求再统一校验。
      ...(options.resident === true ? { resident: true } : {}),
      ...(correction.usageKey === undefined ? {} : { usageKey: correction.usageKey }),
      ...(correction.requestedCoresOriginal === undefined ? {} : { requestedCoresOriginal: correction.requestedCoresOriginal }),
    }
  }
  assertCategoryMatchesWorkType(request.category, request.work.type)
  validateSubmission(request)
  // SCHED-HUB6-REMOTE-FOLLOW-0924:auto 单要求 origin 等于本机且 allowedMachines 包含它(注册表机器名单);
  // 非 auto 单逐字节保持原「恰好 [本机 hostname]」检查。
  if (request.execution === 'auto') {
    if (request.origin !== os.hostname() || !request.allowedMachines.includes(os.hostname())) throw new ClientError('auto 单的 origin 必须是本机且在 allowedMachines 中')
  } else if (canonicalJson(request.allowedMachines) !== canonicalJson([os.hostname()])) throw new ClientError('本机单子的 allowedMachines 必须恰好为 [本机 hostname]')
  const hash = contentHash(request), id = deriveTicketId(request.project, request.idempotencyKey)
  const base = { ticketId: id, idempotencyKey: request.idempotencyKey, contentHash: hash }
  try { createSame(ctx, path.join(paths(ctx.share).submit, `${request.idempotencyKey}.json`), request) } catch (error) {
    if (error.exitCode !== 2) throw error
    return { ...base, status: 'rejected', reason: error.message, exitCode: 2 }
  }
  const receipt = await poll(ctx, () => {
    checkFormat(ctx)
    const found = readJson(path.join(paths(ctx.share).submit, '_receipts', `${request.idempotencyKey}.json`), true)
    if (!found || found.contentHash !== hash) return null
    fields(found, { idempotencyKey: segment, contentHash: value => { if (!SHA256.test(value)) throw new Error('哈希不合法') },
      status: oneOf(['accepted', 'rejected']), at: isoTime, ...(found.status === 'accepted' ? { ticketId } : { reason: text }) })
    if (found.idempotencyKey !== request.idempotencyKey || found.status === 'accepted' && found.ticketId !== id) throw new ClientError('挂号回执身份不符', 3)
    return found
  }, options.timeoutMs)
  return { ...base, status: receipt.status, ...(receipt.status === 'rejected' ? { reason: receipt.reason } : {}), exitCode: receipt.status === 'accepted' ? 0 : 2 }
}

const EVENT_LABELS = { submitted: '入队', granted: '授予', started: '开跑', paused: '暂停', slowed: '低速', resumed: '恢复', restored: '恢复', finished: '结束', requeued: '重新入队', 'cancel-requested': '请求撤单', 'marked-unsatisfiable': '无法满足' }
/** 重新连接时重放快照时间线，随后每个新事件只输出一次；五分钟无变化也报告存活。 */
async function waitFor(id, options = {}) {
  ticketId(id)
  const ctx = runtime(options), until = options.until ?? 'granted'
  oneOf(['granted', 'finished'])(until)
  let lastSeq = 0, previousState = null, aliveAt = ctx.monotonic()
  return poll(ctx, () => {
    const ticket = readTicket(ctx, id)
    if (ticket) {
      let emitted = false
      for (const event of ticket.timeline) {
        if (event.seq <= lastSeq || !EVENT_LABELS[event.type]) continue
        ctx.output(JSON.stringify({ ticketId: id, at: event.at, state: EVENT_LABELS[event.type], reason: event.data?.reason ?? null }))
        emitted = true
      }
      lastSeq = Math.max(lastSeq, ticket.lastSeq)
      if (ticket.state !== previousState && !emitted) ctx.output(JSON.stringify({ ticketId: id, at: ticket.updatedAt, state: ticket.state, reason: ticket.unsatisfiableReason ?? null }))
      previousState = ticket.state
      if (TERMINAL_STATES.includes(ticket.state) || until === 'granted' && ['granted', 'running', 'paused', 'slow'].includes(ticket.state)) return { ticket, exitCode: resultCode(ticket.state) }
    }
    if (ctx.monotonic() - aliveAt >= 300_000) { ctx.output(JSON.stringify({ ticketId: id, at: timestamp(ctx), alive: true })); aliveAt = ctx.monotonic() }
    return null
  }, options.timeoutMs ?? Infinity)
}
/** 指令写入后的等回执公共段；回执身份不符立即失败，等待超时抛 exitCode 4。 */
async function awaitCommandReceipt(ctx, commandId, timeoutMs) {
  const receipt = await poll(ctx, () => {
    checkFormat(ctx)
    const found = readJson(path.join(paths(ctx.share).commands, '_receipts', `${commandId}.json`), true)
    if (!found) return null
    fields(found, { commandId: segment, status: oneOf(['executed', 'rejected', 'expired']), at: isoTime,
      ...(found.status === 'executed' ? {} : { reason: text }) })
    if (found.commandId !== commandId) throw new ClientError('指令回执身份不符', 3)
    return found
  }, timeoutMs)
  return { ...receipt, exitCode: receipt.status === 'executed' ? 0 : 2 }
}
async function cancel(id, options = {}) {
  const ctx = runtime(options)
  const command = writeCancelCommand(ctx, id, options.reason)
  return awaitCommandReceipt(ctx, command.commandId, options.timeoutMs)
}
function writeCancelCommand(ctx, id, reason) {
  checkFormat(ctx); ticketId(id)
  const at = timestamp(ctx)
  const command = validateCommand({ commandId: `cancel-${segment(ctx.nonce())}`, kind: 'cancel',
    data: { ticketId: id, ...(reason ? { reason } : {}) }, submitter: ctx.submitter ?? os.hostname(),
    createdAt: at, expiresAt: new Date(Date.parse(at) + 600_000).toISOString() })
  // 每次调用生成新编号；碰撞不能当重传，必须拒绝而非复用别人的指令。
  publish(ctx, path.join(paths(ctx.share).commands, `${command.commandId}.json`), command)
  return command
}
/** 只登记类单子（category=codex-build）的正常完工入口；退出码口径与 cancel 一致。 */
async function finish(id, options = {}) {
  const ctx = runtime(options); checkFormat(ctx); ticketId(id)
  if (options.result !== 'passed' && options.result !== 'failed') throw new ClientError('finish 必须用 --result 指定 passed 或 failed', 2)
  const at = timestamp(ctx)
  const command = validateCommand({ commandId: `finish-${segment(ctx.nonce())}`, kind: 'finish',
    data: { ticketId: id, result: options.result, ...(options.reason ? { reason: options.reason } : {}) },
    submitter: options.submitter ?? os.hostname(),
    createdAt: at, expiresAt: new Date(Date.parse(at) + 600_000).toISOString() })
  publish(ctx, path.join(paths(ctx.share).commands, `${command.commandId}.json`), command)
  return awaitCommandReceipt(ctx, command.commandId, options.timeoutMs)
}
// ---- status 的「为什么放不下」解读:只读派单员心跳里现成的字段,不新增采集、不改任何准入判据。 ----
// 判据与说明必须同源:sched-decide.ts 的 eligible() / available() / 队首锁怎么算,这里就照着读一遍再翻成人话。
// 客户端另写一套近似口径会造出第二个事实源,看板上说的就会和派单员实际派的不是一回事。
// 只有可派核例外:它直接取心跳值,见 statusMachineReason。
// 为什么不在本文件里写 READING_FRESHNESS_MS / HEAD_PROTECTION_MS 这两个门槛:它们是 sched-contract.ts 的导出,
// 而本文件是零依赖单文件发行件(不 import TS 模块)。心跳里已经有派单员算好的 fresh 布尔与 locks 数组,
// 这边只读结论、把「多久没更新 / 等了多久」算成人话,不再复制一份迟早与正本漂移的门槛常量。
/** reasonCode 是稳定英文码,看板按码上色;中文只给人读。check 类要人查,wait 类等条件消失就会自己好。 */
const STATUS_CHECK_CLAUSE = { offline: '离线了', stale: '读数不新鲜', 'ci-unknown': '读不出 CI 在不在跑', 'quota-small': '装不下这个活' }
const STATUS_WAIT_CLAUSE = { 'ci-lane-reserve': '在给 CI 留余量', 'external-load': '被别处的负载占着',
  'granted-full': '的核授给了正在跑的活', 'owner-reservation': '被负责人预留占着',
  'owner-hold': '被标成「我要用电脑」', 'head-lock': '被队首那张票锁着', 'memory-floor': '内存不够',
  'agent-slots-full': '的作业槽已满' }
const STATUS_WAIT_PLURAL = { 'ci-lane-reserve': '都在给 CI 留余量', 'external-load': '都被别处的负载占着',
  'granted-full': '的核都授给了正在跑的活', 'owner-reservation': '都被负责人预留占着',
  'owner-hold': '都被标成「我要用电脑」', 'head-lock': '都被队首那张票锁着', 'memory-floor': '内存都不够',
  'agent-slots-full': '的作业槽都满了' }
const STATUS_WAIT_UNTIL = { 'ci-lane-reserve': '等 CI 跑完自动放行', 'external-load': '等负载降下来自动放行',
  'granted-full': '等它们跑完自动放行', 'owner-reservation': '等预留到期或撤销后自动放行',
  'owner-hold': '取消这个标记后自动放行', 'head-lock': '等队首那张票先上', 'memory-floor': '等内存回升自动放行',
  'agent-slots-full': '等在跑的作业结束腾出槽后自动放行' }
/** 名单外机器里只有这几种码要在总结里另提一句:它们要人查、又与队首无关。quota-small 不在内 —— 它是拿队首申请核数比出来的,对名单外机器没有意义。 */
const STATUS_UNRELATED_CODES = ['offline', 'stale', 'ci-unknown']
/** 队首自己锁住的机器怎么说:锁只加给队首(sched-decide.ts 的队首保护锁),锁的主人就是队首时,从队首的角度说成在给它留着。不是原因码,不进上面四张表。 */
const STATUS_HEAD_RESERVE = { clause: '在给队首那张票留着', plural: '都在给队首那张票留着', until: '等上面正在跑的活结束就派给它' }
/**
 * 队首那张票允许去的机器名单;取不出来就返回 null,调用方退回「拿心跳全部机器下结论」的老口径。
 * 三种取不出来的来源:队列为空、心跳 queue 项缺这个字段、字段形状不对(空数组或含非字符串)。
 * 现行契约写不出这种心跳,只可能是写坏的文件 —— 宁可按老口径多报一句要人查,也不漏报;
 * 不去读票据文件补名单:多读一次共享盘就多一个失败点,而票据快照不是事实源。
 */
function statusAllowedMachines(headTicket) {
  if (!headTicket) return null
  const allowed = headTicket.allowedMachines
  if (!Array.isArray(allowed) || !allowed.length) return null
  if (allowed.some(name => typeof name !== 'string' || !name.length)) return null
  return allowed
}
/** 人话时长,只给展示用,不参与任何判据。 */
function statusDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}
function statusCountText(count) {
  return `${['零', '一', '两', '三', '四'][count] ?? count}台机器`
}
/** 心跳里那几个数都可能被旧派单员漏写;缺失一律当 0 —— status 是出问题时第一个被跑的命令,它自己不能先炸。 */
function statusCount(value) { return Number.isFinite(value) ? value : 0 }
/**
 * 这台机器这一拍还给 CI 留多少核。ciReserveCores 是 UDQ-T4B 之后的可选字段,旧派单员不写它;
 * 缺了就按「认不出 runner」保守处理:CI 在跑时当作整机配额都留给 CI(等价于改前「有 CI 就不派」),
 * 其余为 0。当 0 处理会把 ci=active 的机器说成放得下,与派单员那一拍的结论正好相反。
 */
function statusCiReserve(machine) {
  if (Number.isFinite(machine.ciReserveCores)) return Math.max(0, machine.ciReserveCores)
  return machine.ci === 'active' ? statusCount(machine.quotaCores) : 0
}
/** 读数里最旧的那一项距今多久(心跳 / 负载采样);两处都没有就返回 null,不编一个数出来。 */
function statusReadingAge(machine, nowMs) {
  const ages = [machine.heartbeatAt, machine.loadSampledAt]
    .filter(at => typeof at === 'string' && Number.isFinite(Date.parse(at)))
    .map(at => Math.max(0, nowMs - Date.parse(at)))
  return ages.length ? Math.max(...ages) : null
}
// ---- 内存下限(SCHED-MR6-MEMORY-DIMENSION-0924):只解释派单员边车里现成的结论,不重算闸。 ----
/** 内存数字给人看,一位小数带单位;与派单员侧 memoryMbText 同一算法,写坏/缺字段宁可不解释也不编数。 */
function statusMemoryGb(mb) {
  return `${(Math.round(mb / 102.4) / 10).toFixed(1)}GB`
}
/** 内存闸边车只认 90 秒内的读数;读不到、写坏、过期一律返回 null —— status 自己不能先炸,宁可少说。 */
const MEMORY_FLOOR_STATE_FRESH_MS = 90_000
function statusMemoryFloor(share, nowMs) {
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(path.join(paths(share).root, 'memory-floor', 'state.json'), 'utf8')) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.formatVersion !== 1) return null
  if (typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at))
    || nowMs - Date.parse(parsed.at) > MEMORY_FLOOR_STATE_FRESH_MS) return null
  if (!parsed.machines || typeof parsed.machines !== 'object' || Array.isArray(parsed.machines)) return null
  return parsed.machines
}

// ---- 超用标红(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925):只解释派单员投出来的标记,不重算。 ----
const OVERUSE_STATE_FRESH_MS = 120_000
/** 零依赖侧与 sched-contract 的 validateTicketOveruse 同判据:ticketId 仅边车条目带,快照内标记不带。 */
function overuseCheck(mark) {
  fields(mark, {
    attemptId, machine: segment, grantedCores: integer,
    measuredCores: v => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('实测核数不合法') },
    since: isoTime, sampledAt: isoTime,
  }, { alertedAt: isoTime, ticketId })
  if (Date.parse(mark.since) > Date.parse(mark.sampledAt)) throw new Error('起始时刻晚于最近读数时刻')
  if (mark.alertedAt !== undefined && Date.parse(mark.alertedAt) < Date.parse(mark.since)) throw new Error('告警时刻早于起始时刻')
}
/** 人话一句:超用标记的授予/实测/持续与告警状态,只给展示用。分钟向下取整,不虚报已持续时长。 */
function overuseText(mark) {
  const minutes = Math.max(0, Math.floor((Date.parse(mark.sampledAt) - Date.parse(mark.since)) / 60_000))
  return `超用:授予 ${mark.grantedCores} 核,${mark.machine} 上实测 ${mark.measuredCores} 核,已持续 ${minutes} 分钟;`
    + (mark.alertedAt !== undefined ? '已告警' : '满 5 分钟告警')
}
/** 终端告警行:带 alertedAt 的标记由调用方按执行去重后打印。分钟向下取整,与告警口径一致。 */
function overuseAlertText(id, mark) {
  const minutes = Math.max(0, Math.floor((Date.parse(mark.sampledAt) - Date.parse(mark.since)) / 60_000))
  return `[sched] 超用告警:单 ${id} 授予 ${mark.grantedCores} 核,${mark.machine} 上实测 ${mark.measuredCores} 核,`
    + `已持续 ${minutes} 分钟;测试或训练里的重进程请按环境变量 SCHED_GRANTED_CORES 限线程`
}
/** 超用边车只认 120 秒内的读数;读不到、写坏、过期一律返回空数组——status 自己不能先炸。 */
function statusOveruse(share, nowMs) {
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(path.join(paths(share).root, 'managed-load', 'overuse.json'), 'utf8')) } catch { return [] }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.formatVersion !== 1) return []
  if (typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at))
    || nowMs - Date.parse(parsed.at) > OVERUSE_STATE_FRESH_MS) return []
  if (!Array.isArray(parsed.tickets)) return []
  const items = []
  for (const entry of parsed.tickets) {
    try {
      overuseCheck(entry)
      const minutes = Math.max(0, Math.floor((Date.parse(entry.sampledAt) - Date.parse(entry.since)) / 60_000))
      items.push({ ticketId: ticketId(entry.ticketId), machine: entry.machine, grantedCores: entry.grantedCores,
        measuredCores: entry.measuredCores, since: entry.since, sustainedMinutes: minutes,
        alerted: entry.alertedAt !== undefined, text: overuseText(entry) })
    } catch { /* 单条写坏不拖累整个数组,也不让 status 炸 */ }
  }
  return items.sort((left, right) => left.ticketId < right.ticketId ? -1 : left.ticketId > right.ticketId ? 1 : 0)
}
// ---- 执行端作业槽(SCHED-SLOTS-VISIBLE-ON-DASH-0924):只解释派单员心跳里现成的快照,不重算件数。 ----
/** 心跳机器项里的作业槽快照:严格只认恰有 capacity/occupied 两键且 capacity 为正整数、occupied 为
 * 非负整数的形状;缺键、null、写坏一律返回 null(未知)。未知不显示槽、不拿它下任何结论,
 * 也不拿准入回退值 1/0 假装实测 —— 旧执行心跳在派单员心跳里就是 null。 */
function statusAgentSlots(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const names = Object.keys(value)
  if (names.length !== 2 || !names.includes('capacity') || !names.includes('occupied')) return null
  const capacity = value.capacity
  const occupied = value.occupied
  if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(occupied) || occupied < 0) return null
  return { capacity, occupied }
}
/**
 * 一台机器此刻放不放得下活、放不下卡在哪一项。纯函数:输入只有心跳里那一项 + locks + 队首申请核数 + 当前时刻。
 * headOccupiesSlot(SCHED-SLOTS-VISIBLE-ON-DASH-0924)由调用方按队首实物给:true=这张票在这台机器要占
 * 作业槽,false=不占(本地单/本地 auto),null=读不出实物不猜。
 * 判定顺序 = 不参与分配(eligible 的四个否定,按 sched-decide.ts 注释的顺序)→ 被队首锁着 → 容量够不够:
 * 不参与分配的机器根本到不了选机那一步,对它们报「核被占满」会把人的注意力引到错的地方。
 */
function statusMachineReason(machine, locks, headRequestedCores, nowMs, memoryBlocked = null, headOccupiesSlot = null) {
  const quotaCores = statusCount(machine.quotaCores)
  const grantedCores = statusCount(machine.grantedCores)
  const externalLoadCores = statusCount(machine.externalLoadCores)
  const ciReserveCores = statusCiReserve(machine)
  const reservationCores = machine.reservation ? statusCount(machine.reservation.requestedCores) : 0
  // 队首那张票要多少核;队列空时按「至少放得下 1 核」判(没有具体的活时,剩 0 核谈不上放得下)。
  const requestedCores = Number.isFinite(headRequestedCores) && headRequestedCores > 0 ? headRequestedCores : 1
  // externalLoadCores 与 ciReserveCores 取大者而不是相加:两者说的是同一批被占住的核(CI 跑起来本身就是外部负载),
  // 相加等于把同一份占用算两遍,会把明明放得下的机器说成放不下 —— decide 的 reservedForCi 就是这么定的。
  const reservedForCi = Math.max(externalLoadCores, ciReserveCores)
  const eligible = machine.fresh && machine.online && machine.ci !== 'unknown' && !machine.ownerHold
  // 可派核以派单员心跳为准:它就是准入这一拍实际用的数(HUB2 开关打开后是新口径,它的分项客户端算不出来),
  // 本地那几个数只用来挑头条原因。心跳缺这个数、不是有限非负数,或是缺 ciReserveCores 的老心跳,
  // 才按原式重算 —— 旧口径下两者逐字节相同。eligible 为假时一律记 0,与 decide 写进心跳的那个数同义。
  const reported = Number.isFinite(machine.availableCores) && machine.availableCores >= 0 && Number.isFinite(machine.ciReserveCores) ? machine.availableCores : null
  const availableCores = eligible ? (reported ?? Math.max(0, quotaCores - (grantedCores + reservedForCi + reservationCores))) : 0
  const locked = locks.find(lock => lock && lock.machine === machine.name) ?? null
  const numbers = { quotaCores, grantedCores, externalLoadCores, ciReserveCores, reservationCores, availableCores, requestedCores,
    missingCores: Math.max(0, requestedCores - availableCores), readingAgeMs: statusReadingAge(machine, nowMs),
    lockedByTicketId: locked ? locked.byTicketId ?? null : null }
  const answer = (reasonCode, reasonText) => ({ ok: reasonCode === 'ok', reasonCode, reasonText, ...numbers })
  if (!machine.online) return answer('offline', `离线了:派单员联系不上它${numbers.readingAgeMs === null ? '' : `(最后一次读数在 ${statusDuration(numbers.readingAgeMs)}前)`}`)
  if (!machine.fresh) return answer('stale', `读数不新鲜${numbers.readingAgeMs === null ? '' : `:心跳或负载采样已 ${statusDuration(numbers.readingAgeMs)}没更新`}`)
  if (machine.ci === 'unknown') return answer('ci-unknown', '读不出这台机器的 CI 状态,按规矩不许当空闲派活')
  if (machine.ownerHold) return answer('owner-hold', '负责人预留了电脑(点了「我要用电脑」),这台不参与派活')
  if (locked) return answer('head-lock', `被队首票 ${locked.byTicketId} 锁着,等它先上`)
  // 内存下限:派单员这一拍真把这台判成「内存不够」时如实说;边车没这台/不是 blocked/数字不全,就按核数口径继续。
  if (memoryBlocked && memoryBlocked.mode === 'blocked'
    && Number.isFinite(memoryBlocked.freeMb) && Number.isFinite(memoryBlocked.floorMb)) {
    return answer('memory-floor', `内存不够:这台可用内存 ${statusMemoryGb(memoryBlocked.freeMb)},`
      + `低于下限 ${statusMemoryGb(memoryBlocked.floorMb)}(内存回升后自动放行)`)
  }
  // 作业槽(SCHED-SLOTS-VISIBLE-ON-DASH-0924,R2 修订):核数够但执行端作业槽占满时,对队首那张已知要
  // 占槽的票如实报 agent-slots-full(自愈等待,不是要人查);占用/容量只认心跳里现成的实测快照。未知
  // (旧派单员、旧执行心跳、读不出队首实物)不下任何结论;已知队首是本机/原机 auto(不占执行端槽)时
  // 保留槽满事实但明说本机不受此限,不写等待语句误导人以为本机也得等;认不出上下文时只写槽满事实,
  // 等不等两边都不猜。
  const slots = statusAgentSlots(machine.agentSlots)
  const slotsFull = slots !== null && slots.occupied >= slots.capacity
  const slotsNote = !slotsFull ? ''
    : headOccupiesSlot === false
      ? `(作业槽已满:${slots.occupied}/${slots.capacity},但本机作业不占执行端槽,不受此限)`
      : `(作业槽已满:${slots.occupied}/${slots.capacity})`
  if (availableCores >= requestedCores) {
    if (slotsFull && headOccupiesSlot === true) {
      return answer('agent-slots-full', `作业槽已满:已占 ${slots.occupied} / 容量 ${slots.capacity} 槽,`
        + `核还剩 ${availableCores} 个,等在跑的作业结束腾出槽后自动放行`)
    }
    return answer('ok', `放得下:还有 ${availableCores} 核可用${slotsNote}`)
  }
  // 配额本身就小于申请是另一回事:decide 会把这单判成 unsatisfiable,这里如实说「装不下」而不是去报某个占用项。
  if (quotaCores < requestedCores) return answer('quota-small', `装不下这个活:整机配额才 ${quotaCores} 核,这张票要 ${requestedCores} 核`)
  // 剩下的情况:说清是被哪一项吃掉的。取占用最大的那一项当头条,平手按 已授 > CI 留核/外部负载 > 预留 的顺序
  // (reduce 只在严格更大时才换人,等值保留先出现的)。CI 留核与外部负载等值时按 CI 说:ciReserveCores > 0
  // 本身就意味着 CI 在跑,「在给 CI 留余量」比「有外部负载」更接近人看到的那件事。
  const top = [
    { code: 'granted-full', cores: grantedCores,
      text: `配额被已授占满:已授 ${grantedCores} / 配额 ${quotaCores} 核,剩下的不够这个活(要 ${requestedCores} 核)` },
    { code: ciReserveCores >= externalLoadCores ? 'ci-lane-reserve' : 'external-load', cores: reservedForCi,
      text: ciReserveCores >= externalLoadCores
        ? `被 CI 车道留核占住:给正在跑的 CI 留了 ${ciReserveCores} 核,剩下的不够这个活(要 ${requestedCores} 核)`
        : `被外部负载占住:机器上已有别处的负载 ${externalLoadCores} 核,剩下的不够这个活(要 ${requestedCores} 核)` },
    { code: 'owner-reservation', cores: reservationCores,
      text: `负责人预留:这台的 ${reservationCores} 核被预留占着,剩下的不够这个活(要 ${requestedCores} 核)` },
  ].reduce((best, item) => item.cores > best.cores ? item : best)
  return answer(top.code, top.text)
}
/**
 * 队首那张票等了多久、在等什么条件。名次直接取心跳里的 position === 1,不在客户端另排一次 ——
 * 展示队列与准入共用 sched-decide.ts 的 compareQueuedTickets 顺序,重排会与派单员的实际名次打架。
 * allowed 非 null 时只看队首那张票允许去的机器:派单员只在「心跳机器 ∩ 名单」里挑(sched-decide.ts),
 * 拿名单外的机器下结论会说出它根本不会去的机器上发生的事。
 */
function statusHead(headTicket, machines, nowMs, allowed = null) {
  if (!headTicket) return null
  const queuedAt = Number.isFinite(Date.parse(headTicket.queuedAt)) ? Date.parse(headTicket.queuedAt) : nowMs
  const waitedMs = Math.max(0, nowMs - queuedAt)
  const scope = allowed === null ? machines : machines.filter(part => allowed.includes(part.name))
  const blocked = scope.filter(part => !part.ok)
  // 名单内既有等条件的、又有要人查的机器时,队首要等的是能自己好的那台,先只看等条件的机器选码
  // (与总结「会自己好」说同一件事);名单内全是同一类时,结果与老算法相同。
  const waits = blocked.filter(part => !STATUS_CHECK_CLAUSE[part.reasonCode])
  const pool = allowed === null || !waits.length ? blocked : waits
  const tally = new Map()
  for (const part of pool) tally.set(part.reasonCode, (tally.get(part.reasonCode) ?? 0) + 1)
  let reasonCode = null, best = 0
  for (const [code, count] of tally) if (count > best) { reasonCode = code; best = count }
  const unsolvable = headTicket.state === 'unsatisfiable' && blocked.length > 0 && blocked.every(part => part.reasonCode === 'quota-small')
  let waitingFor = unsolvable ? '等不到:这张票要的核数超过所有机器放得下的数,得改单或加机器'
    : !blocked.length ? (allowed !== null && !scope.length ? '得先有人查清机器状态' : '不用等:这一拍就能派')
    : STATUS_WAIT_UNTIL[reasonCode] ?? (STATUS_CHECK_CLAUSE[reasonCode] ? '得先有人查清机器状态' : '等机器腾出核来')
  // 队首自己锁住的机器:锁的主人就是队首自己时,说的是「在给它留着」而不是「被队首那张票锁着」。
  if (allowed !== null && reasonCode === 'head-lock') {
    const held = pool.filter(part => part.reasonCode === 'head-lock')
    if (held.length && held.every(part => part.lockedByTicketId === headTicket.ticketId)) waitingFor = STATUS_HEAD_RESERVE.until
  }
  return { ticketId: headTicket.ticketId, requestedCores: statusCount(headTicket.requestedCores), state: headTicket.state,
    reason: headTicket.reason ?? null, waitedMs, waitedText: statusDuration(waitedMs), reasonCode, waitingFor }
}
/**
 * 一句给人看的总结:看完这一句就知道「该等」还是「该查」。字段名、核数减法一律不进来,那些在结构化字段里。
 * 队列为空也要给一句正常话,不留空 —— 空字符串会让人以为 status 坏了。
 */
function statusSummary(machines, head, allowed = null) {
  // allowed 为 null = 老路径(心跳缺名单或写坏了),仍然拿心跳全部机器下结论,输出与改前逐字相同。
  const scope = allowed === null ? machines : machines.filter(part => allowed.includes(part.name))
  const blocked = scope.filter(part => !part.ok)
  // 队首自己锁住的机器(锁的主人就是队首):从队首的角度说成在给它留着。按锁的主人判,不见 head-lock 就换说法。
  const selfLocked = part => allowed !== null && part.reasonCode === 'head-lock'
    && part.lockedByTicketId === (head ? head.ticketId : null)
  // 名单外机器里只有要人查的那几种码另提一句:等条件的、放得下的与队首无关,quota-small 对它们没有意义。
  const unrelated = allowed === null ? [] : machines.filter(part => !allowed.includes(part.name) && STATUS_UNRELATED_CODES.includes(part.reasonCode))
  const tail = unrelated.length ? `。另:${unrelated.map(part => `${part.name}${STATUS_CHECK_CLAUSE[part.reasonCode]}`).join(';')},不在队首允许的机器里,与队首无关` : ''
  if (!machines.length) return '心跳里一台机器都没有,派单员还没接上执行机 —— 这个要查'
  // 名单里的机器心跳里一台都没有:派单员只在名单里挑机器,派不了它是肯定的,这个要人查。
  if (allowed !== null && !scope.length) return `队首那张票只许去${allowed.join('、')},心跳里没有${allowed.length === 1 ? '这台' : '这几台'}机器,派单员派不了它 —— 这个要查${tail}`
  // unsatisfiable 分两种:申请的核超过机器容量(等多久也不会好),或临时被预留/负载卡住(条件变了还能上)。
  // 只有前一种配「等多久也轮不到它」这句话,判据是有机器报 quota-small;后一种照样按机器那台的原因说。
  if (head && head.state === 'unsatisfiable' && blocked.length > 0 && blocked.every(part => part.reasonCode === 'quota-small')) {
    return `队首那张票要 ${head.requestedCores} 核,比所有机器放得下的都多,等多久也轮不到它 —— 这个要查${tail}`
  }
  // 「队首还在队里」与「有机器放得下」在自洽的心跳里不会同时成立(放得下那一拍就授予了),所以这里不另起一句
  // 「某某机器能接」的分支:真出现这种情况,下面按机器逐台点名也说得清楚,机器是否能接在结构化字段里。
  if (!blocked.length) return (head ? '机器都放得下,队首那张票这一拍就会派出去'
    : `没有排队的活,${scope.length === 1 ? `${scope[0].name}还能接` : `${statusCountText(scope.length)}都能接`}`) + tail
  const codes = [...new Set(blocked.map(part => part.reasonCode))]
  const only = codes.length === 1 ? codes[0] : null
  const checks = blocked.filter(part => STATUS_CHECK_CLAUSE[part.reasonCode] !== undefined)
  if (only !== null && !checks.length) {
    // 全是队首自锁的机器:说成在给它留着,不说「被队首那张票锁着」。
    if (only === 'head-lock' && blocked.every(selfLocked)) {
      const reserved = blocked.length === 1 ? `${blocked[0].name}${STATUS_HEAD_RESERVE.clause},${STATUS_HEAD_RESERVE.until}`
        : `${statusCountText(blocked.length)}${STATUS_HEAD_RESERVE.plural},${STATUS_HEAD_RESERVE.until}`
      return (head ? reserved : `没有排队的活;${reserved}`) + tail
    }
    const body = blocked.length === 1 ? `${blocked[0].name}${STATUS_WAIT_CLAUSE[only]},${STATUS_WAIT_UNTIL[only]}`
      : `${statusCountText(blocked.length)}${STATUS_WAIT_PLURAL[only]},${STATUS_WAIT_UNTIL[only]}`
    return (head ? body : `没有排队的活;${body}`) + tail
  }
  if (only !== null && checks.length) {
    const who = blocked.length === 1 ? blocked[0].name : statusCountText(blocked.length)
    const ages = blocked.map(part => part.readingAgeMs).filter(age => age !== null)
    const age = ages.length ? statusDuration(Math.max(...ages)) : null
    const detail = only === 'stale' ? `${who}的读数${age === null ? '不新鲜' : `已 ${age}没更新`},派单员不敢按旧读数派活`
      : only === 'offline' ? `${who}离线了${age === null ? '' : `,最后一次读数在 ${age}前`}`
      : only === 'ci-unknown' ? `${who}读不出 CI 在不在跑,按规矩不许当空闲派活`
      : `${who}装不下这张票要的核数,等多久也不会放行`
    return `${detail}${head ? ',队首那张票一直派不出去' : ''} —— 这个要查${tail}`
  }
  const list = blocked.map(part => selfLocked(part) ? `${part.name}${STATUS_HEAD_RESERVE.clause}`
    : `${part.name}${STATUS_CHECK_CLAUSE[part.reasonCode] ?? STATUS_WAIT_CLAUSE[part.reasonCode]}`).join(';')
  const lead = head ? `队首那张票等了 ${head.waitedText},派不出去:` : '没有排队的活:'
  // 受阻机器里两类都有时:等条件的那几台会自己好,要人查的那几台不挡这张票 —— 不能说「不会自己好」。
  const ends = !checks.length ? ';条件消失后会自动放行'
    : allowed === null || checks.length === blocked.length ? ' —— 这里面有要人查的,不会自己好'
    : ` —— ${blocked.filter(part => STATUS_CHECK_CLAUSE[part.reasonCode] === undefined).map(part => part.name).join('、')}`
      + `放行后就能派,会自己好;${checks.map(part => part.name).join('、')}要人查,但不挡这张票`
  return `${lead}${list}${ends}${tail}`
}
function status(id, options = {}) {
  const ctx = runtime(options); checkFormat(ctx)
  if (id) {
    const ticket = readTicket(ctx, id)
    if (!ticket) throw new ClientError('单子不存在', 2)
    // 超用标记(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925):派单员标了红才多带 overuse/overuseText 两键;
    // 没标不给键,单张结果的顶层键与改前逐字相同(老调用方按整对象比对)。
    const overuse = ticket.overuse
    // 按历史改小的单(SCHED-CORES-HISTORY-AUTOCORRECT-1010)才多带申请核数两键,原文带原申请;
    // 没改过的单不给键,形状与改前逐字相同。
    const original = ticket.request.requestedCoresOriginal
    return { ticketId: id, title: ticket.request.title, state: ticket.state, currentAttemptId: ticket.currentAttemptId,
      cancelRequested: ticket.cancelRequested, updatedAt: ticket.updatedAt, result: activeAttempt(ticket)?.result ?? null,
      ...(overuse === undefined ? {} : { overuse, overuseText: overuseText(overuse) }),
      ...(original === undefined ? {} : { requestedCores: ticket.request.requestedCores,
        requestedCoresText: `${formatCores(ticket.request.requestedCores)} 核(申请 ${formatCores(original)},按历史改小)` }) }
  }
  const heartbeat = readJson(path.join(paths(ctx.share).root, '_control', 'dispatcher-heartbeat.json'))
  isoTime(heartbeat.at); integer(heartbeat.queued); integer(heartbeat.granted)
  const nowMs = Date.parse(timestamp(ctx))
  // 总览的超用名单从边车现读,降级路径也带——status 是出问题时第一个被跑的命令,宁可多给一句实话。
  // 空名单不给键:总览顶层键要稳定,红了才多一个 overuse。
  const overuse = statusOveruse(ctx.share, nowMs)
  const base = { machine: heartbeat.machine, heartbeatAgeMs: Math.max(0, nowMs - Date.parse(heartbeat.at)),
    queued: heartbeat.queued, granted: heartbeat.granted,
    ...(overuse.length > 0 ? { overuse } : {}) }
  // machines/queue/locks 是 UDQ 之后才写进心跳的三项,共享盘上跑的派单员未必已经换代。缺了不算格式错:
  // 退回原来的四字段 + 一句说明。宁可少说,也不能让 status 自己先炸 —— 它是出问题时第一个被跑的命令。
  const degraded = why => ({ ...base, degraded: true, machines: null, head: null, summary: why })
  if (!Array.isArray(heartbeat.machines) || !Array.isArray(heartbeat.queue) || !Array.isArray(heartbeat.locks)) {
    return degraded('这台派单员版本较老,给不出不放行的原因')
  }
  const headTicket = heartbeat.queue.find(ticket => ticket && ticket.position === 1) ?? null
  // 名单只在有队首那张票、且心跳带了形状正常的 allowedMachines 时才有;取不出来就整个走老口径。
  const allowed = statusAllowedMachines(headTicket)
  // 队首实物(SCHED-SLOTS-VISIBLE-ON-DASH-0924,R1 修订):「作业槽满挡不挡这张票」取决于它的执行类型
  // 与挂号机,心跳队列项没这些字段,也不猜 —— 但只有确实出现「合法且已满」的槽快照、需要解释
  // 「核数够为什么不给派」时才读队首实物;槽快照没有、未知或未满(含旧派单员心跳)时一个字节的
  // 实物 IO 都不发生,保持读旧心跳只靠心跳本身的原行为。真要解释时走正式 readTicket;读不到(null)
  // 按未知处理,槽满只进描述、不编造卡槽结论。读票据的真异常(共享盘不可读、快照身份不符)照原样
  // 上抛,不在这里吞成降级;队列项写坏到连单号都不是字符串的老心跳,同样当未知,不让 status 自己先炸。
  const slotsExplainNeeded = heartbeat.machines.some(machine => {
    const slots = statusAgentSlots(machine?.agentSlots)
    return slots !== null && slots.occupied >= slots.capacity
  })
  const headFile = !slotsExplainNeeded || headTicket === null || typeof headTicket.ticketId !== 'string'
    ? null : readTicket(ctx, headTicket.ticketId)
  // 这台机器挡不挡队首这张票的槽:集群单每台候选机都占;auto 单只在自己挂号机之外的机器占;
  // 本地单与本地 auto 不占。读不到实物就是 null(未知),不做「槽满挡票」的结论。
  const occupiesSlot = machine => headFile === null ? null
    : headFile.request.execution === 'cluster'
      || (headFile.request.execution === 'auto' && headFile.request.origin !== machine.name)
  try {
    // 内存闸边车每拍读一次,按机器名对号入座;读不到(开关没开/老派单员)就是 null,解释退回核数口径。
    const memoryFloor = statusMemoryFloor(ctx.share, nowMs)
    const machines = heartbeat.machines.map(machine => ({ name: machine.name,
      ...statusMachineReason(machine, heartbeat.locks, headTicket ? headTicket.requestedCores : null, nowMs,
        memoryFloor?.[machine.name] ?? null, occupiesSlot(machine)) }))
    const head = statusHead(headTicket, machines, nowMs, allowed)
    return { ...base, degraded: false, summary: statusSummary(machines, head, allowed), machines, head }
  } catch {
    // 心跳段结构意外(派单员写坏了、或版本对不上)也只降级:解释不出来不是抛异常的理由。
    return degraded('这份心跳读不出机器段,给不出不放行的原因')
  }
}

// ---- 包装进程：许可与 started 回执到手后才 spawn，心跳控制端在命令树外。 ----
async function reportAndWait(ctx, report) {
  validateReport(report)
  const name = reportName(report)
  const file = path.join(paths(ctx.share).reports, name)
  // started 同时是包装器的排他登记；同 pid 同毫秒的两个 run 调用也不能各自 spawn。
  if (report.phase === 'started') {
    try { publish(ctx, file, report) } catch (error) {
      if (error.code === 'EEXIST') throw new ClientError('本次执行已有包装进程登记', 2)
      throw error
    }
  } else createSame(ctx, file, report)
  const receipt = await poll(ctx, () => {
    checkFormat(ctx)
    const found = readJson(path.join(paths(ctx.share).reports, '_receipts', name), true)
    if (!found) return null
    fields(found, { name: text, status: oneOf(['accepted', 'rejected']), at: isoTime,
      ...(found.status === 'rejected' ? { reason: text } : {}) }, found.status === 'accepted' ? { reason: text } : {})
    if (found.name !== name) throw new ClientError('回报回执身份不符', 3)
    return found
  }, ctx.receiptTimeoutMs ?? 30_000)
  if (receipt.status !== 'accepted') throw new ClientError(`回报被拒:${receipt.reason}`, 2)
  return receipt
}
async function terminateTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
      killer.once('error', reject)
      killer.once('exit', code => {
        if (code === 0 || processGone(child.pid)) resolve()
        else reject(new Error(`终止进程树失败:${code}`))
      })
    })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}
// ---- 等待心跳(SCHED-QUEUED-ORPHAN-LIVENESS-1009) ----
// run/followAuto 在排队、授予未开跑期间每 waitingBeatMs 覆盖写 waiting/<单号>.json,seq 递增。
// 挂号端被工具超时掐断、被强杀,seq 就停了;派单员自己观察到 seq 连续 2 分钟不变即判挂号端已不在
// (排队的撤单、授予未开跑的立即收回),死单不再排到队首锁机器、授予后也不再白占 10 分钟。
// 文件里不放时间:判停更只用派单员自己的时钟,不受跨机钟偏影响。
// 收尾分两种(PR #1131 评审后改):开跑、终结、转交本机 run 这类正常离场 stop() 删文件;被中断、等待超时、
// 跟随放弃、抛错这类异常离场 abandon() 只停写、留下冻结的 seq——派单员 2 分钟后照判,派单员中途重启也照判
// (要是删了文件,派单员只能把它当没有心跳的老挂号端,排队单就永远撤不掉)。派单员判死后自己删文件。
// 写失败只提示、绝不让 run/exec 失败,并顺手删掉旧文件:留着它,派单员会按冻结的 seq 把仍活着的挂号端
// 当停更撤掉;删掉就退回旧规矩(看不到文件不判)。旧文件也删不掉(共享盘只读)时如实提示约 2 分钟后会被撤。
// 授予后同步算内容指纹可能扫很久、定时器响不了:扫描里每碰一个条目调 beatIfDue(),按间隔当场补一拍。
/** 等待心跳文件路径;文件名就是单号(与 sched-contract.ts 的 waitingBeatPath 同名同构)。 */
function waitingBeatFile(share, id) { return path.join(paths(share).waiting, `${ticketId(id)}.json`) }
/**
 * 立刻写第一拍(seq=0),之后每 ctx.waitingBeatMs 一拍。返回三个方法:
 * stop() 正常离场,清定时器并尽力删文件;abandon() 异常离场,只清定时器、文件原样留给派单员判;
 * beatIfDue() 给长时间同步工作用,距上一拍(按 ctx.monotonic)已满间隔就当场补一拍。
 * stop 与 abandon 谁先调谁算,之后两者都是空操作。
 */
function startWaitingBeat(ctx, id) {
  if (!Number.isFinite(ctx.waitingBeatMs) || ctx.waitingBeatMs <= 0) throw new ClientError('等待心跳间隔必须大于零')
  const file = waitingBeatFile(ctx.share, id)
  let seq = 0, failures = 0, stopped = false, lastBeatAt = 0
  const beat = () => {
    if (stopped) return
    lastBeatAt = ctx.monotonic()
    try {
      ctx.testOnlyPublishWaitingBeat(() => {
        // 旧共享盘是在等待心跳出现之前初始化的,可能没有 waiting/ 目录:与续约凭据同口径,写前递归补建。
        fs.mkdirSync(path.dirname(file), { recursive: true })
        publish(ctx, file, { schema: 1, ticketId: id, machine: os.hostname(), pid: process.pid, seq }, 'replace')
      })
      seq++
    } catch (error) {
      failures++
      // 旧文件留着,派单员会按它冻结的 seq 把仍活着的挂号端当停更撤掉;删掉就退回旧规矩(看不到文件不判)。
      let unlinkError = null
      try { unlinkIfPresent(file) } catch (removeError) { unlinkError = removeError }
      // 第 1 次和之后每第 6 次各提示一行(缺省间隔下约一分钟一行),不刷屏。
      if (failures % 6 === 1) ctx.notice(unlinkError === null
        ? `[sched] 等待心跳写入失败(第 ${failures} 次;已清掉旧心跳文件,不影响排队,只是这段时间挂号端若意外退出,派单员没法按心跳及时收回这张单):${error.message}`
        : `[sched] 等待心跳写入失败(第 ${failures} 次;旧心跳文件也删不掉:${unlinkError.message}。共享盘一直写不进的话,派单员约 2 分钟后会按挂号端已不在撤掉或收回这张单,届时请重新挂号):${error.message}`)
    }
  }
  beat()
  const timer = setInterval(beat, ctx.waitingBeatMs)
  // 定时器不单独吊住进程:各条路径都会 stop,万一漏了也不让包装进程挂着不退。
  timer.unref?.()
  const halt = () => {
    if (stopped) return false
    stopped = true
    clearInterval(timer)
    return true
  }
  return {
    stop() {
      if (!halt()) return
      try { unlinkIfPresent(file) } catch (error) { ctx.notice(`[sched] 等待心跳文件删除失败(不影响结果):${error.message}`) }
    },
    abandon() { halt() },
    beatIfDue() { if (!stopped && ctx.monotonic() - lastBeatAt >= ctx.waitingBeatMs) beat() },
  }
}
/** 派单员回收撞上的终态,给出去向提示;不是回收造成的终态返回 undefined。 */
function reclaimHint(reason) {
  if (reason === RECLAIMED_UNSTARTED_REASON) return '许可已因授予后未开跑被收回,请重新挂号'
  if (reason === WAITING_ABANDONED_REASON || reason === GRANTED_WAITING_ABANDONED_REASON) return '挂号端被判已不在(等待心跳停更),请重新挂号'
  return undefined
}
async function run(id, options = {}) {
  const ctx = runtime(options); ticketId(id); checkFormat(ctx)
  requireText(options.command, '命令')
  if (!options._autoLocal) {
    const candidate = readTicket(ctx, id)
    if (candidate?.request.execution === 'auto') return followAuto(ctx, id, candidate, options)
  }
  const beatMs = (options.beatSec ?? 10) * 1000
  if (!Number.isFinite(beatMs) || beatMs <= 0) throw new ClientError('心跳间隔必须大于零')
  let interrupted = false, cancelled = false, child, managed, interval, termination, monitoringError, supervisionError
  const stopTree = () => {
    if (!termination && managed) termination = managed.stop()
    else if (!termination && child?.pid) termination = terminateTree(child)
    // 立即登记处理器，异步信号到来时不能先冒成 unhandled rejection。
    if (termination) void termination.catch(error => { monitoringError = error })
    return termination
  }
  const onSignal = () => { interrupted = true; stopTree() }
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal)
  let waiting
  try {
    // 等授予、报开跑、等 running 快照这一整段都写等待心跳。正常离场(终态、进入 running)当场 stop 删文件;
    // 其余离开路径(中断、超时、抛错)由 finally 的 abandon 停写、留下冻结的 seq 给派单员判。
    waiting = startWaitingBeat(ctx, id)
    const ticket = await poll(ctx, () => {
      if (interrupted) throw new ClientError('包装进程被中断', 1)
      const value = readTicket(ctx, id)
      if (!value) return null
      if (TERMINAL_STATES.includes(value.state)) return value
      if (value.state !== 'granted') return null
      if (activeAttempt(value)?.permit?.machine !== os.hostname()) throw new ClientError('许可机器不是本机', 2)
      if (value.timeline.some(event => event.type === 'dispatch-intent' && event.attemptId === value.currentAttemptId)) throw new ClientError('集群单子不能用本机 run', 2)
      return value
    }, options.timeoutMs ?? Infinity)
    if (TERMINAL_STATES.includes(ticket.state)) {
      waiting.stop()
      // 许可被「挂号端没来领」收回、或被判挂号端已不在而撤单/收回的单子,把去向说清楚:原执行永远不能开跑,要重新挂号。
      const hint = reclaimHint(activeAttempt(ticket)?.result?.reason)
      return { exitCode: resultCode(ticket.state), result: ticket.state, ...(hint ? { hint } : {}) }
    }
    const permit = activeAttempt(ticket).permit
    const root = options.root ?? process.cwd()
    // 内容指纹是同步扫描(content:auto 缺省扫 '.',大工作区、慢盘可能扫上几分钟),期间定时器响不了:
    // 每碰一个条目按间隔补一拍等待心跳,派单员不会把正在准备开跑的挂号端当停更收回。
    const codeRef = ticket.request.codeRef.kind === 'content'
      ? contentFingerprint(root, ticket.request.work.targetPaths, () => waiting.beatIfDue()) : ticket.request.codeRef
    const identity = { ticketId: id, attemptId: permit.attemptId, token: permit.token, machine: os.hostname() }
    const controllerBirth = ticket.request.category === 'codex-acceptance' && ticket.request.work.type === 'acceptance'
      ? createSuspendRuntime().capturePermitController() : {}
    const permitAuthority = controllerBirth.creationFileTime
      ? createSuspendRuntime().createPermitAuthority({ pid: process.pid, creationFileTime: controllerBirth.creationFileTime }) : undefined
    await reportAndWait(ctx, { ...identity, phase: 'started', pid: process.pid, ...controllerBirth,
      ...(permitAuthority ? { verifier: permitAuthority.verifier } : {}), codeRef, at: timestamp(ctx) })
    // 回执先于快照落盘；必须等该执行的 running 快照，入口许可校验才不会误拒。
    await poll(ctx, () => {
      const current = readTicket(ctx, id)
      if (!current || current.currentAttemptId !== permit.attemptId) throw new ClientError('执行已过期', 2)
      if (TERMINAL_STATES.includes(current.state)) throw new ClientError('单子已终结', resultCode(current.state))
      return ['running', 'paused', 'slow'].includes(current.state) ? current : null
    }, ctx.receiptTimeoutMs ?? 30_000)
    // 已开跑:存活改由执行心跳(beats/)负责,等待心跳到此为止。
    waiting.stop()
    ctx.output('跑完之前别改受测文件')
    let childExitCode = 1, spawnError
    // 首拍之前以开始监控的时刻为基准，首拍失败也有有限的容忍预算。
    let lastSuccessfulBeatMs = Date.parse(timestamp(ctx)), consecutiveBeatFailures = 0
    // 超用告警(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925)的已报执行号:同一执行只报一次。
    const overuseAlerted = new Set()
    const pulse = () => {
      try {
        const current = readTicket(ctx, id)
        if (!current || current.currentAttemptId !== permit.attemptId || TERMINAL_STATES.includes(current.state)) throw new Error('执行已过期或已终结')
        if (current.cancelRequested) { cancelled = true; stopTree() }
        // 派单员标了超用红且已到告警时点:报一行人话,任何异常都不影响心跳。
        try {
          const mark = current.overuse
          if (mark?.alertedAt !== undefined && mark.attemptId === permit.attemptId && !overuseAlerted.has(mark.attemptId)) {
            overuseAlerted.add(mark.attemptId)
            ctx.notice(overuseAlertText(id, mark))
          }
        } catch { /* 告警不得影响心跳 */ }
        // 被包装命令已 spawn 且拿得到 pid 才带 childPid；拿不到整个字段不写（回收侧靠它确认整棵执行树）。
        ctx.testOnlyPublishBeat(() => publish(ctx, path.join(paths(ctx.share).beats, `${id}--${permit.attemptId}.json`), {
          ticketId: id, attemptId: permit.attemptId, machine: os.hostname(), at: timestamp(ctx),
          ...(child?.pid ? { childPid: child.pid } : {}),
          ...(managed ? { token: permit.token, suspend: managed.snapshot() } : {}),
        }, 'replace'))
        lastSuccessfulBeatMs = Date.parse(timestamp(ctx)); consecutiveBeatFailures = 0
      } catch (error) {
        // readTicket/checkFormat 会把底层 errno 包在 cause 中；身份/格式错误没有竞争性 errno，照旧立即终止。
        if (permitIoUnavailable(error)) {
          consecutiveBeatFailures++
          const elapsedMs = Date.parse(timestamp(ctx)) - lastSuccessfulBeatMs
          ctx.output(`心跳告警:连续失败 ${consecutiveBeatFailures} 次、距上次成功心跳 ${elapsedMs}ms:${error.message}`)
          if (elapsedMs <= BEAT_FAILURE_TOLERANCE_MS) return
        }
        monitoringError = error; stopTree()
      }
    }
    pulse()
    if (!interrupted && !cancelled && !monitoringError) {
      if (process.platform === 'win32') {
        // SCHED-RUN-SPAWN-FAIL-NO-FINISH-0924：命令没能启动也要先报结束再退出，不能让授予的核干等回收宽限期。
        try {
          // SCHED-RUN-ARG-QUOTING-CMD:托管执行把每个参数都加引号(生成块内 quoteWindows 组合的
          // commandLine),`cmd /c npm …` 的裸名字必须先解析成绝对路径再交出去,理由与解析口径见
          // managedExecutionArgs。改动只落在调用方实参上,生成块一字未动,不需要重新生成。
          managed = await createSuspendRuntime().startManagedExecution({ ...identity, share: ctx.share,
            category: permit.category, ownerPid: process.pid, command: options.command,
            args: managedExecutionArgs(options.command, options.args ?? [], { cwd: root, env: ctx.env }), cwd: root,
            // ciAware（T4B-2）只进执行树，不混进任何回报字段：CI 在跑期间按余量派出来的活开跑即整树降优先级且不冻。
            ...(permit.ciAware === true ? { ciAware: true } : {}),
            ...(permitAuthority ? { permitAuthority } : {}),
            ...(options.ciObserver === undefined ? {} : { ciObserver: options.ciObserver }),
            env: { ...ctx.env, SCHED_PERMIT: `${id}:${permit.attemptId}:${permit.token}`, SCHED_SHARE: ctx.share,
              SCHED_GRANTED_CORES: String(permit.grantedCores) }, warn: ctx.output,
            output: chunk => ctx._summaryOutput ? ctx._summaryOutput(chunk) : process.stdout.write(chunk), publishBeat: false })
        } catch (error) { spawnError = error }
        if (!spawnError) {
          child = { pid: managed.pid }
          if (interrupted || cancelled || monitoringError) stopTree()
          pulse(); interval = setInterval(pulse, beatMs)
          // SCHED-RUN-EXITCODE-NULL-FALSE-RED:done 兑现 null = 整棵执行树已退出但退出码读不出,不许默认按失败记账。
          // SCHED-RUN-SPAWN-FAIL-NO-FINISH-0924 的后续半张卡:监管自身失败(done 拒绝)也要先报结束再退出,不白占核等回收。
          try { childExitCode = await managed.done } catch (error) { supervisionError = error }
          pulse()
        }
      } else {
      const done = new Promise(resolve => {
        // SCHED-RUN-SPAWN-FAIL-NO-FINISH-0924：命令没能启动也要先报结束再退出，不能让授予的核干等回收宽限期。
        try {
          child = spawn(options.command, options.args ?? [], { cwd: root, shell: false,
            stdio: ctx._summaryOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit', windowsHide: true,
            detached: process.platform !== 'win32', env: { ...ctx.env, SCHED_PERMIT: `${id}:${permit.attemptId}:${permit.token}`,
              SCHED_SHARE: ctx.share, SCHED_GRANTED_CORES: String(permit.grantedCores) } })
        } catch (error) { spawnError = error; resolve(1); return }
        if (ctx._summaryOutput) {
          child.stdout.on('data', ctx._summaryOutput); child.stderr.on('data', ctx._summaryOutput)
        }
        child.once('error', error => { spawnError = error; resolve(1) })
        // 摘要要等 pipe 排空；原样仍在原来的 exit 事件完成，不改变信号/撤单路径。
        child.once(ctx._summaryOutput ? 'close' : 'exit', (code, signal) => { resolve(code ?? (signal === 'SIGINT' ? 130 : 1)) })
      })
      interval = setInterval(pulse, beatMs)
      childExitCode = await done
      }
    }
    if (interval) clearInterval(interval)
    if (termination) await termination
    // 子进程退出与最后一次轮询之间的撤单不能漏掉。
    const finalTicket = readTicket(ctx, id)
    if (finalTicket?.cancelRequested) cancelled = true
    let drift = false, fingerprintError
    if (codeRef.kind === 'content') {
      try { drift = contentFingerprint(root, ticket.request.work.targetPaths).value !== codeRef.value } catch (error) { drift = true; fingerprintError = error }
    }
    // SCHED-RUN-EXITCODE-NULL-FALSE-RED:退出码未确认(整树退出但读不出)与监管失败都是独立结论,
    // 一律按 voided 终态记账并退出 6,绝不默认记 failed。
    const unconfirmed = childExitCode === null
    const result = interrupted ? 'failed' : cancelled ? 'cancelled' : drift ? 'voided'
      : supervisionError || unconfirmed ? 'voided'
      : monitoringError || spawnError || childExitCode !== 0 ? 'failed' : 'passed'
    const reason = interrupted ? '包装进程被中断' : cancelled ? '撤单' : drift ? '运行中内容漂移'
      : supervisionError ? `执行监管失败:${supervisionError.message}`
      : unconfirmed ? '退出码未确认:整棵执行树已退出,但退出码读不出;这轮按作废记账,不是失败'
      : monitoringError ? `包装监控失败:${monitoringError.message}` : spawnError ? `命令启动失败:${spawnError.message}` : `命令退出码:${childExitCode}`
    if (fingerprintError) ctx.output(`内容指纹复核失败:${fingerprintError.message}`)
    await reportAndWait(ctx, { ...identity, phase: 'finished', result, reason, at: timestamp(ctx) })
    return { result, reason, exitCode: interrupted ? 1 : cancelled ? 5 : drift ? 6
      : supervisionError || unconfirmed ? 6 : monitoringError || spawnError ? 1 : childExitCode }
  } finally {
    // 正常离场已在上面 stop 删过文件,这里只剩异常离场:停写、文件留给派单员按停更判。
    waiting?.abandon()
    if (interval) clearInterval(interval)
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal)
    // I/O 异常也不能让仍在工作的子树脱离包装进程。
    if (managed) await managed.stop()
    else if (child && child.exitCode === null && child.signalCode === null) await terminateTree(child)
  }
}

// ---- hold：包装常驻服务，替它挂号长期占用单并持续续约（SCHED-MR5-RESIDENT-LEASE-0924）。 ----
// 与 run 的区别:run 包装的是「跑完就完」的活,靠 started/finished 回报结账;hold 包装的是
// 「一直在跑」的服务,它没有开跑/跑完这两个时刻——登记的是占用本身。所以:
//   · 单子挂号当拍即被派单员授予(不排队),计入该机已授予核数,于是别的活会自动绕开这几核;
//   · 只要包装进程还活着就每 beatMs 刷新一次 leases/<单号>.json,mtime 就是「我还活着」;
//   · 服务退出/进程被杀 → 心跳停 → 派单员超时自动销单,核数当拍释放,不会留下永远占着的僵尸单;
//   · 正常退出路径上主动撤单,把释放提前到当拍,不必干等超时。
// 刻意不走 startManagedExecution 的暂停/作业对象纳管:那套是给可派活准备的(CI 让路、整树冻结),
// 而常驻服务不该被调度器冻住,它只是把核「报上去」而已——多一层包装只会让退出语义更难说清。
/** 续约文件路径;文件名就是单号,派单员按 tk-<20hex>.json 认它(与 residentLeasePath 同名同构)。 */
function residentLeaseFile(share, id) { return path.join(paths(share).leases, `${ticketId(id)}.json`) }
/** 续约内容与 sched-contract.ts 的 ResidentLease 逐字相同(schema/ticketId/machine/cores/pid/at)。 */
function residentLeaseRecord(ctx, id, cores) {
  return { schema: 1, ticketId: id, machine: os.hostname(), cores, pid: process.pid, at: timestamp(ctx) }
}
/** 续约是「可再生的心跳」,不是事实源,所以每次整体替换(rename),不做 create-only。 */
function writeResidentLease(ctx, lease) {
  const file = residentLeaseFile(ctx.share, lease.ticketId)
  // SCHED-HOLD-LEASES-DIR-MISSING-0925:旧共享盘是在「续约凭据」这个功能出现之前初始化的,可能没有
  // leases/ 目录——写之前递归补建,已存在时是空操作。只对续约这一条路径生效:其它目录的缺失照旧报错
  // (那说明共享盘没初始化,不该由客户端悄悄补);rename 前目录已齐,ENOENT 不再发生。
  fs.mkdirSync(path.dirname(file), { recursive: true })
  publish(ctx, file, lease, 'replace')
  return lease
}
async function hold(options) {
  const ctx = runtime(options); checkFormat(ctx)
  requireText(options.project, '项目')
  requireText(options.title, '标题')
  const cores = integer(Number(options.cores), 1)
  requireText(options.command, '命令')
  const beatMs = (options.beatSec === undefined ? 30 : Number(options.beatSec)) * 1000
  if (!Number.isFinite(beatMs) || beatMs <= 0) throw new ClientError('续约间隔必须大于零')
  const key = options.key ?? autoIdempotencyKey(ctx, options.project)
  const receipt = await submit({ ...options, resident: true, key, cores, category: options.category ?? 'other',
    workType: options.workType ?? 'other', targets: options.targets ?? ['.'],
    codeRef: options.codeRef ?? autoCodeRef(options.root ?? process.cwd()) })
  if (receipt.status !== 'accepted') return { ...receipt, exitCode: 2 }
  const id = receipt.ticketId
  let interrupted = false, child, interval, spawnError, granted = false
  // 授予之后失败的「哪一步」:首写续约凭据是现实里唯一会抛的(0925 现场),拉起服务其后;
  // 真到了后面几步反而不会抛(spawn 的失败走 spawnError、子进程退出走退出码),这里只求措辞诚实。
  let grantedStep = '写首份续约凭据'
  const stopChild = () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) void terminateTree(child).catch(() => undefined)
  }
  const onSignal = () => { interrupted = true; stopChild() }
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal)
  const release = async (reason) => {
    try { await cancel(id, { ...ctx, reason }) } catch (error) {
      // 撤单没送到只能靠心跳断超时兜底:这是「晚一拍释放」,不是失败退出——绝不能让包装进程
      // 用自己的退出码假装服务还在跑。原因写进输出,人看得到。
      ctx.output(`撤单未送达(${error.message}),改由派单员按心跳断超时自动销单释放`)
    }
  }
  try {
    // 等授予:长期占用单当拍即授予,所以这里通常一拍就过;机器登记错时由派单员的超时销单终结。
    const ticket = await poll(ctx, () => {
      if (interrupted) throw new ClientError('包装进程被中断', 1)
      const value = readTicket(ctx, id)
      if (!value) return null
      if (TERMINAL_STATES.includes(value.state)) return value
      if (value.request.resident !== true) throw new ClientError('该单号不是长期占用单', 2)
      if (activeAttempt(value)?.permit?.machine !== os.hostname()) return null
      return ['granted', 'running'].includes(value.state) ? value : null
    }, options.timeoutMs ?? Infinity)
    if (TERMINAL_STATES.includes(ticket.state)) return { ticketId: id, result: ticket.state,
      reason: ticket.unsatisfiableReason ?? ticket.state, exitCode: resultCode(ticket.state) }
    const permit = activeAttempt(ticket).permit
    granted = true
    const lease = residentLeaseRecord(ctx, id, permit.grantedCores)
    ctx.output(JSON.stringify({ ticketId: id, machine: permit.machine, cores: permit.grantedCores, state: '授予' }))
    writeResidentLease(ctx, lease)
    grantedStep = '拉起常驻服务'
    let childExitCode = 1
    const done = new Promise(resolve => {
      try {
        child = spawn(options.command, options.args ?? [], { cwd: options.root ?? process.cwd(), shell: false, stdio: 'inherit',
          windowsHide: true, detached: process.platform !== 'win32', env: { ...ctx.env,
            SCHED_PERMIT: `${id}:${permit.attemptId}:${permit.token}`, SCHED_SHARE: ctx.share,
            SCHED_GRANTED_CORES: String(permit.grantedCores) } })
      } catch (error) { spawnError = error; resolve(1); return }
      child.once('error', error => { spawnError = error; resolve(1) })
      child.once('exit', (code, signal) => { resolve(code ?? (signal === 'SIGINT' ? 130 : 1)) })
    })
    // 首次续约已经写过;之后按间隔刷。心跳断超过 sched-contract 的门槛就会被销单,
    // 所以这里只需要保证「活着就一直写」,不需要重试逻辑。
    interval = setInterval(() => {
      try { writeResidentLease(ctx, residentLeaseRecord(ctx, id, permit.grantedCores)) } catch (error) {
        ctx.output(`续约失败:${error.message}`)
      }
    }, beatMs)
    childExitCode = await done
    if (interval) { clearInterval(interval); interval = undefined }
    const reason = interrupted ? '包装进程被中断,释放长期占用'
      : spawnError ? `命令启动失败,释放长期占用:${spawnError.message}` : `常驻服务退出(退出码 ${childExitCode}),释放长期占用`
    await release(reason)
    const result = interrupted ? 'failed' : spawnError ? 'failed' : 'cancelled'
    return { ticketId: id, result, reason, exitCode: interrupted || spawnError ? 1 : childExitCode }
  } catch (error) {
    // SCHED-HOLD-LEASES-DIR-MISSING-0925:授予之后、服务跑稳之前的任何异常(首当其冲:旧共享盘没有
    // leases/ 目录时首份续约凭据写不出去)都必须先走 release 把单子撤掉,再以退出码 1 结束——绝不能
    // 留下「已授予」死单一直占着核,要人手工 cancel。release 自身吞掉撤单未送达的错误(改由派单员按
    // 心跳断超时兜底),这里沿用它,不另写一套。两处例外,都不是「已授予」:等授予期间的异常单子还没
    // 授予、没有核可释放,照旧原样上抛;服务起来之后的周期性续约失败是可再生的心跳,下一拍会重写,
    // 照旧只在 interval 里打日志。
    if (!granted) throw error
    const reason = `授予后还没跑稳就失败(${grantedStep}这一步):${error.message},已先撤单释放`
    ctx.output(reason)
    await release(reason)
    return { ticketId: id, result: 'failed', reason, exitCode: 1 }
  } finally {
    if (interval) clearInterval(interval)
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal)
    // I/O 异常也不能把常驻服务留成孤儿进程;正常退出路径上子进程已经没了,这里是空操作。
    stopChild()
  }
}

// ---- exec：一步挂号 + 等授予 + 执行（SCHED-MR3-COMMAND-GATE-0924：给命令闸配套的一步包装）。 ----
/** 项目名安全化 + 14 位时间戳数字 + 8 位随机串；始终落在 SAFE_SEGMENT 内，且不会等于 . 或 ..。 */
function autoIdempotencyKey(ctx, project) {
  const safeProject = String(project).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 40) || 'proj'
  const stamp = timestamp(ctx).replace(/[^0-9]/g, '').slice(0, 14)
  const nonce = String(ctx.nonce()).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'x'
  return `${safeProject}-${stamp}-${nonce}`
}
/** code-ref 缺省：干净仓库(git status --porcelain 无输出)用 commit:HEAD；脏仓库、非仓库、git 报错、
 * HEAD 不是 40 位十六进制，一律回退 content:auto —— 缺省值宁可保守(全量扫描)，也不能猜错提交。 */
function autoCodeRef(root, execGit) {
  const git = execGit ?? (args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }))
  try {
    if (String(git(['status', '--porcelain'])).trim() !== '') return 'content:auto'
    const head = String(git(['rev-parse', 'HEAD'])).trim()
    return SHA1.test(head) ? `commit:${head}` : 'content:auto'
  } catch { return 'content:auto' }
}
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD']
/**
 * 挂号前的静态解析：在 Windows 上按 PATH + PATHEXT 复演一遍 argv[0] 会解析到哪个文件——找不到、
 * 解析到没经 cmd /c 包装的 .cmd/.bat、或解析到 .com 等非 .exe 映像，都在这里直接拒绝，绝不先排队
 * 再让 spawn/原生启动去发现（事故记录：SCHED-MR3-COMMAND-GATE-0924 第一轮 npx 未包 cmd /c，
 * spawn 失败白占 1 核 5 分钟）。判据与原生启动 executable() 逐字同款，两边看到同一个文件
 * （SCHED-RUN-LAUNCH-EDGE-GAPS ②）。只给出诊断结果和改写建议，绝不替调用方悄悄改写命令。
 * 非 Windows 平台直接放行——这层限制是 Windows spawn({shell:false}) 特有的，其它平台的 shell
 * 不存在"批处理必须显式 cmd /c"这回事。
 */
function resolveWindowsExecutable(command, args = [], options = {}) {
  const platform = options.platform ?? process.platform
  const rewrite = () => ['cmd', '/c', command, ...args].map(part => /\s/.test(part) ? `"${part}"` : part).join(' ')
  if (platform !== 'win32') return { ok: true }
  if (/^cmd(\.exe)?$/i.test(command) && /^\/c$/i.test(args[0] ?? '')) return { ok: true, wrapped: true }
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const exists = options.existsSync ?? fs.existsSync
  const pathext = String(env.PATHEXT ?? DEFAULT_PATHEXT.join(';')).split(';').map(value => value.trim()).filter(Boolean)
  const finish = match => {
    const ext = path.extname(match).toLowerCase()
    // SCHED-RUN-LAUNCH-EDGE-GAPS ②:挂号前判据与原生启动 executable() 逐字同款——只有 .exe 映像放行。
    // .cmd/.bat 与 .com 等其余非映像原生一律不收,预检不再放行,消灭"预检过了、原生拒了"的裂缝。
    if (ext === '.exe') return { ok: true, resolvedPath: match }
    if (ext === '.cmd' || ext === '.bat') return { ok: false, reason: `${command} 解析到批处理文件 ${match}，Windows 下 spawn(shell:false) 不能直接启动，必须显式用 cmd /c 包装`, suggestion: rewrite() }
    return { ok: false, reason: `${command} 解析到 ${match}，调度台在 Windows 上只直接启动 .exe 映像，原生启动不会接受它`, suggestion: rewrite() }
  }
  const roots = /[\\/]/.test(command) ? [''] : [cwd, ...String(env.PATH ?? '').split(path.delimiter)]
  // 第一轮照抄原生 executable() 的判据([base, base.exe] 里挑 .exe):两边看到同一个文件才不会一边放行一边拒绝。
  for (const root of roots) {
    const base = path.resolve(root || cwd, command)
    for (const name of [base, `${base}.exe`]) if (/\.exe$/i.test(name) && exists(name)) return finish(name)
  }
  // 第二轮只在第一轮落空后跑,仅为给出与旧口径一致的具体拒绝原因(批处理/非映像/找不到),不再产生放行结论。
  for (const root of roots) {
    const base = path.resolve(root || cwd, command)
    const baseExt = path.extname(base)
    if (baseExt && pathext.some(ext => ext.toLowerCase() === baseExt.toLowerCase()) && exists(base)) return finish(base)
    for (const ext of pathext) { const candidate = base + ext; if (exists(candidate)) return finish(candidate) }
  }
  return { ok: false, reason: `找不到可执行文件:${command}`, suggestion: rewrite() }
}

// ---- SCHED-RUN-ARG-QUOTING-CMD:cmd /c 的裸名字解析成绝对路径。 ----
// 托管执行(native 宿主)把命令行每个参数都加引号:`"cmd.exe" "/c" "npm" "--version"`。cmd 按带
// 引号的名字经 PATH 找到 npm.cmd 后,npm.cmd 里的 %~dp0 解析成**当前目录**而不是 npm 安装目录,
// 于是必报 `Cannot find module '<cwd>\node_modules\npm\bin\npm-prefix.js'`(MR1 施工记录第六节
// 第 13 条对照实验:全加引号退出码 1;同命令行去掉 /c 及其后引号才退出码 0——但去掉引号会触发
// cmd「去首尾引号再粘连」的破坏性行为,不能用)。实测可行且保留托管执行的整树控制的是
// `"cmd.exe" "/c" "<目标绝对路径>" "…"`:绝对路径下 %~dp0 回到安装目录。所以本卡把 /c 的目标
// 名字按 cmd 的查找口径(带分隔符直取;否则 NoDefaultCurrentDirectoryInExePath 决定要不要先搜
// 当前目录,再按 PATH × PATHEXT)解析成绝对路径后替换;内建命令与找不到的名字原样保留——
// 那是 cmd /c 的既有边界(echo/dir 等本来就能跑,带特殊字符的参数是引号规则的事,不在本卡扩面)。
const CMD_NAME_RE = /^cmd(\.exe)?$/i
/** 单独解析 cmd /c 的目标名字;找不到可执行文件(内建命令/不存在都算)返回 null。 */
function cmdTargetPath(target, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return null
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const exists = options.existsSync ?? fs.existsSync
  const pathext = String(env.PATHEXT ?? DEFAULT_PATHEXT.join(';')).split(';').map(value => value.trim()).filter(Boolean)
  const pathList = String(env.PATH ?? '').split(path.delimiter)
  const roots = /[\\/]/.test(target) ? ['']
    : env.NoDefaultCurrentDirectoryInExePath === undefined || env.NoDefaultCurrentDirectoryInExePath === '' ? [cwd, ...pathList] : pathList
  for (const root of roots) {
    const base = path.resolve(root || cwd, target)
    const baseExt = path.extname(base)
    if (baseExt && pathext.some(ext => ext.toLowerCase() === baseExt.toLowerCase()) && exists(base)) return base
    for (const ext of pathext) { const candidate = base + ext; if (exists(candidate)) return candidate }
  }
  return null
}
/** 托管执行的实参改写入口:只动「cmd /c <名字> …」的目标名字,其余包装原样透传。 */
function managedExecutionArgs(command, args, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32' || !CMD_NAME_RE.test(command) || !/^\/c$/i.test(args[0] ?? '') || args.length < 2) return args
  const resolved = cmdTargetPath(args[1], options)
  return resolved ? [args[0], resolved, ...args.slice(2)] : args
}
/** SCHED-TEST-CATEGORY-MISMATCH-FAILFAST:识别「cmd /c vitest …」包装,取出 vitest 的子命令
 * 参数(不含 vitest 本体);不是该包装返回 null。直跑 vitest(不带 cmd /c)在 Windows 上到不了
 * 这里——resolveWindowsExecutable 对 .cmd/.bat 已在更早处拒绝;这一层只管包了 cmd /c 的写法。 */
function vitestSubcommand(command, args = []) {
  if (!CMD_NAME_RE.test(command) || !/^\/c$/i.test(args[0] ?? '')) return null
  if (!/^vitest(\.(cmd|exe|bat))?$/i.test(args[1] ?? '')) return null
  return args.slice(2)
}
/** 尽力从心跳读排队位置；心跳缺失、降级、还没轮到都返回 null——这只是给人看的提示，不是判定依据。 */
function queuePosition(ctx, id) {
  try {
    const heartbeat = readJson(path.join(paths(ctx.share).root, '_control', 'dispatcher-heartbeat.json'), true)
    if (!heartbeat || !Array.isArray(heartbeat.queue)) return null
    const entry = heartbeat.queue.find(item => item && item.ticketId === id)
    return entry && Number.isFinite(entry.position) ? entry.position : null
  } catch { return null }
}
async function freshQueuePosition(ctx, id, waitMs = QUEUE_POSITION_FRESH_WAIT_MS) {
  try {
    let ticket
    try { ticket = readTicket(ctx, id) } catch { return queuePosition(ctx, id) }
    const submitted = ticket?.timeline.find(event => event.type === 'submitted' && Number.isInteger(event.seq) && event.seq > 0)
    if (!submitted) return queuePosition(ctx, id)
    const began = ctx.monotonic()
    let sleptMs = 0
    for (;;) {
      try {
        const heartbeat = readJson(path.join(paths(ctx.share).root, '_control', 'dispatcher-heartbeat.json'), true)
        if (!heartbeat || typeof heartbeat !== 'object' || !Number.isFinite(heartbeat.cursorSeq) || !Array.isArray(heartbeat.queue)) return null
        if (heartbeat.cursorSeq >= submitted.seq) {
          const entry = heartbeat.queue.find(item => item && item.ticketId === id)
          return entry && Number.isFinite(entry.position) ? entry.position : null
        }
      } catch { return null }
      const elapsedMs = ctx.monotonic() - began
      if (elapsedMs >= waitMs || sleptMs >= waitMs) return null
      const sleepMs = Math.min(ctx.pollMs, waitMs - elapsedMs, waitMs - sleptMs)
      await ctx.sleep(sleepMs)
      sleptMs += sleepMs
    }
  } catch { return null }
}
async function awaitQueuePosition(id, options = {}) {
  return freshQueuePosition(runtime(options), id, options.waitMs ?? QUEUE_POSITION_FRESH_WAIT_MS)
}
const REASON_TEXT = Object.freeze({
  'pinned-by-user': v => `[sched] 本机跑(pinned-by-user):你加了 ${v.detail},按要求留本机`,
  'exclusive-resource': () => '[sched] 本机跑(exclusive-resource):要独占屏幕或 Word,只能在本机跑',
  'client-modules-missing': v => `[sched] 本机跑(client-modules-missing):客户端缺菜单或快照模块(${v.detail}),这次留本机`,
  'sandbox-origin': () => '[sched] 本机跑(sandbox-origin):沙箱账户挂的号不往别的机器搬',
  'unknown-command': v => `[sched] 本机跑(unknown-command):这条命令不在 ${v.project} 的菜单里(${v.detail}),留本机跑;常用的话加进菜单`,
  'install-deps': () => '[sched] 本机跑(install-deps):装依赖要装在挂号这台机器上,不搬',
  'needs-android-sdk': () => '[sched] 本机跑(needs-android-sdk):要 Android SDK,别的机器还没装,不搬',
  pinned: () => '[sched] 本机跑(pinned):菜单把这一项钉在本机',
  'not-in-switch': v => `[sched] 本机跑(not-in-switch):${v.project} 的 ${v.item} 还没进可搬名单(hub.json),留本机`,
  'origin-not-allowed': v => `[sched] 本机跑(origin-not-allowed):本机 ${v.machine} 不在 ${v.project} 的执行机名单里`,
  'category-mismatch': v => `[sched] 本机跑(category-mismatch):挂号类别 ${v.category}、作业类型 ${v.workType} 与菜单项 ${v.item} 对不上,留本机`,
  'snapshot-no-head': () => '[sched] 本机跑(snapshot-no-head):这个目录拿不到 HEAD 提交,没法拍快照,留本机',
  'snapshot-base-missing': v => `[sched] 本机跑(snapshot-base-missing):本机仓库里没有共享盘主干那一笔(${v.mainCommit?.slice(0, 12) ?? '读不到'}),拍不出增量包,留本机;先 git fetch 再挂号就能搬`,
  'infra-source': v => `[sched] 本机跑(infra-source):改动碰了代理或调度台源码(${v.detail}),主干锚点换代放开前不送别的机器`,
  'branch-client-old': v => `[sched] 本机跑(branch-client-old):这个分支自带的调度台客户端${v.detail === 'old' ? '早于跨机搬运,认不出可搬单的许可' : `读不了(${v.detail})`},搬过去会被测试入口闸拒跑,留本机;把最新主干合进来后就能搬`,
})
function noticeReason(ctx, reason, values = {}) { ctx.notice(REASON_TEXT[reason](values)) }
function trunkHeadFile(share, project) {
  return project === deployment.getDeploymentConfig().legacyProjectId ? path.join(share, 'code-head.txt') : path.join(share, 'sched', 'repos', `${project}.head`)
}
function trunkHead(share, project) {
  try { const value = fs.readFileSync(trunkHeadFile(share, project), 'utf8').split(/\r?\n/, 1)[0].trim(); return SHA1.test(value) ? value : null }
  catch { return null }
}
function gitAsync(root, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    let output = '', errorOutput = '', settled = false
    const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      void terminateTree(child).then(() => reject(new Error('git timeout')), () => reject(new Error('git timeout')))
    }, timeoutMs)
    child.stdout.on('data', bytes => { output += bytes.toString() })
    child.stderr.on('data', bytes => { errorOutput += bytes.toString() })
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timeout); reject(error) } })
    child.once('close', code => {
      if (settled) return
      settled = true; clearTimeout(timeout)
      if (code === 0) resolve(output.trimEnd())
      else reject(new Error(`git ${args[0]} exited ${code}: ${errorOutput.split(/\r?\n/, 1)[0]}`))
    })
  })
}
function firstInfraPath(lines) {
  return lines.split(/\r?\n/).map(item => item.replace(/\\/g, '/')).find(item => CLIENT_INFRA_SOURCE_PREFIXES.some(prefix => item.startsWith(prefix)))
}
/**
 * 「自己的改动」基点(SCHED-HUB6-INFRA-OWN-CHANGES-1008):只认挂号人自己相对最新主干的改动,
 * 主干上别人的改动、分支落后主干造成的差异都不算。最新主干只读共享盘 trunk-anchor.json
 * (仅 rogue;主机代理约每 2 分钟写一次,字段形如 {"schema":1,"commit":"<40位>",...})。
 * 基点 = git merge-base <ref> <最新主干>;ref 在挂号判定里是工作区 HEAD,在快照第二道里是快照提交。
 * 锚点读不到 / JSON 坏 / schema 不是 1 / commit 不是 40 位小写十六进制 / 本地没有这一笔 /
 * merge-base 失败或输出不是 40 位 —— 一律返回 null,调用方退回 HUB6 现行判法(只会更严,不会更松)。
 */
async function ownChangesBase(ctx, root, project, ref, timeoutMs) {
  if (project !== deployment.getDeploymentConfig().legacyProjectId) return null
  // 共享盘读要异步且有界:SMB 卡住时 5 秒后按「没有最新主干」退回现行判法,不能把挂号卡死(#1095 评审)。
  let bytes, timer
  try {
    bytes = await Promise.race([fs.promises.readFile(path.join(ctx.share, 'trunk-anchor.json')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('trunk-anchor read timeout')), 5_000) })])
  } catch { return null } finally { clearTimeout(timer) }
  let anchor
  try { const body = bytes.toString('utf8'); anchor = JSON.parse(body.charCodeAt(0) === 0xfeff ? body.slice(1) : body) } catch { return null }
  if (!anchor || anchor.schema !== 1 || typeof anchor.commit !== 'string' || !SHA1.test(anchor.commit)) return null
  try { await gitAsync(root, ['cat-file', '-e', `${anchor.commit}^{commit}`], timeoutMs) } catch { return null }
  let base
  try { base = await gitAsync(root, ['merge-base', ref, anchor.commit], timeoutMs) } catch { return null }
  return SHA1.test(base) ? base : null
}
const BRANCH_CLIENT_FILE = ['scripts', 'sched', 'client', 'sched.cjs']
// 用正则字面量:文件里存的是带反斜杠的源码,不会自己匹配自己
const AUTO_AWARE_ENUM = /execution: oneOf\(\[[^\]]*'auto'[^\]]*\]\)/
/**
 * 分支自带的调度台客户端认不认 auto 单(SCHED-HUB6-INFRA-OWN-CHANGES-1008 续聊):
 * 测试入口闸(schedLocalGate → schedPermitProbe)用的是工作区里那份 sched.cjs 的 validatePermit,
 * 快照带走的也是工作区这份;HUB6 之前的旧客户端 execution 枚举里没有 auto,搬过去会被入口闸拒跑。
 * 读工作区文件判断(不是 HEAD 里的版本):ENOENT 表示仓里没有这份客户端、也就没有这道闸,放行;
 * 其他读错误(EISDIR / EACCES 等)钉本机。不加项目判断,别的项目仓里同样没有这个文件。
 */
async function branchClientAuto(root) {
  let source
  try { source = await fs.promises.readFile(path.join(root, ...BRANCH_CLIENT_FILE), 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return { ok: true }
    return { ok: false, detail: error.code ?? 'unknown' }
  }
  return AUTO_AWARE_ENUM.test(source) ? { ok: true } : { ok: false, detail: 'old' }
}
/** 开关关时在读取配置后立即返回，不加载菜单/快照模块，也不启动 git。 */
async function decideAuto(ctx, options, root, category, workType) {
  let bytes
  try { bytes = fs.readFileSync(path.join(ctx.share, 'sched', '_control', 'hub.json')) } catch { return null }
  let raw
  try { const body = bytes.toString('utf8'); raw = JSON.parse(body.charCodeAt(0) === 0xfeff ? body.slice(1) : body) } catch { return null }
  if (!raw || raw.schema !== 1 || raw.portable !== 'on') return null
  const pinned = (reason, values = {}) => { noticeReason(ctx, reason, values); return null }
  if (options.pin || options.local) return pinned('pinned-by-user', { detail: options.pin ? '--pin' : '--local' })
  if (options.machines !== undefined || options.codeRef !== undefined) return pinned('pinned-by-user', { detail: options.machines !== undefined ? '--machines' : '--code-ref' })
  if (options.exclusive?.length) return pinned('exclusive-resource')
  let projects, menu, hub, snapshot
  try { projects = require('./sched-projects.cjs') } catch (error) { return pinned('client-modules-missing', { detail: `sched-projects.cjs:${error.message.split(/\r?\n/, 1)[0]}` }) }
  try { menu = require('./sched-menu.cjs') } catch (error) { return pinned('client-modules-missing', { detail: `sched-menu.cjs:${error.message.split(/\r?\n/, 1)[0]}` }) }
  try { hub = require('./sched-hub-switch.cjs') } catch (error) { return pinned('client-modules-missing', { detail: `sched-hub-switch.cjs:${error.message.split(/\r?\n/, 1)[0]}` }) }
  try { snapshot = require('./sched-snapshot.cjs') } catch (error) { return pinned('client-modules-missing', { detail: `sched-snapshot.cjs:${error.message.split(/\r?\n/, 1)[0]}` }) }
  const switchValue = hub.parseHubSwitch(bytes).value
  if (switchValue.portable !== 'on') return null
  let username
  try { username = (options.userName ?? (() => os.userInfo().username))() } catch { return pinned('sandbox-origin') }
  if (username === 'CodexSandboxOffline' || username === 'CodexSandboxOnline') return pinned('sandbox-origin')
  const project = projects.normalizeProjectId(options.project).id
  const classified = menu.classifyCommand(project, [options.command, ...(options.args ?? [])], { exclusive: options.exclusive })
  if (!classified.recognized) return pinned('unknown-command', { project, detail: `${classified.why}:${classified.detail}` })
  if (!classified.portable) return pinned(classified.pinReason ?? 'pinned')
  if (!hub.portableAllowed(switchValue, project, classified.item)) return pinned('not-in-switch', { project, item: classified.item })
  const machines = projects.getProject(project).machines
  if (!machines.includes(os.hostname())) return pinned('origin-not-allowed', { project, machine: os.hostname() })
  if (!AUTO_CATEGORIES.includes(category) || TEST_LIKE_WORK_TYPES.includes(classified.item) && category !== 'unit-test'
    || options.workType !== undefined && options.workType !== classified.item)
    return pinned('category-mismatch', { category, workType, item: classified.item })
  let head
  try { head = await gitAsync(root, ['rev-parse', '--verify', 'HEAD^{commit}'], options.gitTimeoutMs); if (!SHA1.test(head)) throw new Error('invalid HEAD') }
  catch { return pinned('snapshot-no-head') }
  const mainCommit = trunkHead(ctx.share, project)
  if (!mainCommit) return pinned('snapshot-base-missing')
  try { await gitAsync(root, ['cat-file', '-e', `${mainCommit}^{commit}`], options.gitTimeoutMs) }
  catch { return pinned('snapshot-base-missing', { mainCommit }) }
  if (project === deployment.getDeploymentConfig().legacyProjectId && switchValue.infraOffload !== true) {
    try {
      const ownBase = await ownChangesBase(ctx, root, project, 'HEAD', options.gitTimeoutMs)
      const changed = await gitAsync(root, ['diff', '--name-only', ownBase ?? mainCommit], options.gitTimeoutMs)
      const untracked = await gitAsync(root, ['ls-files', '--others', '--exclude-standard'], options.gitTimeoutMs)
      const hit = firstInfraPath(`${changed}\n${untracked}`)
      if (hit) return pinned('infra-source', { detail: hit })
    } catch { return pinned('infra-source', { detail: 'git diff/ls-files timeout or failed' }) }
  }
  const branchClient = await branchClientAuto(root)
  if (!branchClient.ok) return pinned('branch-client-old', { detail: branchClient.detail })
  try { await snapshot.sweepStaleSnapshots({ repoPath: root }) } catch { /* 过期本地引用尽力清理 */ }
  return { project, classified, machines: [...machines], head, switchValue, snapshot }
}
function remoteLogPath(share, machine, ticket, attempt) {
  return path.join(share, 'logs', `${machine}.${ticket}--${attempt}.log`)
}
function remoteExitCode(ticket, { cancelWritten = false } = {}) {
  if (ticket.state === 'passed') return 0
  if (cancelWritten) return 5
  if (ticket.state === 'failed') {
    const code = activeAttempt(ticket)?.result?.exitCode
    return Number.isSafeInteger(code) && code !== 0 ? code : 1
  }
  return ticket.state === 'cancelled' ? 5 : ticket.state === 'voided' ? 6 : 1
}
const ZIP_MAX_BYTES = 209_715_200
const ZIP_CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function zipCrc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = ZIP_CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
function safeZipName(name) {
  return name.length > 0 && name.length <= 260 && !name.startsWith('/') && !/[\\:\0]/.test(name)
    && name.split('/').every(part => part && part !== '.' && part !== '..')
}
function secureMkdir(directory) {
  const parent = path.dirname(directory)
  if (parent !== directory && !fs.existsSync(parent)) secureMkdir(parent)
  if (fs.existsSync(directory)) {
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error(`产物目录不安全:${directory}`)
  } else fs.mkdirSync(directory)
}
/** 先解析、解压并验证整包，然后才创建任何目标文件。 */
function extractArtifactZip(zipBytes, destDir) {
  const bytes = Buffer.isBuffer(zipBytes) ? zipBytes : Buffer.from(zipBytes)
  if (bytes.length > ZIP_MAX_BYTES || bytes.length < 22) throw new Error('产物 zip 过大或不完整')
  let end = -1
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break }
  }
  if (end < 0) throw new Error('产物 zip 缺中央目录结尾')
  const disk = bytes.readUInt16LE(end + 4), centralDisk = bytes.readUInt16LE(end + 6)
  const diskEntries = bytes.readUInt16LE(end + 8), entries = bytes.readUInt16LE(end + 10)
  const centralSize = bytes.readUInt32LE(end + 12), centralOffset = bytes.readUInt32LE(end + 16)
  const commentLength = bytes.readUInt16LE(end + 20)
  if (disk || centralDisk || diskEntries !== entries || entries === 0xffff || centralSize === 0xffffffff
    || centralOffset === 0xffffffff || end + 22 + commentLength !== bytes.length
    || centralOffset + centralSize !== end) throw new Error('产物 zip 不支持多盘或 zip64')
  const decoded = [], names = new Set()
  let cursor = centralOffset, total = 0
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('产物 zip 中央目录损坏')
    const version = bytes.readUInt16LE(cursor + 6)
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10)
    const crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20)
    const uncompressed = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28)
    const extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32)
    const startDisk = bytes.readUInt16LE(cursor + 34), offset = bytes.readUInt32LE(cursor + 42)
    if (version >= 45 || flags & 1 || method !== 0 && method !== 8 || startDisk
      || [compressed, uncompressed, offset].includes(0xffffffff))
      throw new Error('产物 zip 使用不支持的加密、方法、多盘或 zip64')
    if (cursor + 46 + nameLength + extra + comment > end || offset + 30 > centralOffset) throw new Error('产物 zip 条目越界')
    let extraAt = cursor + 46 + nameLength
    const extraEnd = extraAt + extra
    while (extraAt < extraEnd) {
      if (extraAt + 4 > extraEnd) throw new Error('产物 zip 扩展字段损坏')
      const kind = bytes.readUInt16LE(extraAt), length = bytes.readUInt16LE(extraAt + 2)
      if (kind === 1) throw new Error('产物 zip64 不支持')
      extraAt += 4 + length
      if (extraAt > extraEnd) throw new Error('产物 zip 扩展字段损坏')
    }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    if (!isUtf8(nameBytes)) throw new Error('产物 zip 文件名不是 UTF-8')
    const name = nameBytes.toString('utf8')
    if (!safeZipName(name) || names.has(name)) throw new Error(`产物 zip 路径不安全或重复:${name}`)
    names.add(name)
    if (bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('产物 zip 本地文件头损坏')
    const localVersion = bytes.readUInt16LE(offset + 4)
    const localFlags = bytes.readUInt16LE(offset + 6), localMethod = bytes.readUInt16LE(offset + 8)
    const localNameLength = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28)
    const bodyAt = offset + 30 + localNameLength + localExtra
    let localExtraAt = offset + 30 + localNameLength
    const localExtraEnd = localExtraAt + localExtra
    while (localExtraAt < localExtraEnd) {
      if (localExtraAt + 4 > localExtraEnd) throw new Error('产物 zip 本地扩展字段损坏')
      const kind = bytes.readUInt16LE(localExtraAt), length = bytes.readUInt16LE(localExtraAt + 2)
      if (kind === 1) throw new Error('产物 zip64 不支持')
      localExtraAt += 4 + length
      if (localExtraAt > localExtraEnd) throw new Error('产物 zip 本地扩展字段损坏')
    }
    if (localVersion >= 45 || localFlags & 1 || localMethod !== method || bodyAt + compressed > centralOffset
      || offset + 30 + localNameLength + localExtra > centralOffset
      || bytes.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8') !== name)
      throw new Error('产物 zip 本地与中央目录不一致')
    const body = bytes.subarray(bodyAt, bodyAt + compressed)
    const plain = method === 0 ? body : inflateRawSync(body, { maxOutputLength: ZIP_MAX_BYTES + 1 })
    total += plain.length
    if (total > ZIP_MAX_BYTES || plain.length !== uncompressed || zipCrc32(plain) !== crc) throw new Error('产物 zip 校验失败')
    decoded.push({ name, plain })
    cursor += 46 + nameLength + extra + comment
  }
  if (cursor !== end) throw new Error('产物 zip 中央目录长度不符')
  for (const name of names) {
    const parts = name.split('/')
    for (let index = 1; index < parts.length; index++) {
      if (names.has(parts.slice(0, index).join('/'))) throw new Error('产物 zip 文件与目录路径冲突')
    }
  }
  let written = 0, skipped = 0
  for (const entry of decoded) {
    const target = path.join(destDir, ...entry.name.split('/'))
    secureMkdir(path.dirname(target))
    try { fs.writeFileSync(target, entry.plain, { flag: 'wx' }); written++ }
    catch (error) { if (error.code === 'EEXIST') skipped++; else throw error }
  }
  return { written, skipped }
}
async function ensureInfoExclude(root) {
  const found = await gitAsync(root, ['rev-parse', '--git-path', 'info/exclude'])
  const file = path.isAbsolute(found) ? found : path.resolve(root, found)
  secureMkdir(path.dirname(file))
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (old.split(/\r?\n/).some(line => ['/.sched-artifacts/', '.sched-artifacts/', '/.sched-artifacts'].includes(line.trim()))) return file
  fs.appendFileSync(file, `${old && !old.endsWith('\n') ? '\n' : ''}/.sched-artifacts/\n`)
  return file
}
async function recoverArtifacts(ctx, id, attempt, root) {
  const directory = path.join(ctx.share, 'sched', 'artifacts')
  const file = path.join(directory, `${id}--${attempt}.json`)
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  const destination = path.join(root, '.sched-artifacts', id)
  if (manifest.state === 'failed') { ctx.notice(`[sched] 产物打包失败:${manifest.detail ?? '未给详情'}`); return }
  if (manifest.state === 'listed') {
    secureMkdir(destination)
    try { fs.writeFileSync(path.join(destination, 'manifest.json'), fs.readFileSync(file), { flag: 'wx' }); await ensureInfoExclude(root) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    ctx.notice('[sched] 产物只取回了清单')
    return
  }
  if (manifest.state !== 'zipped') return
  const zipFile = path.join(directory, `${id}--${attempt}.zip`)
  const size = fs.statSync(zipFile).size
  if (size > ZIP_MAX_BYTES) { ctx.notice('[sched] 产物 zip 超过 200MB,没有解压'); return }
  const result = extractArtifactZip(fs.readFileSync(zipFile), destination)
  if (result.written) await ensureInfoExclude(root)
  ctx.notice(`[sched] 取回产物 ${result.written} 个,已有 ${result.skipped} 个跳过`)
}
function placedOnOriginNotice(ticket) {
  const placement = ticket.placement
  if (!placement) return '[sched] 本机跑(dispatcher-switch-off):派单员判完能不能搬之前,本机正好有空位,就先给了本机(派单员那边可搬开关没开时也是这一句)'
  if (placement.portable) return '[sched] 本机跑(placed-on-origin):派单员算下来本机最快'
  const reason = placement.reason ?? 'pinned'
  let detail
  if (reason === 'snapshot-late') detail = '快照两次没在 60 秒内交上,派单员改派本机'
  else if (reason.startsWith('snapshot-') || reason === 'infra-source') detail = `拍快照没成(${reason}),派单员改派本机`
  else if (REASON_TEXT[reason]) detail = REASON_TEXT[reason]({
    detail: placement.detail ?? '', project: ticket.request.project, item: ticket.request.menu?.item ?? ticket.request.work.type,
    category: ticket.request.category, workType: ticket.request.work.type,
    machine: ticket.request.origin, mainCommit: ticket.request.codeRef.value,
  }).split(':').slice(1).join(':')
  else detail = '派单员把它钉在本机'
  return `[sched] 本机跑(${reason}):派单员判定 ${detail}`
}
function publishSnapshotManifest(ctx, file, manifest) {
  try { publish(ctx, file, manifest); return manifest }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = readJson(file)
    if (canonicalJson(existing) !== canonicalJson(manifest)) ctx.notice(`[sched] 快照清单已存在且内容不同:${path.basename(file)};以已存在的为准`)
    return existing
  }
}
function snapshotRefusal(ctx, file, id, attempt, failure) {
  const detail = [failure.step, failure.detail, failure.files?.[0]].filter(Boolean).join(':').slice(0, 500) || failure.reason
  return publishSnapshotManifest(ctx, file, { schema: 1, ticketId: id, attemptId: attempt, state: 'refused',
    reason: failure.reason, detail, createdAt: timestamp(ctx) })
}
async function makeRemoteSnapshot(ctx, id, attempt, root, snapshot, switchValue, cancelRequested) {
  const directory = path.join(ctx.share, 'sched', 'snapshots')
  const file = path.join(directory, `${id}--${attempt}.json`)
  try { fs.mkdirSync(directory, { recursive: true }) }
  catch (error) { throw new ClientError(`创建快照目录失败:${directory}:${error.message}`, 3, error) }
  let manifest = readJson(file, true)
  if (manifest) return manifest
  const obsolete = () => {
    if (cancelRequested()) return true
    try { return readTicket(ctx, id)?.currentAttemptId !== attempt } catch { return true }
  }
  const refuse = async failure => {
    if (obsolete()) { await snapshot.cleanupSnapshot({ repoPath: root, ticketId: id }); return null }
    const result = snapshotRefusal(ctx, file, id, attempt, failure)
    await snapshot.cleanupSnapshot({ repoPath: root, ticketId: id })
    return result
  }
  const made = await snapshot.createSnapshot({ repoPath: root, ticketId: id })
  if (obsolete()) { await snapshot.cleanupSnapshot({ repoPath: root, ticketId: id }); return null }
  if (!made.ok) return refuse(made)
  const project = ctx.autoProject
  const mainCommit = trunkHead(ctx.share, project)
  if (!mainCommit) return refuse({ reason: 'snapshot-base-missing', detail: '共享盘主干号读不到' })
  const bundle = await snapshot.createBundle({ repoPath: root, ticketId: id, mainCommit, destDir: directory })
  if (obsolete()) { await snapshot.cleanupSnapshot({ repoPath: root, ticketId: id }); return null }
  if (!bundle.ok) return refuse(bundle)
  if (project === deployment.getDeploymentConfig().legacyProjectId && switchValue.infraOffload !== true) {
    try {
      const ownBase = await ownChangesBase(ctx, root, project, made.commit)
      const changed = await gitAsync(root, ['diff', '--name-only', ownBase ?? bundle.base, made.commit])
      const hit = firstInfraPath(changed)
      if (hit) {
        await snapshot.removeBundle({ destDir: directory, ticketId: id })
        return refuse({ reason: 'infra-source', detail: hit })
      }
    } catch (error) {
      await snapshot.removeBundle({ destDir: directory, ticketId: id })
      return refuse({ reason: 'infra-source', detail: error.message })
    }
  }
  if (obsolete()) { await snapshot.cleanupSnapshot({ repoPath: root, ticketId: id }); return null }
  return publishSnapshotManifest(ctx, file, { schema: 1, ticketId: id, attemptId: attempt, state: 'ready',
    commit: made.commit, base: bundle.base, bundle: `${id}.bundle`, bundleBytes: bundle.bytes, createdAt: timestamp(ctx) })
}
function readRemoteLog(ctx, file, state) {
  let handle
  try { handle = fs.openSync(file, 'r') } catch (error) { if (error.code === 'ENOENT') return 0; throw error }
  try {
    const size = fs.fstatSync(handle).size
    if (size < state.offset) { state.offset = 0; state.decoder = new StringDecoder('utf8'); ctx.notice(`[sched] 远端日志变短,从头重读:${file}`) }
    const count = Math.min(1_048_576, size - state.offset)
    if (count <= 0) return 0
    const buffer = Buffer.allocUnsafe(count)
    const read = fs.readSync(handle, buffer, 0, count, state.offset)
    state.offset += read
    if (ctx._summaryOutput) ctx.remoteOutput(buffer.subarray(0, read))
    else {
      const decoded = state.decoder.write(buffer.subarray(0, read))
      if (decoded) ctx.remoteOutput(decoded)
    }
    return read
  } finally { fs.closeSync(handle) }
}
async function followAuto(ctx, id, initial, options) {
  const root = options.root ?? process.cwd(), followMs = options.followMs ?? 1000
  if (!Number.isFinite(followMs) || followMs <= 0) throw new ClientError('跟随间隔不合法')
  const request = initial?.request ?? readTicket(ctx, id)?.request
  if (!request || request.execution !== 'auto') throw new ClientError('不是 auto 单')
  const { classifyCommand } = require('./sched-menu.cjs')
  const matched = classifyCommand(request.project, [options.command, ...(options.args ?? [])])
  if (!matched.recognized || matched.item !== request.menu.item || canonicalJson([...matched.args]) !== canonicalJson(request.menu.args))
    throw new ClientError('命令与挂号时的菜单项不符', 2)
  const snapshot = options.snapshot ?? require('./sched-snapshot.cjs')
  let switchValue = options.switchValue
  if (!switchValue) {
    try { switchValue = require('./sched-hub-switch.cjs').parseHubSwitch(
      fs.readFileSync(path.join(ctx.share, 'sched', '_control', 'hub.json'))).value }
    catch { switchValue = { infraOffload: false } }
  }
  ctx.autoProject = request.project
  let currentAttempt = null, machine = null, sawManifest = false, madeSnapshot = false, failedSince = null
  let cancelWritten = false, secondSignal = false, cancelCommandId = null, receiptSeen = false, signalWake, signalStop
  const stopped = new Promise(resolve => { signalStop = resolve })
  const log = { offset: 0, decoder: new StringDecoder('utf8') }
  const noticedLocal = new Set(), noticedRemote = new Set(), noticedStates = new Set()
  // 超用告警(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925)的已报执行号:同一执行只报一次;
  // 只在远端跟随分支报,本机交给路走 run 的 pulse,同一执行两边不会重复。
  const noticedOveruse = new Set()
  const onSignal = () => {
    if (!machine || machine === os.hostname()) return
    if (cancelWritten) { secondSignal = true; ctx.notice('[sched] 再次收到中断信号,停止等待远端'); signalStop(); signalWake?.(); return }
    try {
      const command = writeCancelCommand(ctx, id, '挂号端 Ctrl+C 撤单')
      cancelWritten = true; cancelCommandId = command.commandId
      ctx.notice(`[sched] 已写撤单 ${command.commandId},等 ${machine} 上的执行收尾`)
    } catch (error) { ctx.notice(`[sched] 撤单写入失败:${error.message}`) }
    signalWake?.()
  }
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal)
  const pause = async () => {
    await Promise.race([ctx.sleep(followMs), new Promise(resolve => { signalWake = resolve })])
    signalWake = null
  }
  // 等待心跳(SCHED-QUEUED-ORPHAN-LIVENESS-1009):排队、授予未开跑期间写;观察到开跑或终态即停(删文件),
  // 重排回排队再接着写。转交本机 run 之前先停,由 run 自己接着写,同一张单不出现两个写者。
  // 读票放弃、二次中断、抛错这类异常离场走 finally 的 abandon:停写、文件留给派单员按停更判。
  let waiting = null
  const syncWaiting = state => {
    const waits = state === 'queued' || state === 'unsatisfiable' || state === 'granted'
    if (waits && !waiting) waiting = startWaitingBeat(ctx, id)
    else if (!waits && waiting) { waiting.stop(); waiting = null }
  }
  try {
    syncWaiting('queued')
    for (;;) {
      if (secondSignal) return { exitCode: 1, result: 'interrupted', reason: 'second signal', ticketId: id, machine, remote: true }
      let ticket
      try { ticket = readTicket(ctx, id); failedSince = null }
      catch (error) {
        if (failedSince === null) failedSince = ctx.monotonic()
        if (ctx.monotonic() - failedSince > 30_000) {
          ctx.notice(`[sched] 单子 ${id} 仍在 ${machine ?? '执行机'} 上,可以用 node sched.cjs wait ${id} --until finished 接着看`)
          return { exitCode: 3, result: 'unreadable', reason: error.message, ticketId: id, machine, remote: true }
        }
        ctx.notice(`[sched] 读票据暂时失败:${error.message}`); await pause(); continue
      }
      if (!ticket) { await pause(); continue }
      syncWaiting(ticket.state)
      if (cancelCommandId && !receiptSeen) {
        try {
          const receipt = readOptionalNewChannelJson(path.join(paths(ctx.share).commands, '_receipts', `${cancelCommandId}.json`))
          if (receipt) { receiptSeen = true; if (receipt.status === 'rejected' || receipt.status === 'expired') ctx.notice(`[sched] 撤单回执:${receipt.status}`) }
        } catch (error) { ctx.notice(`[sched] 撤单回执读取失败:${error.message}`); receiptSeen = true }
      }
      if (ticket.currentAttemptId !== currentAttempt) {
        currentAttempt = ticket.currentAttemptId; machine = activeAttempt(ticket)?.permit?.machine ?? null
        log.offset = 0; log.decoder = new StringDecoder('utf8')
      }
      const active = activeAttempt(ticket)
      if (active?.permit) machine = active.permit.machine
      if ((ticket.state === 'granted' || TERMINAL_STATES.includes(ticket.state)) && machine === os.hostname()) {
        if (!noticedLocal.has(currentAttempt)) { ctx.notice(placedOnOriginNotice(ticket)); noticedLocal.add(currentAttempt) }
        process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal)
        // SCHED-HUB6-PINBACK-SNAPSHOT-REF-1009:auto 单先授予别机、本端已为它拍过快照引用,之后被
        // 交接复核拒回(handoff-pin)回排改授予本机时,转本机跑之前先按下面远端终结分支的同一口径
        // 尽力清掉本地隐藏引用与临时索引;失败只告警一行,不改本机跑的结论。从没走过远端的单子
        // (没拍过快照、没见过清单)两个标记都是 false,清理不触发,行为逐字不变。
        if (madeSnapshot || sawManifest) try { await snapshot.cleanupSnapshot({ repoPath: root, ticketId: id }) }
          catch (error) { ctx.notice(`[sched] 清理本地快照失败:${error.message}`) }
        if (waiting) { waiting.stop(); waiting = null }
        return run(id, { ...options, _autoLocal: true })
      }
      // 从没授予过就终结(排队中被撤单,或被判挂号端已不在):没有执行机可等,带着结论返回,不空转。
      if (TERMINAL_STATES.includes(ticket.state) && !machine) {
        const hint = reclaimHint(active?.result?.reason)
        return { exitCode: resultCode(ticket.state), result: ticket.state, reason: active?.result?.reason, ticketId: id,
          ...(hint ? { hint } : {}) }
      }
      if (machine && machine !== os.hostname()) {
        // 派单员标了超用红且已到告警时点:远端跟随这里报一行人话,快照没带标记就整段跳过。
        try {
          const mark = ticket.overuse
          if (mark?.alertedAt !== undefined && mark.attemptId === currentAttempt && !noticedOveruse.has(currentAttempt)) {
            noticedOveruse.add(currentAttempt)
            ctx.notice(overuseAlertText(id, mark))
          }
        } catch { /* 告警不得挡跟随 */ }
        const file = remoteLogPath(ctx.share, machine, id, currentAttempt)
        const manifestFile = path.join(ctx.share, 'sched', 'snapshots', `${id}--${currentAttempt}.json`)
        if (ticket.state === 'granted' && !fs.existsSync(manifestFile) && !cancelWritten) {
          madeSnapshot = true
          const manifest = await Promise.race([makeRemoteSnapshot(ctx, id, currentAttempt, root, snapshot, switchValue,
            () => cancelWritten || secondSignal), stopped])
          if (secondSignal) return { exitCode: 1, result: 'interrupted', reason: 'second signal', ticketId: id, machine, remote: true }
          if (manifest) sawManifest = true
        }
        const manifest = readOptionalNewChannelJson(manifestFile)
        if (manifest) sawManifest = true
        if (manifest?.state === 'ready' && !noticedRemote.has(currentAttempt)) {
          ctx.notice(`[sched] 去 ${machine} 跑(单号 ${id},执行 ${currentAttempt}):派单员按预计完成最早挑中它;本机工作区已拍成快照 ${manifest.commit.slice(0, 12)},远端跑的是这一刻的代码`)
          noticedRemote.add(currentAttempt)
        }
        readRemoteLog(ctx, file, log)
        const started = ticket.timeline.some(event => event.type === 'started' && event.attemptId === currentAttempt)
        const stateKey = `${currentAttempt}:${ticket.state}`
        if (started && !noticedStates.has(`${currentAttempt}:started`)) { ctx.notice(`[sched] ${machine} 已开跑`); noticedStates.add(`${currentAttempt}:started`) }
        if (ticket.timeline.some(event => event.type === 'paused' && event.attemptId === currentAttempt)
          && !noticedStates.has(`${currentAttempt}:paused`)) {
          ctx.notice(`[sched] ${machine} 已暂停`); noticedStates.add(`${currentAttempt}:paused`)
        }
        if (ticket.timeline.some(event => event.type === 'resumed' && event.attemptId === currentAttempt)
          && !noticedStates.has(`${currentAttempt}:resumed`)) {
          ctx.notice(`[sched] ${machine} 已恢复`); noticedStates.add(`${currentAttempt}:resumed`)
        }
        if (['paused', 'running', ...TERMINAL_STATES].includes(ticket.state) && !noticedStates.has(stateKey)) {
          if (TERMINAL_STATES.includes(ticket.state)) ctx.notice(`[sched] ${machine} 已结束:${ticket.state}`)
          noticedStates.add(stateKey)
        }
        if (TERMINAL_STATES.includes(ticket.state)) {
          let idle = 0, elapsed = 0
          while (idle < 2 && elapsed < 5000) {
            await pause(); elapsed += followMs
            if (secondSignal) return { exitCode: 1, result: 'interrupted', reason: 'second signal', ticketId: id, machine, remote: true }
            idle = readRemoteLog(ctx, file, log) ? 0 : idle + 1
          }
          const remainder = log.decoder.end(); if (remainder) ctx.remoteOutput(remainder)
          try { await recoverArtifacts(ctx, id, currentAttempt, root) } catch (error) { ctx.notice(`[sched] 产物取回失败:${error.message}`) }
          if (madeSnapshot || sawManifest) try { await snapshot.cleanupSnapshot({ repoPath: root, ticketId: id }) }
            catch (error) { ctx.notice(`[sched] 清理本地快照失败:${error.message}`) }
          return { exitCode: remoteExitCode(ticket, { cancelWritten }), result: ticket.state,
            reason: active?.result?.reason, ticketId: id, machine, remote: true }
        }
      }
      await pause()
    }
  } finally {
    if (waiting) { waiting.abandon(); waiting = null }
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal)
  }
}
/**
 * 一步完成 submit → 打印单号与排队位置 → run(等授予后执行) → 结束回报；退出码透传被执行命令的
 * 退出码，挂号被拒时非零退出并打印原因。命令预检失败(见 resolveWindowsExecutable)在挂号之前就
 * 拒绝，不占调度台的队。
 */
async function execUnformatted(options) {
  const ctx = runtime(options)
  const root = options.root ?? process.cwd()
  const resolved = resolveWindowsExecutable(options.command, options.args ?? [], { cwd: root, env: ctx.env })
  if (!resolved.ok) {
    ctx.output(JSON.stringify({ stage: 'resolve', reason: resolved.reason, suggestion: resolved.suggestion }))
    return { exitCode: 2, reason: resolved.reason, suggestion: resolved.suggestion }
  }
  // SCHED-TEST-CATEGORY-MISMATCH-FAILFAST:包的是 vitest 而类别不是 unit-test,挂号前当场拒——
  // vitest 只有单测与性能基准(vitest bench → perf-bench)两个合法用法,别的类别下就算排上队也会
  // 被入口闸「许可类别不符」拒掉,白占一轮调度。与 submit 侧的 assertCategoryMatchesWorkType
  // (按作业类型)互补:这一道按命令识别,兜住 workType 也写成 other 的缺省用法。挂号形式给的是
  // LOCAL_WORK 的正确配对,不是自创口径。
  const category = options.category ?? 'other'
  const workType = options.workType ?? 'other'
  const vitestArgs = vitestSubcommand(options.command, options.args ?? [])
  if (vitestArgs !== null && category !== 'unit-test' && !(vitestArgs[0] === 'bench' && category === 'perf-bench')) {
    const reason = `包的是 vitest，挂号类别却是 ${category}`
    const suggestion = vitestArgs[0] === 'bench'
      ? '性能基准请按 --category perf-bench --work-type bench 重新挂号'
      : '单测请按 --category unit-test --work-type test 重新挂号'
    ctx.output(JSON.stringify({ stage: 'category', reason, suggestion }))
    return { exitCode: 2, reason, suggestion }
  }
  const targetsDefaulted = options.targets === undefined
  const targets = options.targets ?? ['.']
  const key = options.key ?? autoIdempotencyKey(ctx, options.project)
  const auto = await decideAuto(ctx, options, root, category, workType)
  if (auto) {
    const previous = readJson(path.join(paths(ctx.share).submit, `${segment(key)}.json`), true)
      ?? readTicket(ctx, deriveTicketId(auto.project, key))?.request
    // auto 单同样按同类活历史实测纠正(SCHED-CORES-HISTORY-AUTOCORRECT-1010);这里自建请求
    // (submit 只透传 options.request),所以就地做同一份纠正,口径与 submit 完全一致。
    const correction = usageCorrection(ctx, { project: auto.project, workType: auto.classified.item, cores: options.cores,
      command: options.command, args: options.args, coresStrict: options.coresStrict, correctable: true })
    const request = {
      idempotencyKey: key, project: auto.project, submitter: options.submitter ?? os.hostname(), category,
      title: options.title, work: { type: auto.classified.item, targetPaths: targets }, requestedCores: correction.cores,
      allowedMachines: auto.machines, codeRef: { kind: 'commit', value: auto.head }, resources: { exclusive: [] },
      createdAt: options.createdAt ?? previous?.createdAt ?? timestamp(ctx), execution: 'auto', origin: os.hostname(),
      menu: { item: auto.classified.item, args: [...auto.classified.args] },
      ...(options.parent ? { parentTicketId: options.parent } : {}),
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      ...(correction.usageKey === undefined ? {} : { usageKey: correction.usageKey }),
      ...(correction.requestedCoresOriginal === undefined ? {} : { requestedCoresOriginal: correction.requestedCoresOriginal }),
    }
    ctx._summaryTicket?.(deriveTicketId(auto.project, key))
    const submitted = await submit({ ...ctx, request, timeoutMs: options.submitTimeoutMs })
    if (submitted.status !== 'accepted') {
      ctx.output(JSON.stringify({ stage: 'submit', ticketId: submitted.ticketId, reason: submitted.reason }))
      return { exitCode: submitted.exitCode, reason: submitted.reason, ticketId: submitted.ticketId }
    }
    ctx._summaryAccepted?.(submitted.ticketId)
    ctx.output(JSON.stringify({ ticketId: submitted.ticketId, queuePosition: await freshQueuePosition(ctx, submitted.ticketId) }))
    const result = await followAuto(ctx, submitted.ticketId, null, { ...options, root, snapshot: auto.snapshot, switchValue: auto.switchValue })
    return { ...result, ticketId: submitted.ticketId }
  }
  const codeRef = options.codeRef ?? autoCodeRef(root, options.execGit)
  if (codeRef === 'content:auto' && targetsDefaulted) {
    ctx.output(`code-ref 落入 content:auto,将对 root='${root}' 下 targets=['.'] 做全量扫描(内容指纹不排除 dist/coverage 等大目录),大仓库可能很慢;如需收窄请显式传 --targets 或 --code-ref`)
  }
  ctx._summaryTicket?.(deriveTicketId(options.project, key))
  const submitResult = await submit({ ...ctx, key, category, title: options.title, cores: options.cores, workType, targets, codeRef, root,
    machines: options.machines, exclusive: options.exclusive, parent: options.parent, engine: options.engine, submitter: options.submitter,
    // 命令头进 usageKey、--cores-strict 透传(SCHED-CORES-HISTORY-AUTOCORRECT-1010),纠正由 submit 内统一做。
    command: options.command, args: options.args, coresStrict: options.coresStrict,
    timeoutMs: options.submitTimeoutMs })
  if (submitResult.status !== 'accepted') {
    ctx.output(JSON.stringify({ stage: 'submit', ticketId: submitResult.ticketId, reason: submitResult.reason }))
    return { exitCode: submitResult.exitCode, reason: submitResult.reason, ticketId: submitResult.ticketId }
  }
  ctx._summaryAccepted?.(submitResult.ticketId)
  ctx.output(JSON.stringify({ ticketId: submitResult.ticketId, queuePosition: await freshQueuePosition(ctx, submitResult.ticketId) }))
  const runResult = await run(submitResult.ticketId, { ...ctx, root, command: options.command, args: options.args ?? [],
    beatSec: options.beatSec, timeoutMs: options.timeoutMs, receiptTimeoutMs: options.receiptTimeoutMs, ciObserver: options.ciObserver })
  return { ...runResult, ticketId: submitResult.ticketId }
}

// ---- exec 的输出层。库调用缺省 raw；收集器不参与许可、载荷、回报或撤单。 ----
function failureScanner() {
  const entries = [], seen = new Set()
  let hasFail = false, eslintFile = null
  const add = (kind, name) => {
    const key = `${kind}:${name}`
    if (name && !seen.has(key)) { seen.add(key); entries.push({ kind, name }) }
  }
  const cleanName = value => value.trim().replace(/\s+\d+(?:\.\d+)?\s*(?:ms|s)\s*$/, '')
    .replace(/\s*\[[^\]]*\]\s*$/, '').replace(/\s+\d+(?:\.\d+)?\s*(?:ms|s)\s*$/, '').trim()
  return {
    line(value) {
      const line = stripVTControlCharacters(value).replace(/\r$/, '')
      let match = /^\s*FAIL\s+(.+)$/.exec(line)
      if (match) { hasFail = true; add('fail', cleanName(match[1])); return }
      match = /^\s*[×✗]\s+(.+)$/.exec(line)
      if (match) { add('fallback', cleanName(match[1])); return }
      match = /^(.+)\((\d+),(\d+)\):\s*error TS(\d+):/.exec(line)
        ?? /^(.+):(\d+):(\d+)\s+-\s+error TS(\d+):/.exec(line)
      if (match) { add('other', `${match[1]}(${match[2]},${match[3]}) TS${match[4]}`); return }
      if (/^\s+\d+:\d+\s+error\b/.test(line) && eslintFile) add('other', eslintFile)
      if (/^\S/.test(line)) eslintFile = /^(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])/.test(line)
        || /^[^\s]+(?:[\\/][^\s]+)+$/.test(line) || /^[^\s]+\.[cm]?[jt]sx?$/.test(line) ? line.trim() : null
    },
    items() { return [...new Set(entries.filter(item => !hasFail || item.kind !== 'fallback').map(item => item.name))] },
  }
}
/** 仅识别输出；FAIL 优先于 ×/✗，不同工具的项按原出现顺序去重。 */
function extractFailureItems(text) {
  const scanner = failureScanner()
  for (const line of stripVTControlCharacters(text).split(/\r?\n/)) scanner.line(line)
  return scanner.items()
}
function execOutputMode(flags, env, isTTY) {
  if (flags.raw && flags.summary) throw new ClientError('--raw 与 --summary 不能同时指定', 2)
  if (flags.raw) return 'raw'
  if (flags.summary) return 'summary'
  const value = env.SCHED_OUTPUT
  if (value && value !== 'raw' && value !== 'summary') throw new ClientError(`SCHED_OUTPUT 只认 raw 或 summary:${value}`, 2)
  return value || (isTTY === true ? 'raw' : 'summary')
}
function createExecCollector(ctx) {
  const directory = path.resolve(ctx.env.SCHED_LOG_DIR || path.join(os.tmpdir(), 'sched-logs'))
  const began = ctx.monotonic(), notices = [], tail = [], scanner = failureScanner(), decoder = new StringDecoder('utf8')
  let pending = '', trailingEmpty = 0, id, logFile, sidecar, logError, sidecarError
  const now = Date.parse(timestamp(ctx))
  // 只删自有命名的旧文件；不递归、不跟随目录，不动其他文件。
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\d{8}-?\d{6}-tk-[a-f0-9]{20}\.(?:log|sched\.txt)$/.test(entry.name)) continue
      try {
        const file = path.join(directory, entry.name)
        if (now - fs.statSync(file).mtimeMs > 7 * 86400_000) fs.unlinkSync(file)
      } catch { /* 清理失败不得影响命令。 */ }
    }
  } catch { /* 日志目录尚不存在或不可读。 */ }
  const line = value => {
    scanner.line(value)
    if (value === '') { trailingEmpty = Math.min(30, trailingEmpty + 1); return }
    tail.push(...Array(trailingEmpty).fill(''), value); trailingEmpty = 0
    if (tail.length > 30) tail.splice(0, tail.length - 30)
  }
  const consume = text => {
    pending += text
    let end
    while ((end = pending.indexOf('\n')) >= 0) { line(pending.slice(0, end).replace(/\r$/, '')); pending = pending.slice(end + 1) }
  }
  const collector = {
    ticket(value) { id = value },
    accepted(value) {
      id = value
      const stamp = new Date(ctx.now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
      logFile = path.join(directory, `${stamp}-${id}.log`)
      sidecar = logFile.slice(0, -4) + '.sched.txt'
      try { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(logFile, Buffer.alloc(0)) }
      catch (error) { logError = error.message }
    },
    output(bytes) {
      const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
      if (logFile && !logError) try { fs.appendFileSync(logFile, chunk) } catch (error) { logError = error.message }
      consume(decoder.write(chunk))
    },
    notice(value) { notices.push(String(value)) },
    finish(result, advice = []) {
      consume(decoder.end())
      if (pending) line(pending)
      while (tail.at(-1) === '') tail.pop()
      if (notices.length && sidecar) {
        try { fs.writeFileSync(sidecar, notices.join('\n') + '\n') } catch (error) { sidecarError = error.message }
      }
      const logLabel = logFile ?? '命令没开跑,没有日志'
      const logProblem = logError ? ` · 日志写入失败:${logError}` : ''
      if (result.exitCode === 0) {
        const elapsed = Math.max(0, ctx.monotonic() - began) / 1000
        const machine = result.remote && result.machine ? ` · 机器 ${result.machine}` : ''
        const hints = notices.length && sidecar && !sidecarError ? ` · 调度提示 ${notices.length} 条见 ${sidecar}` : ''
        const sideProblem = sidecarError ? ` · 调度提示写入失败:${sidecarError}` : ''
        return `[sched] 通过 · ${ctx.title} · 用时 ${elapsed.toFixed(1)}s · 单号 ${id}${machine} · 日志 ${logLabel}${logProblem}${hints}${sideProblem}\n`
      }
      const lines = [`[sched] 未通过(退出码 ${result.exitCode}) · ${ctx.title ?? ''} · ${result.reason ?? result.result ?? '未给原因'} · 单号 ${id ?? '未挂号'} · 日志 ${logLabel}${logProblem}`]
      const failures = scanner.items()
      if (failures.length) {
        lines.push(`失败项(${failures.length} 项):`, ...failures.slice(0, 20).map(name => `  - ${name}`))
        if (failures.length > 20) lines.push(`  …另有 ${failures.length - 20} 项,见日志`)
      } else lines.push('失败项:没认出来(只认 vitest / tsc / eslint 的输出格式),看下面末尾输出')
      if (notices.length) lines.push('调度提示:', ...notices)
      if (sidecarError) lines.push(`调度提示写入失败:${sidecarError}`)
      lines.push(...advice, '末尾 30 行:', ...(tail.length ? tail.map(value => stripVTControlCharacters(value)) : ['(无)']))
      return lines.join('\n') + '\n'
    },
    id: () => id,
  }
  return collector
}

/** 输入均为已读数据；读取失败信息独立传入，不进行 I/O、不改变超时错误。 */
function timeoutAdvice(input) {
  const { ticketId: id, ticket, heartbeat, overview, sampleMs = [], waitedMs = 0,
    clientPath, share, now, readErrors = {} } = input
  const current = typeof now === 'number' ? now : Date.parse(now)
  const state = ticket?.state
  const queued = state === 'queued' || state === 'unsatisfiable'
  const active = ['granted', 'running', 'paused', 'slow'].includes(state)
  const terminal = TERMINAL_STATES.includes(state)
  const found = Array.isArray(heartbeat?.queue) ? heartbeat.queue.find(item => item?.ticketId === id) : null
  const position = Number.isSafeInteger(found?.position) && found.position >= 1 ? found.position : null
  const lines = [`单号 ${id ?? '未挂号'},已等 ${statusDuration(Math.max(0, waitedMs))}`]
  if (readErrors.ticket) lines.push(`票据:读不到(${readErrors.ticket})`)
  else if (!ticket) lines.push('派单员还没收下这张单(票据不存在)')
  else if (queued) lines.push(readErrors.heartbeat ? `排队位置:读不到(${readErrors.heartbeat})`
    : position === null ? '心跳队列里没有这张单,派单员可能还没处理到' : `排在第 ${position} 位,前面还有 ${position - 1} 张`)
  else if (active) lines.push(`已授予/已开跑(状态 ${state}),不再排队`)
  else if (terminal) lines.push(`已结束:${state}`)
  if (readErrors.heartbeat && !queued) lines.push(`心跳:读不到(${readErrors.heartbeat})`)
  const samples = sampleMs.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
  const missing = readErrors.samples ? `读不到(${readErrors.samples})`
    : readErrors.heartbeat ? `读不到(${readErrors.heartbeat})`
    : !queued ? '本单不在排队' : position === null ? '读不到排队位置'
    : samples.length < 3 ? '同类样本不足 3 单' : null
  if (missing) lines.push(`粗估还要等:估不出(${missing})`)
  else {
    const middle = Math.floor(samples.length / 2)
    const minutes = (samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2) / 60_000
    const allowed = ticket.request.allowedMachines
    const count = Math.max(1, (Array.isArray(heartbeat?.machines) ? heartbeat.machines : [])
      .filter(machine => machine?.online === true && machine.fresh === true && allowed.includes(machine.name)).length)
    const estimate = Math.ceil(minutes * Math.ceil(position / count))
    lines.push(`粗估还要等:约 ${estimate} 分钟(同类活最近 ${samples.length} 单中位用时 ${Number(minutes.toFixed(1))} 分钟,前面 ${position - 1} 张,可派机器 ${count} 台)`)
  }
  const summary = readErrors.overview ? `读不到(${readErrors.overview})` : overview?.summary ?? '读不到(没有状态总览)'
  lines.push(`为什么还没派:${summary}`)
  const age = current - Date.parse(heartbeat?.at)
  if (Number.isFinite(age) && age > 120_000) lines.push(`下一步:调度台派单员心跳已 ${statusDuration(age)} 没动,先按 docs/调度台救活.md 救活,别撤单重挂`)
  else if (state === 'unsatisfiable' && !readErrors.overview && /等多久也|这个要查/.test(summary))
    lines.push(`下一步:撤单:node ${clientPath} cancel ${id} --share ${share}(原因:${summary})`)
  else if (terminal) lines.push(`下一步:不用等了,看结果:node ${clientPath} status ${id} --share ${share}`)
  else lines.push(`下一步:继续等:node ${clientPath} wait ${id ?? '未挂号'} --until finished --share ${share}`)
  return lines
}
/** 只读最近修改的最多 200 份票据，预算 2 秒；runningMs+slowMs 不按核数换算，单测同口径。 */
function timeoutSamples(ctx, ticket) {
  if (!ticket) return []
  const began = performance.now(), directory = paths(ctx.share).tickets, candidates = [], samples = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (performance.now() - began >= 2000) break
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = path.join(directory, entry.name)
    candidates.push({ file, mtime: fs.statSync(file).mtimeMs })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  for (const { file } of candidates.slice(0, 200)) {
    if (performance.now() - began >= 2000) break
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (value.state !== 'passed' || value.request?.project !== ticket.request.project || value.request?.work?.type !== ticket.request.work.type) continue
    const attempt = Array.isArray(value.attempts) ? [...value.attempts].reverse().find(item => item.result?.outcome === 'passed') : null
    const running = attempt?.timing?.runningMs, slow = attempt?.timing?.slowMs
    if (Number.isSafeInteger(running) && running >= 0 && Number.isSafeInteger(slow) && slow >= 0 && running + slow > 0) samples.push(running + slow)
  }
  return samples
}
function readTimeoutAdvice(ctx, id, waitedMs) {
  const errors = {}
  const safely = (key, read) => { try { return read() } catch (error) { errors[key] = error.message; return null } }
  const ticket = id ? safely('ticket', () => readTicket(ctx, id)) : null
  const heartbeat = safely('heartbeat', () => readJson(path.join(paths(ctx.share).root, '_control', 'dispatcher-heartbeat.json')))
  // 直接调用现成 status 总览，不复制 statusSummary/statusHead 的判断口径。
  const overview = safely('overview', () => status(undefined, ctx))
  const sampleMs = safely('samples', () => timeoutSamples(ctx, ticket)) ?? []
  return timeoutAdvice({ ticketId: id, ticket, heartbeat, overview, sampleMs, waitedMs,
    clientPath: __filename, share: ctx.share, now: Date.parse(timestamp(ctx)), readErrors: errors })
}
async function exec(options) {
  const mode = options.outputMode ?? 'raw'
  if (mode !== 'raw' && mode !== 'summary') throw new ClientError('outputMode 只认 raw 或 summary', 2)
  if (mode === 'raw') return execUnformatted(options)
  const ctx = runtime(options, false), began = ctx.monotonic(), collector = createExecCollector(ctx)
  const captured = { ...options, output: collector.notice, notice: collector.notice, remoteOutput: collector.output,
    _summaryOutput: collector.output, _summaryTicket: collector.ticket, _summaryAccepted: collector.accepted }
  let result, advice = []
  try { result = await execUnformatted(captured) }
  catch (error) {
    result = { exitCode: error.exitCode ?? (IO_CONTENTION_CODES.includes(error.code) ? 3 : 2), reason: error.message,
      ...(collector.id() ? { ticketId: collector.id() } : {}) }
    if (error.message === '等待超时' && error.exitCode === 4) {
      try { advice = readTimeoutAdvice(ctx, collector.id(), ctx.monotonic() - began) }
      catch (failure) { advice = [`超时提示:读不到(${failure.message})`] }
    }
  }
  if (result.suggestion) collector.notice(result.suggestion)
  process.stdout.write(collector.finish(result, advice))
  return result
}

// ---- 主机本地状态：既不碰共享盘锁，也不消耗调度台账。 ----
function processGone(pid, probe = process.kill) {
  try { probe(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
}
/** 配置可在孙进程或 Stryker 的兄弟 worker 中加载；复用必须有 OS 祖先证据。 */
function permitAncestors() {
  // CI 满载时允许 OS 多花时间给出真实祖先链；查不到仍按“不属于原消费者”拒绝，绝不凭环境变量放行。
  const timeoutMs = process.env.GITHUB_ACTIONS === 'true' ? 15_000 : 3000
  const rows = process.platform === 'win32'
    ? JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }))
      .map(row => ({ pid: row.ProcessId, ppid: row.ParentProcessId, command: row.CommandLine ?? '' }))
    : execFileSync('ps', ['-ww', '-eo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
      .split('\n').flatMap(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []
      })
  const byPid = new Map(rows.map(row => [row.pid, row])), seen = new Set([process.pid]), result = []
  let parent = process.ppid
  while (parent && !seen.has(parent) && result.length < 128) {
    seen.add(parent)
    const row = byPid.get(parent)
    if (!row) break
    result.push(row); parent = row.ppid
  }
  return result
}
/** 只把底层 I/O 故障标成不可用；假票据/坏快照依然是校验拒绝。 */
function permitIoUnavailable(error) {
  const seen = new Set()
  while (error && !seen.has(error)) {
    seen.add(error)
    if (IO_CONTENTION_CODES.includes(error.code)) return true
    error = error.cause
  }
  return false
}
/** 默认检查新开跑；存续复核须显式选择 revalidate。首个顶层消费者以 wx 登记，记录不转让。 */
function validatePermit(options) {
  try {
    const purpose = options.purpose === undefined ? 'start' : options.purpose
    if (purpose !== 'start' && purpose !== 'revalidate') return { ok: false, reason: '许可校验用途不合法' }
    const ctx = runtime(options), encoded = ctx.env.SCHED_PERMIT
    if (typeof encoded !== 'string') return { ok: false, reason: '缺少许可' }
    const match = /^(tk-[0-9a-f]{20}):(a[1-9]\d*):(.+)$/.exec(encoded)
    if (!match) return { ok: false, reason: '伪造许可:格式不合法' }
    const [, id, attempt, token] = match
    const ticket = readTicket(ctx, id)
    if (!ticket || ticket.currentAttemptId !== attempt || TERMINAL_STATES.includes(ticket.state)) return { ok: false, reason: '许可过期:执行已结束或不是当前执行' }
    if (ticket.cancelRequested) return { ok: false, reason: '许可已撤销:已请求撤单' }
    const permit = activeAttempt(ticket)?.permit
    if (!permit || permit.ticketId !== id || permit.attemptId !== attempt || permit.token !== token) return { ok: false, reason: '伪造许可:令牌不符' }
    // 暂停/低速仍持有同一份许可；恢复瞬间共享快照可能尚未赶上，不能误拒被恢复的消费者。
    // 这只适用于已运行消费者的复核；T5 新开跑入口保持 running 才放行，不能借暂停许可开新重活。
    const executable = purpose === 'revalidate' ? ['running', 'paused', 'slow'].includes(ticket.state) : ticket.state === 'running'
    // 0914 改口径:paused 有界重探——拒绝时把票据状态原样带回(两种 purpose 都带),入口闸据此
    // 对 start 用途做有界重探;客户端自己不睡眠、不等待。
    if (!executable) return { ok: false, reason: '许可当前不在执行状态', state: ticket.state }
    if (permit.machine !== os.hostname()) return { ok: false, reason: '许可机器不符' }
    // T6b 挂号的是整组验收；单测子项必须核验该组许可，不能把它误当作另一张 unit-test 单。
    const acceptance = options.acceptanceGroup === true && options.category === 'unit-test' && ticket.request.category === 'codex-acceptance'
    const category = acceptance ? 'codex-acceptance' : options.category
    if (permit.category !== category || ticket.request.category !== category) return { ok: false, reason: '许可类别不符' }
    if (acceptance ? ticket.request.work.type !== 'acceptance' : options.workTypes && !options.workTypes.includes(ticket.request.work.type)) return { ok: false, reason: '许可作业类型不符' }
    integer(options.cores, 1)
    if (!Number.isSafeInteger(permit.grantedCores) || permit.grantedCores < options.cores) return { ok: false, reason: '许可核数不够' }
    if (ctx.env.SCHED_GRANTED_CORES !== undefined && (!/^\d+$/.test(ctx.env.SCHED_GRANTED_CORES)
      || Number(ctx.env.SCHED_GRANTED_CORES) < 1 || Number(ctx.env.SCHED_GRANTED_CORES) > permit.grantedCores)) return { ok: false, reason: '许可核数环境与授予不符' }
    // SCHED-REFUSAL-MESSAGE-ACCURACY:OS 进程表查询(powershell/ps)失败必须在源头单独标注——它的
    // 错误码(ETIMEDOUT/ENOENT/EACCES…)与共享盘竞争码重叠,漏到最外层 catch 会被 permitIoUnavailable
    // 误读成「共享盘 I/O 不可用」,入口闸跟着误报「调度台不可用」,指引人去救一个没坏的调度台
    // (MR1 施工记录第六节第 7 条)。查询失败记下原因并按空链处理:消费者归属照旧拒绝(绝不放行),
    // 只是拒绝原因换成真实的一条并带 osProbeUnavailable,供入口闸与调用方分辨。
    let ancestors, ancestryFailure
    const ancestry = () => {
      if (ancestors === undefined && ancestryFailure === undefined) {
        try { ancestors = permitAncestors() } catch (error) { ancestryFailure = error; ancestors = [] }
      }
      return ancestors
    }
    const osProbeRefusal = () => ({ ok: false, reason: `本机查进程表失败，无法核验许可消费者归属:${ancestryFailure.message}`, osProbeUnavailable: true })
    // run 的 started 回报固定包装器 PID + 出生身份。原生宿主可插在中间，但每一跳都必须
    // 核对创建时间且最终到达原包装器；同组兄弟项仍只消费一次，登记归属共同 _acceptance 根。
    const controller = activeAttempt(ticket).controller
    let group
    if (acceptance) {
      const rejected = { ok: false, reason: '整组许可不属于当前验收执行树' }
      if (controller?.machine !== os.hostname()) return rejected
      // 旧包装端的兼容过渡已随 SCHED-PERMIT-LEGACY-COMPAT-SUNSET 落日下线：出生身份三字段
      // 全缺的记录先于任何操作系统祖先链查询明确拒绝并留痕，不再退回旧契约（只核进程号）。
      // 只要任一字段存在，哪怕是空值、坏身份或残留新版核验端，都不是旧记录，不能在新判据
      // 失败后降级——必须走新判据的严格路径，由 birth() 的格式校验拒绝。
      if (!Object.hasOwn(controller, 'creationFileTime') && !Object.hasOwn(controller, 'createdAt')
        && !Object.hasOwn(controller, 'verifier')) {
        console.warn(`【统一调度】许可记录缺出生身份，旧包装端记录已停止兼容（SCHED-PERMIT-LEGACY-COMPAT-SUNSET）：${id}/${attempt}，包装器 ${controller.pid}。`)
        return { ok: false, reason: '许可记录缺出生身份，旧包装端记录已停止兼容' }
      }
      try {
        ancestors = createSuspendRuntime().acceptancePermitAncestors(controller)
        // 允许原生宿主居中，但整链已核对出生身份并止于包装器。
        group = ancestors.find(row => row.pid !== controller.pid
          && /[\\/]scripts[\\/]codex[\\/]codex-dispatch\.ts["']?\s+["']?_acceptance(?:["'\s]|$)/i.test(row.command))
      } catch {
        // OS 身份不可读是归属拒绝，不能冒充共享盘 I/O 不可用而触发 T5 的入口容错放行。
        return rejected
      }
      if (!group) return rejected
    }
    // 变异运行器在 CLI 的多个子进程内初始化 Vitest；消费属于那一个真实 CLI 执行树。
    const stryker = options.consumerRoot === 'stryker'
      ? ancestry().find(row => /[\\/]@stryker-mutator[\\/]core[\\/]bin[\\/]stryker(?:\.js)?(?:["'\s]|$)/i.test(row.command)) : undefined
    // 查进程表失败时归属核不出来:按真实原因拒,绝不冒充共享盘 I/O 故障,也绝不放行。
    if (ancestryFailure) return osProbeRefusal()
    const pid = group?.pid ?? stryker?.pid ?? process.pid, ppid = process.ppid
    const directory = options.consumerDir ?? path.join(os.tmpdir(), 'sched-permit-consumers')
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, `${contentHash([ctx.share, id, attempt, token])}.json`)
    try { fs.writeFileSync(file, canonicalJson({ pid }), { flag: 'wx' }) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const recorded = JSON.parse(fs.readFileSync(file, 'utf8'))
      fields(recorded, { pid: v => { integer(v, 1) } })
      // 归属只认「活着的祖先」：记录进程已退出就不是任何人的祖先，先按死活短路（也省掉整表 OS
      // 查询）。整条判据不依赖 OS 查询能否成功——原先表达式里直接调 ancestry()，查询一超时/被拒
      // 就把校验炸到最外层 catch，既丢了归属拒绝文案，又带上 unavailable 冒充共享盘故障触发入口
      // 容错放行（施工单 TEST-SCHED-PERMIT-V05-FLAKY-UNDER-LOAD）。SCHED-REFUSAL-MESSAGE-ACCURACY
      // 起 ancestry() 不再抛:查询失败在源头记为 ancestryFailure,这里按真实原因单独拒(osProbeRefusal),
      // 其余照旧按「不是我们的祖先」处理。
      if (recorded.pid !== pid && recorded.pid !== ppid) {
        let owners = []
        if (!processGone(recorded.pid, ctx.probe)) owners = ancestry()
        if (ancestryFailure) return osProbeRefusal()
        if (!owners.some(row => row.pid === recorded.pid)) return { ok: false, reason: '许可已被另一个进程使用' }
      }
    }
    return { ok: true, permit }
  } catch (error) {
    return { ok: false, reason: `许可校验拒绝:${error.message}`, ...(permitIoUnavailable(error) ? { unavailable: true } : {}) }
  }
}

/** 锁竞争热路径的「这一轮没抢到」判定:整组竞争性 I/O 错误码,外加 Windows「我在读他在删」
 * 特有的 EBUSY(与 sched-daemon.ts 的 IO_ERRORS 同口径)。EBUSY 只加在这条判定上,不并入
 * IO_CONTENTION_CODES——那份集合还决定 validatePermit 的 unavailable 分类与 CLI 退出码 3,扩了等于改它们的口径。
 * 竞争失败≠持有者死了:回收判据(持有者进程已死或锁龄超十秒)与这里无关,一个字不动。 */
function isLockContentionError(error) {
  return error != null && (IO_CONTENTION_CODES.includes(error.code) || error.code === 'EBUSY')
}
/** 抢池锁:wx 建锁;撞 EEXIST 说明别人持有,转读锁文件判锁龄与持有者死活。八个进程并发抢同一把锁时,
 * 「我在读、他在删」撞上在 Windows 抛 EPERM/EBUSY 而非 ENOENT(SCHED-SMALLPOOL-EPERM,0915 CI 铁证),
 * 这条热路径上五处文件操作原先只放行 ENOENT、其余抛穿 acquireSmallJob 把子进程打死;现统一按
 * isLockContentionError 放行,五处语义各不相同——判锁龄读=这一轮没抢到交给外层重试;回收复核读/删=
 * 回收没做成,跳过不影响正确性;owned()=读不到宁可认为自己丢了锁;令牌遍历读=跳过该令牌;
 * 第五处=第一步 wx 建锁本身:一个进程刚删掉锁文件、另一个恰好 wx 新建同名文件,Windows 的
 * 「删除挂起」窗口里新建报 EPERM(有时 EBUSY)而非 EEXIST(0915/0924 CI 铁证,卡 SCHED-SMALLPOOL-WX-LOCK-EPERM),
 * 语义同样是这一轮没抢到,返回 null 交 acquireSmallJob 外层按既有 500ms 间隔与总时限重试,不新加重试循环。
 * 五处里只有这一步改变了对外行为;EEXIST 分支与回收判据(持有者进程已死或锁龄超十秒)一个字未改。 */
function claimPoolLock(ctx, directory) {
  const file = path.join(directory, 'pool.lock'), at = timestamp(ctx)
  const lock = { pid: process.pid, at, token: ctx.nonce() }
  const encoded = canonicalJson(lock)
  try { fs.writeFileSync(file, encoded, { flag: 'wx' }) } catch (error) {
    // EEXIST=锁在别人手里,照旧进判锁龄/回收;其余竞争性错误=这一轮没抢到,返回 null 交外层重试;都不是才抛。
    if (error.code !== 'EEXIST') { if (isLockContentionError(error)) return null; throw error }
    let raw, stat
    try { stat = fs.statSync(file); raw = fs.readFileSync(file, 'utf8') } catch (readError) { if (isLockContentionError(readError)) return null; throw readError }
    let holder
    try { holder = JSON.parse(raw) } catch { /* wx 创建者可能尚未写完；只允许按十秒锁龄回收。 */ }
    const age = Date.parse(at) - (holder?.at && Number.isFinite(Date.parse(holder.at)) ? Date.parse(holder.at) : stat.mtimeMs)
    if ((Number.isSafeInteger(holder?.pid) && holder.pid > 0 && processGone(holder.pid, ctx.probe)) || age > 10_000) {
      try { if (fs.readFileSync(file, 'utf8') === raw) fs.unlinkSync(file) } catch (removeError) { if (!isLockContentionError(removeError)) throw removeError }
    }
    return null
  }
  const owned = () => {
    try { return fs.readFileSync(file, 'utf8') === encoded && Date.parse(timestamp(ctx)) - Date.parse(at) <= 10_000 } catch (error) { if (isLockContentionError(error)) return false; throw error }
  }
  return { owned, release: () => { if (owned()) unlinkIfPresent(file) } }
}
/** 锁内完成清死令牌、求和、登记。每 500ms 等待，总时限包含等待锁；release 幂等且退出自动释放。 */
async function acquireSmallJob(options) {
  const ctx = runtime(options, false), cores = integer(options.cores, 1), timeoutMs = options.timeoutMs ?? 60_000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new ClientError('小活池等待时间不合法')
  const directory = options.poolDir ?? path.join(os.tmpdir(), 'sched-small-job-pool'), tokenDir = path.join(directory, 'tokens')
  fs.mkdirSync(tokenDir, { recursive: true })
  const began = ctx.monotonic()
  let used = 0
  for (;;) {
    const lock = claimPoolLock(ctx, directory)
    if (lock) {
      try {
        used = 0
        for (const name of fs.readdirSync(tokenDir)) {
          if (!name.endsWith('.json')) throw new Error('小活池含非法令牌文件')
          const file = path.join(tokenDir, name)
          let token
          try { token = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { if (isLockContentionError(error)) continue; throw error }
          fields(token, { pid: value => { integer(value, 1) }, cores: value => { integer(value, 1) }, at: isoTime })
          if (processGone(token.pid, ctx.probe)) { unlinkIfPresent(file); continue }
          used += token.cores
        }
        if (used + cores <= HOST_SMALL_JOB_POOL_CORES && lock.owned()) {
          const file = path.join(tokenDir, `${segment(ctx.nonce())}.json`)
          fs.writeFileSync(file, canonicalJson({ pid: process.pid, cores, at: timestamp(ctx) }), { flag: 'wx' })
          if (!lock.owned()) { unlinkIfPresent(file); throw new Error('小活池文件锁已失效') }
          let released = false
          const release = () => { if (!released) { unlinkIfPresent(file); released = true; process.removeListener('exit', onExit) } }
          const onExit = () => { try { release() } catch (error) { console.error(`释放小活池失败:${error.message}`) } }
          process.once('exit', onExit)
          return { ok: true, release }
        }
      } finally { lock.release() }
    }
    if (ctx.monotonic() - began >= timeoutMs) return { ok: false, reason: `主机小活池已满(已用 ${used} / 4 核),请改走排队:node sched.cjs submit ...` }
    await ctx.sleep(Math.min(500, Math.max(0, timeoutMs - (ctx.monotonic() - began))))
  }
}

const USAGE = `用法: node sched.cjs <子命令> [--share ROOT]
submit --project P --key K --category C --title T --cores N --work-type W --targets a,b --code-ref commit:40位|content:auto [--local|--machines 本机名] [--exclusive screen,word-com] [--parent 单号] [--engine 施工方标识] [--cores-strict]
wait <ticketId> [--until granted|finished] [--timeout 秒]
run <ticketId> [--beat-sec 10] [--receipt-timeout 30] -- <命令> [参数...]
exec --project P --cores N --title T [--share ROOT] [--category C] [--work-type W] [--targets a,b] [--code-ref commit:40位|content:auto] [--key K] [--root 目录] [--pin|--local] [--cores-strict] [--raw|--summary] -- <命令> [参数...]
hold --project P --cores N --title T [--share ROOT] [--category C] [--work-type W] [--targets a,b] [--code-ref commit:40位|content:auto] [--key K] [--root 目录] [--beat-sec 30] [--cores-strict] -- <常驻服务命令> [参数...]
cancel <ticketId> [--reason 文本]
finish <ticketId> --result passed|failed [--reason 文本]
status [ticketId]
通用: --share 或 SCHED_SHARE; --root 内容根目录(默认当前目录); --receipt-timeout 秒(默认30)。
退出码: submit/cancel/finish 0=受理或执行,2=拒绝,3=共享盘不可读或格式过高,4=回执超时。
wait 0=已授予或通过,1=失败,5=撤单或作废,4=超时,3=读取失败。
run 默认返回子进程退出码;2=开跑被拒,3=共享盘故障,4=回执超时,5=撤单,6=内容漂移,1=包装中断或命令没能启动(已报结束 failed)。
exec 一步完成 submit→打印单号与排队位置→run;退出码透传被执行命令的退出码,挂号被拒或命令预检
(Windows 上按 PATH+PATHEXT 静态解析 argv[0],找不到或是未经 cmd /c 包装的 .cmd/.bat 都拒绝并给改写建议)
失败时都非零退出并打印原因;预检失败不占用排队。缺省 key/code-ref/category/work-type/targets 见文档。
可搬开关打开且项目、菜单与快照判据全部满足时,exec 自动选最早能跑完的机器;--pin 或 --local 强制留本机。
hold 长期占用单:挂号当拍即授予(不排队)、按核数计入该机已授予核数,别的活会自动绕开;
只许本机单、恰好一台机器(缺省本机 hostname)。包装进程活着时每 --beat-sec 秒(默认30)刷新一次续约凭据,
常驻服务退出即撤单释放;包装进程被杀时续约一断,派单员超时自动销单(默认 120 秒)并释放核数。
hold 退出码:透传常驻服务退出码;1=包装中断、命令没能启动或授予后没能跑稳(均已撤单释放),2=挂号被拒,3=共享盘故障。
status 0=成功,2=参数或单号错误,3=读取失败。Windows .cmd/.bat 请显式写 cmd /c。
exec 输出:--raw 原样、--summary 摘要(互斥，仅 exec 接受)；旗标优先，其次 SCHED_OUTPUT=raw|summary。
缺省 stdout 是终端时原样，非终端时摘要；库 exec 缺省原样。摘要成功只有一行结论，失败列出
vitest/tsc/eslint 失败项(最多20项)和末尾30行；完整字节日志在 SCHED_LOG_DIR(缺省系统临时目录/sched-logs)，
调度提示另存同名 .sched.txt，超过7天的自有日志尽力清理；写日志失败不改变退出码。
成功格式:[sched] 通过 · 标题 · 用时 0.0s · 单号 tk-…[ · 机器 执行机(仅跨机)] · 日志 绝对路径[ · 调度提示 N 条见 边车路径]
失败格式:[sched] 未通过(退出码 N) · 标题 · 原因 · 单号 tk-…或未挂号 · 日志 路径或没有日志；随后失败项、调度提示、末尾30行。
wait 超时、摘要 exec 超时另给排队名次、同类通过单粗估等待和下一步；raw exec 一字不追加。
经 Git Bash 下发要加 MSYS_NO_PATHCONV=1，防止 /c 被路径改写；客户端不检测这种改写。
--cores-strict:submit/exec/hold 共用的布尔旗标;总开关 hub.json 的 coresHistoryCorrect 打开且共享盘带
usage-history-v1 能力位时,挂号会按同类活(sched/_stats/cores-usage.json 里同键最近 10 单实测)把「申请超过
90 分位 2 倍且多出 ≥2 核」的申请核数自动改小为 ceil(90分位)+1 并打提醒行;加 --cores-strict 保留原申请
(只记统计键不纠正),开关关或能力位缺时原申请放行、一个字不打。`
function parseArgs(argv) {
  const separator = argv.indexOf('--')
  const commandArgs = separator >= 0 ? argv.slice(separator + 1) : []
  const tokens = separator >= 0 ? argv.slice(0, separator) : argv
  const flags = {}, positionals = []
  const names = ['share', 'project', 'key', 'category', 'title', 'cores', 'work-type', 'targets', 'code-ref', 'machines', 'exclusive', 'parent', 'until', 'timeout', 'beat-sec', 'reason', 'result', 'receipt-timeout', 'root', 'submitter', 'engine']
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token.startsWith('--')) { positionals.push(token); continue }
    const name = token.slice(2)
    if (name === 'local' || name === 'help' || name === 'pin' || name === 'cores-strict'
      || name === 'raw' || name === 'summary') { if (flags[name]) throw new ClientError(`未知或重复参数:${token}`); flags[name] = true; continue }
    if (!names.includes(name) || flags[name] !== undefined) throw new ClientError(`未知或重复参数:${token}`)
    const value = tokens[++index]
    if (!value || value.startsWith('--')) throw new ClientError(`缺少参数:${token}`)
    flags[name] = value
  }
  return { flags, positionals, commandArgs }
}
// 观察器端口仅供调用方显式传参；命令行解析与环境均不提供跳过 CI 的开关。
async function main(argv = process.argv.slice(2), { ciObserver } = {}) {
  let waitContext, waitId
  const waitBegan = performance.now()
  try {
    const { flags: f, positionals: p, commandArgs } = parseArgs(argv)
    if (f.help || !p.length) { console.log(USAGE); return 0 }
    if (f.pin && p[0] !== 'exec') throw new ClientError('未知或重复参数:--pin')
    if (p[0] !== 'exec' && (f.raw || f.summary)) throw new ClientError(`未知或重复参数:--${f.raw ? 'raw' : 'summary'}`)
    const outputMode = p[0] === 'exec' ? execOutputMode(f, process.env, process.stdout.isTTY) : undefined
    const opts = { share: f.share, root: f.root, submitter: f.submitter }
    if (f.timeout !== undefined) opts.timeoutMs = Number(f.timeout) * 1000
    if (f['receipt-timeout'] !== undefined) opts.receiptTimeoutMs = Number(f['receipt-timeout']) * 1000
    let result
    if (p[0] === 'submit') {
      if (f.local && f.machines) throw new ClientError('--local 与 --machines 不能同时指定')
      if (p.length !== 1) throw new ClientError('submit 不接受位置参数')
      result = await submit({ ...opts, project: f.project, key: f.key, category: f.category, title: f.title, cores: Number(f.cores),
        workType: f['work-type'], targets: f.targets?.split(','), codeRef: f['code-ref'], machines: f.machines?.split(','),
        exclusive: f.exclusive?.split(','), parent: f.parent, engine: f.engine,
        coresStrict: f['cores-strict'] === true,
        timeoutMs: opts.receiptTimeoutMs ?? opts.timeoutMs })
    } else if (p[0] === 'wait' && p.length === 2) {
      waitContext = runtime(opts, false); waitId = p[1]
      result = await waitFor(p[1], { ...opts, until: f.until })
    }
    else if (p[0] === 'run' && p.length === 2 && commandArgs.length) result = await run(p[1], { ...opts,
      ...(ciObserver === undefined ? {} : { ciObserver }),
      command: commandArgs[0], args: commandArgs.slice(1), beatSec: f['beat-sec'] === undefined ? 10 : Number(f['beat-sec']) })
    else if (p[0] === 'exec' && p.length === 1 && commandArgs.length) result = await exec({ ...opts, outputMode,
      ...(ciObserver === undefined ? {} : { ciObserver }),
      project: f.project, key: f.key, category: f.category, title: f.title, cores: Number(f.cores),
      workType: f['work-type'], targets: f.targets?.split(','), codeRef: f['code-ref'], machines: f.machines?.split(','),
      exclusive: f.exclusive?.split(','), parent: f.parent, engine: f.engine,
      pin: f.pin, local: f.local, coresStrict: f['cores-strict'] === true,
      command: commandArgs[0], args: commandArgs.slice(1), beatSec: f['beat-sec'] === undefined ? 10 : Number(f['beat-sec']) })
    else if (p[0] === 'hold' && p.length === 1 && commandArgs.length) result = await hold({ ...opts,
      project: f.project, key: f.key, category: f.category, title: f.title, cores: Number(f.cores),
      workType: f['work-type'], targets: f.targets?.split(','), codeRef: f['code-ref'],
      parent: f.parent, engine: f.engine, coresStrict: f['cores-strict'] === true,
      command: commandArgs[0], args: commandArgs.slice(1),
      // 缺省由 hold 自己取 30 秒(与 sched-contract 的说明一致);这里只透传显式给的。
      ...(f['beat-sec'] === undefined ? {} : { beatSec: Number(f['beat-sec']) }) })
    else if (p[0] === 'cancel' && p.length === 2) result = await cancel(p[1], { ...opts, reason: f.reason, timeoutMs: opts.receiptTimeoutMs ?? opts.timeoutMs })
    else if (p[0] === 'finish' && p.length === 2) {
      if (f.result !== 'passed' && f.result !== 'failed') throw new ClientError('finish 必须用 --result 指定 passed 或 failed')
      result = await finish(p[1], { ...opts, result: f.result, reason: f.reason, timeoutMs: opts.receiptTimeoutMs ?? opts.timeoutMs })
    }
    else if (p[0] === 'status' && p.length <= 2) result = { ...status(p[1], opts), exitCode: 0 }
    else throw new ClientError(`子命令或参数错误\n${USAGE}`)
    if (p[0] !== 'wait' && outputMode !== 'summary') { const body = { ...result }; delete body.exitCode; console.log(JSON.stringify(body)) }
    return result.exitCode
  } catch (error) {
    console.error(error.message)
    if (waitContext && error.message === '等待超时' && error.exitCode === 4) {
      try { for (const line of readTimeoutAdvice(waitContext, waitId, performance.now() - waitBegan)) console.error(line) }
      catch (failure) { console.error(`超时提示:读不到(${failure.message})`) }
    }
    return error.exitCode ?? (IO_CONTENTION_CODES.includes(error.code) ? 3 : 2)
  }
}
module.exports = { CLIENT_VERSION, SCHED_FORMAT_VERSION, HOST_SMALL_JOB_POOL_CORES, SAFE_SEGMENT,
  RENAME_RETRY_DELAYS_MS, renameWithRetry, BEAT_FAILURE_TOLERANCE_MS,
  canonicalJson, contentHash, rawContentHash, deriveTicketId, validateSubmission, validateCommand, validateReport, assertWritableFormat,
  submit, waitFor, run, hold, cancel, finish, status, validatePermit, acquireSmallJob, contentFingerprint, ClientError, main, USAGE,
  autoIdempotencyKey, autoCodeRef, resolveWindowsExecutable, queuePosition, awaitQueuePosition, QUEUE_POSITION_FRESH_WAIT_MS,
  exec, extractFailureItems, timeoutAdvice,
  // 长期占用单(SCHED-MR5-RESIDENT-LEASE-0924):续约凭据路径/内容/写入分开导出,
  // 看板与用例都要按同一份判据读它,不能在别处再拼一条路径或另造一个字段集。
  residentLeaseFile, residentLeaseRecord, writeResidentLease,
  // SCHED-RUN-ARG-QUOTING-CMD / SCHED-TEST-CATEGORY-MISMATCH-FAILFAST 新增的注册面纯函数:
  TEST_LIKE_WORK_TYPES, assertCategoryMatchesWorkType, cmdTargetPath, managedExecutionArgs, vitestSubcommand,
  REASON_TEXT, CLIENT_INFRA_SOURCE_PREFIXES, trunkHeadFile, remoteLogPath, remoteExitCode,
  writeCancelCommand, extractArtifactZip, ensureInfoExclude,
  // 挂号端等待心跳(SCHED-QUEUED-ORPHAN-LIVENESS-1009):路径与常量导出,用例与看板按同一份判据读。
  WAITING_BEAT_INTERVAL_MS, WAITING_ABANDONED_REASON, GRANTED_WAITING_ABANDONED_REASON, waitingBeatFile,
  // 按同类活历史实测自动改小申请核数(SCHED-CORES-HISTORY-AUTOCORRECT-1010):纯函数与读数导出,
  // 同一张表驱动用例拿它和派单员侧 sched-usage-history.ts 逐项对一致(照 overuseCheck 先例)。
  usageKeyFor, nearestRankP90, formatCores, suggestCores, readUsagePeaks }
if (require.main === module) main().then(code => { process.exitCode = code })

