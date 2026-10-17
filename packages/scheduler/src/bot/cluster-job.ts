import deployment from '../sched/client/deployment-config.cjs'
/**
 * cluster-job —— 集群工单的**唯一口径**:长什么样、合不合法、该跑什么命令
 * (CLUSTER-DISPATCH-TESTS-UNSUPPORTED,2026-07-30)。
 *
 * 【这个文件为什么存在】集群初版只会派一种活:跑分。派活入口是 `--round <轮次>`,拆活单位是「局」,
 * 执行方写死 spawn `calib-run.ts <round>`,领单处还硬校验 round+shard 缺一就把工单挪进 failed。
 * 于是全量单测 / typecheck / lint 这些**同样吃满 CPU** 的活,一台副机也派不出去,只能留主机跑;
 * 而主机兼着自托管 CI runner,**CI 绿是合并四闸门之一** ⇒ 每跑一次全量就把 CI 堵一次,
 * 那段时间全项目所有卡的合并一起排队,副机 12 核干看着帮不上忙。
 *
 * 【为什么抽成独立文件而不是各自实现】派活方(cluster-dispatch)和执行方(cluster-agent)
 * 必须对「工单合法性」用**同一份判据**。两侧各写一套的后果已经实测过:初版领单处硬要求 round+shard,
 * 加通用作业时忘记同步 ⇒ 每张 test/lint 工单一进来就被判「字段不全」丢进 failed,
 * 而派活方那边显示「已投递」——**不报错、只是活永远不干**,是这套设施里最难归因的一类故障。
 * 一处判据,两处引用。
 *
 * 【安全口径:点菜,不许自带命令行】工单文件躺在共享盘上,就是个普通 json ⇒
 * **谁能写盘,谁就能让无人值守的副机执行东西**。故命令模板由本文件定义,工单只能点作业名 +
 * 填受限参数。曾设计过「工单带完整 argv + 可执行文件白名单(npm/npx/node)」并已否决:
 * 那道白名单挡不住 `node -e <任意代码>` 和 `npx <任意包>`,等于没挡。
 */
import { join, win32 } from 'node:path'
import {
  LIFECYCLE_NAMESPACE,
  LIFECYCLE_SCHEMA,
  lifecyclePayloadSha256,
} from './cluster-lifecycle'
import { RERUN_WORK_TYPES } from '../sched/sched-rerun'

/** 补跑选择的一个条目(d3):用例身份三元组 + CRLF 归一后的源内容指纹(64 位小写十六进制)。 */
export interface ClusterRerunCase {
  identity: { file: string; titlePath: string[]; instanceIndex: number }
  sourceSha256: string
}

/** 出现即 auto 单；属于 protocol 12 payload 并参与哈希，命令由执行端按本机菜单还原。 */
export interface ClusterAutoJob {
  project: string; item: string; args: string[]; bundle: string; commit: string; base: string
}
export const AUTO_JOB_ARGS_MAX = 64
export const AUTO_JOB_ARG_MAX_LENGTH = 200

/** 工单结构(派活方 cluster-dispatch 写,cluster-agent 读)。 */
export interface ClusterJob {
  /** 出现即 auto 单；resolveCommand 不读取此字段。 */
  auto?: ClusterAutoJob
  /** 统一调度来源；只供开跑前撤单复核，旧工单缺省兼容。 */
  ticketId?: string
  /** 产物与日志都按它命名。 */
  jobId?: string
  /** 作业名(JOB_TYPES 的键)。**缺省 'calib'** —— 只带 round 的老工单零改动继续跑。 */
  kind?: string
  /** 跑分专用:calib-run.ts 的轮次名。 */
  round?: string
  /** 跑分专用:`<i>/<n>`,本机在本批里的片号。 */
  shard?: string
  /** 显式并行上限，优先于授予核数与机器配额；缺省只为 quotaInject 工具自动注入。 */
  workers?: number
  /** 当前调度许可的正整数核数；属于 protocol 12 payload，缺省兼容非调度来源的旧工单。 */
  grantedCores?: number
  /**
   * 【CI 共存标 · UDQ-T4B-2b】授予时该机 CI 正在跑、按车道余量派出来的调度工单才带
   * (sched-cluster-job 从许可透传)。带标 = 代理领单口不因 CI 拒领、执行侧开跑即整树
   * 最低优先级且不因 CI 冻(manual/owner-hold 照旧);只认字面 true,其余值判非法。
   * 旧工单不带 ⇒ 一切行为逐字不变。与 lifecycleActivation 同族:只进取证/领单,
   * `resolveCommand` 不读它,不影响「到底跑什么命令」。
   */
  ciAware?: true
  /** 测试类作业的目标(仓库相对路径 / glob,多个用空白分隔);不给=该作业的缺省范围。 */
  target?: string
  /**
   * 【补跑选择 · UDQ-T4B d3】只随 test/test:fast/test:coverage 下发(sched-cluster-job 从票据
   * 时间线的 requeued.rerun 透传)。带它时 target 不生效:resolveCommand 把跑测目标换成
   * 所选身份的文件集合,用例级放行由执行端的 UDQ_SELECTION 名单负责。
   * 属 protocol 12 payload(进哈希);白名单与校验器见 clusterJobPayload / validateJob。
   */
  rerun?: { selection: ClusterRerunCase[] }
  /**
   * 【队列名次 · 卡2 T2】同一拍授予的多张单 createdAt 相同,执行端信箱按 createdAt 排不出
   * 派单员心里的先后;派单员把票据的排队名次(band→queuedAt,与排队投影 sched-decide 同向
   * 同键)绑进 payload,执行端信箱排序据此镜像。属 protocol 12 payload(进哈希),白名单与
   * 校验器见 clusterJobPayload / validateJob;auto 单与旧工单不带 ⇒ 行为逐字不变。
   */
  queueRank?: { band: 0 | 1; queuedAt: string }
  /** 派活时派活方的 HEAD;执行方必须对齐到它才准开跑。**任何工单都不豁免**。 */
  codeVersion?: string
  createdBy?: string
  createdAt?: string
  /** protocol 12 生命周期身份；任一字段出现时，整组都必须完整且与执行 payload 逐字匹配。 */
  namespace?: typeof LIFECYCLE_NAMESPACE
  lifecycleSchema?: typeof LIFECYCLE_SCHEMA
  epoch?: string
  submissionId?: string
  machine?: string
  payloadSha256?: string
  /**
   * 【生命周期溯源标记 · 冷/热切换的激活单】记录这张工单是哪一次维护仪式发出来的
   * (`cluster-lifecycle-cutover.ts` / `cluster-lifecycle-cutover-cold.ts` 的 payload 段写入)。
   *
   * 【为什么必须在册】见下方 `clusterJobPayload` 的「白名单覆盖面」注释:
   * 发布侧对**整个 payload** 取哈希,校验侧只对白名单子集重算——不在册的字段会让两个哈希
   * 必然不等,于是每一张激活单都被自家白名单当场隔离,报错还只说「哈希对不上」。
   *
   * 【它不影响执行】`resolveCommand` 一个字都不读它 ⇒ 只进取证,不改「到底跑什么命令」。
   */
  lifecycleActivation?: { epoch: string; maintenanceId: string; coldMode?: boolean }
  /** 【生命周期溯源标记 · 金丝雀单】同上,记录是哪一次 canary 跑(`--lifecycle-canary` 写入)。 */
  lifecycleCanary?: { runId: string }
  /**
   * 【拒收字段】历史设计的残留:工单**不许自带命令行**。
   * 声明在这里只为了能明确拒掉它——万一共享盘上出现这种工单,要当场报「不许自带命令行」,
   * 而不是把它当未知字段忽略后照跑别的东西。
   */
  cmd?: readonly string[]
}

