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
const PAGE_SIZE = 8
// 默认只看当前项目（跟随顶栏项目切换）；「全部项目」开关可跨项目聚合。
const tasks = computed(() =>
  store.unlandedByTask.filter((task) => store.centerScopeAll || task.projectId === store.currentProjectId),
)
// 按项目再分组:{ pid: {name, tasks: [...] } }。
const grouped = computed(() => {
  const groups: Record<string, { name: string; tasks: UnlandedTask[] }> = {}
  for (const task of tasks.value) {
    if (!groups[task.projectId]) groups[task.projectId] = { name: task.projectName, tasks: [] }
    groups[task.projectId].tasks.push(task)
  }
  return groups
})
const totalDecisions = computed(() => tasks.value.reduce((sum, task) => sum + task.decisions.length, 0))
const decCountOf = (list: UnlandedTask[]) => list.reduce((sum, task) => sum + task.decisions.length, 0)

const taskKey = (task: UnlandedTask) => `${task.projectId}:${task.task.id}`
const dispatching = ref<Record<string, boolean>>({})
const dispatched = ref<Record<string, string>>({})
const projDispatching = ref<Record<string, boolean>>({})
const projDispatched = ref<Record<string, string>>({})
const marking = ref<Record<string, boolean>>({})
const projectPages = ref<Record<string, number>>({})

const nowHM = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const copiedTrigger = ref<Record<string, boolean>>({})

function pageCountOf(list: UnlandedTask[]) {
  return Math.max(1, Math.ceil(list.length / PAGE_SIZE))
}
function pageOf(pid: string, list: UnlandedTask[]) {
  return Math.min(projectPages.value[pid] || 1, pageCountOf(list))
}
function visibleTasks(pid: string, list: UnlandedTask[]) {
  const start = (pageOf(pid, list) - 1) * PAGE_SIZE
  return list.slice(start, start + PAGE_SIZE)
}
function changePage(pid: string, list: UnlandedTask[], next: number) {
  projectPages.value = {
    ...projectPages.value,
    [pid]: Math.max(1, Math.min(pageCountOf(list), next)),
  }
}
function statusTone(status: string) {
  if (['已完工', '已拍板', '收官'].includes(status)) return 'ok'
  if (status === '待拍板') return 'warn'
  if (['施工中', '可复工', '待开工'].includes(status)) return 'info'
  if (status === '暂缓') return 'bad'
  return 'n'
}

// 短触发指令:新对话粘贴这一句,自己去读看板拿完整任务书(避开命令行长度/转义,可靠)。
function triggerText(task: UnlandedTask): string {
  return [
    `你被【项目管理看板】指派接手任务 ${task.task.id}(项目 ${task.projectId})。`,
    '请立刻运行下面命令拿到完整任务书,然后严格按它执行(先 cli claim 再动代码):',
    '',
    `node ~/.claude/dashboard/cli/index.cjs inbox --project ${task.projectId} --tid ${task.task.id}`,
  ].join('\n')
}

// 【主路·可靠】复制接单指令 → 用户在桌面 App 新开对话粘贴 → 那对话读看板开干。
async function copyTrigger(task: UnlandedTask) {
  const key = taskKey(task)
  const text = triggerText(task)
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
  copiedTrigger.value[key] = true
  setTimeout(() => { copiedTrigger.value[key] = false }, 4000)
}

// 【次要·实验】试试自动开终端(开的是终端里的 claude,不是桌面 App;可能因环境失败)。
async function dispatchTask(task: UnlandedTask) {
  const key = taskKey(task)
  if (!confirm(`试试自动开【终端】跑 Claude Code 落地 ${task.task.id}?\n\n注意:开的是"终端里的 Claude Code",不是你常用的桌面 App——你要在弹出的终端窗口里看它。\n若没反应,请改用上面的"复制接单指令"在桌面 App 新开对话粘贴。`)) return
  dispatching.value[key] = true
  try {
    const response = await fetch('/api/dispatch-task', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: task.projectId, tid: task.task.id }),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || '派单失败')
    dispatched.value[key] = nowHM()
  } catch (error) {
    alert('自动开终端失败:' + (error instanceof Error ? error.message : String(error)) + '\n请改用"复制接单指令"。')
  } finally {
    dispatching.value[key] = false
  }
}

// 项目级派单:整个项目所有任务打包给一个对话(适合"一次全清")。
async function dispatchProject(pid: string, name: string, taskCount: number, decisionCount: number) {
  if (!confirm(`确认打包派单【${name}】全部 ${taskCount} 个任务 / ${decisionCount} 条决策给一个对话?\n\n若想分任务各交一个对话,请用每个任务卡片上的"派单本任务"。`)) return
  projDispatching.value[pid] = true
  try {
    const response = await fetch('/api/dispatch-project', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid }),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || '派单失败')
    projDispatched.value[pid] = nowHM()
  } catch (error) {
    alert('派单失败:' + (error instanceof Error ? error.message : String(error)))
  } finally {
    projDispatching.value[pid] = false
  }
}

