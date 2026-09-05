<script setup lang="ts">
// 报告架:先按「待审阅 / 已审阅」分两段(负责人 0905 要求两者别混在一张单子里),
// 段内再按回运批次分组;状态徽章 + 批注/荧光笔数;点选打开。
import { computed } from 'vue'
import type { ReaderManifest, ReaderReportMeta, ReaderReview } from '@/api/reader'

const props = defineProps<{
  manifest: ReaderManifest | null
  annoCounts: Record<string, number>
  markCounts: Record<string, number>
  reviews: Record<string, ReaderReview>
  currentKey: string | null
  showPendingIntake: boolean
  showReviewed: boolean
}>()
const emit = defineEmits<{ (e: 'select', key: string): void; (e: 'toggle-reviewed'): void }>()

const statusClass = (s?: string) => (s === '待审阅' ? 'warn' : s === '文档内已填答' ? 'ok' : s === '已批' ? 'ok' : 'n')
const pendingIntake = computed(() => props.manifest?.pendingIntake?.items ?? [])
const fileName = (p: string) => p.split('/').pop()?.replace(/\.(md|html)$/i, '') ?? p

/** 与 store 的 isReviewed 同口径:本机标记优先,其次认清单里写死的「已批」 */
const reviewed = (r: ReaderReportMeta) => Boolean(props.reviews[r.key]) || r.status === '已批'

type Group = { id: string; name: string; reports: ReaderReportMeta[] }
function groupsOf(want: boolean): Group[] {
  const out: Group[] = []
  for (const b of props.manifest?.batches ?? []) {
    const reports = (b.reports ?? []).filter((r) => reviewed(r) === want)
    if (reports.length) out.push({ id: b.id, name: b.name, reports })
  }
  return out
}
const pendingGroups = computed(() => groupsOf(false))
const doneGroups = computed(() => groupsOf(true))
const pendingCount = computed(() => pendingGroups.value.reduce((n, g) => n + g.reports.length, 0))
const doneCount = computed(() => doneGroups.value.reduce((n, g) => n + g.reports.length, 0))
const fmtDay = (iso?: string) => (iso ? iso.slice(5, 10).replace('-', '-') : '')
</script>

<template>
  <aside class="shelf">
    <template v-if="manifest">
      <section class="section">
        <header class="sec-head"><span>待审阅</span><span class="mono">{{ pendingCount }}</span></header>
        <p v-if="!pendingCount" class="none">都读完了。</p>
        <template v-for="batch in pendingGroups" :key="batch.id">
          <header class="group-head"><span>{{ batch.name }}</span><span class="mono">{{ batch.reports.length }}</span></header>
          <button
            v-for="rep in batch.reports"
            :key="rep.key"
            type="button"
            class="rep"
            :class="{ on: rep.key === currentKey }"
            @click="emit('select', rep.key)"
          >
            <div class="t">{{ rep.title }}</div>
            <div class="meta">
              <span class="badge" :class="statusClass(rep.status)">{{ rep.status || '待审阅' }}</span>
              <span v-if="rep.version" class="badge n">{{ rep.version }}</span>
              <span v-if="rep.prevMd" class="badge info">有上一版</span>
              <span v-if="annoCounts[rep.key]" class="badge info">批注 {{ annoCounts[rep.key] }}</span>
              <span v-if="markCounts[rep.key]" class="badge n">标记 {{ markCounts[rep.key] }}</span>
              <span v-if="rep.docAnswers && Object.keys(rep.docAnswers).length" class="badge ok">文档已填 {{ Object.keys(rep.docAnswers).length }}</span>
            </div>
            <div v-if="rep.why" class="why">{{ rep.why }}</div>
          </button>
        </template>
      </section>

      <section class="section">
        <header class="sec-head clickable" role="button" tabindex="0" :aria-expanded="showReviewed" @click="emit('toggle-reviewed')" @keydown.enter.space.prevent="emit('toggle-reviewed')">
          <span>{{ showReviewed ? '▾' : '▸' }} 已审阅</span><span class="mono">{{ doneCount }}</span>
        </header>
        <template v-if="showReviewed">
          <p v-if="!doneCount" class="none">还没有标记过已审阅的报告。读完一份,在页头点「标记已审阅」。</p>
          <template v-for="batch in doneGroups" :key="batch.id">
            <header class="group-head"><span>{{ batch.name }}</span><span class="mono">{{ batch.reports.length }}</span></header>
            <button
              v-for="rep in batch.reports"
              :key="rep.key"
              type="button"
              class="rep done"
              :class="{ on: rep.key === currentKey }"
              @click="emit('select', rep.key)"
            >
              <div class="t">{{ rep.title }}</div>
              <div class="meta">
                <span class="badge ok">✓ 已审阅<template v-if="reviews[rep.key]"> {{ fmtDay(reviews[rep.key].at) }}</template></span>
                <span v-if="annoCounts[rep.key]" class="badge info">批注 {{ annoCounts[rep.key] }}</span>
                <span v-if="markCounts[rep.key]" class="badge n">标记 {{ markCounts[rep.key] }}</span>
              </div>
            </button>
          </template>
        </template>
      </section>

      <section v-if="showPendingIntake && pendingIntake.length" class="section dim">
        <header class="group-head"><span>仓库里其它审计报告 · 待接入</span><span class="mono">{{ pendingIntake.length }}</span></header>
        <div v-for="p in pendingIntake" :key="p" class="rep static" :title="p">
          <div class="t">{{ fileName(p) }}</div>
          <div class="meta"><span class="badge n">待接入清单</span></div>
        </div>
      </section>
    </template>
    <div v-else class="empty">这个项目还没有报告清单。</div>
  </aside>
</template>

<style scoped>
.shelf { overflow: auto; padding: var(--s2); border-right: 1px solid var(--line); background: var(--surface); min-height: 0; }
.section + .section { margin-top: var(--s3); padding-top: var(--s2); border-top: 1px solid var(--line); }
.sec-head { display: flex; justify-content: space-between; align-items: center; padding: var(--s2); font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.sec-head.clickable { cursor: pointer; border-radius: var(--r); user-select: none; }
.sec-head.clickable:hover { background: var(--surface-2); }
.group-head { display: flex; justify-content: space-between; padding: var(--s3) var(--s2) var(--s1); font-size: var(--fs-xs); color: var(--text-3); letter-spacing: .04em; }
.rep { display: block; width: 100%; text-align: left; padding: var(--s2); border: 1px solid transparent; border-radius: var(--r); background: transparent; color: var(--text); font: inherit; cursor: pointer; }
.rep:hover { background: var(--surface-2); }
.rep.on { background: var(--surface-3); border-color: var(--line); }
.rep.done .t { color: var(--text-2); font-weight: 500; }
.rep.static { cursor: default; }
.rep .t { font-size: var(--fs-base); font-weight: 600; line-height: 1.35; }
.rep .meta { display: flex; flex-wrap: wrap; gap: var(--s1); margin-top: var(--s1); }
.rep .why { margin-top: 2px; color: var(--text-3); font-size: var(--fs-xs); line-height: 1.4; }
.none { margin: 0; padding: 0 var(--s2) var(--s2); color: var(--text-3); font-size: var(--fs-xs); line-height: 1.5; }
.section.dim { opacity: .62; }
.empty { padding: var(--s4); color: var(--text-3); font-size: var(--fs-sm); }
</style>