export function isAutoJob(job: ClusterJob): boolean { return job.auto !== undefined }

/** 一种作业的定义。argv 是**固定模板**,工单只能往里填白名单参数。 */
export interface JobTypeSpec {
  /** 大白话描述(报错/帮助里给人看)。 */
  desc: string
  /** 固定命令模板;argv[0] 是可执行文件。 */
  argv: readonly string[]
  /** 允许工单带 target 追加跑测目标。 */
  acceptsTarget?: boolean
  /** 支持并发上限的命令行参数名。**各工具不同,抄错不是「没限住」而是直接报错退出**。 */
  workersFlag?: string
  /** 并发上限走环境变量下发(跑分脚本的现行契约)。 */
  workersEnv?: string
  /**
   * 工单没显式给 workers 时,是否自动注入默认并发上限：优先授予核数，旧工单沿用机器配额。
   * **默认不注入**;只对「缺省行为=吃满所有核」的工具开启。
   * 反例(必须关):playwright 的配置里 `workers: 1` 是**刻意**钉死的(UI 断言时序敏感),
   * 按配额注入会把它顶掉、破坏 e2e 确定性——那属于悄悄改设计意图,不是「保护主机」。
   */
  quotaInject?: boolean
  /** 该作业固定要带的环境变量(与并发无关的口径修正)。 */
  fixedEnv?: Readonly<Record<string, string>>
  /** 必须带 round + shard(仅跑分)。 */
  needsRound?: boolean
  /**
   * 把执行方本机视角的共享盘根经 `CLUSTER_SHARE_ROOT` 环境变量下发给作业脚本。
   * **默认不下发**;只给「安装材料放在共享盘上」的作业开启(ci:runner:install)。
   * 为什么走环境变量:共享盘在每台机器上的挂载点各不相同(Mac 入伙实测),
   * 只有执行方 agent 知道本机的 --share 路径;而工单参数白名单(target 等)只收仓库内
   * 相对路径,不该也不能用来传盘外坐标。
   */
  injectShareEnv?: boolean
  /**
   * 设了它,target 就**必填**且整串 trim 后必须匹配这个模式(gauge 只认
   * scripts/bot/gauge-plans/ 下的计划文件——计划是数据不是命令,路径形状从严,
   * 别的什么都能不塞进 target)。正则的**唯一正本在本文件**:执行端脚本从这里
   * import 回去用;反向 import 会把执行端脚本拖进代理自更新源码闭包,不许。
   */
  targetPattern?: RegExp
  /** 设了它,执行端把产物目录(ctx.outDir)写进这个环境变量下发给作业脚本(gauge 的 GAUGE_OUT_DIR)。 */
  outDirEnv?: string
  /** 设了它,派活必须用 --machines 点名恰好一台机器(测量类作业同批对照必须同机顺序跑,见 machinePinError)。 */
  pinOneMachine?: boolean
}

/** Administrator-owned job templates. Request validation below remains unchanged. */
export const JOB_TYPES: Readonly<Record<string, JobTypeSpec>> = Object.fromEntries(Object.entries(deployment.getDeploymentConfig().jobs).map(([kind, raw]) => {
  const spec = raw as Omit<JobTypeSpec, 'targetPattern'> & { targetPattern?: string }
  return [kind, { ...spec, ...(spec.targetPattern === undefined ? {} : { targetPattern: new RegExp(spec.targetPattern) }) }]
}))

/** 缺省作业名:兼容只带 round 的老工单。 */
export const DEFAULT_JOB_KIND = deployment.getDeploymentConfig().defaultJobKind ?? ''

/**
 * 工单在信箱里排队超过这么久仍没被领走,代理领单时就按「过期未领」隔离,不再跑(CLUSTER-OFFLINE-MACHINE-STALE-JOB)。
 * 正常排队(给 CI 让路最多 20 分钟、前面排着几张重活)远到不了一天;离线机器的旧单却可能一放好几天,
 * 开机就先把代码对齐到几天前的版本、跑一张早没人等的活。
 */
export const JOB_UNCLAIMED_EXPIRY_MS = 24 * 3600_000

