import type { DayNight } from './types'

/** 只消费宿主的可见帧时间；反向切换从当前比例继续，不额外创建循环。 */
export function createPaletteTransition(initial: DayNight, reduced: boolean, paint: (daylight: number) => void) {
  let value = initial === 'day' ? 1 : 0, from = value, target = value, age = 600
  let stationary = reduced
  paint(value)
  const finish = () => { age = 600; value = target; paint(value) }
  return {
    get daylight() { return value },
    setDayNight(next: DayNight) {
      const nextTarget = next === 'day' ? 1 : 0
      if (nextTarget === target) return
      from = value; target = nextTarget; age = 0
      if (stationary) finish()
    },
    setReducedMotion(next: boolean) { stationary = next; if (next && age < 600) finish() },
    tick(dt: number) {
      if (age >= 600 || stationary) return
      age = Math.min(600, age + Math.max(0, dt))
      const t = age / 600, eased = t * t * (3 - 2 * t)
      value = from + (target - from) * eased
      paint(value)
    },
  }
}

/** 只组合既有色站引用；端点直接用原色，避免多余的嵌套混色。 */
export function mixDaylight(night: string, day: string, daylight: number): string {
  if (daylight <= 0 || night === day) return night
  if (daylight >= 1) return day
  return `color-mix(in srgb, ${day} ${daylight * 100}%, ${night})`
}
