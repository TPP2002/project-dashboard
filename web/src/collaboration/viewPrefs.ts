const KEYS = ['dashboard.laneSort', 'dashboard.myLane'] as const
function checkKey(key: string) {
  if (!KEYS.some(allowed => allowed === key)) throw new Error('不支持的视图偏好')
}
export function readViewPref(key: string, fallback: string): string {
  checkKey(key)
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}
export function writeViewPref(key: string, value: string): void {
  checkKey(key)
  try { localStorage.setItem(key, value) } catch { /* Keep the in-memory preference. */ }
}
