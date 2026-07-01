<script setup lang="ts">
// 待落地队列（任务级派单）。
// 治的病:决策从属于任务——P10 的 d1/d2/d3 是同一任务的三个问题,
// 不该一个决策一个对话(会开三个对话各自 claim 同一 P10 打架)。
// 正确粒度:一个任务 = 一份启动指令,含该任务所有已拍板决策,一个对话接手。
import { computed, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import type { UnlandedTask } from '@/utils/derive'

const store = useBoardStore()
const tasks = computed(() => store.unlandedByTask)
// 按项目再分组:{ pid: {name, tasks: [...] } }
const grouped = computed(() => {
  const g: Record<string, { name: string; tasks: UnlandedTask[] }> = {}
  for (const t of tasks.value) {
    if (!g[t.projectId]) g[t.projectId] = { name: t.projectName, tasks: [] }
    g[t.projectId].tasks.push(t)
  }
  return g
})
const totalDecisions = computed(() => tasks.value.reduce((s, t) => s + t.decisions.length, 0))
const decCountOf = (list: UnlandedTask[]) => list.reduce((s, t) => s + t.decisions.length, 0)

const taskKey = (t: UnlandedTask) => `${t.projectId}:${t.task.id}`
const dispatching = ref<Record<string, boolean>>({})
const dispatched = ref<Record<string, string>>({})
const projDispatching = ref<Record<string, boolean>>({})
const projDispatched = ref<Record<string, string>>({})
const marking = ref<Record<string, boolean>>({})

const nowHM = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

// 任务级派单:一个任务一个对话,含该任务所有已拍板决策
async function dispatchTask(t: UnlandedTask) {
  const k = taskKey(t)
  if (!confirm(`确认开新 Claude Code 对话落地【${t.task.id} ${t.task.title}】?\n\n该任务有 ${t.decisions.length} 条已拍板决策,会一起交给这一个对话。`)) return
  dispatching.value[k] = true
  try {
    const res = await fetch('/api/dispatch-task', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: t.projectId, tid: t.task.id }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '派单失败')
    dispatched.value[k] = nowHM()
  } catch (e) {
    alert('派单失败:' + (e instanceof Error ? e.message : String(e)))
  } finally {
    dispatching.value[k] = false
  }
}

// 项目级派单:整个项目所有任务打包给一个对话(适合"一次全清")
async function dispatchProject(pid: string, name: string, taskCount: number, decCount: number) {
  if (!confirm(`确认打包派单【${name}】全部 ${taskCount} 个任务 / ${decCount} 条决策给一个对话?\n\n若想分任务各交一个对话,请用每个任务卡片上的"派单本任务"。`)) return
  projDispatching.value[pid] = true
  try {
    const res = await fetch('/api/dispatch-project', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '派单失败')
    projDispatched.value[pid] = nowHM()
  } catch (e) {
    alert('派单失败:' + (e instanceof Error ? e.message : String(e)))
  } finally {
    projDispatching.value[pid] = false
  }
}

