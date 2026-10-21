import { apiJson } from './http'
import { progressBody } from './flow'
import { actionPath } from './board'
import type { MemberTask, Project, TaskAction } from './types'

export type MemberRequest = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>
/** Explicit member field whitelist; owner metadata must never enter this view. */
export function memberApi(request: MemberRequest = apiJson) {
  return {
    async projects(signal?: AbortSignal): Promise<Project[]> {
      const response = await request<{ projects: Project[] }>('/api/projects', undefined, signal)
      return response.projects.map(project => ({ id: project.id, name: project.name }))
    },
    async tasks(projectId: string, signal?: AbortSignal): Promise<MemberTask[]> {
      const response = await request<{ tasks: MemberTask[] }>(`/api/board/${encodeURIComponent(projectId)}`, undefined, signal)
      // Do not retain owner-only fields even if a server regression adds them to a response.
      return response.tasks.map(task => ({
        id: task.id, title: task.title, plainTitle: task.plainTitle, description: task.description,
        priority: task.priority, lastProgressAt: task.lastProgressAt,
        status: task.status, percent: task.percent, assigneeUserId: task.assigneeUserId, assigneeName: task.assigneeName,
        actions: [...(task.actions ?? [])], aiWork: task.aiWork,
        blockReason: task.blockReason, cancelReason: task.cancelReason, createdByUserId: task.createdByUserId,
        dates: task.dates ? { design: task.dates.design, start: task.dates.start, done: task.dates.done } : undefined,
        messages: (task.messages ?? []).map(({ ts, author, text, userId }) => ({ ts, author, text, userId })),
        collaborators: (task.collaborators ?? []).map(({ userId, name, joinedAt }) => ({ userId, name, joinedAt })),
      }))
    },
    async create(projectId: string, body: { title: string; plainTitle?: string; description?: string }, signal?: AbortSignal): Promise<void> {
      await request(`/api/collaboration/projects/${encodeURIComponent(projectId)}/tasks`, body, signal)
    },
    async act(projectId: string, taskId: string, action: TaskAction, body: unknown = {}, signal?: AbortSignal): Promise<void> {
      await request(actionPath(projectId, taskId, action), body, signal)
    },
    async claim(projectId: string, taskId: string, signal?: AbortSignal): Promise<void> {
      await request(actionPath(projectId, taskId, 'claim'), {}, signal)
    },
    async progress(projectId: string, taskId: string, percent: number, note: string, signal?: AbortSignal): Promise<void> {
      await request(actionPath(projectId, taskId, 'progress'), progressBody(percent, note), signal)
    },
  }
}

export interface MemberSnapshot { projects: Project[]; projectId: string; tasks: MemberTask[] }
/** A refresh always re-reads authorization before requesting any project board. */
export class MemberLoader {
  private generation = 0
  private controller: AbortController | null = null
  constructor(private api = memberApi()) {}
  cancel() { this.generation++; this.controller?.abort(); this.controller = null }
  async load(selected: string, allowedIds: readonly string[]): Promise<MemberSnapshot | null> {
    this.cancel()
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    const projects = (await this.api.projects(controller.signal)).filter(project => allowedIds.includes(project.id))
    if (generation !== this.generation) return null
    const projectId = projects.some(project => project.id === selected) ? selected : projects[0]?.id ?? ''
    const tasks = projectId ? await this.api.tasks(projectId, controller.signal) : []
    if (generation !== this.generation) return null
    return { projects, projectId, tasks }
  }
}