// 标记整个任务的所有决策已落地。
async function markTaskLanded(task: UnlandedTask) {
  const key = taskKey(task)
  if (!confirm(`确认【${task.task.id}】的 ${task.decisions.length} 条决策都已代码落地?`)) return
  marking.value[key] = true
  try {
    for (const decision of task.decisions) {
      const response = await fetch(`/api/mark-landed/${task.projectId}/${task.task.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ did: decision.id, author: '看板' }),
      })
      if (!response.ok) throw new Error(await response.text())
    }
    await store.refresh()
  } catch (error) {
    alert('标记失败:' + (error instanceof Error ? error.message : String(error)))
  } finally {
    marking.value[key] = false
  }
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>🚀 待落地</h1>
        <p>已拍板但还没落地——按任务派单，一个任务交给一个新对话。</p>
      </div>
      <div class="head-actions">
        <span class="badge info">{{ tasks.length }} 个任务</span>
        <span class="badge n">{{ totalDecisions }} 条决策</span>
        <ScopeToggle />
      </div>
    </header>

    <div v-if="store.loading" class="loading-list" aria-label="正在加载待落地任务">
      <div class="card loading-card"><div class="skel medium" /><div class="skel wide" /><div class="skel row-skel" /><div class="skel row-skel" /></div>
    </div>

    <template v-else>
      <div v-if="tasks.length" class="howto card">
        <span class="glow glow-top howto-glow" />
        <b>怎么派单(可靠做法):</b> 点任务卡上的 <span class="kbd">📋 复制接单指令</span> → 在 Claude Code
        <b>新开一个对话</b> → 粘贴(Ctrl+V)发送。那对话会自己 <code>读看板</code> 拿到完整任务书、认领、开工。
        <span class="muted">("自动开终端"是实验功能,开的是终端里的 Claude Code、不是你常用的桌面 App,可能因环境打不开——打不开就用复制。)</span>
      </div>

      <div v-if="!tasks.length" class="empty card">
        <span class="ic">✨</span>
        所有拍板都已落地——干净<br>
        <span class="empty-help">有决策拍板后尚未标记落地时，对应任务会自动出现在这里。</span>
      </div>

      <section v-for="(group, pid) in grouped" :key="pid" class="project-group">
        <header class="project-head card">
          <div class="project-info">
            <div><h2>📦 {{ group.name }}</h2><p>{{ group.tasks.length }} 个任务 · {{ decCountOf(group.tasks) }} 条决策</p></div>
            <button class="btn" :disabled="projDispatching[pid]"
              @click="dispatchProject(pid, group.name, group.tasks.length, decCountOf(group.tasks))">
              {{ projDispatching[pid] ? '开对话中…' : `📦 整项目打包给一个对话（${group.tasks.length} 任务）` }}
            </button>
          </div>
          <div v-if="projDispatched[pid]" class="project-note"><span class="badge info">已派单</span> 已整项目打包派单于 {{ projDispatched[pid] }}</div>
        </header>

        <div class="task-list stagger-list">
          <article v-for="task in visibleTasks(pid, group.tasks)" :key="taskKey(task)" class="task-row row">
            <header class="task-top">
              <span class="task-id mono">{{ task.task.id }}</span>
              <span class="task-title">{{ task.task.title }}</span>
              <span class="badge" :class="statusTone(task.task.status)">{{ task.task.status }}</span>
              <span class="badge warn">{{ task.decisions.length }} 条已拍板决策</span>
            </header>

            <ul class="decision-list">
              <li v-for="decision in task.decisions" :key="decision.id" class="decision-item">
                <div class="decision-question"><span class="decision-id mono">#{{ decision.id }}</span> {{ decision.question }}</div>
                <div class="decision-answer"><span aria-hidden="true">└→</span> {{ decision.answer }}</div>
              </li>
            </ul>

            <div v-if="copiedTrigger[taskKey(task)]" class="feedback ok-feedback">
              <span class="badge ok">已复制</span>
              接单指令已复制！在 Claude Code <b>新开一个对话</b>,粘贴(Ctrl+V)发送即可——那对话会自己读看板拿到完整任务开干。
            </div>
            <div v-else-if="dispatched[taskKey(task)]" class="feedback info-feedback">
              <span class="badge info">已尝试</span>
              已尝试开终端于 {{ dispatched[taskKey(task)] }}——看弹出的<b>终端窗口</b>(不是桌面 App)。没弹出就用"复制接单指令"。
            </div>

            <div class="actions">
              <button class="btn primary main-action" @click="copyTrigger(task)">
                {{ copiedTrigger[taskKey(task)] ? '✓ 已复制,去新对话粘贴' : '📋 复制接单指令(新对话粘贴)' }}
              </button>
              <button class="btn" :disabled="marking[taskKey(task)]" @click="markTaskLanded(task)">
                {{ marking[taskKey(task)] ? '标记中…' : '✓ 本任务已落地' }}
              </button>
            </div>
            <div class="alternate-action">
              <button class="btn quiet btn-sm" :disabled="dispatching[taskKey(task)]" @click="dispatchTask(task)">
                {{ dispatching[taskKey(task)] ? '开终端中…' : '⚙ 或:试试自动开终端(实验,开的是终端非桌面App)' }}
              </button>
            </div>
          </article>
        </div>

        <nav v-if="pageCountOf(group.tasks) > 1" class="pagination" :aria-label="`${group.name} 分页`">
          <button class="btn btn-sm" :disabled="pageOf(pid, group.tasks) === 1" @click="changePage(pid, group.tasks, pageOf(pid, group.tasks) - 1)">上一页</button>
          <span class="page-count">第 {{ pageOf(pid, group.tasks) }} / {{ pageCountOf(group.tasks) }} 页</span>
          <button class="btn btn-sm" :disabled="pageOf(pid, group.tasks) === pageCountOf(group.tasks)" @click="changePage(pid, group.tasks, pageOf(pid, group.tasks) + 1)">下一页</button>
        </nav>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page { width: 100%; max-width: 1040px; min-width: 0; display: flex; flex-direction: column; gap: var(--s4); overflow-x: hidden; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s4); }
.page-head p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-md); }
.head-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--s2); }
.loading-list, .loading-card { display: flex; flex-direction: column; gap: var(--s3); }
.loading-card { padding: var(--s5); }
.skel.medium { width: 44%; }
.skel.wide { width: 84%; }
.skel.row-skel { height: 52px; }
.howto { position: relative; padding-top: var(--s4); background: var(--surface); font-size: var(--fs-base); line-height: 1.7; }
.howto-glow { position: absolute; inset: 0 0 auto; }
.kbd, code { padding: 1px var(--s1); border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface-2); font-family: var(--mono); font-size: var(--fs-sm); }
.empty-help { font-size: var(--fs-sm); }
.project-group { min-width: 0; display: flex; flex-direction: column; gap: var(--s3); margin-top: var(--s3); }
.project-head { display: flex; flex-direction: column; gap: var(--s2); background: var(--surface); }
.project-info { display: flex; align-items: center; justify-content: space-between; gap: var(--s4); }
.project-info h2 { font-size: var(--fs-lg); }
.project-info p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-sm); }
.project-note, .feedback { display: flex; align-items: flex-start; gap: var(--s2); padding: var(--s2) var(--s3); border-radius: var(--r); font-size: var(--fs-sm); line-height: 1.55; }
.project-note, .info-feedback { background: var(--info-bg); color: var(--text-2); }
.ok-feedback { background: var(--ok-bg); color: var(--text-2); }
.task-list { display: flex; flex-direction: column; gap: var(--s2); }
.task-row { align-items: stretch; flex-direction: column; gap: var(--s3); background: var(--surface); }
.task-top { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s2); }
.task-id { color: var(--text-2); font-size: var(--fs-base); font-weight: 600; }
.task-title { flex: 1; min-width: 180px; font-size: var(--fs-base); font-weight: 600; overflow-wrap: anywhere; }
.decision-list { display: flex; flex-direction: column; gap: var(--s2); margin: 0; padding: 0; list-style: none; }
.decision-item { padding: var(--s2) var(--s3); border-left: 2px solid var(--line-strong); border-radius: var(--r); background: var(--surface-2); }
.decision-question, .decision-answer { font-size: var(--fs-base); line-height: 1.55; }
.decision-id { color: var(--text-3); font-size: var(--fs-sm); }
.decision-answer { margin-top: var(--s1); color: var(--ok); }
.actions { display: flex; align-items: center; gap: var(--s2); }
.main-action { flex: 1; }
.alternate-action { margin-top: calc(var(--s1) * -1); }
.pagination { display: flex; align-items: center; justify-content: flex-end; gap: var(--s2); }
.page-count { color: var(--text-2); font-family: var(--mono); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }

@media (max-width: 760px) {
  .page-head, .project-info { align-items: stretch; flex-direction: column; }
  .head-actions { justify-content: flex-start; }
  .actions { align-items: stretch; flex-direction: column; }
  .actions .btn { width: 100%; }
  .pagination { justify-content: center; }
}
</style>
