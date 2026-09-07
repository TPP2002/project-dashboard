import type { DayNight, WorkfloorSettings } from './types'

const UI_KEY = 'board-workfloor-ui'

export function loadCollapsed(): boolean {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(UI_KEY) ?? 'null')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const value = (raw as Record<string, unknown>).collapsed
      if (typeof value === 'boolean') return value
    }
  } catch (_) { /* 存档损坏或禁用本机存储时只退回展开，不影响看板。 */ }
  return false
}

export function saveCollapsed(collapsed: boolean) {
  try { localStorage.setItem(UI_KEY, JSON.stringify({ collapsed })) }
  catch (_) { /* 本页仍生效，刷新后回到可读存档或默认展开。 */ }
}

export function resolveDayNight(mode: WorkfloorSettings['dayNight'], actualTheme: 'light' | 'dark', hour: number): DayNight {
  if (mode === 'night') return 'night'
  if (mode === 'clock') return hour >= 6 && hour < 18 ? 'day' : 'night'
  return actualTheme === 'light' ? 'day' : 'night'
}
