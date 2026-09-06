<script setup lang="ts">
// 占用防撞：当前项目内，同一 分支 / worktree / 文件域 被多个任务占用即冲突高亮。
import Icon from '@/components/Icon.vue'
import type { IconName } from '@/icons/paths'
import { computed } from 'vue'
import { useBoardStore } from '@/stores/board'
import { isGeneratedArtifact } from 'virtual:generated-artifacts'
import { humanTitle } from '@/utils/taskTitle'
import type { Task } from '@/types'

const store = useBoardStore()
const pid = computed(() => store.currentProjectId || '')
const tasks = computed<Task[]>(() => store.currentBoard?.tasks ?? [])

interface Occ { v: string; ts: { id: string; title: string; plainTitle?: string }[]; conflict: boolean; generated: boolean }
// 自动生成物（docs/INDEX-自动生成.md、lock 文件、dist/ 等）谁干活都会碰：多张卡同时挂着它是常态，
// 不是抢同一个文件，标红只会把真冲突淹掉（卡 BOARD-FILESCOPE-INDEX-POLLUTION）。判据与
// CLI / 并行清单同源（core/generatedArtifacts.cjs）。
function occ(field: 'gitBranch' | 'worktree' | 'fileScope'): Occ[] {
  const m = new Map<string, { id: string; title: string; plainTitle?: string }[]>()
  for (const t of tasks.value) {
    const arr = (t[field] as string[] | undefined) || []
    for (const v of arr) {
      if (!m.has(v)) m.set(v, [])
      m.get(v)!.push({ id: t.id, title: t.title, plainTitle: t.plainTitle })
    }
  }
  return [...m.entries()]
    .map(([v, ts]) => {
      const generated = field === 'fileScope' && isGeneratedArtifact(v)
      return { v, ts, conflict: ts.length > 1 && !generated, generated }
    })
    .sort((a, b) => Number(b.conflict) - Number(a.conflict) || a.v.localeCompare(b.v))
}
const branches = computed(() => occ('gitBranch'))
const worktrees = computed(() => occ('worktree'))
const scopes = computed(() => occ('fileScope'))
const conflictCount = computed(
  () => [...branches.value, ...worktrees.value, ...scopes.value].filter((x) => x.conflict).length,
)

// 每段配一枚功能图标：小标题只有几个字，纯文字排一列会糊成一片。
const SECTIONS = computed((): { title: string; icon: IconName; rows: ReturnType<typeof occ> }[] => [
  { title: '分支占用', icon: 'branch', rows: branches.value },
  { title: 'worktree 占用', icon: 'tree', rows: worktrees.value },
  { title: '文件域占用', icon: 'folder', rows: scopes.value },
])
function open(id: string) { store.openTask(id, pid.value) }
</script>

<template>
  <div>
    <div class="head">
      <h2><Icon name="merge" class="head-ic" :size="20" />占用防撞</h2>
      <span class="badge" :class="conflictCount ? 'bad' : 'ok'">{{ conflictCount ? conflictCount + ' 处冲突' : '无冲突' }}</span>
    </div>

    <div class="cols">
      <section v-for="s in SECTIONS" :key="s.title" class="sec card">
        <div class="sec-t"><Icon :name="s.icon" :size="14" />{{ s.title }}</div>
        <div v-if="!s.rows.length" class="muted small">无占用记录</div>
        <div v-for="r in s.rows" :key="r.v" class="orow row" :class="{ conflict: r.conflict }">
          <div class="ov mono">
            {{ r.v }}
            <span v-if="r.generated" class="badge n" title="自动生成物：谁干活都会碰，不算抢占；并行判断也会忽略它">共用生成物·不算冲突</span>
          </div>
          <div class="ots">
            <button v-for="t in r.ts" :key="t.id" class="otag badge n" type="button" @click="open(t.id)" :title="humanTitle(t)">{{ t.id }}</button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s4); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--s4); align-items: start; }
.sec-t { display: flex; align-items: center; gap: var(--s2); margin-bottom: var(--s3); font-size: var(--fs-base); font-weight: 600; }
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
