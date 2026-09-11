// Pinia 单一数据源：projects + 各项目 board 缓存 + SSE 订阅 + 读时派生 getter。
// 统计一律派生不落盘；BoardStream 实例存闭包（不进 state，避免被 pinia 代理）。
import { defineStore } from 'pinia'
import { ref, computed, reactive } from 'vue'
import type { Board, ProjectSummary, Task } from '@/types'
import { fetchProjects, fetchBoard, fetchHealth, postDecide, postUndecide, type Modules } from '@/api/client'
import { BoardStream, type ConnState } from '@/api/sse'
import * as derive from '@/utils/derive'
import { emitBoardEvent, type BoardEventKind } from '@/utils/boardEvents'

export const useBoardStore = defineStore('board', () => {
  // ---------- state ----------
  const projects = ref<ProjectSummary[]>([])
  const modules = ref<Modules>({ codex: false, cost: false, cpu: false, reader: false, audition: false })
  const boards = ref<Record<string, Board>>({})
  const etags = ref<Record<string, string>>({})
  const activityComplete = ref<Record<string, boolean>>({})
  const currentProjectId = ref<string | null>(null)
  const selectedTaskId = ref<string | null>(null)
  const selectedTaskProjectId = ref<string | null>(null)
  const conn = ref<ConnState>('offline')
  const loading = ref(false)
  const error = ref<string | null>(null)
  const initialized = ref(false)
  const pulses = reactive(new Set<string>())
  // 中心/聚合视图（待拍板 / 待落地 / 拍板历史 / 风险）的项目范围：
  // false = 只看顶栏当前项目（跟随项目切换，默认）；true = 跨全部项目聚合。
  const centerScopeAll = ref(false)
  // 只记本页面成功拍板的时刻；刷新页面后自然清空，不从日期或历史活动猜时间。
  const decidedRecently = reactive(new Map<string, number>())

  let stream: BoardStream | null = null
  let loadGeneration = 0
  const boardRequests = new Map<string, Promise<unknown>>()
  const pendingActivity = new Map<string, Promise<void>>()

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
  const presumedLandedByTask = computed(() => derive.collectPresumedLandedByTask(allBoards.value))
  // 对缓存不再截断；历史页面先 ensureFullActivity，再做筛选与显示分页。
  const globalActivity = computed(() => derive.mergeActivity(allBoards.value, 0))
  // 今日（本地时区）完工卡数：侧栏「每日成果」徽章 + 总览「今日完成」卡
  const todayDoneCount = computed(() => {
    const today = derive.todayLocal()
    return derive.collectDoneRecords(allBoards.value).records.filter((r) => r.day === today).length
  })
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
      if (!oldKeys.has(k) && a.taskId) {
        markPulse(pid, a.taskId)
        emitBoardEvent({ kind: a.type as BoardEventKind, projectId: pid, taskId: a.taskId, ts: a.ts })
      }
    }
  }

  // ---------- actions ----------
  async function loadProjects() {
    projects.value = await fetchProjects()
  }

  async function loadModules() {
    try {
      const health = await fetchHealth()
      const raw = health.modules
      modules.value = {
        codex: raw?.codex === true, cost: raw?.cost === true,
        cpu: raw?.cpu === true, reader: raw?.reader === true,
        audition: raw?.audition === true,
      }
      return true
    } catch (_) {
      // 启动失败时保持默认全关；设置面板据返回值回滚并提示，不能冒充保存成功。
      return false
    }
  }

  // 同项目请求串行，防止“补全历史”与 SSE 重拉相互覆盖；前一次失败不阻止下一次刷新。
  function queueBoardRead<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = boardRequests.get(id) ?? Promise.resolve()
    const request = previous.catch(() => undefined).then(run).finally(() => {
      if (boardRequests.get(id) === request) boardRequests.delete(id)
    })
    boardRequests.set(id, request)
    return request
  }
  function rememberEtag(key: string, etag: string | null) {
    if (etag) etags.value[key] = etag
    else delete etags.value[key]
  }
  async function readBoard(id: string, detect: boolean, generation: number): Promise<Board | null> {
    if (generation !== loadGeneration) return null
    const old = boards.value[id]
    const complete = activityComplete.value[id] === true
    const key = `${id}:${complete ? 'all' : 'recent'}`
    const result = await fetchBoard(id, {
      fields: 'all', activityLimit: complete ? undefined : 200,
      etag: old ? etags.value[key] : undefined,
    })
    if (generation !== loadGeneration || result.notModified) return null
    const b = result.board
    if (!b) throw new Error('看板响应缺少数据')
    rememberEtag(key, result.etag)
    boards.value = { ...boards.value, [id]: b }
    activityComplete.value[id] = complete
    if (detect) diffPulse(id, old, b)
    return b
  }
  function loadBoard(id: string, opts: { detect?: boolean } = {}) {
    const generation = loadGeneration
    return queueBoardRead(id, () => readBoard(id, opts.detect === true, generation))
  }

  /** 全量历史只替换 activity，不触发增量事件；同项目并发调用共用一个 Promise。 */
  function ensureFullActivity(pid: string): Promise<void> {
    if (activityComplete.value[pid]) return Promise.resolve()
    const pending = pendingActivity.get(pid)
    if (pending) return pending
    const generation = loadGeneration
    const request = queueBoardRead(pid, async () => {
      if (generation !== loadGeneration || activityComplete.value[pid]) return
      if (!boards.value[pid]) await readBoard(pid, false, generation)
      if (generation !== loadGeneration) return
      const key = `${pid}:activity`
      const result = await fetchBoard(pid, { fields: 'activity', etag: etags.value[key] })
      if (generation !== loadGeneration) return
      if (!result.notModified) {
        if (!result.board) throw new Error('活动响应缺少数据')
        const board = boards.value[pid]
        if (!board) throw new Error('项目任务清单尚未加载')
        boards.value = { ...boards.value, [pid]: { ...board, activity: result.board.activity ?? [] } }
        rememberEtag(key, result.etag)
      }
      activityComplete.value[pid] = true
    }).finally(() => {
      if (pendingActivity.get(pid) === request) pendingActivity.delete(pid)
    })
    pendingActivity.set(pid, request)
    return request
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
      await loadModules()
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
    decidedRecently.set(`${pid}:${taskId}:${did}`, Date.now())
    // 主动重拉即时反馈（SSE 广播会再刷一次，幂等无害）
    await loadBoard(pid, { detect: true })
    return r
  }

  async function undecide(pid: string, taskId: string, did: string) {
    const r = await postUndecide(pid, taskId, { did })
    decidedRecently.delete(`${pid}:${taskId}:${did}`)
    await loadBoard(pid, { detect: true })
    return r
  }

  function onBoardChanged(pid: string) {
    if (pid === '*') {
      loadProjects()
        .then(() => loadAllBoards())
        .catch(() => {})
      return
    }
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
    // 旧请求仍会排空，但不能写回新一轮缓存；页面观察 loading，刷新后再补自身需要的历史。
    loadGeneration++
    etags.value = {}
    activityComplete.value = {}
    pendingActivity.clear()
    loading.value = true
    error.value = null
    try {
      await loadProjects()
      await loadAllBoards()
    } finally {
      loading.value = false
    }
  }

  return {
    projects, modules, boards, etags, activityComplete, currentProjectId, selectedTaskId, selectedTaskProjectId,
    conn, loading, error, initialized, centerScopeAll, decidedRecently,
    projectList, allBoards, currentBoard, currentTasks, currentStatusCounts,
    currentProgress, pendingDecisions, pendingCount, decidedHistory, unlandedDecisions, unlandedCount, unlandedByTask, presumedLandedByTask, globalActivity, todayDoneCount, selectedBoard, selectedTask,
    isPulsing,
    init, loadProjects, loadModules, loadBoard, loadAllBoards, ensureFullActivity, selectProject,
    openTask, closeTask, decide, undecide, startStream, stopStream, refresh,
  }
})
