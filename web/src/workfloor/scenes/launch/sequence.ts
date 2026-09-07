import type { SceneEvent, SceneState, SceneTask, SoundCue } from '../../types'
import { clamp, smooth } from '../../fx/svg'
import { DOCK_MS, FLIGHT_MS, ROLLOUT_MS, SMOKE_MS } from './layout'

export type Phase = 'READY' | 'ROLLOUT' | 'FUEL' | 'HOLD' | 'GO' | 'SCRUB' | 'STANDBY' | 'LIFTOFF' | 'NOMINAL' | 'COMPLETE'
interface Motion { task: SceneTask; at: number; from?: number }
const WEATHER_MS = 4000
export interface LaunchFrame {
  state: SceneState
  phase: Phase
  /** 事件可以覆盖大屏和天气，但不能截断车辆、落座或起飞。 */
  motionPhase: Phase
  task: SceneTask | null
  fuel: number
  countdown: number | null
  rollout: number
  dockAge: number | null
  pad: boolean
  carrying: boolean
  altitude: number
  flightAge: number | null
  smokeAge: number | null
  launchId: number
  stormAge: number
  rainAge: number
  completeAge: number | null
  waiting: SceneTask | null
  waitingProgress: number
  stock: SceneTask[]
  launchRequested: boolean
}

