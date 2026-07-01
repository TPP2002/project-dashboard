<script setup lang="ts">
// 多项目总览：进度环 / 状态计数 / 最近动态 / 待拍板告警。首屏，纯 SVG 进度环、无 echarts。
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useBoardStore } from '@/stores/board'
import * as derive from '@/utils/derive'
import { statusColor, emojiFor } from '@/api/schema'
import { relTime } from '@/utils/format'
import ProgressRing from '@/components/ProgressRing.vue'
import type { Board } from '@/types'

const store = useBoardStore()
const router = useRouter()
const boards = computed(() => store.allBoards)

const totals = computed(() => {
  let total = 0
  let done = 0
  for (const b of boards.value) {
    const p = derive.progress(b)
    total += p.total
    done += p.done
  }
  return { projects: boards.value.length, total, done, pending: store.pendingCount }
})

function progressOf(b: Board) {
  return derive.progress(b)
}
function countsOf(b: Board) {
  return Object.entries(derive.statusCounts(b)).sort((a, z) => z[1] - a[1])
}
function pendingOf(b: Board) {
  return derive.collectPending([b]).length
}
function recentOf(b: Board) {
  return (b.activity ?? [])
    .slice()
    .sort((x, y) => (y.ts || '').localeCompare(x.ts || ''))
    .slice(0, 3)
}
function open(b: Board) {
  store.selectProject(b.project.id)
  router.push('/kanban')
}
</script>

<template>
  <div>
    <div class="sumbar">
      <div class="sum"><b>{{ totals.projects }}</b><span>项目</span></div>
      <div class="sum"><b>{{ totals.total }}</b><span>任务</span></div>
      <div class="sum"><b class="ok">{{ totals.done }}</b><span>已完工</span></div>
      <div class="sum" :class="{ hot: totals.pending }">
        <b>{{ totals.pending }}</b><span>待拍板</span>
      </div>
    </div>

    <div v-if="!boards.length && !store.loading" class="empty card">
      <div class="big">🗂️</div>
      <div>暂无项目。注册后（cli register）看板将自动出现。</div>
    </div>

    <div class="grid">
      <div v-for="b in boards" :key="b.project.id" class="pcard card" @click="open(b)">
        <div class="pc-top">
          <ProgressRing :percent="progressOf(b).percent" :size="86" :sub="progressOf(b).done + '/' + progressOf(b).total" />
          <div class="pc-info">
            <div class="pc-name">{{ b.project.name }}</div>
            <div class="pc-repo mono">{{ b.project.mainRepo || b.project.id }}</div>
            <div v-if="pendingOf(b)" class="pc-alert">❓ {{ pendingOf(b) }} 条待拍板</div>
          </div>
        </div>

        <div class="chips">
          <span
            v-for="[st, n] in countsOf(b)"
            :key="st"
            class="chip"
            :style="{ color: statusColor(st), borderColor: statusColor(st) + '55', background: statusColor(st) + '18' }"
          >{{ emojiFor(st) }} {{ st }} {{ n }}</span>
        </div>

        <div class="feed">
          <div v-for="(a, i) in recentOf(b)" :key="i" class="fitem">
            <span class="dot" />
            <span class="ftext">{{ a.text }}</span>
            <span class="ftime mono">{{ relTime(a.ts) }}</span>
          </div>
          <div v-if="!recentOf(b).length" class="muted small">暂无动态</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sumbar { display: flex; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
.sum {
  display: flex; flex-direction: column; align-items: center;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 10px 22px; min-width: 96px;
}
.sum b { font-size: 22px; }
.sum b.ok { color: var(--ok); }
.sum span { font-size: 12px; color: var(--muted); }
.sum.hot b { color: var(--warn); }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
.pcard { padding: 16px; cursor: pointer; transition: transform 0.1s, border-color 0.15s; display: flex; flex-direction: column; gap: 12px; }
.pcard:hover { transform: translateY(-2px); border-color: var(--accent); }
.pc-top { display: flex; gap: 14px; align-items: center; }
.pc-info { flex: 1; min-width: 0; }
.pc-name { font-size: 16px; font-weight: 600; }
.pc-repo { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-alert { margin-top: 6px; color: var(--warn); font-size: 12px; font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid; }
.feed { display: flex; flex-direction: column; gap: 5px; border-top: 1px solid var(--border-soft); padding-top: 10px; }
.fitem { display: flex; align-items: center; gap: 7px; font-size: 12px; }
.fitem .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex: none; }
.ftext { flex: 1; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ftime { color: var(--muted-2); font-size: 11px; flex: none; }
.small { font-size: 12px; }
</style>
