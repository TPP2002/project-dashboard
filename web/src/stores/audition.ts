import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '@/api/audition'
import type { AuditionBatchResult, AuditionIndexResult, AuditionOperations, AuditionState } from '@/types/audition'

export const useAuditionStore = defineStore('audition', () => {
  const indexes = ref<Record<string, AuditionIndexResult | null>>({})
  const indexErrors = ref<Record<string, string>>({})
  const project = ref<string | null>(null), currentKey = ref('')
  const payload = ref<AuditionBatchResult | null>(null), state = ref<AuditionState | null>(null)
  const loading = ref(false), error = ref('')
  let generation = 0
  const indexRequests = new Map<string, Promise<AuditionIndexResult | null>>()
  const writes = new Map<string, Promise<unknown>>()
  function checkIndex(pid: string, force = false): Promise<AuditionIndexResult | null> {
    const pending = indexRequests.get(pid)
    if (pending) return pending
    if (!force && Object.prototype.hasOwnProperty.call(indexes.value, pid)) return Promise.resolve(indexes.value[pid])
    const request = api.fetchAuditionIndex(pid).then(result => {
      indexes.value[pid] = result; delete indexErrors.value[pid]
      return result
    }).catch(e => {
      indexes.value[pid] = null; indexErrors.value[pid] = e instanceof Error ? e.message : '试听清单读取失败'
      return null
    }).finally(() => { indexRequests.delete(pid) })
    indexRequests.set(pid, request)
    return request
  }
  async function openProject(pid: string | null) {
    const token = ++generation
    project.value = pid; currentKey.value = ''; payload.value = null; state.value = null; error.value = ''
    loading.value = !!pid
    if (!pid) return
    const result = await checkIndex(pid, true)
    if (token !== generation) return
    if (!result) { error.value = indexErrors.value[pid]; loading.value = false; return }
    if (result.index.batches[0]) await openBatch(result.index.batches[0].key)
    else loading.value = false
  }
  async function openBatch(key: string) {
    const pid = project.value
    if (!pid) return
    const token = ++generation
    currentKey.value = key; payload.value = null; state.value = null; error.value = ''; loading.value = true
    try {
      // 回到刚才的批次时先等本页已发出的保存，避免回读到保存前的旧账本。
      await writes.get(JSON.stringify([pid, key]))?.catch(() => undefined)
      if (token !== generation) return
      const [batch, ledger] = await Promise.all([api.fetchAuditionBatch(pid, key), api.fetchAuditionState(pid, key)])
      if (token !== generation) return
      payload.value = batch; state.value = ledger
    } catch (e) { if (token === generation) error.value = e instanceof Error ? e.message : '批次读取失败' }
    finally { if (token === generation) loading.value = false }
  }
  function acceptState(pid: string, key: string, ledger: AuditionState, token: number) {
    if (token === generation && project.value === pid && currentKey.value === key) state.value = ledger
    const index = indexes.value[pid]
    if (index) {
      const marks = Object.values(ledger.marks)
      index.summaries[key] = { notes: ledger.notes.length, up: marks.filter(v => v === 'up').length, down: marks.filter(v => v === 'down').length, review: ledger.review }
    }
  }
  // 每次调用冻结项目与批次；镜像较慢也不能让先发回包覆盖后一次标记。
  function serial<T>(pid: string, key: string, run: () => Promise<T>): Promise<T> {
    const id = JSON.stringify([pid, key])
    const request = (writes.get(id) ?? Promise.resolve()).catch(() => undefined).then(run).finally(() => {
      if (writes.get(id) === request) writes.delete(id)
    })
    writes.set(id, request)
    return request
  }
  function mutate<K extends keyof AuditionOperations>(action: K, body: AuditionOperations[K]) {
    const pid = project.value, key = currentKey.value, token = generation
    if (!pid || !key || !state.value) return Promise.reject(new Error('请先打开一个批次'))
    return serial(pid, key, async () => {
      const result = await api.mutateAudition(action, pid, key, body)
      acceptState(pid, key, result.state, token)
      return result
    })
  }
  function exportNotes() {
    const pid = project.value, key = currentKey.value
    if (!pid || !key) return Promise.reject(new Error('请先打开一个批次'))
    return serial(pid, key, () => api.exportAudition(pid, key))
  }
  function leave() { ++generation; loading.value = false; payload.value = null; state.value = null }
  return { indexes, indexErrors, project, currentKey, payload, state, loading, error, checkIndex, openProject, openBatch, mutate, exportNotes, leave }
})
