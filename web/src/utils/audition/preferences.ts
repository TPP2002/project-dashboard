export interface AuditionPreferences { volume: number; seed: number; blind: boolean; shelfCollapsed: boolean; railCollapsed: boolean }
export const DEFAULT_PREFERENCES: AuditionPreferences = { volume: 70, seed: 1, blind: false, shelfCollapsed: false, railCollapsed: false }
export const validSeed = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647
export function normalizePreferences(raw: unknown): AuditionPreferences {
  const data = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  return {
    volume: typeof data.volume === 'number' && Number.isFinite(data.volume) && data.volume >= 0 && data.volume <= 100 ? data.volume : 70,
    seed: validSeed(data.seed) ? data.seed : 1,
    blind: typeof data.blind === 'boolean' ? data.blind : false,
    shelfCollapsed: typeof data.shelfCollapsed === 'boolean' ? data.shelfCollapsed : false,
    railCollapsed: typeof data.railCollapsed === 'boolean' ? data.railCollapsed : false,
  }
}
const KEY = 'board-audition-preferences'
export function loadPreferences(): AuditionPreferences {
  try { return normalizePreferences(JSON.parse(localStorage.getItem(KEY) || 'null')) }
  catch { return { ...DEFAULT_PREFERENCES } }
}
export function savePreferences(value: AuditionPreferences): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(normalizePreferences(value))); return true }
  catch { return false }
}
