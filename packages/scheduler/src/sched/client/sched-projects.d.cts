/** HUB0 项目注册表的类型侧车;运行时只加载 sched-projects.cjs(客户端、派单员、执行端共用)。 */
/** §6.2 的类别:vitest 同机同时一件,shared 可并发,solo 独占。 */
export type MenuCategory = 'vitest' | 'shared' | 'solo'
/** 弹性核数(§6.2、C2:保底 min、上限 max)。 */
export interface ElasticCores { readonly min: number; readonly max: number }
/** 受限参数文法;sched-menu.cjs 的识别与执行端复核都按它校验。 */
export type ArgsGrammar =
  | { readonly kind: 'none' }
  | { readonly kind: 'paths' }
  | { readonly kind: 'build-flags' }
  | { readonly kind: 'gradle' }
  | { readonly kind: 'safe-args' }
  | { readonly kind: 'tool-config'; readonly tools: readonly string[] }
  | { readonly kind: 'choice'; readonly values: readonly string[] }
/** 一种命令写法:cmd 是前缀(第一个词是规范化后的命令词);tail 定前缀后能跟什么。 */
export interface MenuForm {
  readonly cmd: readonly string[]
  readonly tail: 'none' | 'npm' | 'args'
  /** 插在受限参数最前面的固定参数。 */
  readonly emit?: readonly string[]
  /** 必须出现、认出后吃掉的开关(如 tsc 的 --noEmit)。 */
  readonly require?: readonly string[]
  /** 可以出现、认出后丢掉的开关(执行端按授予核数重新加)。 */
  readonly drop?: readonly 'maxWorkers'[]
  /** 开关改名(如 --project 记成 -p)。 */
  readonly alias?: Readonly<Record<string, string>>
  /** 比菜单项更严的写法级文法,只校验用户给的那部分。 */
  readonly args?: ArgsGrammar
}
export type PinReason = 'install-deps' | 'needs-android-sdk'
export type CiBorrowable = 'always' | 'targeted' | 'never'
export interface MenuItem {
  readonly id: string
  readonly category: MenuCategory
  readonly cores: number | ElasticCores
  /** §5.2 第二道判据;false 时 pinReason 给原因码。 */
  readonly portable: boolean
  readonly pinReason: PinReason | null
  /** §5.8 执行机失联后能否另开一次执行。 */
  readonly rerunnable: boolean
  /** §6.8 能否借闲着的核并在回收时让路;targeted 仅目标全为测试文件。 */
  readonly ciBorrowable: CiBorrowable
  /** 硬超时(整数分钟),缺省=本项不限时(SCHED-MENU-HARD-TIMEOUT-0924);只对 auto 单生效。
   * rogue 的菜单项一律不写:它有 JOB_HARD_TIMEOUT_MS 兜底,写了会改掉它的判据。 */
  readonly hardTimeoutMin?: number
  /** §5.6 要回送的产物,仓库内相对路径。 */
  readonly artifacts: readonly string[]
  /** 菜单声明的环境变量名(§5.4、审稿 R2),值用执行机自己的。 */
  readonly env: readonly string[]
  readonly args: ArgsGrammar
  readonly forms: readonly MenuForm[]
}
export type Intake = 'batch-1' | 'batch-2' | 'registered' | 'deps-unlocked' | 'not-applicable' | 'merged'
export interface ProjectRecord {
  /** 看板 id。 */
  readonly id: string
  readonly aliases: readonly string[]
  /** 看板上的项目名。 */
  readonly title: string
  /** 主机上的主目录(看板登记的主仓,正斜杠)。 */
  readonly repo: string
  /** 'github:<所有者>/<仓库>'、'bare:<裸库路径>',没有远端为 null。 */
  readonly remote: string | null
  /** 主干分支;不是 git 仓库为 null。 */
  readonly trunk: string | null
  readonly runtime: { readonly node: string | null; readonly python: string | null; readonly other: readonly string[] }
  readonly deps: { readonly manifests: readonly string[]; readonly install: readonly (readonly string[])[] | null } | null
  /** 允许的执行机(机器名);不接的项目为空。 */
  readonly machines: readonly string[]
  /** 仅为明确配置的项目在候选机准入后排序;未配置保持原选机顺序。 */
  readonly preferredMachines?: readonly string[]
  readonly accepted: boolean
  readonly intake: Intake
  readonly mergedInto: string | null
  readonly note: string
  readonly menu: readonly MenuItem[]
}
export const HOST_MACHINE: string | null
export const SPARE_MACHINE: string | null
export const PROJECTS: readonly ProjectRecord[]
export const PROJECT_IDS: readonly string[]
/** 看板 id 与别名规范化:认得的返回看板 id,不认得的原样返回并标未登记;非字符串给空 id。 */
export function normalizeProjectId(id: unknown): { id: string; registered: boolean }
export function getProject(id: unknown): ProjectRecord | null
export function getMenuItem(project: unknown, item: unknown): MenuItem | null
declare const projects: {
  HOST_MACHINE: typeof HOST_MACHINE; SPARE_MACHINE: typeof SPARE_MACHINE; PROJECTS: typeof PROJECTS; PROJECT_IDS: typeof PROJECT_IDS
  normalizeProjectId: typeof normalizeProjectId; getProject: typeof getProject; getMenuItem: typeof getMenuItem
}
export default projects
