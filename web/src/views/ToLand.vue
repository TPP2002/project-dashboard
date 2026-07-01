<script setup lang="ts">
// 待落地队列：已拍板但代码/文档还没落地的决策——需要新对话去执行。
// 治的病:拍板了但对话不知道→对话是手动开的、不常驻、拍完板没人自动做。
// 解法:每条生成"启动指令",你复制粘贴到新对话里,那对话就知道要干啥。
// 落地后走 CLI mark-landed 从队列消失。
import { computed, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import type { PendingItem } from '@/utils/derive'

const store = useBoardStore()
const items = computed(() => store.unlandedDecisions)
// 按项目分组:{ pid: {name, items: [...] } }
const grouped = computed(() => {
  const g: Record<string, { name: string; items: PendingItem[] }> = {}
  for (const it of items.value) {
    if (!g[it.projectId]) g[it.projectId] = { name: it.projectName, items: [] }
    g[it.projectId].items.push(it)
  }
  return g
})
const projDispatching = ref<Record<string, boolean>>({})
const projDispatched = ref<Record<string, string>>({})

async function dispatchProject(pid: string, name: string, count: number) {
  if (!confirm(`确认打包派单【${name}】全部 ${count} 条已拍板决策?\n\n将开一个新终端窗口、启动 claude、注入完整任务书,一个对话接手全部决策。`)) return
  projDispatching.value[pid] = true
  try {
    const res = await fetch('/api/dispatch-project', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '派单失败')
    projDispatched.value[pid] = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch (e) {
    alert('派单失败:' + (e instanceof Error ? e.message : String(e)))
  } finally {
    projDispatching.value[pid] = false
  }
}
const copied = ref<Record<string, boolean>>({})
const marking = ref<Record<string, boolean>>({})
const dispatching = ref<Record<string, boolean>>({})
const dispatched = ref<Record<string, string>>({})

const keyOf = (it: PendingItem) => `${it.projectId}:${it.task.id}:${it.decision.id}`

function launchCommand(it: PendingItem): string {
  const d: any = it.decision
  const CLI = 'node ~/.claude/dashboard/cli/index.cjs'
  return `# ${it.projectName} · ${it.task.id} · #${it.decision.id} 拍板落地任务
# 用户 ${d.decidedAt} 已拍板,现由你负责落地。

## 拍板信息
- **任务**:${it.task.id} ${it.task.title}
- **问题**:${it.decision.question}
- **用户拍的答案**:${it.decision.answer}
${d.recommendReason ? `- **当时的推荐理由**:${d.recommendReason}` : ''}

## 你的施工职责

1. 阅读该任务的设计文档(见 board.json 里 task.docs 字段)
2. 按用户拍的答案「${it.decision.answer}」落地实现
3. 遵守 skill \`project-build-workflow\` §11.2 认领协议:
   - 先 \`git fetch\` 核对 worktree 新鲜度
   - 建独立分支(顺延项目分支命名规则)
   - **动代码前跑 cli claim**:
     \`\`\`
     ${CLI} claim ${it.task.id} --project ${it.projectId} --branch <你的分支名>
     \`\`\`
4. 施工完成后:
   - \`${CLI} done ${it.task.id} --project ${it.projectId} --pr <PR号> --commit <sha>\`
   - 落地完成后标记本 decision 已落地:
     \`\`\`
     ${CLI} mark-landed ${it.task.id} --did ${it.decision.id} --project ${it.projectId}
     \`\`\`
5. 达标自动 push + gh pr create + auto-merge to main(见 skill §11.7)

**注意**:项目根 CLAUDE.md 有本项目的看板协议,一定要读完再动手。`
}

async function copy(it: PendingItem) {
  try {
    await navigator.clipboard.writeText(launchCommand(it))
    copied.value[keyOf(it)] = true
    setTimeout(() => { copied.value[keyOf(it)] = false }, 2000)
  } catch {
    // 老浏览器/权限问题:降级为选中
    const ta = document.createElement('textarea')
    ta.value = launchCommand(it)
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    copied.value[keyOf(it)] = true
    setTimeout(() => { copied.value[keyOf(it)] = false }, 2000)
  }
}

async function dispatch(it: PendingItem) {
  const k = keyOf(it)
  if (!confirm(`确认要看板一键开新 Claude Code 对话去做「${it.task.id}·${it.decision.id}」?\n\n将开一个新终端窗口、启动 claude、注入完整任务上下文。`)) return
  dispatching.value[k] = true
  try {
    const res = await fetch('/api/dispatch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: it.projectId, tid: it.task.id, did: it.decision.id }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '派单失败')
    dispatched.value[k] = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch (e) {
    alert('派单失败:' + (e instanceof Error ? e.message : String(e)))
  } finally {
    dispatching.value[k] = false
  }
}

async function markLanded(it: PendingItem) {
  const k = keyOf(it)
  if (!confirm(`确认「${it.task.id}·${it.decision.id}」已经代码落地了?`)) return
  marking.value[k] = true
  try {
    const res = await fetch(`/api/mark-landed/${it.projectId}/${it.task.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: it.decision.id, author: '看板' }),
    })
    if (!res.ok) throw new Error(await res.text())
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
      <span class="pill">{{ items.length }} 条</span>
      <span class="hint muted">已拍板但代码/文档还没落地——把"启动指令"复制到新对话里派单</span>
    </div>

    <div v-if="!items.length" class="empty card">
      <div class="big">✨</div>
      <div>所有拍板都已落地——干净</div>
    </div>

    <div v-for="(g, pid) in grouped" :key="pid" class="project-group">
      <div class="proj-head card">
        <div class="proj-info">
          <span class="proj-name">📦 {{ g.name }}</span>
          <span class="proj-count muted">{{ g.items.length }} 条待落地</span>
        </div>
        <div class="proj-actions">
          <button class="btn btn-project-dispatch" :disabled="projDispatching[pid]" @click="dispatchProject(pid, g.name, g.items.length)">
            {{ projDispatching[pid] ? '开对话中…' : `🚀 打包派单本项目全部 ${g.items.length} 条` }}
          </button>
        </div>
        <div v-if="projDispatched[pid]" class="proj-note">
          ✓ 已打包派单于 {{ projDispatched[pid] }}——新窗口应已启动
        </div>
      </div>

    <div class="list">
      <div v-for="it in g.items" :key="keyOf(it)" class="row card">
        <div class="top">
          <span class="proj pill">{{ it.projectName }}</span>
          <span class="tid mono">{{ it.task.id }}</span>
          <span class="ttitle">{{ it.task.title }}</span>
          <span class="did mono">#{{ it.decision.id }}</span>
          <span class="date">拍于 {{ it.decision.decidedAt }}</span>
        </div>
        <div class="q"><b>问题:</b> {{ it.decision.question }}</div>
        <div class="ans">
          <span class="ans-label">你的答案 →</span>
          <span class="ans-body">{{ it.decision.answer }}</span>
        </div>
        <div v-if="dispatched[keyOf(it)]" class="dispatched-note">
          ✓ 已派单开新 Claude Code 对话于 {{ dispatched[keyOf(it)] }}——新窗口应已在跑
        </div>
        <div class="actions">
          <button class="btn btn-primary-strong" :disabled="dispatching[keyOf(it)]" @click="dispatch(it)">
            {{ dispatching[keyOf(it)] ? '开对话中…' : '🚀 一键开 Claude Code 对话派单' }}
          </button>
          <button class="btn btn-outline" :disabled="marking[keyOf(it)]" @click="markLanded(it)">
            {{ marking[keyOf(it)] ? '标记中…' : '✓ 已落地(标记完成)' }}
          </button>
        </div>
        <details class="cmd-details">
          <summary class="muted">📋 备用:如果一键开对话不成功,展开手动复制启动指令</summary>
          <pre class="cmd">{{ launchCommand(it) }}</pre>
          <button class="btn btn-mini" @click="copy(it)">
            {{ copied[keyOf(it)] ? '✓ 已复制' : '📋 复制' }}
          </button>
        </details>
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
.list { display: flex; flex-direction: column; gap: 12px; max-width: 900px; }
.row { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.top { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.tid { color: var(--muted); font-weight: 600; }
.ttitle { font-weight: 600; }
.did { color: var(--muted-2); font-size: 12px; }
.date { color: var(--muted); font-size: 12px; margin-left: auto; }
.q { font-size: 13px; line-height: 1.5; }
.ans { padding: 9px 12px; background: rgba(90, 200, 120, 0.08); border-left: 3px solid #5ac878; border-radius: var(--radius-sm); font-size: 13px; }
.ans-label { color: var(--muted); }
.ans-body { color: #5ac878; font-weight: 500; }
.cmd-details { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 10px; }
.cmd-details summary { cursor: pointer; font-size: 12px; color: var(--muted); user-select: none; }
.cmd { margin: 8px 0 0; padding: 10px 12px; background: var(--panel-2); border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: 11px; line-height: 1.55; color: var(--text); white-space: pre-wrap; word-break: break-all; overflow-x: auto; max-height: 260px; }
.actions { display: flex; gap: 8px; }
.btn { flex: 1; padding: 8px 14px; background: var(--accent); color: white; border: none; border-radius: var(--radius-sm); font-size: 13px; cursor: pointer; }
.btn:hover { opacity: 0.9; }
.btn-outline { background: transparent; color: var(--text); border: 1px solid var(--border); }
.btn-outline:hover { background: var(--panel-2); }
.btn-primary-strong { background: linear-gradient(90deg, #4c8ce0, #6c9ce8); font-weight: 500; }
.btn-mini { padding: 4px 10px; font-size: 11px; margin-top: 8px; background: var(--panel-2); color: var(--text); border: 1px solid var(--border); }
.dispatched-note { padding: 8px 12px; background: rgba(76, 140, 224, 0.15); border-left: 3px solid #4c8ce0; border-radius: var(--radius-sm); color: #4c8ce0; font-size: 13px; }
.project-group { margin-bottom: 24px; }
.proj-head { padding: 14px 16px; margin-bottom: 12px; background: linear-gradient(135deg, rgba(76,140,224,0.08), rgba(108,156,232,0.04)); border-left: 4px solid #4c8ce0; display: flex; flex-direction: column; gap: 10px; }
.proj-info { display: flex; align-items: baseline; gap: 12px; }
.proj-name { font-size: 15px; font-weight: 500; }
.proj-count { font-size: 12px; }
.proj-actions { display: flex; }
.btn-project-dispatch { padding: 10px 16px; background: linear-gradient(90deg, #4c8ce0, #6c9ce8); color: white; border: none; border-radius: var(--radius-sm); font-weight: 500; font-size: 13px; cursor: pointer; width: 100%; }
.btn-project-dispatch:hover { opacity: 0.92; }
.btn-project-dispatch:disabled { opacity: 0.5; cursor: not-allowed; }
.proj-note { padding: 6px 10px; background: rgba(76,140,224,0.15); border-radius: var(--radius-sm); color: #4c8ce0; font-size: 12px; }
.empty { padding: 40px; text-align: center; }
.empty .big { font-size: 48px; margin-bottom: 8px; }
</style>
