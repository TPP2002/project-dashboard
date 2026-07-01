<script setup lang="ts">
// 占用防撞：当前项目内，同一 分支 / worktree / 文件域 被多个任务占用即冲突高亮。
import { computed } from 'vue'
import { useBoardStore } from '@/stores/board'
import type { Task } from '@/types'

const store = useBoardStore()
const pid = computed(() => store.currentProjectId || '')
const tasks = computed<Task[]>(() => store.currentBoard?.tasks ?? [])

interface Occ { v: string; ts: { id: string; title: string }[]; conflict: boolean }
function occ(field: 'gitBranch' | 'worktree' | 'fileScope'): Occ[] {
  const m = new Map<string, { id: string; title: string }[]>()
  for (const t of tasks.value) {
    const arr = (t[field] as string[] | undefined) || []
    for (const v of arr) {
      if (!m.has(v)) m.set(v, [])
      m.get(v)!.push({ id: t.id, title: t.title })
    }
  }
  return [...m.entries()]
    .map(([v, ts]) => ({ v, ts, conflict: ts.length > 1 }))
    .sort((a, b) => Number(b.conflict) - Number(a.conflict) || a.v.localeCompare(b.v))
}
const branches = computed(() => occ('gitBranch'))
const worktrees = computed(() => occ('worktree'))
const scopes = computed(() => occ('fileScope'))
const conflictCount = computed(
  () => [...branches.value, ...worktrees.value, ...scopes.value].filter((x) => x.conflict).length,
)

const SECTIONS = computed(() => [
  { title: '🌿 分支占用', rows: branches.value },
  { title: '🌲 worktree 占用', rows: worktrees.value },
  { title: '📁 文件域占用', rows: scopes.value },
])
function open(id: string) { store.openTask(id, pid.value) }
</script>

<template>
  <div>
    <div class="head">
      <h2>💥 占用防撞</h2>
      <span class="pill" :class="{ bad: conflictCount }">{{ conflictCount ? conflictCount + ' 处冲突' : '无冲突' }}</span>
    </div>

    <div class="cols">
      <section v-for="s in SECTIONS" :key="s.title" class="sec card">
        <div class="sec-t">{{ s.title }}</div>
        <div v-if="!s.rows.length" class="muted small">无占用记录</div>
        <div v-for="r in s.rows" :key="r.v" class="orow" :class="{ conflict: r.conflict }">
          <div class="ov mono">{{ r.v }}</div>
          <div class="ots">
            <span v-for="t in r.ts" :key="t.id" class="otag" @click="open(t.id)" :title="t.title">{{ t.id }}</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.head h2 { font-size: 18px; }
.pill.bad { color: var(--danger); border-color: rgba(208, 99, 124, 0.5); background: rgba(208, 99, 124, 0.12); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; align-items: start; }
.sec { padding: 12px 14px; }
.sec-t { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.orow { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: var(--radius-sm); }
.orow + .orow { border-top: 1px solid var(--border-soft); }
.orow.conflict { background: rgba(208, 99, 124, 0.1); border: 1px solid rgba(208, 99, 124, 0.35); }
.ov { flex: 1; font-size: 12px; word-break: break-all; }
.ots { display: flex; gap: 5px; flex-wrap: wrap; }
.otag { background: var(--panel-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 1px 7px; font-size: 11px; font-family: var(--mono); cursor: pointer; }
.orow.conflict .otag { border-color: var(--danger); color: #f2b8c4; }
.small { font-size: 12px; }
</style>
