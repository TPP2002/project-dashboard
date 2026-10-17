/** HUB0 总开关解析的类型侧车;运行时只加载 sched-hub-switch.cjs。 */
/** 设计正本 §七 的开关形状。 */
export interface HubSwitch {
  readonly schema: 1
  readonly portable: 'on' | 'off'
  /** 看板 id(别名已规范化;没登记的保留原样)。 */
  readonly projects: readonly string[]
  /** 菜单项 id,不分项目:可搬名单 = projects × workTypes。 */
  readonly workTypes: readonly string[]
  readonly managedLoad: boolean
  readonly ciBorrow: boolean
  readonly infraOffload: boolean
  /** 内存下限闸(SCHED-MR6-MEMORY-DIMENSION-0924);关 = 派单员完全不碰内存读数。 */
  readonly memoryFloor: boolean
  /** 按同类活历史实测自动改小申请核数(SCHED-CORES-HISTORY-AUTOCORRECT-1010);关 = 挂号端原申请放行。 */
  readonly coresHistoryCorrect: boolean
}
export type HubSwitchFailure = 'missing' | 'invalid-input' | 'bad-json' | 'not-object' | 'unknown-schema' | 'bad-field'
export type HubSwitchParse =
  | { readonly ok: true; readonly warnings: readonly string[]; readonly value: HubSwitch }
  | { readonly ok: false; readonly reason: HubSwitchFailure; readonly detail: string; readonly warnings: readonly string[]; readonly value: HubSwitch }
export const HUB_SWITCH_SCHEMA: 1
/** 全关;任何失败都返回这一个冻结对象。 */
export const ALL_OFF: HubSwitch
/** 解析开关文件内容;null/undefined 表示读不到。永不抛错,失败一律全关。 */
export function parseHubSwitch(text: string | Uint8Array | null | undefined): HubSwitchParse
/** 开关名单是否许这个项目的这个菜单项搬(菜单属性另由 sched-menu.cjs 判);项目可写别名。 */
export function portableAllowed(value: HubSwitch | null | undefined, project: unknown, item: unknown): boolean
declare const hub: {
  HUB_SWITCH_SCHEMA: typeof HUB_SWITCH_SCHEMA; ALL_OFF: typeof ALL_OFF
  parseHubSwitch: typeof parseHubSwitch; portableAllowed: typeof portableAllowed
}
export default hub
