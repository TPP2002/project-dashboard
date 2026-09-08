<script setup lang="ts">
// 全局活动流：跨项目 activity 合并倒序 + 项目/类型筛选 + 分页加载。点条目开对应任务抽屉。
// 修复（体检 B1/B2）：旧版先截断 60 条再筛选，筛"done"看不到历史记录、类型下拉也不全；
// 现在筛选作用于全量（数千条纯内存过滤毫秒级），显示端分页防 DOM 过大。
import { activityKind } from '@/utils/activityKind'
import Icon from '@/components/Icon.vue'
import { ref, computed, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import { fmtDateTime, relTime } from '@/utils/format'
import type { ActivityWithProject } from '@/utils/derive'

const store = useBoardStore()
const fType = ref('')
const fProj = ref('')
const PAGE = 100
const shown = ref(PAGE)

watch(() => store.loading ? [] : (fProj.value ? [fProj.value] : store.projectList.map((p) => p.id))
  .filter((pid) => !store.activityComplete[pid]), (pids) => {
  for (const pid of pids) store.ensureFullActivity(pid).catch((e) => {
    store.error = e instanceof Error ? e.message : String(e)
  })
}, { immediate: true })

const types = computed(() => [...new Set(store.globalActivity.map((a) => a.type).filter(Boolean))] as string[])
const filtered = computed(() =>
  store.globalActivity.filter(
    (a) => (!fType.value || a.type === fType.value) && (!fProj.value || a.projectId === fProj.value),
  ),
)
const list = computed(() => filtered.value.slice(0, shown.value))
const hasMore = computed(() => filtered.value.length > shown.value)
// 换筛选条件时回到第一页
watch([fType, fProj], () => { shown.value = PAGE })
const keyOf = (a: ActivityWithProject, i: number) => `${a.projectId}|${a.ts}|${a.taskId ?? ''}|${i}`
function open(a: ActivityWithProject) {
  if (a.taskId) store.openTask(a.taskId, a.projectId)
}
</script>

<template>
  <div>
    <div class="head">
      <h2><Icon name="activity" class="head-ic" :size="20" />活动流</h2>
      <span class="pill">{{ filtered.length }} 条{{ hasMore ? ` · 已显示 ${list.length}` : '' }}</span>
      <span class="spacer" />
      <select v-model="fProj" class="field sel">
        <option value="">全部项目</option>
        <option v-for="p in store.projectList" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <select v-model="fType" class="field sel">
        <option value="">全部类型</option>
        <!-- option 里塞不了 SVG，改成直接显示人话名字（比原来的英文 type 还好认）。 -->
        <option v-for="t in types" :key="t" :value="t">{{ activityKind(t).label }}</option>
      </select>
    </div>

    <div v-if="!list.length" class="empty card"><div class="big"><Icon name="inbox" :size="36" animated /></div><div>暂无活动，任务有新进展后会显示在这里。</div></div>

    <div class="tl" v-else>
      <div v-for="(a, i) in list" :key="keyOf(a, i)" class="item row" :class="{ clickable: a.taskId }" @click="open(a)">
        <Icon class="ic" :name="activityKind(a.type).icon" :size="16" :label="activityKind(a.type).label" />
        <div class="main">
          <div class="text">{{ a.text }}</div>
          <div class="meta mono">
            <span class="proj">{{ a.projectName }}</span>
            <span v-if="a.taskId" class="tid">{{ a.taskId }}</span>
            <span>{{ a.author }}</span>
            <span>{{ fmtDateTime(a.ts) }}</span>
            <span class="rel">{{ relTime(a.ts) }}</span>
          </div>
        </div>
      </div>
      <button v-if="hasMore" class="btn more" @click="shown += PAGE">
        <Icon name="chevron" :size="14" /> 加载更早的 {{ Math.min(PAGE, filtered.length - shown) }} 条（还剩 {{ filtered.length - shown }} 条）
      </button>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s4); flex-wrap: wrap; }
.sel { width: auto; }
.tl { display: flex; flex-direction: column; gap: var(--s2); }
.item { align-items: flex-start; }
.item.clickable { cursor: pointer; }
.ic { flex: none; color: var(--text-3); }
.main { flex: 1; min-width: 0; }
.text { font-size: var(--fs-base); }
.meta { display: flex; gap: var(--s3); flex-wrap: wrap; margin-top: var(--s1); color: var(--text-3); font-size: var(--fs-xs); }
.meta .proj, .meta .tid, .meta .rel { color: var(--text-2); }
.more { align-self: center; margin: var(--s2); }
</style>
