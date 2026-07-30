<script setup lang="ts">
// 全局活动流：跨项目 activity 合并倒序 + 项目/类型筛选 + 分页加载。点条目开对应任务抽屉。
// 修复（体检 B1/B2）：旧版先截断 60 条再筛选，筛"done"看不到历史记录、类型下拉也不全；
// 现在筛选作用于全量（数千条纯内存过滤毫秒级），显示端分页防 DOM 过大。
import { ref, computed, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import { fmtDateTime, relTime } from '@/utils/format'
import type { ActivityWithProject } from '@/utils/derive'

const store = useBoardStore()
const fType = ref('')
const fProj = ref('')
const PAGE = 100
const shown = ref(PAGE)

const TYPE_EMOJI: Record<string, string> = {
  claim: '🙋', progress: '📈', pending: '❓', decide: '✅',
  done: '🏁', park: '🚫', block: '⛔', note: '📝',
}
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
      <h2>📜 活动流</h2>
      <span class="pill">{{ filtered.length }} 条{{ hasMore ? ` · 已显示 ${list.length}` : '' }}</span>
      <span class="spacer" />
      <select v-model="fProj" class="sel">
        <option value="">全部项目</option>
        <option v-for="p in store.projectList" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <select v-model="fType" class="sel">
        <option value="">全部类型</option>
        <option v-for="t in types" :key="t" :value="t">{{ TYPE_EMOJI[t] || '·' }} {{ t }}</option>
      </select>
    </div>

    <div v-if="!list.length" class="empty card"><div class="big">📭</div><div>暂无活动。</div></div>

    <div class="tl card" v-else>
      <div v-for="(a, i) in list" :key="keyOf(a, i)" class="item" :class="{ clickable: a.taskId }" @click="open(a)">
        <span class="ic">{{ TYPE_EMOJI[a.type || ''] || '·' }}</span>
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
        ↓ 加载更早的 {{ Math.min(PAGE, filtered.length - shown) }} 条（还剩 {{ filtered.length - shown }} 条）
      </button>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.head h2 { font-size: 18px; }
.sel { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 5px 9px; font-size: 12px; }
.tl { padding: 6px; display: flex; flex-direction: column; }
.item { display: flex; gap: 10px; padding: 9px 10px; border-radius: var(--radius-sm); }
.item.clickable { cursor: pointer; }
.item.clickable:hover { background: var(--panel-2); }
.item + .item { border-top: 1px solid var(--border-soft); }
.ic { font-size: 15px; width: 20px; text-align: center; }
.main { flex: 1; min-width: 0; }
.text { font-size: 13px; }
.meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; color: var(--muted-2); margin-top: 3px; }
.meta .proj { color: var(--accent); }
.meta .tid { color: var(--muted); }
.meta .rel { color: var(--muted); }
.more { margin: 8px; align-self: center; }
</style>
