<script setup lang="ts">
// 验收矩阵：当前项目 task × 维度（状态/测试/类型检查/待拍板）红黄绿灯。点行开抽屉。
import { computed } from 'vue'
import { useBoardStore } from '@/stores/board'
import type { Task } from '@/types'

const store = useBoardStore()
const pid = computed(() => store.currentProjectId || '')
const tasks = computed(() => store.currentBoard?.tasks ?? [])

type Light = 'ok' | 'warn' | 'bad' | 'na'
const LIGHT: Record<Light, string> = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--danger)', na: 'var(--muted-2)' }

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
    <div class="head"><h2>🚦 验收矩阵</h2><span class="pill" v-if="store.currentBoard">{{ store.currentBoard.project.name }}</span></div>

    <div v-if="!tasks.length" class="empty card"><div class="big">🚦</div><div>暂无任务。</div></div>

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
            <td class="mono">{{ t.percent || 0 }}%</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.head h2 { font-size: 18px; }
.tablewrap { overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--border-soft); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; font-size: 12px; position: sticky; top: 0; background: var(--panel); }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--panel-2); }
.tcell { display: flex; gap: 8px; align-items: baseline; }
.tcell .tid { color: var(--muted); font-weight: 600; }
.tcell .tt { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; vertical-align: middle; }
</style>
