<script setup lang="ts">
// 拍板历史：所有 answer !== null 的 decision，按 decidedAt 倒序。
// 治的病:"我拍了没?拍了啥?什么时候拍的?"——之前完全没记录。
import { computed, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import ScopeToggle from '@/components/ScopeToggle.vue'

const store = useBoardStore()
const search = ref('')
const showLanded = ref(true)  // 已落地也显示（默认全显示）

// 默认只看当前项目（跟随顶栏项目切换）；「全部项目」开关可跨项目聚合。
const base = computed(() =>
  store.decidedHistory.filter((it) => store.centerScopeAll || it.projectId === store.currentProjectId),
)

const items = computed(() => {
  let arr = base.value
  if (!showLanded.value) arr = arr.filter((it) => !(it.decision as any).landed)
  const s = search.value.trim().toLowerCase()
  if (s) arr = arr.filter((it) =>
    it.task.id.toLowerCase().includes(s) ||
    it.task.title.toLowerCase().includes(s) ||
    it.decision.question.toLowerCase().includes(s) ||
    (it.decision.answer || '').toLowerCase().includes(s)
  )
  return arr
})
const stats = computed(() => {
  const all = base.value
  const landed = all.filter((it) => (it.decision as any).landed).length
  return { total: all.length, landed, unlanded: all.length - landed }
})
</script>

<template>
  <div class="history-page">
    <div class="head">
      <h2>📜 拍板历史</h2>
      <span class="pill">{{ stats.total }} 条 · 待落地 {{ stats.unlanded }} · 已落地 {{ stats.landed }}</span>
      <ScopeToggle />
      <span class="spacer" />
      <label class="toggle">
        <input type="checkbox" v-model="showLanded" />
        <span>显示已落地</span>
      </label>
      <input v-model="search" class="field search" placeholder="搜任务 / 问题 / 答案…" />
    </div>

    <div v-if="!items.length" class="empty card">
      <div class="big">🎯</div>
      <div>{{ base.length ? '没匹配的记录，换个关键词或重新显示已落地' : '还没拍过板，完成一次拍板后会在这里留档' }}</div>
    </div>

    <div class="list">
      <div v-for="it in items" :key="`${it.projectId}:${it.task.id}:${it.decision.id}`" class="row decision-row">
        <div class="top">
          <span class="proj pill">{{ it.projectName }}</span>
          <span class="tid mono">{{ it.task.id }}</span>
          <span class="ttitle">{{ it.task.title }}</span>
          <span class="did mono">#{{ it.decision.id }}</span>
          <span class="date">{{ it.decision.decidedAt || '—' }}</span>
          <span class="badge" :class="(it.decision as any).landed ? 'ok' : 'warn'">
            {{ (it.decision as any).landed ? '✓ 已落地' : '⏳ 待落地' }}
          </span>
        </div>
        <div class="q">{{ it.decision.question }}</div>
        <div class="ans">
          <span class="ans-label">你的答案：</span>
          <span class="ans-body">{{ it.decision.answer }}</span>
          <span v-if="it.decision.answer !== it.decision.recommended" class="badge warn compact custom-tag">✍️ 自定义/非推荐</span>
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
.history-page { display: flex; flex-direction: column; min-width: 0; }
.head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s4); flex-wrap: wrap; }
.toggle { display: flex; align-items: center; gap: var(--s1); color: var(--text-2); cursor: pointer; font-size: var(--fs-sm); }
.search { width: 200px; }
.list { display: flex; flex-direction: column; gap: var(--s2); max-width: 900px; }
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
</style>
