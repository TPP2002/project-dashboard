<script setup lang="ts">
import type { Task } from '@/types'
import { useBoardStore } from '@/stores/board'
import { relTime } from '@/utils/format'

const props = defineProps<{ task: Task; projectId: string }>()
const store = useBoardStore()
const pending = () => (props.task.decisions ?? []).filter((d) => d.answer == null).length
const building = () => props.task.status === '施工中'
// 施工中恒显进度条(哪怕 0%);进度戳超 30 分钟没动 = 陈旧,标黄提醒
const lastProgressAt = () => (props.task as any).lastProgressAt as string | undefined
const stale = () => {
  const t = lastProgressAt()
  if (!t || !building()) return false
  return Date.now() - new Date(t).getTime() > 30 * 60 * 1000
}
</script>

<template>
  <article
    class="tcard card"
    :class="{ pulsing: store.isPulsing(projectId, task.id) }"
    role="button"
    tabindex="0"
    @click="store.openTask(task.id, projectId)"
    @keydown.enter="store.openTask(task.id, projectId)"
    @keydown.space.prevent="store.openTask(task.id, projectId)"
  >
    <span v-if="building()" class="glow-edge" />
    <div class="tcard-head">
      <span class="tid mono">{{ task.id }}</span>
      <span class="spacer" />
      <span v-if="pending()" class="badge warn" :title="pending() + ' 条待拍板'">❓{{ pending() }}</span>
    </div>
    <div class="ttitle">{{ task.title }}</div>
    <div v-if="building() || (task.percent ?? 0) > 0" class="prog-wrap">
      <div class="glow-rail"><i :style="{ width: (task.percent || 0) + '%' }" /></div>
      <span class="pct mono">{{ task.percent || 0 }}%</span>
      <span v-if="building() && lastProgressAt()" class="prog-time" :class="{ stale: stale() }">
        {{ stale() ? '⚠ ' : '' }}{{ relTime(lastProgressAt()) }}
      </span>
    </div>
    <div class="tcard-meta" v-if="(task.gitBranch?.length || task.prNumbers?.length || task.wave || task.modelHint)">
      <span v-for="b in task.gitBranch || []" :key="b" class="pill">🌿 {{ b }}</span>
      <span v-for="p in task.prNumbers || []" :key="p" class="pill">PR #{{ p }}</span>
      <span v-if="task.wave" class="pill">W{{ task.wave }}</span>
      <span v-if="task.modelHint" class="badge info" :title="'建议施工档位:' + task.modelHint">🤖 {{ task.modelHint }}</span>
    </div>
  </article>
</template>

<style scoped>
.tcard { display: flex; flex-direction: column; gap: var(--s2); cursor: pointer; transition: transform .14s ease, border-color .14s ease; }
.tcard:hover { transform: translateY(-1px); border-color: var(--line-strong); }
.tcard-head, .tcard-meta, .prog-wrap { display: flex; align-items: center; gap: var(--s2); }
.tcard-head { font-size: var(--fs-sm); }
.tcard-meta { flex-wrap: wrap; }
.tid { color: var(--text-2); font-weight: 600; }
.ttitle { font-size: var(--fs-base); line-height: 1.4; }
.prog-wrap .glow-rail { flex: 1; }
.pct { min-width: var(--s6); color: var(--text-2); font-size: var(--fs-xs); text-align: right; }
.prog-time { color: var(--text-3); font-size: var(--fs-xs); white-space: nowrap; }
.prog-time.stale { color: var(--warn); }
</style>
