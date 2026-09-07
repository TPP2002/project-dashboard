import { ref } from 'vue'
import { spectrumRevision } from './spectrum'

export type ThemeChoice = 'light' | 'dark' | 'system'
export const THEMES: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
  { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'system', label: '跟随系统' },
]
const THEME_KEY = 'board-theme'

function readTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY)
    if (THEMES.some(option => option.value === value)) return value as ThemeChoice
  } catch (_) { /* 站点存储不可用时跟随系统。 */ }
  return 'system'
}

/** 下拉与大面板共用一份选择，沿用已有存储键。 */
export const theme = ref<ThemeChoice>(readTheme())

function applyTheme(persistNow = true) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme.value === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme.value)
  // 进度环回读的是实色，主题改变后也要重读，尤其是随主题取色的单色预设。
  spectrumRevision.value += 1
  if (persistNow) {
    try { localStorage.setItem(THEME_KEY, theme.value) }
    catch (_) { /* 存不下时保留当前页的主题选择。 */ }
  }
}

export function setTheme(value: ThemeChoice) {
  theme.value = THEMES.some(option => option.value === value) ? value : 'system'
  applyTheme()
}

if (typeof document !== 'undefined') applyTheme(false)
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const sync = () => { if (theme.value === 'system') spectrumRevision.value += 1 }
  if (typeof query.addEventListener === 'function') query.addEventListener('change', sync)
  else query.addListener(sync)
}