/** 快照是业务真相；这里只保存展示时间，绝不把事件计数写回 SceneState。 */
export function createSequence(initial: SceneState, sound?: (cue: SoundCue) => void) {
  let state = initial, time = 0, fuel = selected(initial)?.percent ?? 0, reduced = false
  let transfer: Motion | null = null, waitingTransfer: Motion | null = null
  // 单发射台的进行中队列最多一枚；setState 不能从中删除火箭。
  const flights: Motion[] = []
  let smokeAt: number | null = null, fullAt: number | null = null
  let go: { taskId: string; at: number } | null = null, requested: SceneTask | null = null
  let weather: { phase: 'HOLD' | 'SCRUB'; at: number } | null = null
  let weatherAt = 4000, rainAt = 0, launchId = 0, lastSecond = -Infinity
  let truckSafe = true
  let pendingComplete = false, liftoffSound = false
  const seen = new Set<string>()
  let previousTask: SceneTask | null = selected(initial)
  function selected(value: SceneState): SceneTask | null {
    return value.active[0] ?? value.pending[0] ?? value.blocked[0] ?? null
  }
  const mainTask = () => selected(state)
  function phaseOf(): Phase {
    const task = mainTask()
    if (!task) return state.complete ? 'COMPLETE' : 'READY'
    if (state.active[0]?.id === task.id) return go?.taskId === task.id || task.status === '已拍板' ? 'GO' : 'FUEL'
    return state.pending[0]?.id === task.id ? 'HOLD' : 'SCRUB'
  }
  function settle() {
    transfer = waitingTransfer = null; flights.length = 0
    requested = null; smokeAt = null; fullAt = null; weather = null
    pendingComplete = false
    fuel = mainTask()?.percent ?? 0
  }
  function setState(next: SceneState) {
    if (next.projectId !== state.projectId) {
      state = next; seen.clear(); go = null; previousTask = selected(next)
      lastSecond = -Infinity; settle(); return
    }
    const before = mainTask()
    previousTask = before ?? previousTask
    state = next
    if (go && ![...state.active, ...state.done].some(task => task.id === go!.taskId)) go = null
    if (transfer && !state.active.some(task => task.id === transfer!.task.id)) transfer = null
    if (waitingTransfer && !state.active.some(task => task.id === waitingTransfer!.task.id)) waitingTransfer = null
    if (!state.complete) { fullAt = null; pendingComplete = false }
    if (!flights.length && !transfer && (before?.id !== mainTask()?.id || reduced)) fuel = mainTask()?.percent ?? 0
  }
  function launch(task: SceneTask) {
    flights.push({ task, at: time }); smokeAt = time; transfer = null; requested = null; go = null
    launchId++
    liftoffSound = false; sound?.('ignition')
  }
  function complete() {
    if (!pendingComplete || !state.complete || flights.length || requested) return
    pendingComplete = false; fullAt = time; sound?.('complete')
  }
  function handleEvent(event: SceneEvent, animate: boolean) {
    if (event.projectId !== state.projectId) return
    const key = `${event.kind}:${event.taskId}:${event.ts}`
    if (seen.has(key)) return
    seen.add(key)
    if (seen.size > 96) seen.delete(seen.values().next().value!)
    const moving = animate && !reduced
    const task = [...state.active, ...state.pending, ...state.blocked, ...state.done, ...state.queued].find(task => task.id === event.taskId)
      ?? (previousTask?.id === event.taskId ? previousTask : null)
    if (event.kind === 'complete') { if (state.complete && moving) { pendingComplete = true; complete() }; return }
    if (!task) return
    if (event.kind === 'done') {
      const stamp = Date.parse(event.ts), second = Math.floor((Number.isFinite(stamp) ? stamp : time) / 1000)
      const suppressed = !moving || second === lastSecond || Boolean(flights.length || requested)
      lastSecond = second
      if (!suppressed) {
        if (!truckSafe || go?.taskId === task.id && time - go.at < 10000) requested = task
        else launch(task)
      }
      return
    }
    if (event.kind === 'claim') {
      if (moving && state.active[0]?.id === task.id && !flights.length) { transfer = { task, at: time }; fuel = 0; go = null }
      else if (moving && state.active[1]?.id === task.id) waitingTransfer = { task, at: time }
    }
    // block / hold 只播放一次提示；选台、停工和恢复仍以最新快照分组为准。
    if (moving && (event.kind === 'block' || event.kind === 'hold')) {
      weather = { phase: event.kind === 'block' ? 'SCRUB' : 'HOLD', at: time }
      weatherAt = time + 400
      if (event.kind === 'block') rainAt = time
      sound?.(event.kind === 'block' ? 'alarm' : 'hold')
    }
    if (task.id !== mainTask()?.id) return
    if (event.kind === 'go') { go = { taskId: task.id, at: moving ? time : Infinity }; if (moving) sound?.('stamp') }
    // 显示目标直接来自 snapshot，progress 不制造第二份可被旧事件覆盖的进度。
    if (!moving) fuel = mainTask()?.percent ?? 0
  }
  function tick(dt: number) {
    if (reduced) return
    time += Math.max(0, Math.min(dt, 100))
    if (weather && time - weather.at >= WEATHER_MS) weather = null
    if (transfer && time - transfer.at >= ROLLOUT_MS + DOCK_MS) transfer = null
    if (waitingTransfer && time - waitingTransfer.at >= ROLLOUT_MS) waitingTransfer = null
    if (requested && truckSafe && (!go || time - go.at >= 10000)) launch(requested)
    const flight = flights[0]
    if (flight && !liftoffSound && time - flight.at >= 400) { liftoffSound = true; sound?.('liftoff') }
    if (flight && time - flight.at >= FLIGHT_MS) {
      flights.shift(); fuel = mainTask()?.percent ?? 0
      const next = state.active[0]
      // 并行任务已经在履带路上等候，接班沿剩余路段走，不能跳回厂房门口。
      if (next && next.id !== flight.task.id && !state.complete) transfer = { task: next, at: time, from: .22 }
    }
    complete()
    if (!transfer && !flights.length) {
      const target = mainTask()?.percent ?? 0
      fuel += (target - fuel) * (1 - Math.exp(-dt / 350))
      if (Math.abs(target - fuel) < .05) fuel = target
    }
    if (smokeAt !== null && time - smokeAt >= SMOKE_MS) smokeAt = null
  }
  function frame(): LaunchFrame {
    const flight = flights[0]
    const travelAge = transfer ? time - transfer.at : 0
    const flightAge = flight ? time - flight.at : null
    const dockAge = transfer && travelAge >= ROLLOUT_MS ? travelAge - ROLLOUT_MS : null
    const motionPhase: Phase = flight ? 'LIFTOFF' : requested ? go ? 'GO' : 'FUEL' : transfer ? 'ROLLOUT' : phaseOf()
    const phase = weather?.phase ?? motionPhase
    const task = flight?.task ?? requested ?? transfer?.task ?? mainTask()
    const carrying = Boolean(transfer && dockAge === null)
    const ascent = flightAge === null ? 0 : Math.max(0, (flightAge - 400) / 1000)
    const altitude = ascent <= 1 ? 30 * ascent : 30 + 30 * (ascent - 1) + 190 * (ascent - 1) ** 2
    const countdown = phase === 'HOLD' ? 10 : phase === 'GO' ? Math.max(requested ? 0 : 1, 10 - Math.max(0, Math.floor((time - (go?.at ?? time)) / 1000)))
      : phase === 'LIFTOFF' ? 0 : phase === 'FUEL' && (task?.percent ?? 0) >= 90 ? 10 : null
    const remaining = state.active.filter(item => item.id !== task?.id)
    const waiting = remaining[0] ?? null
    return { state, phase, motionPhase, task, fuel: transfer ? 0 : flight ? flight.task.percent : requested ? requested.percent : task ? fuel : 0, countdown,
      rollout: transfer ? (transfer.from ?? 0) + (1 - (transfer.from ?? 0)) * smooth(clamp((travelAge - 250) / (ROLLOUT_MS - 250))) : 1, dockAge,
      pad: Boolean(task && !carrying && motionPhase !== 'COMPLETE'), carrying, altitude, flightAge,
      smokeAge: smokeAt === null ? null : time - smokeAt, launchId, stormAge: time - weatherAt,
      rainAge: time - rainAt, completeAge: fullAt === null ? null : time - fullAt,
      waiting, waitingProgress: waitingTransfer && waitingTransfer.task.id === waiting?.id ? .22 * smooth((time - waitingTransfer.at) / ROLLOUT_MS) : .22,
      stock: [...state.queued, ...remaining.slice(1)],
      launchRequested: Boolean(requested),
    }
  }
  return { setState, handleEvent, tick, frame, setTruckSafe(value: boolean) { truckSafe = value },
    setReducedMotion(value: boolean) { reduced = value; if (value) settle() } }
}
