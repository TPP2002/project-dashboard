import type { Status } from '../types'

export type WorldId = 'launch' | 'mech'
export type DayNight = 'day' | 'night'
export type Detail = 'standard' | 'ultra'
export type Height = 'standard' | 'compact'

export interface WorkfloorSettings {
  world: WorldId | 'off'
  dayNight: 'theme' | 'night' | 'clock'
  detail: Detail
  height: Height
  soundLink: boolean
}

export interface SceneTask {
  id: string
  title: string
  percent: number
  status: Status
  /** 分组内从零开始的稳定排序位置。 */
  order: number
}

export interface SceneState {
  projectId: string
  projectName: string
  queued: SceneTask[]
  active: SceneTask[]
  pending: SceneTask[]
  blocked: SceneTask[]
  done: SceneTask[]
  total: number
  percent: number
  complete: boolean
}

interface EventIdentity { projectId: string; taskId: string; ts: string }
export type SceneEvent = EventIdentity & (
  | { kind: 'claim' | 'hold' | 'go' | 'block' | 'park' | 'done' | 'complete' }
  | { kind: 'progress'; percent: number }
)

/** 音效只传配置；W1 不播放，也不创建音频上下文。 */
export interface SoundSettings {
  linked: boolean
  enabled: boolean
  volume: number
  quietStart: string
  quietEnd: string
}

export interface SceneOptions {
  state: SceneState
  dayNight: DayNight
  detail: Detail
  height: Height
  reducedMotion: boolean
  sound: SoundSettings
}

export interface SceneHandle {
  /** 首次调用直接摆放，后续每帧以最新状态校正，不能改写输入。 */
  setState(state: SceneState): void
  /** animate=false 表示直接落位，包括同秒合并、不可见和减少动效。 */
  handleEvent(event: SceneEvent, animate: boolean): void
  /** 毫秒；elapsed 只累计可见的运行时间，恢复不补帧。 */
  tick(dt: number, elapsed: number): void
  setDayNight(value: DayNight): void
  setDetail(value: Detail): void
  setHeight(value: Height): void
  setReducedMotion(value: boolean): void
  setSound(value: SoundSettings): void
  destroy(): void
}

export type SceneFactory = (host: SVGSVGElement, options: SceneOptions) => SceneHandle
