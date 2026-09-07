export type Tick = (dt: number, elapsed: number) => void
export interface Runtime {
  start(tick: Tick): void
  stop(): void
  setPaused(reason: string, on: boolean): void
  readonly paused: boolean
  readonly reducedMotion: boolean
  destroy(): void
}

/** 单一 rAF、毫秒累计，最多每 1000/30ms 更新一次；暂停恢复不追赶历史时间。 */
export function createRuntime(host: Element, onReducedMotion: (value: boolean) => void): Runtime {
  const doc = host.ownerDocument
  const win = doc.defaultView!
  const motion = win.matchMedia('(prefers-reduced-motion: reduce)')
  const reasons = new Set<string>()
  let callback: Tick | null = null
  let frame: number | null = null
  let last: number | null = null
  let accumulated = 0
  let elapsed = 0
  let destroyed = false
  const interval = 1000 / 30

  function cancel() {
    if (frame !== null) win.cancelAnimationFrame(frame)
    frame = null
    last = null
    accumulated = 0
  }
  function schedule() {
    if (!destroyed && callback && !reasons.size && frame === null) frame = win.requestAnimationFrame(step)
  }
  function step(now: number) {
    frame = null
    if (destroyed || !callback || reasons.size) return
    if (last !== null) accumulated += Math.max(0, now - last)
    last = now
    if (accumulated + 0.001 >= interval) {
      // 卡顿最多推进 100ms；余数只保留不足一帧的部分，不做补帧循环。
      const frames = Math.floor((accumulated + .001) / interval)
      const dt = Math.min(frames * interval, 100)
      accumulated = Math.max(0, accumulated - frames * interval)
      elapsed += dt
      callback(dt, elapsed)
    }
    schedule()
  }
  function setPaused(reason: string, on: boolean) {
    if (reasons.has(reason) === on) return
    if (on) reasons.add(reason)
    else reasons.delete(reason)
    cancel()
    schedule()
  }
  function visibility() { setPaused('hidden', doc.hidden) }
  function preference() {
    setPaused('reduced-motion', motion.matches)
    onReducedMotion(motion.matches)
    callback?.(0, elapsed)
  }
  visibility()
  if (motion.matches) reasons.add('reduced-motion')
  doc.addEventListener('visibilitychange', visibility)
  motion.addEventListener('change', preference)
  // 首次交集结果前只画静态首帧，不给离屏横幅偷跑一轮动画。
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    const entry = entries.find(entry => entry.target === host)
    if (entry) setPaused('offscreen', !entry.isIntersecting)
  }) : null
  if (observer) { reasons.add('offscreen'); observer.observe(host) }

  return {
    start(tick) {
      if (destroyed) return
      cancel()
      callback = tick
      elapsed = 0
      tick(0, 0)
      schedule()
    },
    stop() { callback = null; cancel() },
    setPaused,
    get paused() { return reasons.size > 0 },
    get reducedMotion() { return motion.matches },
    destroy() {
      if (destroyed) return
      destroyed = true
      callback = null
      cancel()
      observer?.disconnect()
      doc.removeEventListener('visibilitychange', visibility)
      motion.removeEventListener('change', preference)
    },
  }
}
