/** 客户端类型侧车；运行时从不加载本文件。可搬路径另需同目录四个 CJS 模块。 */
import type { Category, CodeRef, Permit, SubmissionRequest, SchedulerCommand, AttemptReport, SchedulerFormat, TicketSnapshot } from '../sched-contract'
import type { AgentCiObserver } from '../../bot/cluster-agent-ci-observer'

export interface RuntimeOptions {
  share?: string; env?: NodeJS.ProcessEnv; root?: string; submitter?: string
  now?: () => string | number; monotonic?: () => number; nonce?: () => string
  sleep?: (ms: number) => Promise<void>; output?: (line: string) => void; pollMs?: number; timeoutMs?: number
  notice?: (line: string) => void; remoteOutput?: (bytes: Uint8Array | string) => void; followMs?: number
  userName?: () => string; gitTimeoutMs?: number
  /** 仅供测试注入心跳发布故障；调用参数即可执行真实发布，不影响其它文件发布。 */
  testOnlyPublishBeat?: (publishBeat: () => void) => void
  /** 等待心跳间隔(毫秒，缺省 WAITING_BEAT_INTERVAL_MS)；仅供测试缩短。 */
  waitingBeatMs?: number
  /** 仅供测试注入等待心跳的发布故障；调用参数即可执行真实发布。 */
  testOnlyPublishWaitingBeat?: (publishWaitingBeat: () => void) => void
}
export interface SubmitOptions extends RuntimeOptions {
  request?: SubmissionRequest; project?: string; key?: string; category?: Category; title?: string; cores?: number
  workType?: string; targets?: string[]; codeRef?: CodeRef | string; machines?: string[]; exclusive?: ('screen' | 'word-com')[]
  parent?: string; createdAt?: string
  /** 实际施工平台；1–24 位小写字母、数字或连字符，缺省不写入请求。 */
  engine?: string
  /** 命令与参数只用于算同类活统计键 usageKey(命令头前 3 个词);不进请求本体。 */
  command?: string; args?: string[]
  /** SCHED-CORES-HISTORY-AUTOCORRECT-1010:带 true 时只发 usageKey、不改小申请核数(对应 CLI --cores-strict)。 */
  coresStrict?: boolean
}
/** exec 专用选项：在 SubmitOptions 基础上叠加「要挂号执行的命令」本身与透传给 run() 的字段。 */
export interface ExecOptions extends SubmitOptions {
  command: string; args?: string[]
  /** 仅 exec 的可选输出层；库缺省 raw，不读取 SCHED_OUTPUT。 */
  outputMode?: 'raw' | 'summary'
  pin?: boolean; local?: boolean
  /** 供测试注入的 git 调用替身；缺省用 execFileSync 真跑 git（见 autoCodeRef）。 */
  execGit?: (args: string[]) => string
  beatSec?: number; receiptTimeoutMs?: number
  /** 只作用于内部 submit() 调用的超时；等待 run() 授予/执行仍用 RuntimeOptions.timeoutMs。 */
  submitTimeoutMs?: number
  ciObserver?: AgentCiObserver
}
export const CLIENT_VERSION: 1
export const SCHED_FORMAT_VERSION: 1
export const HOST_SMALL_JOB_POOL_CORES: 4
export const SAFE_SEGMENT: RegExp
export const RENAME_RETRY_DELAYS_MS: readonly number[]
export const BEAT_FAILURE_TOLERANCE_MS: 30000
export function renameWithRetry(source: string, target: string, rename?: (source: string, target: string) => void,
  sleep?: (milliseconds: number) => void): void
