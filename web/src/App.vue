<script setup lang="ts">
import '@/utils/celebrate'
import '@/utils/soundLink'
import '@/utils/notify'
import Icon from '@/components/Icon.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import router from '@/router'
import type { ModuleId } from '@/api/client'
import type { JobSummary } from '@/types/codex'
import TopBar from '@/components/TopBar.vue'
import SideNav from '@/components/SideNav.vue'
import TaskDrawer from '@/components/TaskDrawer.vue'

const store = useBoardStore()
const hasRunningJob = ref(false)

/**
 * 宽屏内嵌详情栏：窗口够宽(≥1600)时，任务详情不再糊一层遮罩挡住列表，
 * 而是占住外壳的第三列常驻显示——左边列表照常滚动、照常点下一张卡。
 * 窄于 1600 自动回落到原来的遮罩抽屉，所以这里只需要一个断点判断，
 * 真正的两套外观由 TaskDrawer 按 docked 自己切。
 */
const DOCK_QUERY = '(min-width: 1600px)'
const wideEnough = ref(false)
let dockMql: MediaQueryList | null = null
/**
 * 除了 matchMedia 的 change，还挂一个 resize 兜底：
 * 内嵌浏览器/被 CDP 改过视口大小的环境里 change 事件不一定发得出来，
 * 这时只靠 change 会一直停在开窗时的那一档（实测踩到过）。resize 里重新读一遍 matches，
 * 值没变时给 ref 赋同一个布尔不会触发重渲染，白跑几次没有代价。
 */
function syncDock() { wideEnough.value = dockMql ? dockMql.matches : window.innerWidth >= 1600 }
// 详情栏只在「屏够宽」且「真的选中了一张卡」时才占列，否则第三列根本不存在。
const dockDetail = computed(() => wideEnough.value && !!store.selectedTask)

let jobsTimer: ReturnType<typeof setInterval> | null = null
let jobsRequestInFlight = false

async function refreshRunningJobs() {
  const projectId = store.currentProjectId
  if (!store.modules.codex || !projectId || document.visibilityState !== 'visible' || jobsRequestInFlight) return
  jobsRequestInFlight = true
  try {
    const response = await fetch(`/api/codex/jobs?project=${encodeURIComponent(projectId)}`)
    if (!response.ok) {
      hasRunningJob.value = false
      return
    }
    const jobs = await response.json() as JobSummary[]
    if (store.modules.codex && store.currentProjectId === projectId) {
      hasRunningJob.value = Array.isArray(jobs) && jobs.some(job => job.running === true)
    }
  } catch (_) {
    hasRunningJob.value = false
  } finally {
    jobsRequestInFlight = false
    if (store.currentProjectId !== projectId) void refreshRunningJobs()
  }
}

function stopJobsPolling() {
  if (!jobsTimer) return
  clearInterval(jobsTimer)
  jobsTimer = null
}

function startJobsPolling() {
  stopJobsPolling()
  if (!store.modules.codex || !store.currentProjectId || document.visibilityState !== 'visible') return
  void refreshRunningJobs()
  jobsTimer = setInterval(refreshRunningJobs, 60_000)
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') startJobsPolling()
  else stopJobsPolling()
}

watch(() => [store.modules.codex, store.currentProjectId], () => {
  hasRunningJob.value = false
  startJobsPolling()
})
watch(() => store.modules, () => {
  const module = router.currentRoute.value.meta.module as ModuleId | undefined
  if (module && !store.modules[module]) void router.replace('/overview')
}, { deep: true })

onMounted(() => {
  store.init()
  document.addEventListener('visibilitychange', onVisibilityChange)
  startJobsPolling()
  dockMql = window.matchMedia(DOCK_QUERY)
  syncDock()
  dockMql.addEventListener('change', syncDock)
  window.addEventListener('resize', syncDock)
})

onBeforeUnmount(() => {
  stopJobsPolling()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  dockMql?.removeEventListener('change', syncDock)
  window.removeEventListener('resize', syncDock)
  store.stopStream()
})
</script>

<template>
  <div class="shell" :class="{ 'has-dock': dockDetail }">
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
        <span class="errline"><Icon name="alertTri" :size="16" />{{ store.error }}</span>
        <button class="btn btn-sm" type="button" @click="store.refresh()">重试</button>
        <span class="spacer" />
        <button class="btn btn-sm quiet" type="button" aria-label="关闭错误提示" @click="store.error = null"><Icon name="x" :size="14" /></button>
      </div>
      <!-- 裸 router-view：视图切换即时可靠，不依赖 transitionend（out-in 在异步组件/受限动画环境会卡住）。 -->
      <router-view />
    </main>
    <TaskDrawer :docked="dockDetail" />
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  display: grid;
  grid-template-columns: 208px 1fr;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100vh;
  overflow: hidden;
}
/* 内嵌详情栏开着时腾出第三列；TaskDrawer 在 docked 模式下正好落进 grid-column 3。
   宽度与原抽屉同量级(480 vs 520)，主内容区剩 1232，仍够两栏卡片流。 */
.shell.has-dock { grid-template-columns: 208px 1fr 480px; }
.system-heartbeat { position: absolute; z-index: 60; top: 0; right: 0; left: 0; background-color: var(--line); }
.area-top { grid-column: 1 / 3; grid-row: 1; }
.shell.has-dock .area-top { grid-column: 1 / 4; }
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
.errline { display: inline-flex; align-items: center; gap: var(--s2); }
.loading-line { position: absolute; top: 0; right: 0; left: 0; }

@media (max-width: 700px) {
  .shell { grid-template-columns: 172px 1fr; }
  .area-main { padding: var(--s4); }
}
</style>
