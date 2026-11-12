import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import * as api from '@/api/sched'
import { fetchSnapshotWithRetry } from './schedRetry'
import { BoardStream } from '@/api/sse'
import { commandTimes, loadCommands, loadFilters, queryFilters, saveLocal, type LedgerPrefs } from '@/components/sched/preferences'
import { pruneQueueRecords, queueMetadataOf, type QueueMetadata } from './schedResourceLifecycle'

export const useSchedStore = defineStore('sched', () => {
  const snapshot = ref<api.SchedSnapshot | null>(null)
  const snapshotError = ref(''), loading = ref(false), commandError = ref(''), storageError = ref('')
  const now = ref(Date.now()), busy = ref(false)
  const reconnecting = ref(false), reconnectAttempt = ref(0)
  const submitted = ref(loadCommands()), filters = ref(loadFilters())
  const ledger = ref<api.TicketPage | null>(null), ledgerError = ref(''), ledgerLoading = ref(false)
  const cursors = ref(['']), page = ref(0)
  const detail = ref<api.TicketDetail | null>(null), detailId = ref<string | null>(null), detailError = ref('')
  const detailLoading = ref(false)
  const related = ref<api.TicketRelations | null>(null)
  const exporting = ref(false), exportError = ref('')
  const queueDetails = ref<Record<string, QueueMetadata>>({}), queueErrors = ref<Record<string, string>>({})
  const readable = computed(() => !!snapshot.value && !snapshotError.value)
  const host = computed(() => snapshot.value?.machines.find(machine => machine.name === snapshot.value?.dispatcher.config.machine) ?? null)
  const commands = computed(() => submitted.value.filter(item => item.share === snapshot.value?.share))
  let active = false, stream: BoardStream | null = null, timer: number | undefined
  let snapshotRequest: AbortController | null = null, ledgerRequest: AbortController | null = null, detailRequest: AbortController | null = null
  let exportRequest: AbortController | null = null
  let ledgerQuery = queryFilters(filters.value, now.value), metadataShare = ''
  let metadataGeneration = 0, metadataTickets = new Set<string>()
  let ledgerRequestKey = '', ledgerRefreshPending = false

  function rememberCommands() {
    if (!saveLocal('commands', submitted.value)) storageError.value = '浏览器未能记住指令记录；刷新后请按单号核对回执。'
  }
  function reconcileReceipts(data: api.SchedSnapshot) {
    for (const command of submitted.value) {
      if (command.share !== data.share) continue
      const receipt = data.recentReceipts.find(item => item.commandId === command.commandId)
      if (receipt) command.receipt = receipt
    }
    rememberCommands()
  }
  async function queueMetadata(data: api.SchedSnapshot, signal: AbortSignal) {
    const generation = metadataGeneration
    const current = (id: string) => active && !signal.aborted && generation === metadataGeneration
      && metadataShare === data.share && metadataTickets.has(id)
    const missing = data.queue.filter(item => !queueDetails.value[item.ticketId])
    // 请求并发有界；仅保留队列表格实际消费的字段，不驻留 attempts/timeline。
    let index = 0
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
      while (index < missing.length && !signal.aborted) {
        const item = missing[index++]!
        try {
          const result = await api.fetchQueueTicket(item.ticketId, signal)
          if (current(item.ticketId)) { queueDetails.value[item.ticketId] = queueMetadataOf(result.ticket); delete queueErrors.value[item.ticketId] }
        } catch (error) {
          if (current(item.ticketId)) queueErrors.value[item.ticketId] = error instanceof Error ? error.message : String(error)
        }
      }
    }))
  }
  async function refreshSnapshot() {
    if (!active || document.visibilityState !== 'visible' || snapshotRequest) return
    const request = new AbortController(); snapshotRequest = request; loading.value = true
    reconnecting.value = false; reconnectAttempt.value = 0
    try {
      const data = await fetchSnapshotWithRetry(api.fetchSnapshot, {
        signal: request.signal,
        onRetry: (n) => {
          if (n === 0) { reconnecting.value = false; reconnectAttempt.value = 0 }
          else { reconnecting.value = true; reconnectAttempt.value = n }
        },
      })
      if (request.signal.aborted || snapshotRequest !== request || !active) return
      if (metadataShare !== data.share) { queueDetails.value = {}; queueErrors.value = {}; metadataShare = data.share }
      metadataGeneration++; metadataTickets = new Set(data.queue.map(item => item.ticketId))
      pruneQueueRecords(queueDetails.value, metadataTickets); pruneQueueRecords(queueErrors.value, metadataTickets)
      snapshot.value = data; snapshotError.value = ''; now.value = Date.now(); reconcileReceipts(data)
      await queueMetadata(data, request.signal)
    } catch (error) {
      if (!request.signal.aborted) {
        reconnecting.value = false
        snapshotError.value = error instanceof Error ? error.message : String(error)
      }
    } finally { if (snapshotRequest === request) { snapshotRequest = null; loading.value = false } }
  }
  async function loadLedger() {
    if (!active || document.visibilityState !== 'visible') return
    const query = { ...ledgerQuery }, cursor = cursors.value[page.value] || ''
    const key = JSON.stringify([Object.entries(query).sort(([a], [b]) => a.localeCompare(b)), page.value, cursor])
    // Identical events mark one trailing refresh instead of repeatedly cancelling server reads.
    if (ledgerRequest && ledgerRequestKey === key) { ledgerRefreshPending = true; return }
    ledgerRequest?.abort()
    ledgerRefreshPending = false; ledgerRequestKey = key
    const request = new AbortController(); ledgerRequest = request; ledgerLoading.value = true
    try {
      const data = await api.fetchTickets(query, cursor, 50, request.signal)
      if (!request.signal.aborted && ledgerRequest === request) { ledger.value = data; ledgerError.value = '' }
    } catch (error) {
      if (!request.signal.aborted && ledgerRequest === request) ledgerError.value = error instanceof Error ? error.message : String(error)
    } finally {
      if (ledgerRequest === request) {
        const refresh = ledgerRefreshPending
        ledgerRequest = null; ledgerRefreshPending = false; ledgerLoading.value = false
        if (refresh) void loadLedger()
      }
    }
  }
  function applyFilters(value: LedgerPrefs) {
    ledgerRequest?.abort(); ledgerRequest = null; ledgerRefreshPending = false; ledgerLoading.value = false
    exportRequest?.abort(); exportRequest = null; exporting.value = false; exportError.value = ''
    filters.value = { ...value }; cursors.value = ['']; page.value = 0; ledger.value = null
    ledgerQuery = queryFilters(value, Date.now())
    if (!saveLocal('filters', value)) storageError.value = '浏览器未能记住筛选条件，本次筛选仍然有效。'
    void loadLedger()
  }
  async function exportLedger() {
    if (exporting.value || !readable.value) return
    const request = new AbortController(); exportRequest = request; exporting.value = true; exportError.value = ''
    try {
      const blob = await api.exportTickets({ ...ledgerQuery }, request.signal)
      if (request.signal.aborted) return
      const url = URL.createObjectURL(blob), link = document.createElement('a')
      try {
        link.href = url; link.download = 'sched-ledger.csv'; document.body.appendChild(link); link.click()
      } finally { link.remove(); URL.revokeObjectURL(url) }
    } catch (error) {
      if (!request.signal.aborted) exportError.value = error instanceof Error ? error.message : String(error)
    } finally { if (exportRequest === request) { exportRequest = null; exporting.value = false } }
  }
  function movePage(direction: -1 | 1) {
    if (ledgerLoading.value) return
    if (direction === 1 && ledger.value?.nextCursor) {
      cursors.value = [...cursors.value.slice(0, page.value + 1), ledger.value.nextCursor]; page.value++
    } else if (direction === -1 && page.value > 0) page.value--
    else return
    ledger.value = null; void loadLedger()
  }
  async function openDetail(id: string) {
    detailRequest?.abort(); const request = new AbortController(); detailRequest = request
    detailId.value = id; detail.value = null; related.value = null; detailError.value = ''; detailLoading.value = true
    try {
      const data = await api.fetchTicket(id, request.signal)
      if (!request.signal.aborted) { detail.value = data.ticket; related.value = data.related }
    } catch (error) {
      if (!request.signal.aborted) detailError.value = error instanceof Error ? error.message : String(error)
    } finally { if (detailRequest === request) { detailRequest = null; detailLoading.value = false } }
  }
  function closeDetail() { detailRequest?.abort(); detailRequest = null; detailId.value = null; detail.value = null; related.value = null; detailLoading.value = false }
  async function command(input: api.CommandInput) {
    if (busy.value || !readable.value || !snapshot.value) return false
    busy.value = true; commandError.value = ''; const share = snapshot.value.share
    try {
      const result = await api.postCommand(input)
      submitted.value.unshift({ commandId: result.commandId, input, share, ...commandTimes(result.commandId) })
      submitted.value = submitted.value.slice(0, 50); rememberCommands(); void refreshSnapshot()
      return true
    } catch (error) { commandError.value = error instanceof Error ? error.message : String(error); return false }
    finally { busy.value = false }
  }
  function suspend() {
    exportRequest?.abort(); exportRequest = null; exporting.value = false
    if (timer !== undefined) window.clearInterval(timer)
    timer = undefined; stream?.stop(); stream = null
    snapshotRequest?.abort(); snapshotRequest = null; loading.value = false
    ledgerRequest?.abort(); ledgerRequest = null; ledgerRefreshPending = false; ledgerLoading.value = false
  }
  function visibilityChanged() {
    suspend()
    if (!active || document.visibilityState !== 'visible') return
    now.value = Date.now(); void refreshSnapshot(); void loadLedger()
    stream = new BoardStream({ onChanged: () => {}, onSchedChanged: () => { void refreshSnapshot(); void loadLedger() } })
    stream.start()
    timer = window.setInterval(() => { now.value = Date.now(); void refreshSnapshot() }, 5000)
  }
  function start() {
    if (active) return
    active = true; ledgerQuery = queryFilters(filters.value, Date.now()); cursors.value = ['']; page.value = 0
    document.addEventListener('visibilitychange', visibilityChanged); visibilityChanged()
  }
  function stop() {
    active = false; document.removeEventListener('visibilitychange', visibilityChanged); suspend(); closeDetail()
    metadataGeneration++; metadataTickets.clear(); metadataShare = ''; queueDetails.value = {}; queueErrors.value = {}
    snapshot.value = null; ledger.value = null; cursors.value = ['']; page.value = 0
    snapshotError.value = ''; ledgerError.value = ''; detailError.value = ''; exportError.value = ''
    ledgerRequestKey = ''
  }

  return { snapshot, snapshotError, loading, commandError, storageError, now, busy, readable, host, commands, reconnecting, reconnectAttempt,
    filters, ledger, ledgerError, ledgerLoading, page, detail, detailId, detailError, detailLoading, related, queueDetails, queueErrors,
    exporting, exportError, exportLedger, refreshSnapshot, loadLedger, applyFilters, movePage, openDetail, closeDetail, command, start, stop }
})
