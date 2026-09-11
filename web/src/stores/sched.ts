import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import * as api from '@/api/sched'
import { BoardStream } from '@/api/sse'
import { commandTimes, loadCommands, loadFilters, queryFilters, saveLocal, type LedgerPrefs } from '@/components/sched/preferences'

export const useSchedStore = defineStore('sched', () => {
  const snapshot = ref<api.SchedSnapshot | null>(null)
  const snapshotError = ref(''), loading = ref(false), commandError = ref(''), storageError = ref('')
  const now = ref(Date.now()), busy = ref(false)
  const submitted = ref(loadCommands()), filters = ref(loadFilters())
  const ledger = ref<api.TicketPage | null>(null), ledgerError = ref(''), ledgerLoading = ref(false)
  const cursors = ref(['']), page = ref(0)
  const detail = ref<api.TicketDetail | null>(null), detailId = ref<string | null>(null), detailError = ref('')
  const detailLoading = ref(false)
  const queueDetails = ref<Record<string, api.TicketDetail>>({}), queueErrors = ref<Record<string, string>>({})
  const readable = computed(() => !!snapshot.value && !snapshotError.value)
  const host = computed(() => snapshot.value?.machines.find(machine => machine.name === snapshot.value?.dispatcher.config.machine) ?? null)
  const commands = computed(() => submitted.value.filter(item => item.share === snapshot.value?.share))
  let active = false, stream: BoardStream | null = null, timer: number | undefined
  let snapshotRequest: AbortController | null = null, ledgerRequest: AbortController | null = null, detailRequest: AbortController | null = null
  let ledgerQuery = queryFilters(filters.value, now.value), metadataShare = ''

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
    const missing = data.queue.filter(item => !queueDetails.value[item.ticketId])
    // 请求并发有界；详情只缓存不可变挂号元数据，不拿它覆盖实时状态。
    let index = 0
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
      while (index < missing.length && !signal.aborted) {
        const item = missing[index++]!
        try {
          const result = await api.fetchTicket(item.ticketId, signal)
          if (!signal.aborted) { queueDetails.value[item.ticketId] = result.ticket; delete queueErrors.value[item.ticketId] }
        } catch (error) {
          if (!signal.aborted) queueErrors.value[item.ticketId] = error instanceof Error ? error.message : String(error)
        }
      }
    }))
  }
  async function refreshSnapshot() {
    if (!active || document.visibilityState !== 'visible' || snapshotRequest) return
    const request = new AbortController(); snapshotRequest = request; loading.value = true
    try {
      const data = await api.fetchSnapshot(request.signal)
      if (request.signal.aborted) return
      if (metadataShare !== data.share) { queueDetails.value = {}; queueErrors.value = {}; metadataShare = data.share }
      snapshot.value = data; snapshotError.value = ''; now.value = Date.now(); reconcileReceipts(data)
      await queueMetadata(data, request.signal)
    } catch (error) {
      if (!request.signal.aborted) snapshotError.value = error instanceof Error ? error.message : String(error)
    } finally { if (snapshotRequest === request) { snapshotRequest = null; loading.value = false } }
  }
  async function loadLedger() {
    if (!active || document.visibilityState !== 'visible') return
    ledgerRequest?.abort()
    const request = new AbortController(); ledgerRequest = request; ledgerLoading.value = true
    try {
      const data = await api.fetchTickets(ledgerQuery, cursors.value[page.value] || '', 50, request.signal)
      if (!request.signal.aborted) { ledger.value = data; ledgerError.value = '' }
    } catch (error) {
      if (!request.signal.aborted) ledgerError.value = error instanceof Error ? error.message : String(error)
    } finally { if (ledgerRequest === request) { ledgerRequest = null; ledgerLoading.value = false } }
  }
  function applyFilters(value: LedgerPrefs) {
    filters.value = { ...value }; cursors.value = ['']; page.value = 0; ledger.value = null
    ledgerQuery = queryFilters(value, Date.now())
    if (!saveLocal('filters', value)) storageError.value = '浏览器未能记住筛选条件，本次筛选仍然有效。'
    void loadLedger()
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
    detailId.value = id; detail.value = null; detailError.value = ''; detailLoading.value = true
    try {
      const data = await api.fetchTicket(id, request.signal)
      if (!request.signal.aborted) detail.value = data.ticket
    } catch (error) {
      if (!request.signal.aborted) detailError.value = error instanceof Error ? error.message : String(error)
    } finally { if (detailRequest === request) { detailRequest = null; detailLoading.value = false } }
  }
  function closeDetail() { detailRequest?.abort(); detailRequest = null; detailId.value = null; detail.value = null; detailLoading.value = false }
  async function command(input: api.CommandInput) {
    if (busy.value || !readable.value || !snapshot.value) return false
    busy.value = true; commandError.value = ''; const share = snapshot.value.share
    try {
      const result = await api.postCommand(input)
      submitted.value.unshift({ commandId: result.commandId, input, share, ...commandTimes(result.commandId), legacy: result.legacy })
      submitted.value = submitted.value.slice(0, 50); rememberCommands(); void refreshSnapshot()
      return true
    } catch (error) { commandError.value = error instanceof Error ? error.message : String(error); return false }
    finally { busy.value = false }
  }
  async function retryLegacy(id: string) {
    const item = commands.value.find(command => command.commandId === id)
    if (!item || item.input.kind !== 'reserve' || busy.value || !readable.value) return
    busy.value = true
    try { item.legacy = (await api.retryLegacyReserve(item.input.data)).legacy; void refreshSnapshot() }
    catch (error) { item.legacy = { ok: false, error: error instanceof Error ? error.message : String(error) } }
    finally { rememberCommands(); busy.value = false }
  }
  function suspend() {
    if (timer !== undefined) window.clearInterval(timer)
    timer = undefined; stream?.stop(); stream = null
    snapshotRequest?.abort(); snapshotRequest = null; loading.value = false
    ledgerRequest?.abort(); ledgerRequest = null; ledgerLoading.value = false
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
  function stop() { active = false; document.removeEventListener('visibilitychange', visibilityChanged); suspend(); closeDetail() }

  return { snapshot, snapshotError, loading, commandError, storageError, now, busy, readable, host, commands,
    filters, ledger, ledgerError, ledgerLoading, page, detail, detailId, detailError, detailLoading, queueDetails, queueErrors,
    refreshSnapshot, loadLedger, applyFilters, movePage, openDetail, closeDetail, command, retryLegacy, start, stop }
})
