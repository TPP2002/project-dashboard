<script setup lang="ts">
// 拍板历史：所有 answer !== null 的 decision，按 decidedAt 倒序。
// 治的病:"我拍了没?拍了啥?什么时候拍的?"——之前完全没记录。
import Icon from '@/components/Icon.vue'
import { computed, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import ScopeToggle from '@/components/ScopeToggle.vue'
import { humanTitle } from '@/utils/taskTitle'
import { isUnlanded, isPresumedLanded } from 'virtual:decision-landing'

const store = useBoardStore()
const search = ref('')
const showLanded = ref(true)  // 已落地也显示（默认全显示）

// 默认只看当前项目（跟随顶栏项目切换）；「全部项目」开关可跨项目聚合。
const base = computed(() =>
  store.decidedHistory.filter((it) => store.centerScopeAll || it.projectId === store.currentProjectId),
)

const items = computed(() => {
  let arr = base.value
  if (!showLanded.value) arr = arr.filter((it) => isUnlanded(it.task, it.decision))
  const s = search.value.trim().toLowerCase()
  if (s) arr = arr.filter((it) =>
    it.task.id.toLowerCase().includes(s) ||
    it.task.title.toLowerCase().includes(s) ||
    (it.task.plainTitle || '').toLowerCase().includes(s) ||
    it.decision.question.toLowerCase().includes(s) ||
    (it.decision.answer || '').toLowerCase().includes(s)
  )
  return arr
})
const stats = computed(() => {
  const all = base.value
  const unlanded = all.filter((it) => isUnlanded(it.task, it.decision)).length
  const presumed = all.filter((it) => isPresumedLanded(it.task, it.decision)).length
  return { total: all.length, unlanded, presumed, landed: all.length - unlanded - presumed }
})
</script>

<template>
  <div class="history-page">
    <header class="page-head">
      <div>
        <h1><Icon name="history" class="head-ic" :size="20" />拍板历史</h1>
        <p>拍过的每一条都留档：什么时候拍的、拍了什么、当时为什么这么推荐。</p>
      </div>
      <div class="head-actions">
        <span class="pill">{{ stats.total }} 条 · 待落地 {{ stats.unlanded }} · 推定落地 {{ stats.presumed }} · 已落地 {{ stats.landed }}</span>
        <ScopeToggle />
        <label class="toggle">
          <input type="checkbox" v-model="showLanded" />
          <span>显示已落地</span>
        </label>
        <input v-model="search" class="field search" placeholder="搜任务 / 问题 / 答案…" />
      </div>
    </header>

    <div v-if="!items.length" class="empty card">
      <div class="big"><Icon name="target" :size="36" /></div>
      <div>{{ base.length ? '没匹配的记录，换个关键词或重新显示已落地' : '还没拍过板，完成一次拍板后会在这里留档' }}</div>
    </div>

    <div class="list">
      <div v-for="it in items" :key="`${it.projectId}:${it.task.id}:${it.decision.id}`" class="row decision-row">
        <div class="top">
          <span class="proj pill">{{ it.projectName }}</span>
          <span class="tid mono">{{ it.task.id }}</span>
          <span class="ttitle">{{ humanTitle(it.task) }}</span>
          <span class="did mono">#{{ it.decision.id }}</span>
          <span class="date">{{ it.decision.decidedAt || '—' }}</span>
          <span v-if="isPresumedLanded(it.task, it.decision)" class="badge n icon-badge">
            <Icon name="check" :size="14" />随卡完工
          </span>
          <span v-else-if="isUnlanded(it.task, it.decision)" class="badge warn icon-badge">
            <Icon name="toland" :size="14" />待落地
          </span>
          <span v-else class="badge ok icon-badge">
            <Icon name="check" :size="14" />已落地
          </span>
        </div>
        <div class="q">{{ it.decision.question }}</div>
        <div class="ans">
          <span class="ans-label">你的答案：</span>
          <span class="ans-body">{{ it.decision.answer }}</span>
          <span v-if="it.decision.answer !== it.decision.recommended" class="badge warn compact custom-tag icon-badge"><Icon name="pencil" :size="14" />自定义/非推荐</span>
          <span v-else class="badge n compact rec-tag">= 推荐</span>
        </div>
        <div v-if="(it.decision as any).recommendReason" class="reason muted">
          <b>当时的推荐理由:</b> {{ (it.decision as any).recommendReason }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.history-page { width: 100%; min-width: 0; display: flex; flex-direction: column; gap: var(--s4); }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s5); }
.page-head p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-md); }
.head-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--s2); }
.toggle { display: flex; align-items: center; gap: var(--s1); color: var(--text-2); cursor: pointer; font-size: var(--fs-sm); white-space: nowrap; }
.search { width: 200px; }
/* 记录自动分栏：每列不窄于 560（一条记录 = 问题 + 答案 + 当时的推荐理由，再窄就开始频繁折行）。 */
.list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(560px, 100%), 1fr)); align-items: start; gap: var(--s2); }
.decision-row { align-items: stretch; flex-direction: column; gap: var(--s2); padding: var(--s3) var(--s4); }
.top { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
.tid { color: var(--text-2); font-weight: 600; }
.ttitle { font-weight: 600; }
.did { color: var(--text-3); font-size: var(--fs-sm); }
.date { margin-left: auto; color: var(--text-2); font-size: var(--fs-sm); }
.q { color: var(--text-2); font-size: var(--fs-base); line-height: 1.5; }
.ans { padding: var(--s2) var(--s3); border-left: 3px solid var(--info); border-radius: var(--r); background: var(--surface); font-size: var(--fs-base); }
.ans-label { color: var(--text-2); }
.ans-body { color: var(--text); font-weight: 500; }
.custom-tag, .rec-tag { margin-left: var(--s2); }
.reason { padding-left: var(--s3); font-size: var(--fs-sm); line-height: 1.55; }

@media (max-width: 760px) {
  .page-head { flex-direction: column; }
  .head-actions { justify-content: flex-start; }
  .search { width: 100%; }
}
</style>
