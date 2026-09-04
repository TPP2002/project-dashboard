// 审阅台状态仓(READER-INTO-BOARD):清单 / 当前报告 / 段级对照 / 批注 / 阅读偏好。
// 报告正文与批注来自 server(仓库文件 + data/reader 账本);阅读偏好是纯个人习惯,存 localStorage(读写都兜 try)。
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as api from '@/api/reader'
import type { ReaderManifest, ReaderReportPayload, ReaderReportMeta, ReaderAnno, ReaderNoteLayer } from '@/api/reader'
import { diffBlocks, diffStats, splitBlocks, type DocBlock } from '@/utils/reader/diff'
import { extractStatusLine } from '@/utils/reader/markdown'

export type DiffMode = 'clean' | 'marks' | 'changes' | 'split'
export type NotesLayout = 'fold' | 'always' | 'rail'
export interface ReaderPrefs {
  /** 版本对照读法;负责人 2026-09-05 拍:默认干净,其余保留为个性化设置 */
  mode: DiffMode
  /** 边注摆法;默认折叠成标题旁小标 */
  notesLayout: NotesLayout
  fontSize: number
  /** 隐藏的边注层 id */
  hiddenLayers: string[]
  /** 报告架里是否显示「待接入」的报告 */
  showPendingIntake: boolean
}
const PREFS_KEY = 'dashboard.reader.prefs.v1'
const DEFAULT_PREFS: ReaderPrefs = { mode: 'clean', notesLayout: 'fold', fontSize: 15, hiddenLayers: [], showPendingIntake: true }

function loadPrefs(): ReaderPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const p = JSON.parse(raw) as Partial<ReaderPrefs>
    return { ...DEFAULT_PREFS, ...p, hiddenLayers: Array.isArray(p.hiddenLayers) ? p.hiddenLayers : [] }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}
function savePrefs(p: ReaderPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* 隐私模式等场景写不进,忽略 */ }
}

/** 把「状态:…」仓库状态行从正文摘出;剩下的段重新拼回 markdown 供对照 */
function stripStatus(md: string): { status: string | null; md: string } {
  const { status, rest } = extractStatusLine(splitBlocks(md))
  return { status, md: rest.join('\n\n') }
}

export interface ShelfReport extends ReaderReportMeta { batchId: string; batchName: string }

export const useReaderStore = defineStore('reader', () => {
  const project = ref<string | null>(null)
  const manifest = ref<ReaderManifest | null>(null)
  const annoCounts = ref<Record<string, number>>({})
  const manifestError = ref<string | null>(null)
  const currentKey = ref<string | null>(null)
  const payload = ref<ReaderReportPayload | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const prefs = ref<ReaderPrefs>(loadPrefs())
  const annos = ref<ReaderAnno[]>([])
  const lastMirror = ref<{ ok: boolean; error?: string; task?: string | null } | null>(null)

  const reportsFlat = computed<ShelfReport[]>(() =>
    (manifest.value?.batches ?? []).flatMap((b) => (b.reports ?? []).map((r) => ({ ...r, batchId: b.id, batchName: b.name }))),
  )
  const currentReport = computed<ReaderReportMeta | null>(() => payload.value?.report ?? null)
  const statusLine = computed<string | null>(() => (payload.value ? stripStatus(payload.value.md).status : null))
  const blocks = computed<DocBlock[]>(() => {
    if (!payload.value) return []
    const cur = stripStatus(payload.value.md).md
    const prev = payload.value.prevMd ? stripStatus(payload.value.prevMd).md : null
    return diffBlocks(prev, cur)
  })
  const stats = computed(() => diffStats(blocks.value))
  const noteLayers = computed<ReaderNoteLayer[]>(() => payload.value?.notes ?? [])
  const visibleNoteLayers = computed(() => noteLayers.value.filter((l) => !prefs.value.hiddenLayers.includes(l.id)))
  const pendingReviewCount = computed(() => reportsFlat.value.filter((r) => (r.status || '待审阅') === '待审阅').length)

  async function loadManifest(pid: string) {
    project.value = pid
    manifestError.value = null
    try {
      const res = await api.fetchReaderManifest(pid)
      manifest.value = res.manifest
      annoCounts.value = res.annoCounts || {}
    } catch (e) {
      manifest.value = null
      annoCounts.value = {}
      manifestError.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function openReport(key: string) {
    if (!project.value) return
    loading.value = true
    error.value = null
    currentKey.value = key
    try {
      const res = await api.fetchReaderReport(project.value, key)
      payload.value = res
      annos.value = res.annos || []
    } catch (e) {
      payload.value = null
      annos.value = []
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  async function addAnno(input: { blockId: string; anchor: string; quote: string; text: string; author?: string }) {
    if (!project.value || !currentKey.value) throw new Error('没有打开的报告')
    const res = await api.postReaderAnno(project.value, currentKey.value, input)
    annos.value = res.annos
    annoCounts.value = { ...annoCounts.value, [currentKey.value]: res.annos.length }
    lastMirror.value = { ok: res.mirror, error: res.mirrorError, task: res.task }
    return res
  }

  async function removeAnno(id: string) {
    if (!project.value || !currentKey.value) return
    const res = await api.deleteReaderAnno(project.value, currentKey.value, id)
    annos.value = res.annos
    annoCounts.value = { ...annoCounts.value, [currentKey.value]: res.annos.length }
  }

  async function exportAnnos() {
    if (!project.value || !currentKey.value) throw new Error('没有打开的报告')
    return api.postReaderExport(project.value, currentKey.value)
  }

  function setPrefs(patch: Partial<ReaderPrefs>) {
    prefs.value = { ...prefs.value, ...patch }
    savePrefs(prefs.value)
  }
  function toggleLayer(id: string) {
    const hidden = new Set(prefs.value.hiddenLayers)
    if (hidden.has(id)) hidden.delete(id)
    else hidden.add(id)
    setPrefs({ hiddenLayers: [...hidden] })
  }

  return {
    project, manifest, annoCounts, manifestError, currentKey, payload, loading, error, prefs, annos, lastMirror,
    reportsFlat, currentReport, statusLine, blocks, stats, noteLayers, visibleNoteLayers, pendingReviewCount,
    loadManifest, openReport, addAnno, removeAnno, exportAnnos, setPrefs, toggleLayer,
  }
})
