/** 参数为本地 HH:mm；静音区间左闭右开，起止相同表示不静音。 */
export function inQuietHours(nowHM: string, start: string, end: string): boolean {
  if (start === end) return false
  return start < end ? nowHM >= start && nowHM < end : nowHM >= start || nowHM < end
}

/** 时间与窗口均为毫秒；刚好到窗口末端可再次播放。 */
export function shouldThrottle(lastAt: number | undefined, now: number, windowMs = 1000): boolean {
  return lastAt !== undefined && now - lastAt < windowMs
}

/** 百分比音量限幅后映射到主增益，保留合成声音的余量。 */
export function toGain(volume: number): number {
  return Math.min(100, Math.max(0, volume)) / 100 * 0.6
}