export const USAGE: string
export class ClientError extends Error { exitCode: number; constructor(message: string, exitCode?: number, cause?: unknown) }
export function canonicalJson(value: unknown): string
export function contentHash(value: unknown): string
export function rawContentHash(value: string | Uint8Array): string
export function deriveTicketId(project: string, key: string): string
export function validateSubmission(value: unknown): SubmissionRequest
export function validateCommand(value: unknown): SchedulerCommand
export function validateReport(value: unknown): AttemptReport
export function assertWritableFormat(value: unknown): SchedulerFormat
/** onEntry 每走到一个条目回调一次、不影响结果(授予后同步扫描期间给等待心跳补拍)。 */
export function contentFingerprint(root: string, targets: string[], onEntry?: () => void): CodeRef
export function submit(options: SubmitOptions): Promise<{ ticketId: string; idempotencyKey: string; contentHash: string; status: 'accepted' | 'rejected'; reason?: string; exitCode: number }>
export function waitFor(id: string, options?: RuntimeOptions & { until?: 'granted' | 'finished' }): Promise<{ ticket: TicketSnapshot; exitCode: number }>
export function cancel(id: string, options?: RuntimeOptions & { reason?: string }): Promise<{ commandId: string; at: string; status: 'executed' | 'rejected' | 'expired'; reason?: string; exitCode: number }>
/** 只登记类单子（category=codex-build）的正常完工入口；result 必须是 passed 或 failed。 */
export function finish(id: string, options: RuntimeOptions & { result: 'passed' | 'failed'; reason?: string }): Promise<{ commandId: string; at: string; status: 'executed' | 'rejected' | 'expired'; reason?: string; exitCode: number }>
export function status(id?: string, options?: RuntimeOptions): Record<string, unknown>
/** ciObserver 仅为显式调用端口；缺省仍观察本机真实 CI。 */
export function run(id: string, options: RuntimeOptions & { command: string; args?: string[]; beatSec?: number; receiptTimeoutMs?: number; ciObserver?: AgentCiObserver }): Promise<{ exitCode: number; result: string; reason?: string; ticketId?: string; machine?: string; remote?: boolean; hint?: string }>
/** 幂等键缺省值：项目名安全化 + 14 位时间戳数字 + 8 位随机串拼接；始终落在 SAFE_SEGMENT 内，且不等于 . 或 ..。 */
export function autoIdempotencyKey(ctx: { now: () => string | number; nonce: () => string }, project: string): string
/** code-ref 缺省值：干净仓库(git status --porcelain 无输出)用 commit:HEAD；脏仓库、非仓库、git 报错、
 * HEAD 不是 40 位十六进制，一律回退 content:auto。execGit 缺省时用 execFileSync 真跑 git。 */
export function autoCodeRef(root: string, execGit?: (args: string[]) => string): string
/** 挂号前的静态解析：在 Windows 上按 PATH + PATHEXT 复演一遍 argv[0] 会解析到哪个文件；非 Windows 平台
 * 直接放行。解析到未经 cmd /c 包装的 .cmd/.bat 时拒绝并给出可直接复制的改写建议。 */
export function resolveWindowsExecutable(command: string, args?: string[], options?: {
  platform?: string; cwd?: string; env?: NodeJS.ProcessEnv; existsSync?: (candidate: string) => boolean
}): { ok: boolean; wrapped?: boolean; resolvedPath?: string; reason?: string; suggestion?: string }
/** 一步完成 submit → 打印单号与排队位置 → run(等授予后执行) → 结束回报；退出码透传被执行命令的退出码，
 * 挂号被拒时非零退出并打印原因。命令预检失败(见 resolveWindowsExecutable)与「包的是 vitest 而类别
 * 不是单测」的类别预检(见 vitestSubcommand)都在挂号之前拒绝，不占调度台的队。 */
export function exec(options: ExecOptions): Promise<{ exitCode: number; ticketId?: string; reason?: string; suggestion?: string; result?: string; machine?: string; remote?: boolean }>
/** 去 ANSI，按出现顺序识别并去重 vitest / tsc / eslint 的失败项。 */
export function extractFailureItems(text: string): string[]
/** 排队位置等待上限：正式一拍两秒，并容忍一拍心跳写失败。 */
export const QUEUE_POSITION_FRESH_WAIT_MS: number
/** 尽力从心跳读排队位置,读不到给 null,只给人看。 */
export function queuePosition(ctx: { share?: string }, id: string): number | null
/** 等含本单的那一拍心跳再读排队位置,封顶 waitMs,绝不抛错。 */
export function awaitQueuePosition(id: string, options?: { share?: string; waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; monotonic?: () => number }): Promise<number | null>
export interface TimeoutAdviceInput {
  ticketId?: string
  ticket: TicketSnapshot | null
  heartbeat: { at?: string; queue?: { ticketId: string; position: number }[];
    machines?: { name: string; online: boolean; fresh: boolean }[] } | null
  overview: { summary?: string } | null
  sampleMs: number[]; waitedMs: number; clientPath: string; share: string; now: string | number
  readErrors?: Partial<Record<'ticket' | 'heartbeat' | 'overview' | 'samples', string>>
}
/** 只对已读数据生成补充文字，不进行 I/O 或改变原超时错误。 */
export function timeoutAdvice(input: TimeoutAdviceInput): string[]
export const CLIENT_INFRA_SOURCE_PREFIXES: readonly string[]
export const REASON_TEXT: Readonly<Record<string, (values: Record<string, string>) => string>>
export function trunkHeadFile(share: string, project: string): string
export function remoteLogPath(share: string, machine: string, ticketId: string, attemptId: string): string
export function remoteExitCode(ticket: TicketSnapshot, options?: { cancelWritten?: boolean }): number
export function writeCancelCommand(ctx: RuntimeOptions & { share: string; now: () => string | number; nonce: () => string },
  id: string, reason?: string): SchedulerCommand
