import type { SceneEvent, SceneState, SceneTask } from '../../types'
import { clamp, smooth } from '../../fx/svg'
import { DOCK_MS, FLIGHT_MS, ROLLOUT_MS, SMOKE_MS } from './layout'

export type Phase = 'READY' | 'ROLLOUT' | 'FUEL' | 'HOLD' | 'GO' | 'SCRUB' | 'STANDBY' | 'LIFTOFF' | 'NOMINAL' | 'COMPLETE'
interface Motion { task: SceneTask; at: number; from?: number }
export interface LaunchFrame {
  state: SceneState
  phase: Phase
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
export function createSequence(initial: SceneState) {
  let state = initial, time = 0, fuel = selected(initial)?.percent ?? 0, reduced = false
  let transfer: Motion | null = null, waitingTransfer: Motion | null = null, flight: Motion | null = null
  let smokeAt: number | null = null, fullAt: number | null = null, nominalAt: number | null = null
  let go: { taskId: string; at: number } | null = null, requested: SceneTask | null = null, parkedId = ''
  let weatherAt = 4000, rainAt = 0, launchId = 0, lastSecond = -Infinity
  let truckSafe = true
  const seen = new Set<string>()
  let previousTask: SceneTask | null = selected(initial)
  function selected(value: SceneState): SceneTask | null {
    return value.pending[0] ?? value.active[0] ?? value.blocked[0] ?? null
  }
  const mainTask = () => state.blocked.find(task => task.id === parkedId) ?? selected(state)
  function phaseOf(): Phase {
    if (state.complete) return 'COMPLETE'
    if (parkedId && state.blocked.every(task => task.id === parkedId)) return 'STANDBY'
    if (state.blocked.length) return 'SCRUB'
    if (state.pending.length) return 'HOLD'
    if (mainTask()) return go?.taskId === mainTask()?.id || mainTask()?.status === '已拍板' ? 'GO' : 'FUEL'
    return 'READY'
  }
  function settle() {
    transfer = waitingTransfer = flight = null
    requested = null; smokeAt = null; fullAt = null; nominalAt = null
    fuel = mainTask()?.percent ?? 0
  }
  function setState(next: SceneState) {
    if (next.projectId !== state.projectId) {
      state = next; seen.clear(); go = null; parkedId = ''; previousTask = selected(next)
      lastSecond = -Infinity; settle(); return
    }
    const before = mainTask(), wasBlocked = state.blocked.length > 0
    previousTask = before ?? previousTask
    state = next
    if (!state.blocked.some(task => task.id === parkedId)) parkedId = ''
    if (go && (![...state.active, ...state.done].some(task => task.id === go!.taskId) || state.pending.length || state.blocked.length)) go = null
    if (transfer && (!state.active.some(task => task.id === transfer!.task.id) || state.pending.length || state.blocked.length)) transfer = null
    if (waitingTransfer && !state.active.some(task => task.id === waitingTransfer!.task.id)) waitingTransfer = null
    if (flight && !state.done.some(task => task.id === flight!.task.id)) { flight = null; smokeAt = null }
    if (requested && !state.done.some(task => task.id === requested!.id)) requested = null
    if (state.blocked.length && !wasBlocked) rainAt = time
    if (!state.complete) fullAt = null
    if (!flight && !transfer && (before?.id !== mainTask()?.id || reduced)) fuel = mainTask()?.percent ?? 0
  }
  function launch(task: SceneTask) {
    flight = { task, at: time }; smokeAt = time; transfer = null; requested = null; go = null
    launchId++; parkedId = ''; nominalAt = null
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
    if (event.kind === 'complete') { if (state.complete && moving) fullAt = time; return }
    if (!task) return
    if (event.kind === 'done') {
      const stamp = Date.parse(event.ts), second = Math.floor((Number.isFinite(stamp) ? stamp : time) / 1000)
      const suppressed = !moving || second === lastSecond || Boolean(flight)
      lastSecond = second
      if (!suppressed) {
        if (!truckSafe || go?.taskId === task.id && time - go.at < 10000) requested = task
        else launch(task)
      } else if (!moving && flight?.task.id === task.id) { flight = null; smokeAt = null }
      return
    }
    if (event.kind === 'park') {
      parkedId = task.id; go = null; transfer = null; requested = null
      fuel = task.percent
      return
    }
    if (event.kind === 'claim') {
      parkedId = ''
      if (moving && state.active[0]?.id === task.id && !flight) { transfer = { task, at: time }; fuel = 0; go = null }
      else if (moving && state.active[1]?.id === task.id) waitingTransfer = { task, at: time }
    }
    if (event.kind === 'block') { weatherAt = time + 400; rainAt = time; go = null; transfer = null; requested = null }
    if (task.id !== mainTask()?.id) return
    if (event.kind === 'go') { go = { taskId: task.id, at: moving ? time : Infinity }; weatherAt = time + 4000 }
    if (event.kind === 'hold') { weatherAt = time + 400; go = null; transfer = null; requested = null }
    // 显示目标直接来自 snapshot，progress 不制造第二份可被旧事件覆盖的进度。
    if (!moving) fuel = mainTask()?.percent ?? 0
  }
  function tick(dt: number) {
    if (reduced) return
    time += Math.max(0, Math.min(dt, 100))
    if (transfer && time - transfer.at >= ROLLOUT_MS + DOCK_MS) transfer = null
    if (waitingTransfer && time - waitingTransfer.at >= ROLLOUT_MS) waitingTransfer = null
    if (requested && truckSafe && (!go || time - go.at >= 10000)) launch(requested)
    if (flight && time - flight.at >= FLIGHT_MS) {
      flight = null; fuel = 0; nominalAt = time
      const next = state.active[0]
      // 并行任务已经在履带路上等候，接班沿剩余路段走，不能跳回厂房门口。
      if (next && !state.complete && !state.pending.length && !state.blocked.length) transfer = { task: next, at: time, from: .22 }
    }
    if (!transfer && !flight) {
      const target = mainTask()?.percent ?? 0
      fuel += (target - fuel) * (1 - Math.exp(-dt / 350))
      if (Math.abs(target - fuel) < .05) fuel = target
    }
    if (smokeAt !== null && time - smokeAt >= SMOKE_MS) smokeAt = null
  }
  function frame(): LaunchFrame {
    const travelAge = transfer ? time - transfer.at : 0
    const flightAge = flight ? time - flight.at : null
    const dockAge = transfer && travelAge >= ROLLOUT_MS ? travelAge - ROLLOUT_MS : null
    const phase = flight ? 'LIFTOFF' : requested ? go ? 'GO' : 'FUEL' : transfer ? 'ROLLOUT' : nominalAt !== null && !mainTask() && !state.complete && time - nominalAt < 1400 ? 'NOMINAL' : phaseOf()
    const task = flight?.task ?? requested ?? transfer?.task ?? mainTask()
    const carrying = Boolean(transfer && dockAge === null)
    const ascent = flightAge === null ? 0 : Math.max(0, (flightAge - 400) / 1000)
    const altitude = ascent <= 1 ? 30 * ascent : 30 + 30 * (ascent - 1) + 190 * (ascent - 1) ** 2
    const countdown = phase === 'HOLD' ? 10 : phase === 'GO' ? Math.max(requested ? 0 : 1, 10 - Math.max(0, Math.floor((time - (go?.at ?? time)) / 1000)))
      : phase === 'LIFTOFF' ? 0 : phase === 'FUEL' && (task?.percent ?? 0) >= 90 ? 10 : null
    const remaining = state.active.filter(item => item.id !== task?.id)
    const waiting = remaining[0] ?? null
    return { state, phase, task, fuel: transfer ? 0 : flight ? flight.task.percent : requested ? requested.percent : task ? fuel : 0, countdown,
      rollout: transfer ? (transfer.from ?? 0) + (1 - (transfer.from ?? 0)) * smooth(clamp((travelAge - 250) / (ROLLOUT_MS - 250))) : 1, dockAge,
      pad: Boolean(task && !carrying && phase !== 'COMPLETE'), carrying, altitude, flightAge,
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
