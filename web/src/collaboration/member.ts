import { apiJson } from './http'
import { progressBody } from './flow'
import { actionPath } from './board'
import { patchMemberTasks } from './writeEcho'
import type { MemberTask, Project, TaskAction } from './types'

export type MemberRequest = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>
type BoardResult = { unchanged: true; version: string } | { unchanged: false; version?: string; tasks: MemberTask[] }
function cleanTasks(tasks: MemberTask[]): MemberTask[] {
  return tasks.map(task => ({
    id: task.id, title: task.title, plainTitle: task.plainTitle, description: task.description,
    priority: task.priority, lastProgressAt: task.lastProgressAt,
    status: task.status, percent: task.percent, assigneeUserId: task.assigneeUserId, assigneeName: task.assigneeName,
    actions: [...(task.actions ?? [])], aiWork: task.aiWork,
    blockReason: task.blockReason, cancelReason: task.cancelReason, createdByUserId: task.createdByUserId,
    dates: task.dates ? { design: task.dates.design, start: task.dates.start, done: task.dates.done } : undefined,
    messages: (task.messages ?? []).map(({ ts, author, text, userId }) => ({ ts, author, text, userId })),
    collaborators: (task.collaborators ?? []).map(({ userId, name, joinedAt }) => ({ userId, name, joinedAt })),
  }))
}
function echoedTask(response: { task?: MemberTask }): MemberTask | null {
  return response?.task && typeof response.task.id === 'string' ? cleanTasks([response.task])[0] : null
}
/** Explicit member field whitelist; owner metadata must never enter this view. */
export function memberApi(request: MemberRequest = apiJson) {
  return {
    async projects(signal?: AbortSignal): Promise<Project[]> {
      const response = await request<{ projects: Project[] }>('/api/projects', undefined, signal)
      return response.projects.map(project => ({ id: project.id, name: project.name }))
    },
    async tasks(projectId: string, signal?: AbortSignal): Promise<MemberTask[]> {
      const response = await request<{ tasks: MemberTask[] }>(`/api/board/${encodeURIComponent(projectId)}`, undefined, signal)
      return cleanTasks(response.tasks)
    },
    async board(projectId: string, since?: string, signal?: AbortSignal): Promise<BoardResult> {
      const query = since === undefined ? '' : `?since=${encodeURIComponent(since)}`
      const response = await request<{ unchanged?: boolean; version?: string; tasks?: MemberTask[] }>(`/api/board/${encodeURIComponent(projectId)}${query}`, undefined, signal)
      if (response.unchanged && typeof response.version === 'string') return { unchanged: true, version: response.version }
      return { unchanged: false, version: response.version, tasks: cleanTasks(response.tasks!) }
    },
    async create(projectId: string, body: { title: string; plainTitle?: string; description?: string }, signal?: AbortSignal): Promise<MemberTask | null> {
      return echoedTask(await request<{ task?: MemberTask }>(`/api/collaboration/projects/${encodeURIComponent(projectId)}/tasks`, body, signal))
    },
    async act(projectId: string, taskId: string, action: TaskAction, body: unknown = {}, signal?: AbortSignal): Promise<MemberTask | null> {
      return echoedTask(await request<{ task?: MemberTask }>(actionPath(projectId, taskId, action), body, signal))
    },
    async claim(projectId: string, taskId: string, signal?: AbortSignal): Promise<MemberTask | null> {
      return echoedTask(await request<{ task?: MemberTask }>(actionPath(projectId, taskId, 'claim'), {}, signal))
    },
    async progress(projectId: string, taskId: string, percent: number, note: string, signal?: AbortSignal): Promise<MemberTask | null> {
      return echoedTask(await request<{ task?: MemberTask }>(actionPath(projectId, taskId, 'progress'), progressBody(percent, note), signal))
    },
  }
}

export interface MemberSnapshot { projects: Project[]; projectId: string; tasks: MemberTask[] }
/** A refresh always re-reads authorization before requesting any project board. */
export class MemberLoader {
  private generation = 0
  private controller: AbortController | null = null
  private memory = new Map<string, { version?: string; tasks: MemberTask[] }>()
  constructor(private api = memberApi()) {}
  cancel() { this.generation++; this.controller?.abort(); this.controller = null }
  patch(projectId: string, task: MemberTask): MemberTask[] | null {
    const previous = this.memory.get(projectId)
    if (!previous) return null
    const tasks = patchMemberTasks(previous.tasks, task)
    this.memory.set(projectId, { tasks })
    return tasks
  }
  async load(selected: string, allowedIds: readonly string[]): Promise<MemberSnapshot | null> {
    this.cancel()
    for (const id of this.memory.keys()) if (!allowedIds.includes(id)) this.memory.delete(id)
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    const projects = (await this.api.projects(controller.signal)).filter(project => allowedIds.includes(project.id))
    if (generation !== this.generation) return null
    const projectId = projects.some(project => project.id === selected) ? selected : projects[0]?.id ?? ''
    let tasks: MemberTask[] = []
    if (projectId) {
      const previous = this.memory.get(projectId)
      let result = await this.api.board(projectId, previous ? previous.version ?? '' : undefined, controller.signal)
      if (generation !== this.generation) return null
      if (result.unchanged && (!previous || previous.version !== result.version)) {
        result = await this.api.board(projectId, undefined, controller.signal)
        if (generation !== this.generation) return null
      }
      if (result.unchanged) {
        if (!previous || previous.version !== result.version) throw new Error('Invalid unchanged board response')
        tasks = previous.tasks
      } else {
        tasks = result.tasks
        this.memory.set(projectId, { version: result.version, tasks })
      }
    }
    if (generation !== this.generation) return null
    return { projects, projectId, tasks }
  }
}
