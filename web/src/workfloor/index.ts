import type { SceneEvent, SceneHandle, SceneOptions, WorldId } from './types'
import { createRuntime } from './runtime'
import { ensureDefs, removeDefs } from './fx/defs'
import { registry } from './scenes/registry'

export type * from './types'
export interface WorkfloorOptions extends Omit<SceneOptions, 'reducedMotion'> {
  world: WorldId
  collapsed: boolean
  onError: (error: unknown) => void
  /** 展示时间，供完工同秒合并与派生事件时间戳使用；不影响任务状态。 */
  now?: () => number
}
export interface WorkfloorHandle {
  update(options: WorkfloorOptions): void
  handleEvent(event: SceneEvent): void
  destroy(): void
}

/** 接管一个已挂载 SVG；只订阅运行环境，不订阅看板。destroy 可重复调用。 */
export function createWorkfloor(host: SVGSVGElement, options: WorkfloorOptions): WorkfloorHandle {
  let latest = options
  let scene: SceneHandle | null = null
  let destroyed = false, generation = 0, mountedKey = '', targetKey = ''
  let animation: Animation | null = null
  let reconcile = false, elapsed = 0
  const doneSeconds = new Set<number>()
  const defs = ensureDefs(host)
  const runtime = createRuntime(host, reduced => {
    if (reduced) animation?.finish()
    scene?.setReducedMotion(reduced)
    if (mountedKey === targetKey) scene?.setState(latest.state)
  })
  const key = (value: WorkfloorOptions) => `${value.world}:${value.state.projectId}`
  const clock = () => (latest.now ?? Date.now)()

  function apply() {
    if (!scene) return
    scene.setDayNight(latest.dayNight)
    scene.setDetail(latest.detail)
    scene.setHeight(latest.height)
    scene.setReducedMotion(runtime.reducedMotion)
    scene.setSound(latest.sound)
    scene.setState(latest.state)
  }
  function tick(dt: number, time: number) {
    elapsed = time
    if (!scene || mountedKey !== targetKey) return
    if (reconcile) { scene.setState(latest.state); reconcile = false }
    defs.tick(time, runtime.reducedMotion)
    scene.tick(dt, time)
  }
  async function fade(to: number) {
    animation?.cancel()
    if (runtime.reducedMotion || latest.collapsed || host.ownerDocument.hidden) { host.style.opacity = String(to); return }
    const current = host.ownerDocument.defaultView!.getComputedStyle(host).opacity
    const own = host.animate([{ opacity: current }, { opacity: String(to) }], { duration: 300, easing: 'ease', fill: 'forwards' })
    animation = own
    try { await own.finished }
    catch (error) { if (own.playState !== 'idle') throw error /* 新切换取消旧过渡是预期路径。 */ }
    if (animation === own) {
      host.style.opacity = String(to)
      own.cancel()
      animation = null
    }
  }
  async function switchScene(version: number) {
    runtime.stop()
    runtime.setPaused('transition', true)
    doneSeconds.clear()
    if (scene) await fade(0)
    else host.style.opacity = '0'
    if (destroyed || version !== generation) return
    scene?.destroy()
    scene = null
    mountedKey = ''
    const module = await registry[latest.world]()
    if (destroyed || version !== generation) return
    scene = module.createScene(host, { ...latest, reducedMotion: runtime.reducedMotion })
    mountedKey = targetKey
    apply()
    reconcile = false
    runtime.start(tick)
    await fade(1)
    if (!destroyed && version === generation) runtime.setPaused('transition', false)
  }
  function handleEvent(event: SceneEvent) {
    if (destroyed || !scene || mountedKey !== targetKey || event.projectId !== latest.state.projectId) return
    let animate = !runtime.paused && !runtime.reducedMotion && !latest.collapsed
    if (event.kind === 'done') {
      const parsed = Date.parse(event.ts)
      const second = Math.floor((Number.isFinite(parsed) ? parsed : clock()) / 1000)
      if (doneSeconds.has(second)) animate = false
      doneSeconds.add(second)
      if (doneSeconds.size > 32) doneSeconds.delete(doneSeconds.values().next().value!)
    }
    scene.handleEvent(event, animate)
    // 事件不能成为第二份业务状态；动效下一帧、静态模式当下均回到最新快照。
    reconcile = true
    if (!animate) { scene.setState(latest.state); tick(0, elapsed) }
  }
  function update(next: WorkfloorOptions) {
    if (destroyed) return
    const wasComplete = latest.state.complete
    latest = next
    runtime.setPaused('collapsed', next.collapsed)
    if (targetKey !== key(next)) {
      targetKey = key(next)
      const version = ++generation
      void switchScene(version).catch(error => {
        if (destroyed || version !== generation) return
        runtime.stop()
        latest.onError(error)
      })
    } else if (scene && mountedKey === targetKey) {
      apply()
      if (!wasComplete && next.state.complete) handleEvent({ kind: 'complete', projectId: next.state.projectId, taskId: '', ts: new Date(clock()).toISOString() })
      if (runtime.paused) tick(0, elapsed)
    }
  }
  update(options)
  return {
    update, handleEvent,
    destroy() {
      if (destroyed) return
      destroyed = true
      generation++
      animation?.cancel()
      runtime.destroy()
      scene?.destroy()
      removeDefs(host)
      host.style.removeProperty('opacity')
    },
  }
}
