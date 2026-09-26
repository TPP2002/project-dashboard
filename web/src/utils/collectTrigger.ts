// 「待收单」卡的收单指令取数(前端版)。
// 正本 = core/collectTrigger.cjs,经 vite 虚拟模块 'virtual:board-schema' 内联进来:
// 卡上 collectBrief 存了完整指令就原样用;没存才按同一份模板拼兜底句 —— CLI 打出来的、
// 任务书引用的和网页复制出去的必须一字不差,所以前端只准用这一份,不许在组件里另拼字符串。
import { COLLECT_TRIGGER_TEMPLATE, NO_JOBS_TEXT, OUTCOME_TEXT } from 'virtual:board-schema'
import type { Task } from '@/types'

export { OUTCOME_TEXT }

/** 有卡号就能取;collectBrief / awaitCollect 都可缺省。 */
export type CollectInstructionTask = {
  id: string
  awaitCollect?: Task['awaitCollect']
  collectBrief?: Task['collectBrief']
}

/** 卡上该用的收单指令:有 collectBrief.text 原样返回,否则按模板拼兜底句,与 core 版逐字等价。 */
export function collectInstructionOf(projectId: string, task: CollectInstructionTask): string {
  const brief = task.collectBrief
  if (brief && typeof brief.text === 'string' && brief.text) return brief.text
  const jobs = (task.awaitCollect?.jobs || [])
    .map((j) => `${j.slug}(${OUTCOME_TEXT[j.outcome] || j.outcome})`)
    .join('、')
  return COLLECT_TRIGGER_TEMPLATE
    .split('{taskId}').join(task.id)
    .split('{projectId}').join(projectId)
    .split('{jobs}').join(jobs || NO_JOBS_TEXT)
}

/** 卡上存没存过完整收单指令(collectBrief.text 为非空字符串即算存过),与 core 版同口径。 */
export function hasCollectBrief(task: { collectBrief?: Task['collectBrief'] }): boolean {
  const brief = task.collectBrief
  return !!brief && typeof brief.text === 'string' && !!brief.text
}
