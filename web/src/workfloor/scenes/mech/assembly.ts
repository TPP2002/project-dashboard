import type { SceneState, SceneTask } from '../../types'
import { ORDER, type PartState } from './geometry'
import { clampPercent } from './dom'

export type AssemblyMode = 'ready' | 'build' | 'pend' | 'block' | 'park' | 'powered'
export interface Assembly {
  installed: number
  target: string | null
  task: SceneTask | undefined
  mode: AssemblyMode
  progress: number
  parts: Record<string, PartState>
}

/** 暂停提示只来自当前页面收到的 park；快照不再暂缓该卡时立即失效。 */
export function projectAssembly(state: SceneState, parkedTask: string | null = null): Assembly {
  const installed = state.total > 0
    ? Math.max(0, Math.min(ORDER.length, Math.round(state.done.length / state.total * ORDER.length))) : 0
  const parked = state.blocked.find(task => task.id === parkedTask)
  const blocked = state.blocked.find(task => task.id !== parkedTask)
  const mode: AssemblyMode = state.complete ? 'powered' : blocked ? 'block'
    : parked ? 'park' : state.pending.length ? 'pend' : state.active.length ? 'build' : 'ready'
  const task = mode === 'park' ? parked : state.active[0] ?? state.pending[0] ?? state.blocked[0]
  const target = installed < ORDER.length && mode !== 'ready' && mode !== 'powered' ? ORDER[installed] : null
  const parts: Record<string, PartState> = {}
  ORDER.forEach((name, index) => {
    parts[name] = index < installed || state.complete ? 'done' : name === target
      ? mode === 'pend' || mode === 'block' || mode === 'park' ? mode : 'build' : 'off'
  })
  return { installed: state.complete ? ORDER.length : installed, target, task, mode,
    progress: clampPercent(task?.percent ?? 0), parts }
}

export function actionLabel(assembly: Assembly) {
  switch (assembly.mode) {
    case 'powered': return 'POWER ON'
    case 'block': return 'JAMMED'
    case 'park': return 'PAUSED'
    case 'pend': return 'INSPECT?'
    case 'build': return `WELDING ${Math.round(assembly.progress)}%`
    default: return 'STANDBY'
  }
}