export function extractArtifactZip(zipBytes: Uint8Array, destDir: string): { written: number; skipped: number }
export function ensureInfoExclude(root: string): Promise<string>
/** 挂号端等待心跳(SCHED-QUEUED-ORPHAN-LIVENESS-1009):间隔、两个回收原因原文(与 sched-waiting.ts 逐字相同)与文件路径。 */
export const WAITING_BEAT_INTERVAL_MS: 10000
export const WAITING_ABANDONED_REASON: string
export const GRANTED_WAITING_ABANDONED_REASON: string
export function waitingBeatFile(share: string, ticketId: string): string
/** SCHED-RUN-ARG-QUOTING-CMD:托管执行把每个参数都加引号,Windows 上「cmd /c <裸名字> …」的裸名字
 * 会让批处理的 %~dp0 解析到当前目录而必败(MR1 施工记录第六节第 13 条对照实验);run() 在挂载点前
 * 用本函数把 /c 的目标名字按 PATH×PATHEXT 解析成绝对路径。非该包装、非 Windows、找不到目标
 * (内建命令/不存在的名字)都原样返回,不猜。 */
export function managedExecutionArgs(command: string, args: readonly string[], options?: {
  platform?: string; cwd?: string; env?: NodeJS.ProcessEnv; existsSync?: (candidate: string) => boolean
}): string[]
/** 单独解析 cmd /c 的目标名字;找不到可执行文件(内建命令/不存在都算)返回 null。 */
export function cmdTargetPath(target: string, options?: {
  platform?: string; cwd?: string; env?: NodeJS.ProcessEnv; existsSync?: (candidate: string) => boolean
}): string | null
/** SCHED-TEST-CATEGORY-MISMATCH-FAILFAST:识别「cmd /c vitest …」包装,返回 vitest 的子命令参数
 * (不含 vitest 本体);非该包装返回 null。 */
export function vitestSubcommand(command: string, args?: readonly string[]): string[] | null
/** 只有两个合法用法之外的「cmd /c vitest …」类别都会被 exec 的挂号前预检拒绝(vitest bench 配
 * perf-bench 例外);这个常量与函数给出 submit 侧按作业类型的同口径预检。 */
export const TEST_LIKE_WORK_TYPES: readonly string[]
/** 作业类型属于单测而类别不是 unit-test 时抛 ClientError,消息带可直接复制的重挂形式;其余放行。 */
export function assertCategoryMatchesWorkType(category: string, workType: string): void
/** SCHED-CORES-HISTORY-AUTOCORRECT-1010:同类活统计键,与派单员侧 sched-usage-history.ts 同名同逻辑;
 *  total 长 >120 字符时截到 120(与请求字段同判据)。 */
export function usageKeyFor(input: { project: string; workType: string; command?: string; args?: readonly string[] }): string
/** 最近邻秩 90 分位:升序第 ceil(0.9×n) 个;空表返回 null。 */
export function nearestRankP90(values: readonly number[]): number | null
/** 核数显示:整数不带小数点,非整数保留一位小数(读数是 0.1 核粒度)。 */
export function formatCores(value: number): string
/** 按历史实测判断申请核数要不要改小(只改小不改大);changed 时 reason 是给 stdout 的提醒行原文。 */
export function suggestCores(input: { requested: number; peaks: readonly number[]; strict?: boolean; minHistory?: number; label?: string }): { cores: number; changed: boolean; p90: number | null; reason: string | null }
/** 读统计文件同键最近 limit 个执行的 peakCores;文件缺失、内容坏、键不存在都返回空表。 */
export function readUsagePeaks(share: string, key: string, limit?: number): number[]
/** purpose 缺省为 start，只允许 running；revalidate 供已运行消费者复核，同一许可在 paused/slow 仍有效。
 * acceptanceGroup 只让单测核验 codex-acceptance/acceptance 许可；仍须属于票据包装器的真实整组执行树。
 * 拒绝分支的 state 只在「许可当前不在执行状态」时带回票据状态(两种 purpose 都带)，供入口闸做有界重探；客户端不等待。 */