// 标记整个任务的所有决策已落地
async function markTaskLanded(t: UnlandedTask) {
  const k = taskKey(t)
  if (!confirm(`确认【${t.task.id}】的 ${t.decisions.length} 条决策都已代码落地?`)) return
  marking.value[k] = true
  try {
    for (const d of t.decisions) {
      const res = await fetch(`/api/mark-landed/${t.projectId}/${t.task.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ did: d.id, author: '看板' }),
      })
      if (!res.ok) throw new Error(await res.text())
    }
    await store.refresh()
  } catch (e) {
    alert('标记失败:' + (e instanceof Error ? e.message : String(e)))
  } finally {
    marking.value[k] = false
  }
}
</script>

<template>
  <div class="wrap">
    <div class="head">
      <h2>🚀 待落地队列</h2>
      <span class="pill">{{ tasks.length }} 个任务 · {{ totalDecisions }} 条决策</span>
      <span class="hint muted">已拍板但还没落地——按任务派单,一个任务交给一个新对话</span>
    </div>

    <div v-if="!tasks.length" class="empty card">
      <div class="big">✨</div>
      <div>所有拍板都已落地——干净</div>
    </div>

    <div v-for="(g, pid) in grouped" :key="pid" class="project-group">
      <div class="proj-head card">
        <div class="proj-info">
          <span class="proj-name">📦 {{ g.name }}</span>
          <span class="proj-count muted">{{ g.tasks.length }} 个任务 · {{ decCountOf(g.tasks) }} 条决策</span>
        </div>
        <button class="btn btn-project-dispatch" :disabled="projDispatching[pid]"
          @click="dispatchProject(pid, g.name, g.tasks.length, decCountOf(g.tasks))">
          {{ projDispatching[pid] ? '开对话中…' : `📦 整项目打包给一个对话（${g.tasks.length} 任务）` }}
        </button>
        <div v-if="projDispatched[pid]" class="proj-note">✓ 已整项目打包派单于 {{ projDispatched[pid] }}</div>
      </div>

      <div class="task-list">
        <div v-for="t in g.tasks" :key="taskKey(t)" class="task-card card">
          <div class="task-top">
            <span class="tid mono">{{ t.task.id }}</span>
            <span class="ttitle">{{ t.task.title }}</span>
            <span class="dcount">{{ t.decisions.length }} 条已拍板决策</span>
          </div>

          <ul class="dec-list">
            <li v-for="d in t.decisions" :key="d.id" class="dec">
              <div class="dec-q"><span class="did mono">#{{ d.id }}</span> {{ d.question }}</div>
              <div class="dec-a"><span class="a-arrow">└→</span> {{ d.answer }}</div>
            </li>
          </ul>

          <div v-if="dispatched[taskKey(t)]" class="dispatched-note">
            ✓ 已开新对话落地本任务于 {{ dispatched[taskKey(t)] }}——新窗口应已启动
          </div>

          <div class="actions">
            <button class="btn btn-primary-strong" :disabled="dispatching[taskKey(t)]" @click="dispatchTask(t)">
              {{ dispatching[taskKey(t)] ? '开对话中…' : '🚀 派单本任务给一个对话' }}
            </button>
            <button class="btn btn-outline" :disabled="marking[taskKey(t)]" @click="markTaskLanded(t)">
              {{ marking[taskKey(t)] ? '标记中…' : '✓ 本任务已落地' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap { display: flex; flex-direction: column; height: 100%; }
.head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.head h2 { font-size: 18px; }
.hint { font-size: 12px; }
.empty { padding: 40px; text-align: center; }
.empty .big { font-size: 48px; margin-bottom: 8px; }

.project-group { margin-bottom: 26px; max-width: 920px; }
.proj-head { padding: 14px 16px; margin-bottom: 12px; background: linear-gradient(135deg, rgba(76,140,224,0.08), rgba(108,156,232,0.04)); border-left: 4px solid #4c8ce0; display: flex; flex-direction: column; gap: 10px; }
.proj-info { display: flex; align-items: baseline; gap: 12px; }
.proj-name { font-size: 15px; font-weight: 500; }
.proj-count { font-size: 12px; }
.btn-project-dispatch { padding: 8px 14px; background: transparent; color: #4c8ce0; border: 1px dashed rgba(76,140,224,0.6); border-radius: var(--radius-sm); font-size: 12px; cursor: pointer; }
.btn-project-dispatch:hover { background: rgba(76,140,224,0.1); }
.btn-project-dispatch:disabled { opacity: 0.5; cursor: not-allowed; }
.proj-note { padding: 6px 10px; background: rgba(76,140,224,0.15); border-radius: var(--radius-sm); color: #4c8ce0; font-size: 12px; }

.task-list { display: flex; flex-direction: column; gap: 12px; padding-left: 8px; }
.task-card { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.task-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tid { color: var(--muted); font-weight: 600; font-size: 14px; }
.ttitle { font-weight: 600; font-size: 14px; }
.dcount { margin-left: auto; font-size: 11px; color: #f0b45a; padding: 2px 8px; border: 1px solid rgba(240,180,90,0.4); border-radius: 999px; }

.dec-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dec { padding: 8px 12px; background: var(--panel-2); border-radius: var(--radius-sm); border-left: 3px solid var(--accent); }
.dec-q { font-size: 12.5px; line-height: 1.5; }
.did { color: var(--muted-2); font-size: 11px; margin-right: 4px; }
.dec-a { font-size: 12.5px; color: #5ac878; margin-top: 3px; line-height: 1.45; }
.a-arrow { color: var(--muted-2); margin-right: 4px; }

.dispatched-note { padding: 8px 12px; background: rgba(76,140,224,0.15); border-left: 3px solid #4c8ce0; border-radius: var(--radius-sm); color: #4c8ce0; font-size: 13px; }
.actions { display: flex; gap: 8px; }
.btn { padding: 8px 14px; border-radius: var(--radius-sm); font-size: 13px; cursor: pointer; border: none; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary-strong { flex: 1; background: linear-gradient(90deg, #4c8ce0, #6c9ce8); color: white; font-weight: 500; }
.btn-primary-strong:hover { opacity: 0.92; }
.btn-outline { background: transparent; color: var(--text); border: 1px solid var(--border); }
.btn-outline:hover { background: var(--panel-2); }
</style>
