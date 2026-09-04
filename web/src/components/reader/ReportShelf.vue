<script setup lang="ts">
// 报告架:按回运批次分组列报告;状态徽章 + 批注数;点选打开。
import { computed } from 'vue'
import type { ReaderManifest } from '@/api/reader'

const props = defineProps<{
  manifest: ReaderManifest | null
  annoCounts: Record<string, number>
  currentKey: string | null
  showPendingIntake: boolean
}>()
const emit = defineEmits<{ (e: 'select', key: string): void }>()

const statusClass = (s?: string) => (s === '待审阅' ? 'warn' : s === '文档内已填答' ? 'ok' : s === '已批' ? 'ok' : 'n')
const pendingIntake = computed(() => props.manifest?.pendingIntake?.items ?? [])
const fileName = (p: string) => p.split('/').pop()?.replace(/\.(md|html)$/i, '') ?? p
</script>

<template>
  <aside class="shelf">
    <template v-if="manifest">
      <section v-for="batch in manifest.batches" :key="batch.id" class="group">
        <header class="group-head">
          <span>{{ batch.name }}</span><span class="mono">{{ batch.reports.length }}</span>
        </header>
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
            <span v-if="rep.docAnswers && Object.keys(rep.docAnswers).length" class="badge ok">文档已填 {{ Object.keys(rep.docAnswers).length }}</span>
          </div>
          <div v-if="rep.why" class="why">{{ rep.why }}</div>
        </button>
      </section>
      <section v-if="showPendingIntake && pendingIntake.length" class="group dim">
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
.group-head { display: flex; justify-content: space-between; padding: var(--s3) var(--s2) var(--s1); font-size: var(--fs-xs); color: var(--text-3); letter-spacing: .04em; }
.rep { display: block; width: 100%; text-align: left; padding: var(--s2); border: 1px solid transparent; border-radius: var(--r); background: transparent; color: var(--text); font: inherit; cursor: pointer; }
.rep:hover { background: var(--surface-2); }
.rep.on { background: var(--surface-3); border-color: var(--line); }
.rep.static { cursor: default; }
.rep .t { font-size: var(--fs-base); font-weight: 600; line-height: 1.35; }
.rep .meta { display: flex; flex-wrap: wrap; gap: var(--s1); margin-top: var(--s1); }
.rep .why { margin-top: 2px; color: var(--text-3); font-size: var(--fs-xs); line-height: 1.4; }
.group.dim { opacity: .62; }
.empty { padding: var(--s4); color: var(--text-3); font-size: var(--fs-sm); }
</style>
