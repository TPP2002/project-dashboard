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
      <span class="badge" :class="conflictCount ? 'bad' : 'ok'">{{ conflictCount ? conflictCount + ' 处冲突' : '无冲突' }}</span>
    </div>

    <div class="cols">
      <section v-for="s in SECTIONS" :key="s.title" class="sec card">
        <div class="sec-t">{{ s.title }}</div>
        <div v-if="!s.rows.length" class="muted small">无占用记录</div>
        <div v-for="r in s.rows" :key="r.v" class="orow row" :class="{ conflict: r.conflict }">
          <div class="ov mono">{{ r.v }}</div>
          <div class="ots">
            <button v-for="t in r.ts" :key="t.id" class="otag badge n" type="button" @click="open(t.id)" :title="t.title">{{ t.id }}</button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s4); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--s4); align-items: start; }
.sec-t { margin-bottom: var(--s3); font-size: var(--fs-base); font-weight: 600; }
.orow {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--s2);
  align-items: start;
}
.orow + .orow { margin-top: var(--s2); }
.orow.conflict { border-color: var(--bad); background: var(--bad-bg); }
.ov { min-width: 0; font-size: var(--fs-sm); overflow-wrap: anywhere; }
.ots { display: flex; gap: var(--s1); flex-wrap: wrap; }
.otag { cursor: pointer; }
.orow.conflict .otag { border-color: var(--bad); color: var(--bad); }
.small { font-size: var(--fs-sm); }
</style>
