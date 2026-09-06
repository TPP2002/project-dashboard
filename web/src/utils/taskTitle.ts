// 三层结构（id / plainTitle 人话 / title 技术说明）的统一读取入口。
// 全站原先各页各写一份"plainTitle || title"，这里收口成一个函数，行为才不会走样。
import type { Task } from '@/types'

const PLAIN_TITLE_TRUNCATE_LEN = 60

type TitleFields = Pick<Task, 'title' | 'plainTitle'>

/** 给人看的标题：有 plainTitle 用它；老卡没有就把技术说明截 60 字应急，不整段糊脸上。 */
export function humanTitle(t: TitleFields): string {
  if (t.plainTitle) return t.plainTitle
  const title = t.title || ''
  return title.length > PLAIN_TITLE_TRUNCATE_LEN ? title.slice(0, PLAIN_TITLE_TRUNCATE_LEN) + '…' : title
}

/** 给模型看的技术说明原文，只在需要展开细节的地方读它。 */
export function specText(t: Pick<Task, 'title'>): string {
  return t.title
}

/** 老卡没有人话标题——用来决定要不要露出"补充"入口。 */
export function missingPlainTitle(t: Pick<Task, 'plainTitle'>): boolean {
  return !t.plainTitle
}

/** 补人话标题的命令：AUD-CLI-LIFECYCLE-CMDS 的专用 edit 落地前，通用 set 是唯一入口。 */
export function plainTitleFixCommand(projectId: string, taskId: string): string {
  return `node ~/.claude/dashboard-release/cli/index.cjs set ${taskId} --project ${projectId} --field plainTitle --value "在此填一句人话"`
}
