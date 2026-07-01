<script setup lang="ts">
// 拍板历史：所有 answer !== null 的 decision，按 decidedAt 倒序。
// 治的病:"我拍了没?拍了啥?什么时候拍的?"——之前完全没记录。
import { computed, ref } from 'vue'
import { useBoardStore } from '@/stores/board'

const store = useBoardStore()
const search = ref('')
const showLanded = ref(true)  // 已落地也显示（默认全显示）

const items = computed(() => {
  let arr = store.decidedHistory
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
  const all = store.decidedHistory
  const landed = all.filter((it) => (it.decision as any).landed).length
  return { total: all.length, landed, unlanded: all.length - landed }
})
</script>

<template>
  <div class="wrap">
    <div class="head">
      <h2>📜 拍板历史</h2>
      <span class="pill">{{ stats.total }} 条 · 待落地 {{ stats.unlanded }} · 已落地 {{ stats.landed }}</span>
      <span class="spacer" />
      <label class="toggle">
        <input type="checkbox" v-model="showLanded" />
        <span>显示已落地</span>
      </label>
      <input v-model="search" class="search" placeholder="搜任务 / 问题 / 答案…" />
    </div>

    <div v-if="!items.length" class="empty card">
      <div class="big">🎯</div>
      <div>{{ store.decidedHistory.length ? '没匹配的记录' : '还没拍过板' }}</div>
    </div>

    <div class="list">
      <div v-for="it in items" :key="`${it.projectId}:${it.task.id}:${it.decision.id}`" class="row card">
        <div class="top">
          <span class="proj pill">{{ it.projectName }}</span>
          <span class="tid mono">{{ it.task.id }}</span>
          <span class="ttitle">{{ it.task.title }}</span>
          <span class="did mono">#{{ it.decision.id }}</span>
          <span class="date">{{ it.decision.decidedAt || '—' }}</span>
          <span class="badge" :class="(it.decision as any).landed ? 'landed' : 'unlanded'">
            {{ (it.decision as any).landed ? '✓ 已落地' : '⏳ 待落地' }}
          </span>
        </div>
        <div class="q">{{ it.decision.question }}</div>
        <div class="ans">
          <span class="ans-label">你的答案：</span>
          <span class="ans-body">{{ it.decision.answer }}</span>
          <span v-if="it.decision.answer !== it.decision.recommended" class="custom-tag">✍️ 自定义/非推荐</span>
          <span v-else class="rec-tag">= 推荐</span>
        </div>
        <div v-if="(it.decision as any).recommendReason" class="reason muted">
          <b>当时的推荐理由:</b> {{ (it.decision as any).recommendReason }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap { display: flex; flex-direction: column; height: 100%; }
.head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.head h2 { font-size: 18px; }
.spacer { flex: 1; }
.toggle { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 5px; cursor: pointer; }
.search { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); border-radius: var(--radius-sm); padding: 5px 10px; width: 200px; font-size: 12px; }
.list { display: flex; flex-direction: column; gap: 10px; max-width: 900px; }
.row { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.top { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.tid { color: var(--muted); font-weight: 600; }
.ttitle { font-weight: 600; }
.did { color: var(--muted-2); font-size: 12px; }
.date { color: var(--muted); font-size: 12px; margin-left: auto; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; }
.badge.landed { background: rgba(90, 200, 120, 0.15); color: #5ac878; border: 1px solid rgba(90, 200, 120, 0.4); }
.badge.unlanded { background: rgba(240, 180, 90, 0.15); color: #f0b45a; border: 1px solid rgba(240, 180, 90, 0.4); }
.q { font-size: 13px; line-height: 1.5; color: var(--muted); }
.ans { padding: 8px 12px; background: var(--panel-2); border-left: 3px solid var(--accent); border-radius: var(--radius-sm); font-size: 13px; }
.ans-label { color: var(--muted); }
.ans-body { color: var(--text); font-weight: 500; }
.custom-tag { margin-left: 8px; font-size: 11px; color: #f0b45a; padding: 1px 6px; border: 1px solid rgba(240, 180, 90, 0.4); border-radius: 999px; }
.rec-tag { margin-left: 8px; font-size: 11px; color: var(--muted-2); }
.reason { font-size: 12px; line-height: 1.55; padding-left: 12px; }
.empty { padding: 40px; text-align: center; }
.empty .big { font-size: 48px; margin-bottom: 8px; }
</style>
