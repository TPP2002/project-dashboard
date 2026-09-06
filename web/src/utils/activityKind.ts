// 活动流水的八种动作：图标 + 人话名字。
// 活动流页与每日成果页原先各自硬编码了一份（一份只有图标、一份图标加标签），
// 改一处漏一处，这里收成一份唯一的表，两边都读它。
import type { IconName } from '@/icons/paths'

export interface ActivityKind {
  readonly icon: IconName
  /** 给负责人看的名字。流水里的 type 是英文键（claim / park…），不能直接摆到界面上。 */
  readonly label: string
}

export const ACTIVITY_KINDS = {
  claim: { icon: 'hand', label: '认领' },
  progress: { icon: 'trending', label: '进度更新' },
  pending: { icon: 'bell', label: '登记待拍板' },
  decide: { icon: 'check', label: '拍板' },
  done: { icon: 'checks', label: '完工' },
  park: { icon: 'parkingNote', label: '暂缓' },
  block: { icon: 'ban', label: '阻塞' },
  note: { icon: 'pencil', label: '备注' },
} as const satisfies Record<string, ActivityKind>

/** 认不出的动作类型退回一枚中性的「有条记录」图标，名字就用原始 type，不吞掉信息。 */
export function activityKind(type: string | undefined): ActivityKind {
  return ACTIVITY_KINDS[type as keyof typeof ACTIVITY_KINDS] ?? { icon: 'activity', label: type || '动作' }
}
