<script setup lang="ts">
// 验收矩阵：当前项目 task × 维度（状态/测试/类型检查/待拍板）红黄绿灯。点行开抽屉。
// 已完工默认折叠（体检 U1）：132 张完工卡淹没活跃任务，与看板/波次/甘特统一用 DoneToggle。
import { computed, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import { DONE_STATUSES } from '@/api/schema'
import DoneToggle from '@/components/DoneToggle.vue'
import type { Task } from '@/types'

const store = useBoardStore()
const pid = computed(() => store.currentProjectId || '')
const allTasks = computed(() => store.currentBoard?.tasks ?? [])
const showDone = ref(false)
const doneCount = computed(() => allTasks.value.filter((t) => DONE_STATUSES.has(t.status)).length)
const tasks = computed(() =>
  showDone.value ? allTasks.value : allTasks.value.filter((t) => !DONE_STATUSES.has(t.status)),
)

type Light = 'ok' | 'warn' | 'bad' | 'na'
const LIGHT: Record<Light, string> = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', na: 'var(--text-3)' }

function statusLight(t: Task): Light {
  if (t.status === '已完工') return 'ok'
  if (['收官', '施工中', '可复工', '已拍板'].includes(t.status)) return 'warn'
  if (t.status === '暂缓') return 'bad'
  return 'na'
}
function testLight(t: Task): [Light, string] {
  if (!t.tests || !t.tests.total) return ['na', '—']
  const { total, passing = 0 } = t.tests
  const txt = `${passing}/${total}`
  return [passing >= total ? 'ok' : passing > 0 ? 'warn' : 'bad', txt]
}
function typeLight(t: Task): [Light, string] {
  if (t.typecheck === undefined) return ['na', '—']
  return [t.typecheck ? 'ok' : 'bad', t.typecheck ? '通过' : '失败']
}
function pendLight(t: Task): [Light, string] {
  const n = (t.decisions ?? []).filter((d) => d.answer == null).length
  return [n ? 'warn' : 'ok', n ? String(n) : '清']
}
</script>

<template>
  <div>
    <div class="head">
      <h2>🚦 验收矩阵</h2>
      <span class="pill" v-if="store.currentBoard">{{ store.currentBoard.project.name }}</span>
      <span class="pill">{{ tasks.length }} 行</span>
      <DoneToggle v-if="doneCount" v-model="showDone" :count="doneCount" />
    </div>

    <div v-if="!tasks.length" class="empty card">
      <div class="big">🚦</div>
      <div>{{ allTasks.length ? '活跃任务全部清零——已完工的已折叠，点上方开关查看' : '暂无任务。' }}</div>
    </div>

    <div v-else class="tablewrap card">
      <table>
        <thead>
          <tr><th>任务</th><th>状态</th><th>测试</th><th>类型检查</th><th>待拍板</th><th>进度</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in tasks" :key="t.id" @click="store.openTask(t.id, pid)">
            <td class="tcell"><span class="tid mono">{{ t.id }}</span><span class="tt">{{ t.title }}</span></td>
            <td><span class="dot" :style="{ background: LIGHT[statusLight(t)] }" />{{ t.status }}</td>
            <td><span class="dot" :style="{ background: LIGHT[testLight(t)[0]] }" />{{ testLight(t)[1] }}</td>
            <td><span class="dot" :style="{ background: LIGHT[typeLight(t)[0]] }" />{{ typeLight(t)[1] }}</td>
            <td><span class="dot" :style="{ background: LIGHT[pendLight(t)[0]] }" />{{ pendLight(t)[1] }}</td>
            <td class="mono num">{{ t.percent || 0 }}%</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s4); flex-wrap: wrap; }
.tablewrap { overflow: auto; }
th, td { white-space: nowrap; }
th { position: sticky; top: 0; z-index: 1; background: var(--surface-2); }
tbody tr { cursor: pointer; }
.tcell { display: flex; gap: var(--s2); align-items: baseline; }
.tcell .tid { color: var(--text-2); font-weight: 600; }
.tcell .tt { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.dot { display: inline-block; width: var(--s2); height: var(--s2); margin-right: var(--s2); border-radius: 50%; vertical-align: middle; }
</style>
