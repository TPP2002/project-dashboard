export const ACCEPTANCE_KIND_LABELS = Object.freeze({
  'test:targeted': '跑了指定的那部分测试',
  'test:fast': '跑了全部测试',
  typecheck: '检查代码有没有写错类型',
  lint: '检查代码/文案格式',
  'lint:content': '检查代码/文案格式',
  'docs:index:check': '检查文档目录对不对得上',
  manual: '需要人工核对(机器没法自动查)',
})

export const SELF_REPORT_STATUS_LABELS = Object.freeze({
  completed: '它说做完了',
  partial: '它说只做了一部分',
  failed: '它说没做成',
})

/** @param {{ kind?: string | null, id?: string | null }} item */
export function acceptanceLabel(item) {
  const kind = typeof item.kind === 'string' ? item.kind.trim() : ''
  if (kind) return ACCEPTANCE_KIND_LABELS[kind] || kind
  return typeof item.id === 'string' && item.id.trim() ? item.id : '检查结果'
}

/** @param {string | null | undefined} status */
export function selfReportStatusLabel(status) {
  const value = typeof status === 'string' ? status.trim().toLowerCase() : ''
  return SELF_REPORT_STATUS_LABELS[value] || '它还没有明确说明是否做完'
}

/** @param {{ running: boolean, collected: boolean, passed: boolean | null }} job */
export function jobGroupKey(job) {
  if (job.running) return 'running'
  if (!job.collected) return 'waiting'
  if (job.passed) return 'completed'
  return 'rejected'
}