export function validatePermit(options: RuntimeOptions & { category: Category; cores: number; consumerDir?: string; workTypes?: readonly string[]; consumerRoot?: 'stryker'; acceptanceGroup?: boolean; purpose?: 'start' | 'revalidate' }): { ok: true; permit: Permit } | { ok: false; reason: string; unavailable?: true; osProbeUnavailable?: true; state?: string }
export function acquireSmallJob(options: RuntimeOptions & { cores: number; poolDir?: string; probe?: (pid: number, signal: 0) => unknown }): Promise<{ ok: true; release: () => void } | { ok: false; reason: string }>
export function main(argv?: string[], dependencies?: { ciObserver?: AgentCiObserver }): Promise<number>
declare const client: {
  CLIENT_VERSION: typeof CLIENT_VERSION; SCHED_FORMAT_VERSION: typeof SCHED_FORMAT_VERSION
  HOST_SMALL_JOB_POOL_CORES: typeof HOST_SMALL_JOB_POOL_CORES; SAFE_SEGMENT: typeof SAFE_SEGMENT; USAGE: typeof USAGE
  RENAME_RETRY_DELAYS_MS: typeof RENAME_RETRY_DELAYS_MS; BEAT_FAILURE_TOLERANCE_MS: typeof BEAT_FAILURE_TOLERANCE_MS
  renameWithRetry: typeof renameWithRetry
  canonicalJson: typeof canonicalJson; contentHash: typeof contentHash; rawContentHash: typeof rawContentHash
  deriveTicketId: typeof deriveTicketId; validateSubmission: typeof validateSubmission; validateCommand: typeof validateCommand
  validateReport: typeof validateReport; assertWritableFormat: typeof assertWritableFormat; contentFingerprint: typeof contentFingerprint
  submit: typeof submit; waitFor: typeof waitFor; cancel: typeof cancel; finish: typeof finish; status: typeof status; run: typeof run
  validatePermit: typeof validatePermit; acquireSmallJob: typeof acquireSmallJob; ClientError: typeof ClientError; main: typeof main
  autoIdempotencyKey: typeof autoIdempotencyKey; autoCodeRef: typeof autoCodeRef
  resolveWindowsExecutable: typeof resolveWindowsExecutable; exec: typeof exec
  extractFailureItems: typeof extractFailureItems; timeoutAdvice: typeof timeoutAdvice
  queuePosition: typeof queuePosition; awaitQueuePosition: typeof awaitQueuePosition; QUEUE_POSITION_FRESH_WAIT_MS: typeof QUEUE_POSITION_FRESH_WAIT_MS
  managedExecutionArgs: typeof managedExecutionArgs; cmdTargetPath: typeof cmdTargetPath
  vitestSubcommand: typeof vitestSubcommand; TEST_LIKE_WORK_TYPES: typeof TEST_LIKE_WORK_TYPES
  assertCategoryMatchesWorkType: typeof assertCategoryMatchesWorkType
  CLIENT_INFRA_SOURCE_PREFIXES: typeof CLIENT_INFRA_SOURCE_PREFIXES; REASON_TEXT: typeof REASON_TEXT
  trunkHeadFile: typeof trunkHeadFile; remoteLogPath: typeof remoteLogPath; remoteExitCode: typeof remoteExitCode
  writeCancelCommand: typeof writeCancelCommand; extractArtifactZip: typeof extractArtifactZip; ensureInfoExclude: typeof ensureInfoExclude
  WAITING_BEAT_INTERVAL_MS: typeof WAITING_BEAT_INTERVAL_MS; WAITING_ABANDONED_REASON: typeof WAITING_ABANDONED_REASON
  GRANTED_WAITING_ABANDONED_REASON: typeof GRANTED_WAITING_ABANDONED_REASON; waitingBeatFile: typeof waitingBeatFile
  usageKeyFor: typeof usageKeyFor; nearestRankP90: typeof nearestRankP90; formatCores: typeof formatCores
  suggestCores: typeof suggestCores; readUsagePeaks: typeof readUsagePeaks
}
export default client
