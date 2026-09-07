import type { DayNight, WorkfloorSettings } from './types'

/** hour 为本机小时；06:00 含、18:00 不含。不读时钟、主题存档或 DOM。 */
export function resolveDayNight(setting: WorkfloorSettings['dayNight'], theme: 'light' | 'dark', hour: number): DayNight {
  if (setting === 'night') return 'night'
  if (setting === 'clock') return hour >= 6 && hour < 18 ? 'day' : 'night'
  return theme === 'light' ? 'day' : 'night'
}