/** 工单已过期时返回给人看的说明,未过期返回 undefined。派单时间缺失或非法时不判,交给 validateJob。 */
export function unclaimedJobExpiry(job: { createdAt?: string }, nowMs: number): string | undefined {
  if (typeof job.createdAt !== 'string') return undefined
  const createdMs = Date.parse(job.createdAt)
  if (!Number.isFinite(createdMs)) return undefined
  const waitedMs = nowMs - createdMs
  if (waitedMs <= JOB_UNCLAIMED_EXPIRY_MS) return undefined
  return `派于 ${job.createdAt},已等待 ${Math.floor(waitedMs / 3600_000)} 小时,超过 ${JOB_UNCLAIMED_EXPIRY_MS / 3600_000} 小时未领`
}

/** 在册作业名(报错提示与帮助里按这个顺序列)。 */
export function jobTypeNames(): string[] {
  return Object.keys(JOB_TYPES)
}

/** 作业菜单的人话帮助文本。 */
export function jobMenuHelp(): string {
  return jobTypeNames().map(n => `    ${n.padEnd(14)} ${JOB_TYPES[n]!.desc}`).join('\n')
}

/**
 * shell 元字符。**为什么在校验层就掐掉**:执行方 spawn 在 win32 上确实开了 `shell: true`,
 * 那种情况下 `&&` / `|` / 反引号会被解释。不赌下游永远不开 shell。
 */
