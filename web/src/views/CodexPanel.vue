<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import CodexReport from '@/components/codex/CodexReport.vue'
import CodexJobsTab from '@/components/codex/CodexJobsTab.vue'
import CodexSessionsTab from '@/components/codex/CodexSessionsTab.vue'

type Tab = 'jobs' | 'sessions'
const activeTab = ref<Tab>('jobs')
const autoRefresh = ref(true)
const refreshKey = ref(0)
const requestedSlug = ref('')
const requestedSessionId = ref('')
const jumpNonce = ref(0)
let timer: number | undefined

function refresh() { refreshKey.value += 1 }

function resetTimer() {
  if (timer !== undefined) window.clearInterval(timer)
  timer = autoRefresh.value ? window.setInterval(refresh, 10_000) : undefined
}

function openJob(slug: string) {
  requestedSlug.value = slug
  activeTab.value = 'jobs'
  jumpNonce.value += 1
}

function openSession(sessionId: string) {
  requestedSessionId.value = sessionId
  activeTab.value = 'sessions'
  jumpNonce.value += 1
}

onMounted(() => { refresh(); resetTimer() })
watch(autoRefresh, resetTimer)
onUnmounted(() => { if (timer !== undefined) window.clearInterval(timer) })
</script>

<template>
  <div class="page">
    <header class="toolbar">
      <div><h1>🤖 Codex</h1><p>本机全部 Codex 活动与 stock-rogue 派单工单</p></div>
      <span class="spacer" />
      <label class="auto"><input v-model="autoRefresh" type="checkbox"> 每 10 秒自动刷新</label>
      <button class="btn btn-sm" @click="refresh">刷新</button>
    </header>

    <CodexReport :refresh-key="refreshKey" @open-job="openJob" />

    <div class="tabs" role="tablist" aria-label="Codex 数据范围">
      <button :class="{ on: activeTab === 'jobs' }" role="tab" @click="activeTab = 'jobs'">工单</button>
      <button :class="{ on: activeTab === 'sessions' }" role="tab" @click="activeTab = 'sessions'">全部会话</button>
    </div>

    <CodexJobsTab
      v-if="activeTab === 'jobs'"
      :refresh-key="refreshKey" :requested-slug="requestedSlug" :jump-nonce="jumpNonce"
      @open-session="openSession"
    />
    <CodexSessionsTab
      v-else
      :refresh-key="refreshKey" :requested-session-id="requestedSessionId" :jump-nonce="jumpNonce"
      @open-job="openJob"
    />
  </div>
</template>

<style scoped>
.page { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.toolbar { display: flex; align-items: center; gap: 10px; }
.toolbar h1 { font-size: 20px; } .toolbar p { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
.auto { color: var(--muted); font-size: 12px; cursor: pointer; }
.tabs { align-self: flex-start; display: flex; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.tabs button { border: 0; padding: 7px 18px; background: var(--panel); color: var(--muted); cursor: pointer; }
.tabs button.on { background: var(--accent-soft); color: var(--text); font-weight: 600; }
@media (max-width: 820px) { .toolbar { flex-wrap: wrap; } }
</style>
