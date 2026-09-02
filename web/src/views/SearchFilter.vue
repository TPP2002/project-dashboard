<script setup lang="ts">
// 全局搜索筛选 + 导出快照：跨项目搜 id/title/描述/分支/文件域；导出当前项目 board JSON（git 外快照）。
import { ref, computed } from 'vue'
import { useBoardStore } from '@/stores/board'
import { STATUS } from '@/api/schema'
import StatusBadge from '@/components/StatusBadge.vue'
import type { Task } from '@/types'

const store = useBoardStore()
const q = ref('')
const fProj = ref('')
const fStatus = ref('')

interface Hit { pid: string; pname: string; task: Task }
const results = computed<Hit[]>(() => {
  const out: Hit[] = []
  const kw = q.value.trim().toLowerCase()
  for (const b of store.allBoards) {
    if (fProj.value && b.project.id !== fProj.value) continue
    for (const t of b.tasks) {
      if (fStatus.value && t.status !== fStatus.value) continue
      if (kw) {
        const hay = [
          t.id, t.title, t.description || '',
          (t.gitBranch || []).join(' '), (t.fileScope || []).join(' '), (t.worktree || []).join(' '),
        ].join(' ').toLowerCase()
        if (!hay.includes(kw)) continue
      }
      out.push({ pid: b.project.id, pname: b.project.name, task: t })
    }
  }
  return out
})

function exportSnapshot() {
  const b = store.currentBoard
  if (!b) return
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${b.project.id}-board-snapshot.json`
  a.click()
  URL.revokeObjectURL(a.href)
}
</script>

<template>
  <div>
    <div class="head">
      <h2>🔍 搜索 / 筛选</h2>
      <span class="spacer" />
      <button class="btn btn-sm" :disabled="!store.currentBoard" @click="exportSnapshot" title="导出当前项目 board 快照 JSON">⬇ 导出快照</button>
    </div>

    <div class="filters card">
      <input v-model="q" class="field q" placeholder="搜索 任务号 / 标题 / 描述 / 分支 / 文件域…" />
      <select v-model="fProj" class="field sel">
        <option value="">全部项目</option>
        <option v-for="p in store.projectList" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <select v-model="fStatus" class="field sel">
        <option value="">全部状态</option>
        <option v-for="s in STATUS" :key="s" :value="s">{{ s }}</option>
      </select>
      <span class="cnt pill">{{ results.length }} 条</span>
    </div>

    <div v-if="!results.length" class="empty card"><div class="big">🔍</div><div>无匹配结果，清空关键词或筛选条件后可查看全部任务。</div></div>

    <div v-else class="list">
      <div v-for="h in results" :key="h.pid + h.task.id" class="hit row" @click="store.openTask(h.task.id, h.pid)">
        <StatusBadge :status="h.task.status" small />
        <span class="tid mono">{{ h.task.id }}</span>
        <span class="tt g">{{ h.task.title }}</span>
        <span class="spacer" />
        <span class="proj pill">{{ h.pname }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s4); }
.filters { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; margin-bottom: var(--s3); }
.q { flex: 1; min-width: 220px; }
.sel { width: auto; }
.list { display: flex; flex-direction: column; gap: var(--s2); }
.hit { cursor: pointer; }
.hit .tid { color: var(--text-2); font-weight: 600; font-size: var(--fs-sm); }
.hit .tt { font-size: var(--fs-base); }
</style>
