<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import type { JobSummary } from '@/types/codex'
import TopBar from '@/components/TopBar.vue'
import SideNav from '@/components/SideNav.vue'
import TaskDrawer from '@/components/TaskDrawer.vue'

const store = useBoardStore()
const hasRunningJob = ref(false)
let jobsTimer: ReturnType<typeof setInterval> | null = null
let jobsRequestInFlight = false

async function refreshRunningJobs() {
  if (document.visibilityState !== 'visible' || jobsRequestInFlight) return
  jobsRequestInFlight = true
  try {
    const response = await fetch('/api/codex/jobs')
    if (!response.ok) {
      hasRunningJob.value = false
      return
    }
    const jobs = await response.json() as JobSummary[]
    hasRunningJob.value = Array.isArray(jobs) && jobs.some(job => job.running === true)
  } catch (_) {
    hasRunningJob.value = false
  } finally {
    jobsRequestInFlight = false
  }
}

function stopJobsPolling() {
  if (!jobsTimer) return
  clearInterval(jobsTimer)
  jobsTimer = null
}

function startJobsPolling() {
  stopJobsPolling()
  if (document.visibilityState !== 'visible') return
  void refreshRunningJobs()
  jobsTimer = setInterval(refreshRunningJobs, 60_000)
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') startJobsPolling()
  else stopJobsPolling()
}

onMounted(() => {
  store.init()
  document.addEventListener('visibilitychange', onVisibilityChange)
  startJobsPolling()
})

onBeforeUnmount(() => {
  stopJobsPolling()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  store.stopStream()
})
</script>

<template>
  <div class="shell">
    <div
      class="system-heartbeat glow-top"
      :class="{ glow: hasRunningJob }"
      :title="hasRunningJob ? '有工单正在运行' : '当前没有运行中的工单'"
      aria-hidden="true"
    />
    <TopBar class="area-top" />
    <SideNav class="area-nav" />
    <main class="area-main">
      <div v-if="store.loading" class="loading-line" />
      <div v-if="store.error" class="errbar">
        <span>⚠︎ {{ store.error }}</span>
        <button class="btn btn-sm" type="button" @click="store.refresh()">重试</button>
        <span class="spacer" />
        <button class="btn btn-sm quiet" type="button" aria-label="关闭错误提示" @click="store.error = null">×</button>
      </div>
      <!-- 裸 router-view：视图切换即时可靠，不依赖 transitionend（out-in 在异步组件/受限动画环境会卡住）。 -->
      <router-view />
    </main>
    <TaskDrawer />
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  display: grid;
  grid-template-columns: 208px 1fr;
  grid-template-rows: 52px 1fr;
  height: 100vh;
  overflow: hidden;
}
.system-heartbeat { position: absolute; z-index: 60; top: 0; right: 0; left: 0; background-color: var(--line); }
.area-top { grid-column: 1 / 3; grid-row: 1; }
.area-nav { grid-column: 1; grid-row: 2; }
.area-main { position: relative; grid-column: 2; grid-row: 2; overflow: auto; padding: var(--s4) var(--s5); }
.errbar {
  display: flex;
  align-items: center;
  gap: var(--s2);
  margin-bottom: var(--s3);
  padding: var(--s2) var(--s3);
  background: var(--bad-bg);
  border: 1px solid var(--bad);
  border-radius: var(--r);
  color: var(--bad);
  font-size: var(--fs-base);
}
.loading-line { position: absolute; top: 0; right: 0; left: 0; }

@media (max-width: 700px) {
  .shell { grid-template-columns: 172px 1fr; }
  .area-main { padding: var(--s4); }
}
</style>
