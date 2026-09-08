/** 分钟；卡片、抽屉与后续看板视图共用，达到阈值即进入该档。 */
export const DEFAULT_AGE_THRESHOLDS = [60, 240, 1440] as const

/** elapsedMs 为毫秒；阈值由设置入口保证是三个严格递增的正整数分钟。 */
export function ageLevel(elapsedMs: number, thresholdsMinutes: readonly number[] = DEFAULT_AGE_THRESHOLDS): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0
  if (elapsedMs >= thresholdsMinutes[2] * 60_000) return 3
  if (elapsedMs >= thresholdsMinutes[1] * 60_000) return 2
  if (elapsedMs >= thresholdsMinutes[0] * 60_000) return 1
  return 0
}

export function ageTone(level: ReturnType<typeof ageLevel>): 'n' | 'info' | 'warn' | 'bad' {
  return (['n', 'info', 'warn', 'bad'] as const)[level]
}
