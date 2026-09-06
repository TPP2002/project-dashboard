// 图标动效三档：关 / 微 / 活泼（默认活泼）。
//
// 分工约定：本模块只回答「此刻该不该动」，不碰任何具体动画——动画本身写在 StatusTile.vue 的样式里，
// 组件只读 effectiveMotion 决定加不加动效 class。这样「三档设置」「减少动效」「同屏过多降档」
// 三条降级规则集中在一处，不散落到每个组件里各判一次。
//
// 三条降级规则，从强到弱：
//   1. 系统开了「减少动效」→ 一律当「关」，用户的档位设置保留但不生效（无障碍优先，不给覆盖开关）。
//   2. 同屏可见的动效瓦片超过 CROWD_LIMIT → 「活泼」自动降到「微」（长列表滚动时不至于几百个动画一起跑）。
//   3. 否则按用户选的档位。
import { computed, ref, watchEffect } from 'vue'

export type MotionMode = 'off' | 'calm' | 'lively'

export const MOTION_MODES: ReadonlyArray<{ id: MotionMode; label: string; hint: string }> = [
  { id: 'off', label: '关', hint: '全部静止' },
  { id: 'calm', label: '微', hint: '只有待拍板 / 施工中 / 暂缓 循环' },
  { id: 'lively', label: '活泼', hint: '全部循环（默认）' },
]

/** 同屏动效瓦片的上限：超过就把「活泼」降到「微」。 */
export const CROWD_LIMIT = 40

const MOTION_KEY = 'board-icon-motion'

function isMotionMode(value: unknown): value is MotionMode {
  return value === 'off' || value === 'calm' || value === 'lively'
}

function loadMode(): MotionMode {
  try {
    const stored = localStorage.getItem(MOTION_KEY)
    if (isMotionMode(stored)) return stored
  } catch (_) { /* 禁用站点存储时用默认档，只是刷新后记不住。 */ }
  return 'lively'
}

/** 用户选的档位（外观面板绑定这份）。 */
export const iconMotion = ref<MotionMode>(loadMode())

/** 系统「减少动效」偏好。 */
export const reducedMotion = ref(false)

/** 当前进入视口、且在「活泼」档下会动的瓦片数。 */
const visibleAnimatedTiles = ref(0)

/** 真正生效的档位：把三条降级规则合成一个值，组件只读这个。 */
export const effectiveMotion = computed<MotionMode>(() => {
  if (reducedMotion.value) return 'off'
  if (iconMotion.value === 'lively' && visibleAnimatedTiles.value > CROWD_LIMIT) return 'calm'
  return iconMotion.value
})

export function setIconMotion(mode: MotionMode) {
  iconMotion.value = mode
  try { localStorage.setItem(MOTION_KEY, mode) }
  catch (_) { /* 同上：存不下就只在本页生效。 */ }
}

/** 瓦片进入 / 离开视口时调用，用来维护「同屏几个在动」的计数。 */
export function trackVisibleTile(visible: boolean) {
  visibleAnimatedTiles.value = Math.max(0, visibleAnimatedTiles.value + (visible ? 1 : -1))
}

// 把生效档位挂到根节点上，供纯 CSS 的动效（不由 StatusTile 管的那些）跟着一起降档。
if (typeof document !== 'undefined') {
  watchEffect(() => { document.documentElement.dataset.iconMotion = effectiveMotion.value })
}

// 监听系统「减少动效」：跟随系统实时变，用户中途在系统设置里打开也立刻静止。
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)')
  reducedMotion.value = query.matches
  const onChange = (event: MediaQueryListEvent) => { reducedMotion.value = event.matches }
  if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange)
  else query.addListener(onChange) // Safari < 14 仍只有旧接口。
}
