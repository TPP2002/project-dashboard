<script setup lang="ts">
// 待落地队列（任务级派单）。
// 治的病:决策从属于任务——P10 的 d1/d2/d3 是同一任务的三个问题,
// 不该一个决策一个对话(会开三个对话各自 claim 同一 P10 打架)。
// 正确粒度:一个任务 = 一份启动指令,含该任务所有已拍板决策,一个对话接手。
import { computed, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import ScopeToggle from '@/components/ScopeToggle.vue'
import type { UnlandedTask } from '@/utils/derive'

const store = useBoardStore()
// 默认只看当前项目（跟随顶栏项目切换）；「全部项目」开关可跨项目聚合。
const tasks = computed(() =>
  store.unlandedByTask.filter((t) => store.centerScopeAll || t.projectId === store.currentProjectId),
)
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
const copiedTrigger = ref<Record<string, boolean>>({})

// 短触发指令:新对话粘贴这一句,自己去读看板拿完整任务书(避开命令行长度/转义,可靠)
function triggerText(t: UnlandedTask): string {
  return [
    `你被【项目管理看板】指派接手任务 ${t.task.id}(项目 ${t.projectId})。`,
    `请立刻运行下面命令拿到完整任务书,然后严格按它执行(先 cli claim 再动代码):`,
    '',
    `node ~/.claude/dashboard/cli/index.cjs inbox --project ${t.projectId} --tid ${t.task.id}`,
  ].join('\n')
}

// 【主路·可靠】复制接单指令 → 用户在桌面 App 新开对话粘贴 → 那对话读看板开干
async function copyTrigger(t: UnlandedTask) {
  const k = taskKey(t)
  const text = triggerText(t)
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text; document.body.appendChild(ta); ta.select()
    document.execCommand('copy'); document.body.removeChild(ta)
  }
  copiedTrigger.value[k] = true
  setTimeout(() => { copiedTrigger.value[k] = false }, 4000)
}

// 【次要·实验】试试自动开终端(开的是终端里的 claude,不是桌面 App;可能因环境失败)
async function dispatchTask(t: UnlandedTask) {
  const k = taskKey(t)
  if (!confirm(`试试自动开【终端】跑 Claude Code 落地 ${t.task.id}?\n\n注意:开的是"终端里的 Claude Code",不是你常用的桌面 App——你要在弹出的终端窗口里看它。\n若没反应,请改用上面的"复制接单指令"在桌面 App 新开对话粘贴。`)) return
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
    alert('自动开终端失败:' + (e instanceof Error ? e.message : String(e)) + '\n请改用"复制接单指令"。')
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
      <span class="spacer" />
      <ScopeToggle />
    </div>
    <div class="hint muted subhint">已拍板但还没落地——按任务派单,一个任务交给一个新对话</div>

    <div v-if="tasks.length" class="howto card">
      <b>怎么派单(可靠做法):</b> 点任务卡上的 <span class="kbd">📋 复制接单指令</span> → 在 Claude Code
      <b>新开一个对话</b> → 粘贴(Ctrl+V)发送。那对话会自己 <code>读看板</code> 拿到完整任务书、认领、开工。
      <span class="muted">("自动开终端"是实验功能,开的是终端里的 Claude Code、不是你常用的桌面 App,可能因环境打不开——打不开就用复制。)</span>
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

          <div v-if="copiedTrigger[taskKey(t)]" class="copied-note">
            ✓ 接单指令已复制！在 Claude Code <b>新开一个对话</b>,粘贴(Ctrl+V)发送即可——那对话会自己读看板拿到完整任务开干。
          </div>
          <div v-else-if="dispatched[taskKey(t)]" class="dispatched-note">
            ✓ 已尝试开终端于 {{ dispatched[taskKey(t)] }}——看弹出的<b>终端窗口</b>(不是桌面 App)。没弹出就用"复制接单指令"。
          </div>

          <div class="actions">
            <button class="btn btn-primary-strong" @click="copyTrigger(t)">
              {{ copiedTrigger[taskKey(t)] ? '✓ 已复制,去新对话粘贴' : '📋 复制接单指令(新对话粘贴)' }}
            </button>
            <button class="btn btn-outline" :disabled="marking[taskKey(t)]" @click="markTaskLanded(t)">
              {{ marking[taskKey(t)] ? '标记中…' : '✓ 本任务已落地' }}
            </button>
          </div>
          <div class="alt-row">
            <button class="btn-link" :disabled="dispatching[taskKey(t)]" @click="dispatchTask(t)">
              {{ dispatching[taskKey(t)] ? '开终端中…' : '⚙ 或:试试自动开终端(实验,开的是终端非桌面App)' }}
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
.spacer { flex: 1; }
.hint { font-size: 12px; }
.subhint { margin: -4px 0 14px; }
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
.copied-note { padding: 8px 12px; background: rgba(90,200,120,0.15); border-left: 3px solid #5ac878; border-radius: var(--radius-sm); color: #5ac878; font-size: 13px; line-height: 1.5; }
.howto { padding: 12px 14px; margin-bottom: 16px; font-size: 13px; line-height: 1.7; max-width: 920px; background: rgba(90,200,120,0.06); border-left: 3px solid #5ac878; }
.howto .kbd { background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; font-size: 12px; white-space: nowrap; }
.howto code { background: var(--panel-2); padding: 1px 5px; border-radius: 3px; font-family: var(--font-mono); font-size: 12px; }
.alt-row { margin-top: 2px; }
.btn-link { background: none; border: none; color: var(--muted-2); font-size: 11px; cursor: pointer; padding: 2px 0; text-decoration: underline; }
.btn-link:hover { color: var(--muted); }
.btn-link:disabled { opacity: 0.5; cursor: not-allowed; }
.actions { display: flex; gap: 8px; }
.btn { padding: 8px 14px; border-radius: var(--radius-sm); font-size: 13px; cursor: pointer; border: none; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary-strong { flex: 1; background: linear-gradient(90deg, #4c8ce0, #6c9ce8); color: white; font-weight: 500; }
.btn-primary-strong:hover { opacity: 0.92; }
.btn-outline { background: transparent; color: var(--text); border: 1px solid var(--border); }
.btn-outline:hover { background: var(--panel-2); }
</style>
