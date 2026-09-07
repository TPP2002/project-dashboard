import type { SceneEvent, SceneFactory, SceneHandle, SceneState } from '../../types'
import { createHangar } from './hangar'
import { createBoard } from './board'
import { createRack } from './rack'
import { createMachine } from './machine'
import { createEffects, type EffectFrame } from './effects'
import { projectAssembly } from './assembly'
import { NAME_CN, ORDER } from './geometry'
import { clampPercent, ease, setAttrs } from './dom'
import type { Cue } from './pose'
import { createPaletteTransition } from '../../paletteTransition'

let serial = 0

/** 场景不读取 store、时钟或历史活动来推断进度；快照是唯一装配真相。 */
export const createMechScene: SceneFactory = (host, options): SceneHandle => {
  const prefix = `wf-mech-${++serial}-`
  const hangar = createHangar(host, prefix)
  const { root } = hangar
  const board = createBoard(root), rack = createRack(root, prefix), machine = createMachine(root)
  let state = options.state, detail = options.detail, reduced = options.reducedMotion
  let height = options.height, dayNight = options.dayNight
  let sound = options.sound, lastDoneSecond = -Infinity
  let pendingWeldTask: string | null = null
  const daylight = createPaletteTransition(dayNight, reduced, hangar.paintDaylight)
  let assembly = projectAssembly(state), previous = assembly
  let parkedTask: string | null = null, cue: Cue | null = null
  let elapsed = 0, destroyed = false, initialized = false, fingerprint = ''
  let weld = assembly.progress, weldFrom = weld, weldTarget = weld, weldAge = 600
  const initialFrame: EffectFrame = { detail, reducedMotion: reduced, dayNight, height, snap: true, weldingPoint: null, cue: null }
  const effects = createEffects(root, initialFrame, machine.illuminate)

  function describe() {
    const name = assembly.target ? NAME_CN[assembly.target] : ''
    const action = assembly.mode === 'powered' ? '通电悬浮' : assembly.mode === 'block' ? '部件阻塞'
      : assembly.mode === 'park' ? '无人机停机' : assembly.mode === 'pend' ? '等待检验'
        : assembly.mode === 'build' ? `正在焊${name} ${Math.round(weld)}%` : '等待开工'
    const label = `机甲装配：已装 ${assembly.installed}/29，${action}，${state.pending.length} 件待拍板`
    setAttrs(root, { 'aria-label': label })
    setAttrs(host, { 'aria-label': label })
  }
  function render(dt = 0, snap = false) {
    if (destroyed) return
    const weldingPoint = machine.tick(assembly, weld, elapsed, reduced, height, cue, dt)
    board.tick(dt, elapsed, reduced)
    effects.update(dt, assembly, { detail, reducedMotion: reduced, dayNight, height, snap, weldingPoint, cue })
    if (pendingWeldTask && assembly.task?.id === pendingWeldTask && assembly.mode === 'build' && cue?.kind !== 'claim') {
      pendingWeldTask = null; sound?.('weld')
    }
    describe()
  }
  function setState(next: SceneState) {
    if (destroyed) return
    const key = JSON.stringify(next)
    const changed = key !== fingerprint
    const reallocating = !initialized || next.total !== state.total || next.projectId !== state.projectId
    if (changed) previous = assembly
    if (!next.blocked.some(task => task.id === parkedTask)) parkedTask = null
    state = next
    const projected = projectAssembly(next, parkedTask)
    const moved = projected.target !== assembly.target || projected.task?.id !== assembly.task?.id
    if (reallocating || moved || reduced) {
      weld = weldFrom = weldTarget = projected.progress
      weldAge = 600
    } else if (weldTarget !== projected.progress) {
      weldFrom = weld
      weldTarget = projected.progress
      weldAge = 0
    }
    assembly = projected
    if (reallocating) cue = null
    // 仅保留与最新状态相容的动作。done 的白闪可以播，但不能冒充一块已装甲。
    if (cue && cue.kind !== 'done') {
      const compatible = cue.kind === 'complete' ? state.complete
        : cue.kind === 'hold' ? state.pending.some(task => task.id === cue!.taskId)
          : cue.kind === 'block' || cue.kind === 'park' ? state.blocked.some(task => task.id === cue!.taskId)
            : state.active[0]?.id === cue.taskId
      if (!compatible) cue = null
    }
    machine.setAssembly(assembly)
    board.update(state, assembly)
    rack.update(state, assembly.installed)
    fingerprint = key
    const snap = !initialized || reallocating || reduced
    initialized = true
    render(0, snap)
  }
  function handleEvent(event: SceneEvent, animate: boolean) {
    if (destroyed || event.projectId !== state.projectId) return
    const moving = animate && !reduced
    board.handleEvent(event, moving)
    if (event.kind === 'done') {
      if (pendingWeldTask === event.taskId) pendingWeldTask = null
      const stamp = Date.parse(event.ts), second = Math.floor((Number.isFinite(stamp) ? stamp : elapsed) / 1000)
      if (moving && second !== lastDoneSecond) {
        const part = assembly.task?.id === event.taskId ? assembly.target
          : previous.task?.id === event.taskId ? previous.target : ORDER[Math.max(0, assembly.installed - 1)]
        machine.queueDone({ kind: 'done', taskId: event.taskId, part, age: 0, pickup: rack.takePoint(event.taskId) })
        sound?.('done')
      }
      lastDoneSecond = second
      render(0, !moving)
      return
    }
    if (event.kind === 'park' && state.blocked.some(task => task.id === event.taskId)) parkedTask = event.taskId
    if (['claim', 'go', 'block', 'done'].includes(event.kind) && parkedTask === event.taskId) parkedTask = null
    if (event.kind === 'park' || event.kind === 'block' || event.kind === 'go') {
      assembly = projectAssembly(state, parkedTask)
      machine.setAssembly(assembly)
      board.update(state, assembly)
    }
    if (!moving) {
      // 同秒的其余完工只刷新真实计数，不取消正在播的第一次白闪。
      if (reduced) cue = null
      weld = weldFrom = weldTarget = assembly.progress
      weldAge = 600
      render(0, true)
      return
    }
    if (event.kind === 'block') { machine.alarm(); sound?.('alarm') }
    if (event.kind === 'hold') sound?.('hold')
    if (event.kind === 'go') sound?.('stamp')
    if (event.kind === 'complete') sound?.('complete')
    if (event.kind === 'claim' || event.kind === 'go') {
      if (state.active[0]?.id === event.taskId) pendingWeldTask = event.taskId
    }
    if (event.kind === 'progress') {
      if (event.taskId === assembly.task?.id && clampPercent(event.percent) === assembly.progress) {
        weldFrom = weld
        weldTarget = assembly.progress
        weldAge = 0
      }
    } else {
      const representsCurrent = ['done', 'complete', 'hold', 'block', 'park'].includes(event.kind)
        || state.active[0]?.id === event.taskId
      if (representsCurrent) {
        cue = { kind: event.kind, taskId: event.taskId, part: assembly.target, age: 0, pickup: rack.takePoint(event.taskId) }
      }
    }
    render()
  }
  hangar.setHeight(height)
  setAttrs(root, { 'data-day-night': dayNight, 'data-detail': detail, 'data-reduced-motion': String(reduced), 'data-sound-linked': String(Boolean(sound)) })
  setState(state)

  return {
    setState, handleEvent,
    tick(dt, time) {
      if (destroyed) return
      const delta = reduced ? 0 : Math.max(0, Math.min(100, dt))
      elapsed = reduced ? 0 : time
      daylight.tick(delta)
      if (cue) {
        cue.age += delta
        if (cue.age >= (cue.kind === 'claim' || cue.kind === 'park' ? 2000 : cue.kind === 'block' ? 2600 : 700)) cue = null
      }
      if (weldAge < 600) {
        weldAge = Math.min(600, weldAge + delta)
        weld = weldFrom + (weldTarget - weldFrom) * ease(weldAge / 600)
      }
      render(delta)
    },
    setDayNight(value) {
      if (destroyed || value === dayNight) return
      dayNight = value; daylight.setDayNight(value); setAttrs(root, { 'data-day-night': value }); render(0, true)
    },
    setDetail(value) {
      if (destroyed || value === detail) return
      detail = value; setAttrs(root, { 'data-detail': value }); render(0, true)
    },
    setHeight(value) {
      if (destroyed || value === height) return
      height = value; hangar.setHeight(value); render(0, true)
    },
    setReducedMotion(value) {
      if (destroyed || value === reduced) return
      reduced = value
      daylight.setReducedMotion(value)
      if (value) { cue = null; pendingWeldTask = null; weld = weldFrom = weldTarget = assembly.progress; weldAge = 600; elapsed = 0 }
      setAttrs(root, { 'data-reduced-motion': String(value) }); render(0, true)
    },
    setSound(value) { sound = value; if (!destroyed) setAttrs(root, { 'data-sound-linked': String(Boolean(value)) }) },
    destroy() {
      if (destroyed) return
      destroyed = true; cue = null
      effects.destroy(); hangar.destroy()
    },
  }
}

export const createScene: SceneFactory = createMechScene