const SHELL_METACHARS = /[&|;`$()<>{}^!"'\\\r\n]/

/** target 的单段允许字符:字母数字 + `_ . / * @ -`(够写路径和 glob,写不出别的)。 */
const TARGET_SEGMENT = /^[A-Za-z0-9_./*@-]+$/

/** round 允许字符(它会被当一个 argv 元素拼进固定命令)。 */
const ROUND_OK = /^[A-Za-z0-9_.-]+$/

/** shard 形如 `<i>/<n>`。 */
const SHARD_OK = /^\d+\s*\/\s*\d+$/

/**
 * 校验结果。`reason` 只在 `ok === false` 时有值。
 * 【为什么不做成可辨识联合】调用方最常见的写法是 `expect(r.ok, r.reason)` /
 * `log(\`非法:${r.reason}\`)` —— 联合类型会让「顺手把原因打出来」变成类型错误,
 * 逼人写额外的窄化分支。而**报错原因打不出来正是这套设施最贵的故障模式**
 * (工单静默进 failed),不该给它增加任何摩擦。
 */
export interface ValidateResult {
  ok: boolean
  reason?: string
  /**
   * 领单期遇到「不在册的作业名」时为 true:**不算非法,只是现在还判不了**
   * ——菜单随代码版本走,等版本闸门对齐 + 代理自更新之后再判(见 ValidateOptions)。
   */
  deferred?: boolean
}

export interface ValidateOptions {
  /**
   * 遇到不在册的作业名时**不拒收**,而是返回 `{ ok: true, deferred: true }`。
   *
   * 【为什么需要这个开关(2026-07-30 实测 bug)】给副机派新加的 `e2e:install`,被**当场拒收**
   * 丢进 failed:领单时跑的校验用的是**代理内存里那份(旧)菜单**,而菜单是随代码版本走的
   * ——版本闸门本来马上就会把磁盘代码对齐到含该作业的 commit、代理也会自更新。
   * 顺序错一步,结果是「新增作业类型对所有还没升级的执行机永久不可用」,
   * 而派活方看到的只是一个静默的 failed(这套设施里最难归因的那类故障)。
   *
   * 故执行方**领单期**用 `{ deferUnknownKind: true }` 只守与菜单无关的底线,
   * **对齐代码 + 自更新之后**再做一次完整校验。派活方不用这个开关(它就是菜单的来源)。
   */
  deferUnknownKind?: boolean
}

const bad = (reason: string): ValidateResult => ({ ok: false, reason })

/**
 * 生命周期身份只摘要真正影响执行的字段。jobId/机器/版本/创建者属于 envelope identity，
 * 不重复塞进 payload；固定字段顺序也让 legacy 审计工具可以复算。
 *
 * 【这份清单就是 payload 白名单 —— 两侧覆盖面必须一致】
 * (CLUSTER-ACTIVATION-JOB-QUARANTINE,2026-08-31)
 * 发布侧 `buildLifecycleIdentity` 用 `lifecyclePayloadSha256(整个 payload)` 算身份摘要;
 * 校验侧 `validateJob` 用 `lifecyclePayloadSha256(clusterJobPayload(job))` 重算。
 * **两处覆盖的字段集合一旦不同,哈希必然不等** —— payload 里多一个不在册的字段,
 * 结果就是工单被自家白名单隔离,而报错只说「payloadSha256 与工单执行字段不匹配」,
 * 看不出是哪个字段。冷切换的激活单与 `--lifecycle-canary` 的金丝雀单**各踩了一次**
 * (实测隔离件:`…/quarantine/lifecycle-activation-epoch-cold-2026-08-31b-…json`,
 * `reason: invalid-job:protocol 12 payloadSha256 与工单执行字段不匹配`)。
 * 属 skill §8.G「守卫过严和守卫失效一样坏」那一族:守卫拦的不是坏人,是自家的仪式。
 *
 * **往 payload 里加字段 = 必须同时加进本清单**,否则带该字段的工单一张都跑不了。
 * 忘了加不会静默:`validateJob` 会点名说「payload 含白名单外字段:<字段名>」。
 *
 * ⚠ 加的必须是**具名**字段。文件头否决过的「什么都收」那条路不许重开 ——
 * 白名单一旦放宽成「未知字段一律忽略」,共享盘上任何人写的任何工单都能过闸。
 */
function autoPayload(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const auto = value as Record<string, unknown>
  return { project: auto.project, item: auto.item, args: Array.isArray(auto.args) ? [...auto.args] : auto.args,
    bundle: auto.bundle, commit: auto.commit, base: auto.base }
}
export function clusterJobPayload(job: ClusterJob): Record<string, unknown> {
  return {
    ...(job.ticketId !== undefined ? { ticketId: job.ticketId } : {}),
    ...(job.kind !== undefined ? { kind: job.kind } : {}),
    ...(job.round !== undefined ? { round: job.round } : {}),
    ...(job.shard !== undefined ? { shard: job.shard } : {}),
    ...(job.workers !== undefined ? { workers: job.workers } : {}),
    ...(job.grantedCores !== undefined ? { grantedCores: job.grantedCores } : {}),
    ...(job.ciAware !== undefined ? { ciAware: job.ciAware } : {}),
    ...(job.target !== undefined ? { target: job.target } : {}),
    ...(job.rerun !== undefined ? { rerun: job.rerun } : {}),
    ...(job.queueRank !== undefined ? { queueRank: job.queueRank } : {}),
    ...(job.lifecycleActivation !== undefined ? { lifecycleActivation: job.lifecycleActivation } : {}),
    ...(job.lifecycleCanary !== undefined ? { lifecycleCanary: job.lifecycleCanary } : {}),
    ...(job.auto !== undefined ? { auto: autoPayload(job.auto) } : {}),
  }
}

/**
 * payload 白名单的键名清单(与 `clusterJobPayload` 同源,单一事实源)。
 * 只用于**报错时点名**是哪个字段不在册;真正的摘要仍走 `clusterJobPayload`。
 * 导出供 SCHED-PAYLOAD-FIELD-PROTOCOL-GATE 的结构性用例核对「可选字段都登记了协议闸」。
 */
export const PAYLOAD_FIELDS = [
  'kind', 'round', 'shard', 'workers', 'grantedCores', 'ciAware', 'target', 'rerun', 'queueRank', 'lifecycleActivation', 'lifecycleCanary', 'ticketId', 'auto',
] as const

/**
 * 信封字段:由 `buildLifecycleIdentity` / `jobFromLifecycleRecord` 挂在工单顶层,
 * **不属于 payload**,故不参与 payload 摘要,也不该被当成「白名单外字段」报出来。
 */
const ENVELOPE_FIELDS = [
  'jobId', 'codeVersion', 'createdBy', 'createdAt',
  'namespace', 'lifecycleSchema', 'epoch', 'submissionId', 'machine', 'payloadSha256',
  'selfUpgradeTried', 'cmd',
] as const

/** 工单里既不在 payload 白名单、也不是信封字段的那些键(按字母序,便于断言)。 */
function unknownPayloadFields(job: ClusterJob): string[] {
  const known = new Set<string>([...PAYLOAD_FIELDS, ...ENVELOPE_FIELDS])
  return Object.keys(job).filter(k => !known.has(k)).sort()
}

/**
 * 校验一个生命周期溯源标记:必须是普通对象,字段名与类型逐个对上,**不许多带字段**。
 * 返回错误原因;合法则 undefined。
 *
 * 【为什么连"多带字段"都要拒】它进 payload 摘要 ⇒ 是被哈希绑定的内容。
 * 允许自由塞字段,等于给共享盘上的写入方开了一块不受约束的自由区。
 */
function checkProvenanceMark(
  value: unknown, label: string, shape: Readonly<Record<string, 'string' | 'boolean'>>,
  required: readonly string[],
): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${label} 必须是一个对象`
  }
  const mark = value as Record<string, unknown>
  for (const key of Object.keys(mark).sort()) {
    const want = shape[key]
    if (want === undefined) return `${label} 不认识的字段:${key}(只收 ${Object.keys(shape).join(' / ')})`
    if (typeof mark[key] !== want) return `${label}.${key} 必须是 ${want},收到:${typeof mark[key]}`
    if (want === 'string' && (mark[key] as string).trim() === '') return `${label}.${key} 是空的`
  }
  for (const key of required) {
    if (mark[key] === undefined) return `${label} 缺 ${key}`
  }
  return undefined
}

/** 校验 target:返回错误原因,合法则返回 undefined。 */
function checkTarget(target: string): string | undefined {
  if (target.trim() === '') return 'target 是空的'
  if (target.length > 200) return `target 过长(${target.length} 字符,上限 200)`
  if (SHELL_METACHARS.test(target)) return `target 含 shell 元字符,拒收:${target}`
  for (const seg of target.trim().split(/\s+/)) {
    if (/^([A-Za-z]:|[/\\])/.test(seg)) return `target 不许用绝对路径(只能点仓库内的东西):${seg}`
    if (seg.includes('..')) return `target 不许含 ..(只能点仓库内的东西):${seg}`
    if (!TARGET_SEGMENT.test(seg)) return `target 含不允许的字符:${seg}`
  }
  return undefined
}

/** 不可信输入的对象视图:值不是普通对象(含数组)⇒ undefined。不假设任何业务字段存在。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/**
 * 校验 rerun 选择(d3):与 sched 侧 requeued.rerun 事件同一口径——
 * 文件是仓库内相对正斜杠路径(不含 ..),标题路径非空文本,实例序号非负,指纹 64 位小写十六进制。
 * 入参是不可信输入(共享盘上谁都能写),按 unknown 逐项收窄,不做任何业务类型强转。
 */
function checkRerunSelection(rerun: unknown): string | undefined {
  const selection = asRecord(rerun)?.selection
  const entries: readonly unknown[] = Array.isArray(selection) ? selection : []
  if (entries.length === 0) return 'rerun.selection 必须是非空数组'
  for (const entry of entries) {
    const item = asRecord(entry)
    if (item === undefined) return 'rerun.selection 条目必须是对象'
    const identity = asRecord(item.identity)
    if (identity === undefined) return 'rerun 身份必须是对象'
    const file = identity.file
    if (typeof file !== 'string' || file === '' || file.includes('\\')
      || file.includes('..') || file.startsWith('/') || /^[A-Za-z]:/.test(file)
      || file.split('/').some(part => part === '' || part === '.')) {
      return `rerun 文件必须是仓库内相对路径(正斜杠,不含 ..):${file}`
    }
    const titlePath = identity.titlePath
    if (!Array.isArray(titlePath) || titlePath.length === 0
      || titlePath.some(part => typeof part !== 'string' || part === '')) {
      return 'rerun 标题路径必须是非空文本数组'
    }
    if (typeof identity.instanceIndex !== 'number' || !Number.isSafeInteger(identity.instanceIndex)
      || identity.instanceIndex < 0) {
      return 'rerun instanceIndex 必须是非负安全整数'
    }
    const sha = item.sourceSha256
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) {
      return 'rerun sourceSha256 必须是 64 位小写十六进制'
    }
  }
  return undefined
}

/**
 * 工单合法性:**派活方投递前**和**执行方领单时**都调这一个。
 *
 * 判据故意从严:非法一律拒收并说清原因。宁可当场报错,也不许把一张半懂的工单
 * 交给无人值守的机器去跑——那会产出「口径不明的绿」,比红更坏。
 */
function checkAutoJob(job: ClusterJob): string | undefined {
  const auto: unknown = job.auto
  if (typeof auto !== 'object' || auto === null || Array.isArray(auto)) return 'auto 单 auto 必须是对象'
  const fields = auto as Record<string, unknown>
  if (Object.keys(fields).sort().join(',') !== 'args,base,bundle,commit,item,project') return 'auto 单 auto 只能有六个指定字段'
  if (typeof job.ticketId !== 'string' || !/^tk-[0-9a-f]{20}$/.test(job.ticketId)) return 'auto 单 ticketId 必带且须为合法单号'
  if (typeof job.jobId !== 'string' || job.jobId.match(new RegExp(`^${job.ticketId}--a[1-9][0-9]*$`)) === null) {
    return 'auto 单 jobId 必须等于单号加正整数执行号'
  }
  if (job.submissionId !== undefined && job.submissionId !== job.jobId) return 'auto 单 submissionId 必须等于 jobId'
  if (typeof job.grantedCores !== 'number' || !Number.isSafeInteger(job.grantedCores) || job.grantedCores < 1) {
    return 'auto 单 grantedCores 必须是正整数'
  }
  if (typeof fields.project !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(fields.project)) {
    return 'auto 单 project 只许一至六十四位菜单段字符'
  }
  if (typeof fields.item !== 'string' || !/^[A-Za-z0-9:._-]{1,64}$/.test(fields.item)) {
    return 'auto 单 item 只许一至六十四位菜单项字符'
  }
  if (job.kind !== fields.item) return 'auto 单 kind 必须等于 item'
  if (!Array.isArray(fields.args) || fields.args.length > AUTO_JOB_ARGS_MAX
    || fields.args.some(arg => typeof arg !== 'string' || arg.length < 1 || arg.length > AUTO_JOB_ARG_MAX_LENGTH
      || SHELL_METACHARS.test(arg) || arg.includes('%'))) return 'auto 单 args 须为至多六十四个受限字符串'
  if (fields.bundle !== `${job.ticketId}.bundle`) return 'auto 单 bundle 必须是本单号的包名'
  if (typeof fields.commit !== 'string' || !/^[0-9a-f]{40}$/.test(fields.commit)) return 'auto 单 commit 必须是四十位小写十六进制'
  if (typeof fields.base !== 'string' || !/^[0-9a-f]{40}$/.test(fields.base)) return 'auto 单 base 必须是四十位小写十六进制'
  if (job.codeVersion !== fields.commit) return 'auto 单 codeVersion 必须等于 commit'
  for (const name of ['target', 'rerun', 'round', 'shard', 'workers', 'queueRank', 'lifecycleActivation', 'lifecycleCanary'] as const) {
    if (job[name] !== undefined) return `auto 单 ${name} 不允许出现`
  }
  return undefined
}

export function validateJob(job: ClusterJob, opts: ValidateOptions = {}): ValidateResult {
  if (typeof job !== 'object' || job === null) return bad('工单不是一个对象')
  if (typeof job.jobId !== 'string' || job.jobId.trim() === '') return bad(job.auto !== undefined
    ? 'auto 单 jobId 必带且须为单号加正整数执行号' : '缺 jobId(产物与日志都按它命名)')
  if (job.ticketId !== undefined && (typeof job.ticketId !== 'string' || !/^tk-[0-9a-f]{20}$/.test(job.ticketId))) {
    return bad(job.auto !== undefined ? 'auto 单 ticketId 必带且须为合法单号' : 'ticketId 必须是合法调度单号')
  }
  if (job.grantedCores !== undefined && (typeof job.grantedCores !== 'number'
    || !Number.isSafeInteger(job.grantedCores) || job.grantedCores < 1)) {
    return bad(job.auto !== undefined ? 'auto 单 grantedCores 必须是正整数'
      : `grantedCores 必须是大于等于 1 的整数,收到:${String(job.grantedCores)}`)
  }
  // CI 共存标(UDQ-T4B-2b)与许可契约同口径:只认字面 true,免得「显式假」在派发侧与执行侧读出不同含义。
  if (job.ciAware !== undefined && job.ciAware !== true) {
    return bad(job.auto !== undefined ? 'auto 单 ciAware 只认字面 true'
      : `ciAware 只认字面 true,收到:${String(job.ciAware)}`)
  }
  // 【队列名次 · 卡2 T2】形状从严:它进 payload 摘要、被哈希绑定,与 lifecycleActivation 同族——不许多带字段。
  if (job.queueRank !== undefined) {
    const rank: unknown = job.queueRank
    if (typeof rank !== 'object' || rank === null || Array.isArray(rank)) return bad('queueRank 必须是对象')
    const keys = Object.keys(rank).sort().join(',')
    if (keys !== 'band,queuedAt') return bad(`queueRank 只能有 band 与 queuedAt 两个字段,收到:${keys}`)
    const { band, queuedAt } = rank as { band: unknown; queuedAt: unknown }
    if (band !== 0 && band !== 1) return bad(`queueRank.band 必须是 0 或 1,收到:${String(band)}`)
    if (typeof queuedAt !== 'string' || !Number.isFinite(Date.parse(queuedAt))) {
      return bad('queueRank.queuedAt 必须是可解析的时刻文本')
    }
  }

  // 【安全地基】工单不许自带命令行:共享盘上谁能写盘谁就能让副机执行东西
  if (job.cmd !== undefined) {
    return bad('工单不许自带命令行(cmd 字段)——只能点作业名 + 填白名单参数。可用作业名:' + jobTypeNames().join(' / '))
  }

  // 【跨机正确性地基】版本闸门对所有工单一视同仁:
  // 副机跑的若不是派活方那个 commit,「副机说测试绿了」这句话毫无意义
  if (typeof job.codeVersion !== 'string' || job.codeVersion.trim() === '') {
    return bad(job.auto !== undefined ? 'auto 单 codeVersion 必带且须等于 commit'
      : '缺 codeVersion —— 执行方无法确认跑的是不是派活方那份代码,拒收')
  }

  /**
   * 【白名单闸·点名版】payload 里出现不在册的字段,当场点名拒收。
   *
   * 【为什么要在算哈希之前拦】不拦的话,这种工单会在下面的 `payloadSha256` 比对那里失败
   * (发布侧哈希整个 payload、这里只哈希白名单子集 ⇒ 必不等),报出来的却是
   * 「payloadSha256 与工单执行字段不匹配」—— 看不出是哪个字段,也看不出是"多带了东西"
   * 还是"内容被人篡改过"。这两件事的处置完全不同,必须分开报。
   * 实测代价:一张冷切换激活单为此躺在 quarantine 里,靠人下钻 json + 手工复算哈希才认出来。
   */
  const unknown = unknownPayloadFields(job)
  if (unknown.length !== 0) {
    return bad(`${job.auto !== undefined ? 'auto 单 ' : ''}payload 含白名单外字段:${unknown.join(' / ')}`
      + `——工单只能点作业名 + 填白名单参数(${PAYLOAD_FIELDS.join(' / ')})`)
  }

  if (job.auto === undefined && job.lifecycleActivation !== undefined) {
    const why = checkProvenanceMark(job.lifecycleActivation, 'lifecycleActivation',
      { epoch: 'string', maintenanceId: 'string', coldMode: 'boolean' }, ['epoch', 'maintenanceId'])
    if (why !== undefined) return bad(why)
  }
  if (job.auto === undefined && job.lifecycleCanary !== undefined) {
    const why = checkProvenanceMark(job.lifecycleCanary, 'lifecycleCanary',
      { runId: 'string' }, ['runId'])
    if (why !== undefined) return bad(why)
  }

  const lifecycleFields = [
    job.namespace,
    job.lifecycleSchema,
    job.epoch,
    job.submissionId,
    job.machine,
    job.payloadSha256,
  ]
  if (lifecycleFields.some(value => value !== undefined)) {
    if (job.namespace !== LIFECYCLE_NAMESPACE || job.lifecycleSchema !== LIFECYCLE_SCHEMA) {
      return bad(`protocol 12 身份必须完整绑定 ${LIFECYCLE_NAMESPACE}/schema ${LIFECYCLE_SCHEMA}`)
    }
    if (typeof job.epoch !== 'string' || !/^[A-Za-z0-9._-]+$/.test(job.epoch)) return bad('protocol 12 缺合法 epoch')
    if (typeof job.submissionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(job.submissionId)) {
      return bad('protocol 12 缺合法 submissionId')
    }
    if (typeof job.machine !== 'string' || !/^[A-Za-z0-9._-]+$/.test(job.machine)) return bad('protocol 12 缺合法 machine')
    if (!/^[0-9a-f]{40}$/.test(job.codeVersion)) return bad('protocol 12 codeVersion 必须是 exact 40 位 SHA')
    if (typeof job.createdAt !== 'string' || !Number.isFinite(Date.parse(job.createdAt))) return bad('protocol 12 缺合法 createdAt')
    if (typeof job.createdBy !== 'string' || job.createdBy.trim() === '') return bad('protocol 12 缺 createdBy')
    if (typeof job.payloadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(job.payloadSha256)) {
      return bad('protocol 12 缺合法 payloadSha256')
    }
    if (lifecyclePayloadSha256(clusterJobPayload(job)) !== job.payloadSha256) {
      return bad('protocol 12 payloadSha256 与工单执行字段不匹配')
    }
  }

  if (job.auto !== undefined) {
    const why = checkAutoJob(job)
    return why === undefined ? { ok: true } : bad(why)
  }

  const kind = job.kind ?? DEFAULT_JOB_KIND
  const spec = JOB_TYPES[kind]
  if (spec === undefined) {
    // 领单期:菜单随代码版本走,现在判不了 ⇒ 留给版本闸门 + 自更新之后复核(见 ValidateOptions)
    if (opts.deferUnknownKind === true) return { ok: true, deferred: true }
    return bad(`作业名不在册:${kind}。可用作业名:${jobTypeNames().join(' / ')}`)
  }

  if (spec.needsRound === true) {
    if (typeof job.round !== 'string' || job.round.trim() === '') return bad(`${kind} 必须带 round(轮次名)`)
    if (!ROUND_OK.test(job.round)) return bad(`round 含不允许的字符(疑似 shell 元字符注入):${job.round}`)
    if (typeof job.shard !== 'string' || !SHARD_OK.test(job.shard)) return bad(`${kind} 必须带 shard,形如 0/2`)
  } else {
    // 通用作业整台派,没有「片」的概念。带了 round/shard 说明派活方口径错了,当场点出来
    if (job.round !== undefined) return bad(`${kind} 不吃 round(那是跑分才有的概念)`)
    if (job.shard !== undefined) return bad(`${kind} 不吃 shard —— 通用作业整台派,不分片`)
  }

  // targetPattern(CLUSTER-JOB-MENU-P03-CALIB-1001):设了即 target 必填,整串还须匹配形状正则。
  if (spec.targetPattern !== undefined && job.target === undefined) {
    return bad(`${kind} 必须带 target:符合配置 targetPattern 的相对路径`)
  }
  if (job.target !== undefined) {
    if (typeof job.target !== 'string') return bad('target 必须是字符串')
    if (spec.acceptsTarget !== true) {
      return bad(`${kind} 不吃 target(它的跑测范围是固定的);想缩范围请改用 test 作业`)
    }
    const why = checkTarget(job.target)
    if (why !== undefined) return bad(why)
    if (spec.targetPattern !== undefined && !spec.targetPattern.test(job.target.trim())) {
      return bad(`${kind} 的 target 必须是配置指定的计划文件路径,收到:${job.target.trim()}`)
    }
  }

  // 补跑选择(d3)只允许随 vitest 三类测试作业下发;其余作业带它一律拒收(宁可拒,不静默忽略)。
  if (job.rerun !== undefined) {
    if (!(RERUN_WORK_TYPES as readonly string[]).includes(kind)) {
      return bad(`rerun 只随 ${RERUN_WORK_TYPES.join(' / ')} 作业下发,收到:${kind}`)
    }
    const whyRerun = checkRerunSelection(job.rerun)
    if (whyRerun !== undefined) return bad(whyRerun)
  }

  if (job.workers !== undefined) {
    if (typeof job.workers !== 'number' || !Number.isSafeInteger(job.workers) || job.workers < 1) {
      return bad(`workers 必须是大于等于 1 的整数,收到:${String(job.workers)}`)
    }
    if (spec.workersFlag === undefined && spec.workersEnv === undefined) {
      return bad(`${kind} 不吃并发上限参数(硬塞给它会直接报错退出)`)
    }
  }

  return { ok: true }
}

/**
 * 派活侧的点名闸(CLUSTER-JOB-MENU-P03-CALIB-1001):pinOneMachine 的作业(gauge)必须用
 * --machines 点名**恰好一台**机器。P03 §8 盘口校准是 off/on 两侧对照,同一批对照必须同机
 * 顺序跑,跨机或并行的读数没有可比性——与其让工单投进信箱后由执行端拒收(派活方还显示
 * 「已投递」),不如在 cluster-dispatch 的参数校验口当场拦下。纯函数、可在册外作业名安全
 * 返回 undefined(闸只认显式声明 pinOneMachine 的作业),供派活命令行直接调用。
 */
export function machinePinError(kind: string, machinesRaw: string | undefined): string | undefined {
  if (JOB_TYPES[kind]?.pinOneMachine !== true) return undefined
  const machines = (machinesRaw ?? '').split(',').map(value => value.trim()).filter(value => value !== '')
  if (machines.length === 1) return undefined
  return `${kind} 是测量类作业,同批对照必须同机顺序跑:必须用 --machines 点名恰好一台机器(收到:${machines.length === 0 ? '未指定' : machines.join(',')})`
}

/** 解析工单时的执行环境上下文(由执行方提供:它才知道自己是哪台机、产物往哪放)。 */
export interface ResolveContext {
  /**
   * 本机允许吃的核数(`lib/cpuLease.quotaCores()`:主机 85%、专职算力机 100%)。
   * **核数的第一来源是调度台的授予**(`job.grantedCores`,由 permit 经 protocol 12 payload
   * 下发,见 clusterJobPayload);它只在这条兜底路径上生效:工单既无授予核数、也没显式给
   * workers 的**旧工单**——**这是必需件不是附赠**:兜底路径「副机不在线→派主机」若裸跑默认值,
   * vitest 缺省吃满所有核,等于把本卡要解决的问题(吃满主机 ⇒ 堵住 CI ⇒ 堵住全项目合并)原样搬回来。
   */
  quotaCores?: number
  /** 跑分产物目录(下发给 calib-run 的 CALIB_OUT_DIR)。 */
  outDir?: string
  /** 执行方本机视角的共享盘根(agent 的 --share);只发给声明了 injectShareEnv 的作业。 */
  sharePath?: string
}

export interface ResolvedCommand {
  bin: string
  args: string[]
  /** 需要**追加**到 process.env 上的键(只含本工单相关的,不含继承项)。 */
  env: Record<string, string>
}

/**
 * 工单 → 真正要跑的命令。**调用前必须先过 validateJob**(本函数假定工单已合法)。
 */
export function resolveCommand(job: ClusterJob, ctx: ResolveContext = {}): ResolvedCommand {
  if (isAutoJob(job)) throw new Error('[cluster-job] auto 单没有可还原的命令:命令由执行端按本机菜单还原(HUB5),不许走 resolveCommand')
  const kind = job.kind ?? DEFAULT_JOB_KIND
  const spec = JOB_TYPES[kind]
  if (spec === undefined) {
    // 走到这里说明调用方跳过了 validateJob;给出可归因的错,不猜着跑
    throw new Error(`[cluster-job] 作业名不在册:${kind}(调用 resolveCommand 前必须先过 validateJob)`)
  }

  const args = spec.argv.slice(1)
  const env: Record<string, string> = { ...spec.fixedEnv }

  if (spec.injectShareEnv === true && ctx.sharePath !== undefined) {
    env.CLUSTER_SHARE_ROOT = ctx.sharePath
  }

  if (spec.needsRound === true) {
    args.push(job.round!)
    if (job.shard !== undefined) env.CALIB_SHARD = job.shard
    if (ctx.outDir !== undefined) env.CALIB_OUT_DIR = ctx.outDir
  } else if (job.rerun !== undefined) {
    // 补跑(d3):跑测目标换成所选身份的文件集合(去重 + 排序,稳定且同名文件只跑一次);
    // 用例级放行由执行端注入的 UDQ_SELECTION 名单负责,这里只保证命令面指到这些文件。
    // test:fast/test:coverage 内置的缺省目标(tests/unit 等)全部丢弃——补跑集合就是新目标;
    // test:coverage 的覆盖率口径不能因补跑丢失,--coverage 显式补回。
    args.length = 2 // 保留 argv[1..2]=['vitest','run']:丢了 'run',vitest 在有终端时会进监视模式
    args.push(...[...new Set(job.rerun.selection.map(item => item.identity.file))].sort())
    if (kind === 'test:coverage') args.push('--coverage')
  } else if (job.target !== undefined && job.target.trim() !== '') {
    args.push(...job.target.trim().split(/\s+/))
  }

  // 产物目录(outDirEnv,gauge 的 GAUGE_OUT_DIR):执行方本机的盘外坐标,只经环境变量下发、
  // 不进命令行;没给 ctx.outDir 就不带这个键(calib 的 CALIB_OUT_DIR 在上面 needsRound 分支,一字不动)。
  if (spec.outDirEnv !== undefined && ctx.outDir !== undefined) {
    env[spec.outDirEnv] = ctx.outDir
  }

  // 显式 workers 最优先；没有显式值时，仅为 quotaInject===true 的工具注入并发上限：
  // **优先调度台授予核数**(job.grantedCores)，旧工单无授予核数才用机器配额(ctx.quotaCores)；
  // 其余工具保持自身配置，不能把 e2e 的单 worker 顶掉。
  // 参数名跟着工具走(vitest=--maxWorkers、playwright=--workers、
  // 跑分脚本走环境变量)——抄错的后果是命令直接报错退出,不是「没限住」。
  const workers = job.workers ?? (spec.quotaInject === true ? (job.grantedCores ?? ctx.quotaCores) : undefined)
  if (workers !== undefined) {
    if (spec.workersEnv !== undefined) env[spec.workersEnv] = String(workers)
    else if (spec.workersFlag !== undefined) args.push(`${spec.workersFlag}=${workers}`)
  }

  return { bin: spec.argv[0]!, args, env }
}

/** 一句话描述工单在跑什么(日志/心跳/状态显示共用,免得三处各写一套)。 */
export function describeJob(job: ClusterJob): string {
  if (isAutoJob(job)) return `${job.auto!.project}:${job.auto!.item}(auto)`
  const kind = job.kind ?? DEFAULT_JOB_KIND
  const spec = JOB_TYPES[kind]
  if (spec === undefined) return `${kind}(不在册)`
  const workers = job.workers ?? (spec.quotaInject === true ? job.grantedCores : undefined)
  if (spec.needsRound === true) {
    return `${kind} 轮次=${job.round ?? '-'} 片=${job.shard ?? '-'} workers=${workers ?? '按配额'}`
  }
  const parts = [kind]
  if (job.target !== undefined) parts.push(`目标=${job.target}`)
  parts.push(`workers=${workers ?? '按配额'}`)
  return parts.join(' ')
}

/* ═══════════════ 工单日志路径口径(CLUSTER-RESULT-LOG-XPLAT,2026-08-10)═══════════════
 *
 * 【为什么归本文件】执行方(cluster-agent)落盘日志、读取方(cluster-dispatch --wait)找日志,
 * 必须用同一份文件名规则——两侧各写一套的漂移故障这套设施已经踩过(见文件头)。
 *
 * 【为什么不许写绝对路径】Mac 副机入伙首日实测:执行机把自己视角的共享盘绝对路径
 * (<mounted data directory>/logs/….log)写进 result.logFile,Windows 主机按它读必然读不到,
 * --wait 汇总只剩「(读不到日志 …)」,而文件本身在共享盘上真实存在。同一块共享盘在
 * 每台机器上的挂载点各不相同,**结果 json 里只有「相对 share 根」是各方都能翻译的坐标**。
 */

/** 工单日志的纯文件名。执行方落盘与读取方兜底拼接共用,单一事实源。 */
export function jobLogFileName(machine: string, jobId: string): string {
  return `${machine}.${jobId}.log`
}

/** 归档进结果 json 的日志路径:相对 share 根、恒正斜杠(哪个平台读它都自己拼挂载点)。 */
export function jobLogRelPath(machine: string, jobId: string): string {
  return `logs/${jobLogFileName(machine, jobId)}`
}

/**
 * 读取方把结果 json 里的 logFile 解析成**本机可读的候选路径列表**(按优先序逐个试读)。
 *
 * 优先序与向后兼容:
 * 1. 旧工单里执行机视角的**绝对路径**——同平台(Win 派 Win)仍可直读,排第一保现状;
 * 2. 取文件名拼到本机视角的 `<share>/logs/` 下——跨平台旧工单靠它退化命中,
 *    新版相对路径(`logs/….log`)也走这条(**不许**按 cwd 解析裸相对路径);
 * 3. 按固定文件名规则兜底——logFile 字段缺失/脏值的更老工单。
 *
 * 只产路径不查存在性:「读取成功」本身就是存在性检查,交给调用方逐个试读。
 */
export function jobLogCandidates(share: string, machine: string, jobId: string, rawLogFile?: unknown): string[] {
  const cands: string[] = []
  if (typeof rawLogFile === 'string' && rawLogFile !== '') {
    // win32.isAbsolute 同时认「/ 开头」与「盘符/UNC」,是跨平台绝对路径判断的超集
    // (posix.isAbsolute 只认 / 开头)。相对路径(logs/x.log)两者都判否,不会被原样收录。
    if (win32.isAbsolute(rawLogFile)) cands.push(rawLogFile)
    // 正反斜杠都切:Mac 写的 / 分隔、Windows 写的 \ 分隔,在任何主机上都能取出文件名
    const base = rawLogFile.split(/[\\/]/).pop() ?? ''
    if (base !== '') cands.push(join(share, 'logs', base))
  }
  cands.push(join(share, 'logs', jobLogFileName(machine, jobId)))
  return [...new Set(cands)]
}
