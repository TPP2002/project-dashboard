// Pinia 单一数据源：projects + 各项目 board 缓存 + SSE 订阅 + 读时派生 getter。
// 统计一律派生不落盘；BoardStream 实例存闭包（不进 state，避免被 pinia 代理）。
import { defineStore } from 'pinia'
import { ref, computed, reactive } from 'vue'
import type { Board, ProjectSummary, Task } from '@/types'
import { fetchProjects, fetchBoard, postDecide } from '@/api/client'
import { BoardStream, type ConnState } from '@/api/sse'
import * as derive from '@/utils/derive'

export const useBoardStore = defineStore('board', () => {
  // ---------- state ----------
  const projects = ref<ProjectSummary[]>([])
  const boards = ref<Record<string, Board>>({})
  const currentProjectId = ref<string | null>(null)
  const selectedTaskId = ref<string | null>(null)
  const selectedTaskProjectId = ref<string | null>(null)
  const conn = ref<ConnState>('offline')
  const loading = ref(false)
  const error = ref<string | null>(null)
  const initialized = ref(false)
  const pulses = reactive(new Set<string>())

  let stream: BoardStream | null = null

  // ---------- getters（读时派生） ----------
  const projectList = computed(() => projects.value)
  const allBoards = computed<Board[]>(() => Object.values(boards.value))
  const currentBoard = computed<Board | null>(() =>
    currentProjectId.value ? boards.value[currentProjectId.value] ?? null : null,
  )
  const currentTasks = computed<Task[]>(() => currentBoard.value?.tasks ?? [])
  const currentStatusCounts = computed(() => derive.statusCounts(currentBoard.value))
  const currentProgress = computed(() => derive.progress(currentBoard.value))
  const pendingDecisions = computed(() => derive.collectPending(allBoards.value))
  const pendingCount = computed(() => pendingDecisions.value.length)
  const decidedHistory = computed(() => derive.collectDecided(allBoards.value))
  const unlandedDecisions = computed(() => derive.collectUnlanded(allBoards.value))
  const unlandedCount = computed(() => unlandedDecisions.value.length)
  const unlandedByTask = computed(() => derive.collectUnlandedByTask(allBoards.value))
  const globalActivity = computed(() => derive.mergeActivity(allBoards.value))
  const selectedBoard = computed<Board | null>(() =>
    selectedTaskProjectId.value ? boards.value[selectedTaskProjectId.value] ?? null : null,
  )
  const selectedTask = computed<Task | null>(() => {
    if (!selectedTaskId.value) return null
    return selectedBoard.value?.tasks.find((t) => t.id === selectedTaskId.value) ?? null
  })

  // ---------- pulse（增量变更黄色脉冲） ----------
  const pulseKey = (pid: string, taskId: string) => `${pid}:${taskId}`
  function markPulse(pid: string, taskId: string) {
    const k = pulseKey(pid, taskId)
    pulses.add(k)
    window.setTimeout(() => pulses.delete(k), 2600)
  }
  function isPulsing(pid: string, taskId: string) {
    return pulses.has(pulseKey(pid, taskId))
  }
  function diffPulse(pid: string, oldBoard: Board | undefined, newBoard: Board) {
    if (!oldBoard) return
    const oldKeys = new Set((oldBoard.activity ?? []).map((a) => `${a.ts}|${a.taskId}|${a.text}`))
    for (const a of newBoard.activity ?? []) {
      const k = `${a.ts}|${a.taskId}|${a.text}`
      if (!oldKeys.has(k) && a.taskId) markPulse(pid, a.taskId)
    }
  }

  // ---------- actions ----------
  async function loadProjects() {
    projects.value = await fetchProjects()
  }
  async function loadBoard(id: string, opts: { detect?: boolean } = {}) {
    const old = boards.value[id]
    const b = await fetchBoard(id)
    boards.value = { ...boards.value, [id]: b }
    if (opts.detect) diffPulse(id, old, b)
    return b
  }
  async function loadAllBoards() {
    const results = await Promise.allSettled(projects.value.map((p) => loadBoard(p.id)))
    const firstErr = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    if (firstErr && !error.value) {
      const reason = firstErr.reason
      error.value = reason instanceof Error ? reason.message : String(reason)
    }
  }
  async function init() {
    if (initialized.value) return
    loading.value = true
    error.value = null
    try {
      await loadProjects()
      await loadAllBoards()
      if (!currentProjectId.value && projects.value.length) {
        currentProjectId.value = projects.value[0].id
      }
      startStream()
      initialized.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }
  function selectProject(id: string) {
    currentProjectId.value = id
    if (!boards.value[id]) {
      loadBoard(id).catch((e) => (error.value = e instanceof Error ? e.message : String(e)))
    }
  }
  function openTask(taskId: string, projectId?: string) {
    selectedTaskId.value = taskId
    selectedTaskProjectId.value = projectId ?? currentProjectId.value
  }
  function closeTask() {
    selectedTaskId.value = null
    selectedTaskProjectId.value = null
  }
  async function decide(pid: string, taskId: string, did: string, answer: string, author?: string) {
    const r = await postDecide(pid, taskId, { did, answer, author })
    // 主动重拉即时反馈（SSE 广播会再刷一次，幂等无害）
    await loadBoard(pid, { detect: true })
    await loadProjects().catch(() => {})
    return r
  }

  function onBoardChanged(pid: string) {
    if (pid === '*') {
      loadProjects()
        .then(() => loadAllBoards())
        .catch(() => {})
      return
    }
    loadProjects().catch(() => {})
    loadBoard(pid, { detect: true }).catch(() => {})
  }
  function startStream() {
    if (stream) return
    stream = new BoardStream({ onChanged: onBoardChanged, onState: (s) => (conn.value = s) })
    stream.start()
  }
  function stopStream() {
    stream?.stop()
    stream = null
  }
  async function refresh() {
    await loadProjects()
    await loadAllBoards()
  }

  return {
    projects, boards, currentProjectId, selectedTaskId, selectedTaskProjectId,
    conn, loading, error, initialized,
    projectList, allBoards, currentBoard, currentTasks, currentStatusCounts,
    currentProgress, pendingDecisions, pendingCount, decidedHistory, unlandedDecisions, unlandedCount, unlandedByTask, globalActivity, selectedBoard, selectedTask,
    isPulsing,
    init, loadProjects, loadBoard, loadAllBoards, selectProject,
    openTask, closeTask, decide, startStream, stopStream, refresh,
  }
})
