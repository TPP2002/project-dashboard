/** HUB0 命令识别的类型侧车;运行时只加载 sched-menu.cjs。 */
import type { ElasticCores, MenuCategory, PinReason } from './sched-projects.cjs'

/** 认不出细分到哪一步;原因码一律是 unknown-command(Q1:留本机跑,不算报错)。 */
export type UnknownWhy =
  | 'invalid-argv' | 'project-unregistered' | 'project-not-accepted' | 'shell-metachar' | 'command-path' | 'bad-argument' | 'no-match'
export interface Recognized {
  readonly recognized: true
  /** 看板 id(别名已规范化)。 */
  readonly project: string
  /** 菜单项 id。 */
  readonly item: string
  /** 受限参数:执行端按自己那份菜单还原命令用。 */
  readonly args: readonly string[]
  /** 菜单项能搬且 resources.exclusive 为空。 */
  readonly portable: boolean
  readonly pinReason: PinReason | 'exclusive-resource' | null
  readonly category: MenuCategory
  readonly cores: number | ElasticCores
}
export interface Unrecognized {
  readonly recognized: false
  readonly reason: 'unknown-command'
  readonly why: UnknownWhy
  readonly detail: string
  readonly project: string
}
export type Classification = Recognized | Unrecognized
export interface ClassifyOptions {
  /** 票据的 resources.exclusive;非空一律钉挂号机。 */
  readonly exclusive?: readonly string[]
}
export type MenuArgsCheck =
  | { readonly ok: true; readonly project: string; readonly item: string; readonly args: readonly string[] }
  | { readonly ok: false; readonly why: 'project-unregistered' | 'project-not-accepted' | 'no-such-item' | 'invalid-args' | 'shell-metachar' | 'bad-argument'; readonly detail: string }
export const SHELL_METACHARS: RegExp
export const SAFE_PATH: RegExp
/** 仓库内的安全相对路径:非空、不超过 200 字、不以 - 开头、不含 ..、不是绝对路径、只含安全字符。 */
export function isSafeRelativePath(value: unknown): boolean
/** 命令词规范化:去 ./、转小写、去 .exe/.cmd/.bat/.ps1,python3 与 py 当 python;非字符串给空串。 */
export function normalizeCommandWord(word: unknown): string
/** 把挂号命令(argv,命令词在前)与项目菜单比对;project 可写别名。 */
export function classifyCommand(project: unknown, argv: unknown, options?: ClassifyOptions): Classification
/** 执行端复核工单里的「菜单项 + 受限参数」;通过时给冻结的副本。 */
export function validateMenuArgs(project: unknown, item: unknown, args: unknown): MenuArgsCheck
declare const menu: {
  SHELL_METACHARS: typeof SHELL_METACHARS; SAFE_PATH: typeof SAFE_PATH; isSafeRelativePath: typeof isSafeRelativePath
  normalizeCommandWord: typeof normalizeCommandWord; classifyCommand: typeof classifyCommand; validateMenuArgs: typeof validateMenuArgs
}
export default menu
