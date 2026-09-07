<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Task } from '@/types'
import { useBoardStore } from '@/stores/board'
import { relTime } from '@/utils/format'
import { registerCardElement, unregisterCardElement } from '@/utils/boardEvents'
import Icon from './Icon.vue'
import StatusTile from './StatusTile.vue'

const props = defineProps<{ task: Task; projectId: string }>()
const root = ref<HTMLElement | null>(null)
let registeredKey = ''
function registerRoot() {
  if (!root.value) return
  unregisterCardElement(registeredKey, root.value)
  registeredKey = `${props.projectId}:${props.task.id}`
  registerCardElement(registeredKey, root.value)
}
onMounted(registerRoot)
// 切换项目时同号任务可能复用组件，登记键须跟随当前项目。
watch(() => `${props.projectId}:${props.task.id}`, registerRoot)
onBeforeUnmount(() => {
  if (root.value) unregisterCardElement(registeredKey, root.value)
})
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
    ref="root"
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
      <StatusTile :status="task.status" :size="16" />
      <span class="tid mono">{{ task.id }}</span>
      <span class="spacer" />
      <span v-if="pending()" class="badge warn icon-badge" :title="pending() + ' 条待拍板'">
        <Icon name="bell" :size="14" />{{ pending() }}
      </span>
    </div>
    <!-- 三层结构:编号在上、人话标题居主位、技术说明退到小字(没写人话标题的老卡直接显示技术说明) -->
    <div class="ttitle">{{ task.plainTitle || task.title }}</div>
    <div v-if="task.plainTitle && task.title" class="tdesc" :title="task.title">{{ task.title }}</div>
    <div v-if="building() || (task.percent ?? 0) > 0" class="prog-wrap">
      <div class="glow-rail"><i :style="{ width: (task.percent || 0) + '%' }" /></div>
      <span class="pct mono">{{ task.percent || 0 }}%</span>
      <span v-if="building() && lastProgressAt()" class="prog-time" :class="{ stale: stale() }">
        <Icon v-if="stale()" name="alertTri" :size="14" />{{ relTime(lastProgressAt()) }}
      </span>
    </div>
    <div class="tcard-meta" v-if="(task.gitBranch?.length || task.prNumbers?.length || task.wave || task.modelHint)">
      <span v-for="b in task.gitBranch || []" :key="b" class="pill"><Icon name="branch" :size="14" />{{ b }}</span>
      <span v-for="p in task.prNumbers || []" :key="p" class="pill"><Icon name="pr" :size="14" />#{{ p }}</span>
      <span v-if="task.wave" class="pill"><Icon name="layers" :size="14" />W{{ task.wave }}</span>
      <span v-if="task.modelHint" class="badge info icon-badge" :title="'建议施工档位:' + task.modelHint">
        <Icon name="bot" :size="14" />{{ task.modelHint }}
      </span>
    </div>
  </article>
</template>

<style scoped>
/**
 * flex: none 是必须的:卡片放在纵向 flex 的列里,不写它就会被 flex 压扁——
 * 卡多的时候整张卡被挤成一行只剩编号,标题和进度全看不见(0902 负责人报的就是这个)。
 * 卡片必须保持自然高度,由列自己滚动。
 */
.tcard { flex: none; display: flex; flex-direction: column; gap: var(--s2); cursor: pointer; transition: transform .14s ease, border-color .14s ease; }
.tcard:hover { transform: translateY(-1px); border-color: var(--line-strong); }
.tcard-head, .tcard-meta, .prog-wrap { display: flex; align-items: center; gap: var(--s2); }
.tcard-head { font-size: var(--fs-sm); }
.tcard-meta { flex-wrap: wrap; }
.tid { color: var(--text-2); font-weight: 600; }
.ttitle { font-size: var(--fs-base); line-height: 1.4; }
/* 技术说明:给模型读的,负责人扫卡时不该被它挤占。压成两行,鼠标悬停看全文。 */
.tdesc {
  color: var(--text-3); font-size: var(--fs-sm); line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden;
}
.prog-wrap .glow-rail { flex: 1; }
.pct { min-width: var(--s6); color: var(--text-2); font-size: var(--fs-xs); text-align: right; }
/* 徽章基类是 inline-block，塞进图标后要改成 flex 才对得齐基线。 */
.icon-badge { display: inline-flex; align-items: center; gap: var(--s1); }
.prog-time { display: inline-flex; align-items: center; gap: var(--s1); color: var(--text-3); font-size: var(--fs-xs); white-space: nowrap; }
.prog-time.stale { color: var(--warn); }
</style>
