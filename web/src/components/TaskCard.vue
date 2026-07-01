<script setup lang="ts">
import type { Task } from '@/types'
import { useBoardStore } from '@/stores/board'
import { statusColor } from '@/api/schema'
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
  <div
    class="tcard card"
    :class="{ pulsing: store.isPulsing(projectId, task.id) }"
    :style="{ borderLeft: '3px solid ' + statusColor(task.status) }"
    @click="store.openTask(task.id, projectId)"
  >
    <div class="row gap-2 head">
      <span class="tid mono">{{ task.id }}</span>
      <span class="spacer" />
      <span v-if="pending()" class="badge pend" :title="pending() + ' 条待拍板'">❓{{ pending() }}</span>
    </div>
    <div class="ttitle">{{ task.title }}</div>
    <div v-if="building() || (task.percent ?? 0) > 0" class="prog-wrap">
      <div class="progress"><i :style="{ width: (task.percent || 0) + '%' }" /></div>
      <span class="pct mono">{{ task.percent || 0 }}%</span>
      <span v-if="building() && lastProgressAt()" class="prog-time" :class="{ stale: stale() }">
        {{ stale() ? '⚠ ' : '' }}{{ relTime(lastProgressAt()) }}
      </span>
    </div>
    <div class="row gap-2 wrap meta" v-if="(task.gitBranch?.length || task.prNumbers?.length || task.wave)">
      <span v-for="b in task.gitBranch || []" :key="b" class="pill">🌿 {{ b }}</span>
      <span v-for="p in task.prNumbers || []" :key="p" class="pill">PR #{{ p }}</span>
      <span v-if="task.wave" class="pill">W{{ task.wave }}</span>
    </div>
  </div>
</template>

<style scoped>
.tcard { padding: 9px 11px; cursor: pointer; display: flex; flex-direction: column; gap: 7px; transition: transform 0.1s, border-color 0.15s; }
.tcard:hover { transform: translateY(-1px); border-color: var(--accent); }
.head { font-size: 12px; }
.tid { color: var(--muted); font-weight: 600; }
.ttitle { font-size: 13px; line-height: 1.35; }
.meta { margin-top: 1px; }
.pend { background: rgba(245, 166, 35, 0.16); color: var(--warn); border: 1px solid rgba(245, 166, 35, 0.4); }
.prog-wrap { display: flex; align-items: center; gap: 7px; }
.prog-wrap .progress { flex: 1; }
.pct { font-size: 11px; color: var(--muted); min-width: 30px; text-align: right; }
.prog-time { font-size: 10px; color: var(--muted-2); white-space: nowrap; }
.prog-time.stale { color: var(--warn); }
</style>
