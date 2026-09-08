<script setup lang="ts">
// 卡片详情抽屉：task 全字段 + 文档链接(→/api/doc 预览) + 待拍板内联拍板 + 活动时间线。
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { useBoardStore } from '@/stores/board'
import * as derive from '@/utils/derive'
import { fetchDoc, docUrl, postTaskAction } from '@/api/client'
import { fmtDateTime, relTime } from '@/utils/format'
import Icon from './Icon.vue'
import StatusBadge from './StatusBadge.vue'
import { humanTitle, specText, missingPlainTitle, plainTitleFixCommand } from '@/utils/taskTitle'
import { appearance } from '@/utils/appearance'
import { ageLevel, ageTone } from '@/utils/ageLevel'
import type { DocRef, Status } from '@/types'

/**
 * docked = 宽屏内嵌模式(由 App.vue 按 ≥1600 的断点决定)。
 * 两种模式共用同一份内容，只换外壳：
 *   false → 老样子，Teleport 到 body、铺满视口的遮罩 + 右侧浮层抽屉；
 *   true  → 不 Teleport，就地渲染成 .shell 的第三列，不遮罩、不压暗。
 */
const props = defineProps<{ docked?: boolean }>()

const store = useBoardStore()
const task = computed(() => store.selectedTask)
const pid = computed(() => store.selectedTaskProjectId || '')
const acts = computed(() => derive.activityOfTask(store.selectedBoard, task.value?.id || ''))
watch(() => [store.selectedTaskId, pid.value, store.loading, store.activityComplete[pid.value]], () => {
  if (store.loading || !store.selectedTaskId || !pid.value) return
  store.ensureFullActivity(pid.value).catch((e) => {
    store.error = e instanceof Error ? e.message : String(e)
  })
}, { immediate: true })
const now = ref(Date.now())
let freshnessTimer: ReturnType<typeof setInterval> | null = null
const progressAge = computed(() => {
  const lp = (task.value as any)?.lastProgressAt
  if (!lp || task.value?.status !== '施工中') return 0
  return ageLevel(now.value - new Date(lp).getTime(), appearance.ageThresholds)
})

const hasArr = (a: unknown): a is unknown[] => Array.isArray(a) && a.length > 0

// ---- 技术说明折叠 + 补人话标题一键复制 ----
const specExpanded = ref(false)
const copiedFix = ref(false)
async function copyPlainTitleFix(t: { id: string }) {
  const text = plainTitleFixCommand(pid.value, t.id)
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
  copiedFix.value = true
  setTimeout(() => { copiedFix.value = false }, 4000)
}

// ---- 内联拍板 ----
const picked = reactive<Record<string, string>>({})
const submitting = reactive<Record<string, boolean>>({})
const derr = reactive<Record<string, string>>({})
async function decide(did: string, options: string[], recommended: string) {
  const answer = picked[did] ?? recommended
  submitting[did] = true
  delete derr[did]
  try {
    await store.decide(pid.value, task.value!.id, did, answer, '看板')
  } catch (e) {
    derr[did] = e instanceof Error ? e.message : String(e)
  } finally {
    submitting[did] = false
  }
}

const undoing = reactive<Record<string, boolean>>({})
const undoErrors = reactive<Record<string, string>>({})
const decisionKey = (did: string) => `${pid.value}:${task.value?.id}:${did}`
function canUndo(did: string, at = Math.max(now.value, Date.now())) {
  const decidedAt = store.decidedRecently.get(decisionKey(did))
  return decidedAt !== undefined && at >= decidedAt && at - decidedAt < 5 * 60_000
}
async function undoDecision(did: string) {
  const current = task.value
  const projectId = pid.value
  const key = decisionKey(did)
  if (!current || undoing[key] || !canUndo(did, Date.now())) return
  if (!confirm(`确认撤销 ${current.id} 的这条拍板？答案将清空，施工方会重新看到待拍板问题。`)) return
  if (!canUndo(did, Date.now())) return
  undoing[key] = true
  delete undoErrors[key]
  try { await store.undecide(projectId, current.id, did) }
  catch (error) { undoErrors[key] = error instanceof Error ? error.message : String(error) }
  finally { undoing[key] = false }
}

// ---- 负责人操作：两种抽屉外壳共用，状态迁移仍交 CLI 判断 ----
const drawerActions = [
  { action: 'note', label: '留言', icon: 'message' },
  { action: 'park', label: '暂缓', icon: 'parkingNote' },
  { action: 'unpark', label: '复工', icon: 'rotateCcw' },
  { action: 'cancel', label: '作废', icon: 'x' },
  { action: 'reopen', label: '重开', icon: 'refresh' },
] as const
type DrawerAction = typeof drawerActions[number]['action']
const activeAction = ref<DrawerAction | null>(null)
const actionText = ref('')
const actionBusy = ref(false)
const actionError = ref('')
function actionAllowed(action: DrawerAction, status: Status): boolean {
  const terminal = status === '已完工' || status === '已作废'
  if (action === 'reopen') return terminal
  if (action === 'unpark') return status === '暂缓'
  if (action === 'park' || action === 'cancel') return !terminal
  return true
}
const availableActions = computed(() => drawerActions.filter((entry) => task.value && actionAllowed(entry.action, task.value.status)))
const actionMinLength = computed(() => activeAction.value === 'note' ? 1 : 4)
function resetActionForm() { activeAction.value = null; actionText.value = ''; actionError.value = '' }
function openAction(action: DrawerAction) {
  if (actionBusy.value) return
  resetActionForm()
  activeAction.value = action
}
watch([pid, () => task.value?.id], resetActionForm)
watch(() => task.value?.status, (status) => {
  if (status && activeAction.value && !actionAllowed(activeAction.value, status)) resetActionForm()
})
async function submitAction() {
  const action = activeAction.value
  const current = task.value
  const projectId = pid.value
  if (!action || !current || actionBusy.value || !actionAllowed(action, current.status)) return
  const text = actionText.value.trim()
  if (text.length < actionMinLength.value) {
    actionError.value = action === 'note' ? '请填写留言' : '理由至少填写 4 个字'
    return
  }
  const confirmations: Record<DrawerAction, string> = {
    note: `这会给卡 ${current.id} 留下负责人留言，确认发送？`,
    park: `这会把卡 ${current.id} 转成暂缓，确认继续？`,
    unpark: `这会把卡 ${current.id} 转成可复工，确认继续？`,
    cancel: `这会把卡 ${current.id} 转成已作废，确认继续？`,
    reopen: `这会把卡 ${current.id} 转成待开工，并清零进度和完工日期，确认重开？`,
  }
  if (!confirm(confirmations[action])) return
  actionBusy.value = true
  actionError.value = ''
  const stillSelected = () => pid.value === projectId && task.value?.id === current.id
  try {
    if (action === 'note') await postTaskAction(projectId, current.id, action, { text })
    else await postTaskAction(projectId, current.id, action, { reason: text })
    await store.loadBoard(projectId, { detect: true })
    if (stillSelected()) resetActionForm()
  } catch (error) {
    if (stillSelected()) {
      activeAction.value = action
      actionError.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    actionBusy.value = false
  }
}

// ---- 文档预览 ----
const activeDoc = ref<string | null>(null)
const docText = ref('')
const docLoading = ref(false)
const docErr = ref('')
function docPath(d: DocRef) { return typeof d === 'string' ? d : d.path }
function docName(d: DocRef) {
  const p = docPath(d)
  const base = p.split(/[\\/]/).pop() || p
  return typeof d === 'string' ? base : d.title || base
}
async function preview(d: DocRef) {
  const p = docPath(d)
  if (activeDoc.value === p) { activeDoc.value = null; return }
  activeDoc.value = p
  docText.value = ''
  docErr.value = ''
  docLoading.value = true
  try {
    docText.value = await fetchDoc(pid.value, p)
  } catch (e) {
    docErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    docLoading.value = false
  }
}

// 切换任务时重置文档预览 + 技术说明展开态
watch(task, () => { activeDoc.value = null; docText.value = ''; docErr.value = ''; specExpanded.value = false; copiedFix.value = false })
// 遮罩抽屉要锁 body 滚动；内嵌模式是页面的一列，不该锁（拖窄窗口回落时也要跟着放开）。
watch([task, () => props.docked], ([t, docked]) => {
  document.body.style.overflow = t && !docked ? 'hidden' : ''
})

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && store.selectedTask) store.closeTask()
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  now.value = Date.now()
  freshnessTimer = setInterval(() => { now.value = Date.now() }, 30_000)
})
onUnmounted(() => {
  if (freshnessTimer !== null) clearInterval(freshnessTimer)
  window.removeEventListener('keydown', onKey)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body" :disabled="docked">
    <Transition name="drawer">
      <div v-if="task" class="overlay" :class="{ docked }" @click.self="docked || store.closeTask()">
        <aside class="drawer card" aria-label="任务详情">
          <header class="d-head">
            <span class="d-id mono">{{ task.id }}</span>
            <StatusBadge :status="task.status" />
            <span class="spacer" />
            <button class="btn btn-sm btn-ghost close" type="button" aria-label="关闭任务详情" @click="store.closeTask()"><Icon name="x" :size="16" label="关闭" /></button>
          </header>

          <div class="d-body">
            <div class="d-title-row">
              <h2 class="d-title">{{ humanTitle(task) }}</h2>
              <button
                v-if="missingPlainTitle(task)"
                type="button"
                class="badge warn icon-badge no-plain-title"
                :title="plainTitleFixCommand(pid, task.id)"
                @click="copyPlainTitleFix(task)"
              ><Icon :name="copiedFix ? 'check' : 'pencil'" :size="14" />{{ copiedFix ? '已复制补充命令' : '无人话标题·点击复制补充命令' }}</button>
            </div>

            <section class="sec block spec-sec">
              <button type="button" class="sec-t spec-toggle" @click="specExpanded = !specExpanded">
                技术说明（给 AI）
                <Icon name="chevron" :size="14" :rotate="specExpanded ? 180 : 0" />
              </button>
              <p class="d-spec" :class="{ clamped: !specExpanded }">{{ specText(task) }}</p>
            </section>

            <div class="d-prog">
              <div class="glow-rail"><i :style="{ width: (task.percent || 0) + '%' }" /></div>
              <span class="pct mono">{{ task.percent || 0 }}%</span>
              <span v-if="task.status === '施工中' && (task as any).lastProgressAt" class="prog-time" :class="ageTone(progressAge)">
                <Icon v-if="progressAge >= 2" name="alertTri" :size="14" />{{ progressAge >= 2 ? '进度' : '进度更新于' }} {{ relTime((task as any).lastProgressAt) }}
              </span>
            </div>

            <p v-if="task.description" class="d-desc">{{ task.description }}</p>

            <!-- 元信息 -->
            <section class="sec">
              <div class="kv" v-if="task.wave"><span>波次</span><b>W{{ task.wave }}</b></div>
              <div class="kv" v-if="task.modelHint"><span>建议档位</span><b class="with-icon"><Icon name="bot" :size="14" />{{ task.modelHint }}</b></div>
              <div class="kv" v-if="task.dates?.design"><span>设计</span><b>{{ task.dates.design }}</b></div>
              <div class="kv" v-if="task.dates?.start"><span>开工</span><b>{{ task.dates.start }}</b></div>
              <div class="kv" v-if="task.dates?.done"><span>完工</span><b>{{ task.dates.done }}</b></div>
              <div class="kv" v-if="task.typecheck !== undefined"><span>类型检查</span><b class="with-icon"><Icon v-if="task.typecheck" name="check" :size="14" /><template v-else>—</template></b></div>
              <div class="kv" v-if="task.nextMilestone"><span>下一里程碑</span><b>{{ task.nextMilestone }}</b></div>
            </section>

            <!-- 测试 -->
            <section v-if="task.tests" class="sec block">
              <div class="sec-t">测试</div>
              <div class="inline-list">
                <span class="pill">共 {{ task.tests.total ?? 0 }}</span>
                <span class="pill">通过 {{ task.tests.passing ?? 0 }}</span>
                <span class="pill" v-if="task.tests.mustFailFirst">先失败 {{ task.tests.mustFailFirst }}</span>
              </div>
            </section>

            <!-- 分支 / 占用 -->
            <section v-if="hasArr(task.gitBranch) || hasArr(task.worktree) || hasArr(task.prNumbers) || hasArr(task.commitShas) || hasArr(task.fileScope) || hasArr(task.forbiddenZones)" class="sec block">
              <div class="sec-t">分支 / 占用</div>
              <div class="inline-list">
                <span v-for="b in task.gitBranch || []" :key="b" class="pill"><Icon name="branch" :size="14" />{{ b }}</span>
                <span v-for="w in task.worktree || []" :key="w" class="pill"><Icon name="tree" :size="14" />{{ w }}</span>
                <span v-for="p in task.prNumbers || []" :key="p" class="pill"><Icon name="pr" :size="14" />#{{ p }}</span>
                <span v-for="c in task.commitShas || []" :key="c" class="pill"><Icon name="commit" :size="14" />{{ String(c).slice(0, 8) }}</span>
              </div>
              <div class="inline-list secondary-list" v-if="hasArr(task.fileScope) || hasArr(task.forbiddenZones)">
                <span v-for="f in task.fileScope || []" :key="f" class="badge info icon-badge"><Icon name="folder" :size="14" />{{ f }}</span>
                <span v-for="f in task.forbiddenZones || []" :key="f" class="badge bad icon-badge"><Icon name="ban" :size="14" />{{ f }}</span>
              </div>
            </section>

            <!-- 施工成本 -->
            <section v-if="hasArr(task.cost?.entries)" class="sec block">
              <div class="sec-t">施工成本</div>
              <div v-for="(e, i) in task.cost!.entries" :key="i" class="cost-row">
                <span class="mono cost-date">{{ e.date }}</span>
                <span class="pill">{{ Object.entries(e.agents || {}).map(([m, n]) => `${m}×${n}`).join(' + ') || '—' }}</span>
                <span v-if="e.tokens" class="pill">≈{{ e.tokens.toLocaleString() }} tok</span>
                <span v-if="e.note" class="cost-note">{{ e.note }}</span>
              </div>
            </section>

            <!-- 依赖 / 状态说明：卡为什么停着、为什么退回来、为什么不做了、为什么又要做，都摆在这一段 -->
            <section v-if="task.deps && (hasArr(task.deps.dependsOn) || hasArr(task.deps.blockedBy) || hasArr(task.deps.relatedTasks)) || task.blockReason || task.parkedNote || task.unparkReason || task.unclaimReason || task.cancelReason || task.reopenReason" class="sec block">
              <div class="sec-t">依赖 / 状态说明</div>
              <div class="kv" v-if="hasArr(task.deps?.dependsOn)"><span>依赖</span><b>{{ task.deps!.dependsOn!.join(', ') }}</b></div>
              <div class="kv" v-if="hasArr(task.deps?.blockedBy)"><span>被阻塞</span><b class="warn">{{ task.deps!.blockedBy!.join(', ') }}</b></div>
              <div class="kv" v-if="hasArr(task.deps?.relatedTasks)"><span>关联</span><b>{{ task.deps!.relatedTasks!.join(', ') }}</b></div>
              <div class="note" v-if="task.blockReason"><Icon name="alertTri" :size="16" />{{ task.blockReason }}</div>
              <div class="note" v-if="task.parkedNote"><Icon name="parkingNote" :size="16" />{{ task.parkedNote }}</div>
              <div class="note ok" v-if="task.unparkReason"><Icon name="rotateCcw" :size="16" />{{ task.unparkReason }}<span v-if="task.unparkedAt" class="note-when mono">{{ task.unparkedAt }}</span></div>
              <div class="note" v-if="task.unclaimReason"><Icon name="hand" :size="16" />放弃认领：{{ task.unclaimReason }}<span v-if="task.unclaimedAt" class="note-when mono">{{ task.unclaimedAt }}</span></div>
              <div class="note" v-if="task.cancelReason"><Icon name="x" :size="16" />作废：{{ task.cancelReason }}<span v-if="task.cancelledAt" class="note-when mono">{{ task.cancelledAt }}</span></div>
              <div class="note ok" v-if="task.reopenReason"><Icon name="refresh" :size="16" />重开：{{ task.reopenReason }}<span v-if="task.reopenedAt" class="note-when mono">{{ task.reopenedAt }}</span></div>
            </section>

            <!-- 决策（含内联拍板） -->
            <section v-if="hasArr(task.decisions)" class="sec block">
              <div class="sec-t">决策</div>
              <div v-for="d in task.decisions" :key="d.id" class="dec card">
                <div class="dec-q"><span class="did mono">#{{ d.id }}</span> {{ d.question }}</div>
                <template v-if="d.answer == null">
                  <div class="opts">
                    <button
                      v-for="o in d.options" :key="o" class="opt btn"
                      :class="{ on: (picked[d.id] ?? d.recommended) === o, rec: d.recommended === o }"
                      @click="picked[d.id] = o"
                    ><i class="pick" :class="{ on: (picked[d.id] ?? d.recommended) === o }" aria-hidden="true" />{{ o }}
                      <span v-if="d.recommended === o" class="badge ok compact">推荐</span>
                    </button>
                  </div>
                  <div class="decision-actions">
                    <span v-if="derr[d.id]" class="err with-icon"><Icon name="alertTri" :size="14" />{{ derr[d.id] }}</span>
                    <span class="spacer" />
                    <button class="btn btn-primary btn-sm" :disabled="submitting[d.id]" @click="decide(d.id, d.options, d.recommended)">
                      {{ submitting[d.id] ? '提交中…' : '拍板：' + (picked[d.id] ?? d.recommended) }}
                    </button>
                  </div>
                </template>
                <div v-else class="dec-done">
                  <Icon name="check" :size="14" />已拍板：<b>{{ d.answer }}</b><span v-if="d.decidedAt" class="mono"> · {{ d.decidedAt }}</span>
                  <button v-if="canUndo(d.id)" class="btn btn-sm quiet" type="button" :disabled="undoing[decisionKey(d.id)]" @click="undoDecision(d.id)">
                    <Icon name="rotateCcw" :size="14" />{{ undoing[decisionKey(d.id)] ? '撤销中…' : '撤销' }}
                  </button>
                  <span v-if="undoErrors[decisionKey(d.id)]" class="err" role="alert">{{ undoErrors[decisionKey(d.id)] }}</span>
                </div>
              </div>
            </section>

            <!-- 文档 -->
            <section v-if="hasArr(task.docs)" class="sec block">
              <div class="sec-t">文档</div>
              <div v-for="(d, i) in task.docs" :key="i" class="doc card">
                <div class="doc-row">
                  <button class="doc-name" @click="preview(d)"><Icon name="file" :size="14" />{{ docName(d) }}</button>
                  <a class="pill" :href="docUrl(pid, docPath(d))" target="_blank" rel="noopener">打开<Icon name="toland" :size="14" /></a>
                </div>
                <div v-if="activeDoc === docPath(d)" class="doc-view">
                  <div v-if="docLoading" class="muted small">加载中…</div>
                  <div v-else-if="docErr" class="err">{{ docErr }}</div>
                  <pre v-else>{{ docText }}</pre>
                </div>
              </div>
            </section>

            <section class="sec block">
              <div class="sec-t">操作</div>
              <div class="inline-list">
                <button
                  v-for="entry in availableActions" :key="entry.action"
                  type="button" class="btn btn-sm" :disabled="actionBusy"
                  :aria-pressed="activeAction === entry.action" @click="openAction(entry.action)"
                ><Icon :name="entry.icon" :size="14" />{{ entry.label }}</button>
              </div>
              <form v-if="activeAction" class="task-action-form" @submit.prevent="submitAction">
                <label class="task-action-label">
                  {{ activeAction === 'note' ? '留言（必填）' : '理由（至少 4 个字）' }}
                  <textarea
                    v-model="actionText" class="field" rows="3" required :minlength="actionMinLength"
                    :disabled="actionBusy" :placeholder="activeAction === 'note' ? '给施工方留下要先读的话' : '请写明这次操作的理由'"
                  />
                </label>
                <div class="inline-list">
                  <button type="submit" class="btn btn-primary btn-sm" :disabled="actionBusy || actionText.trim().length < actionMinLength">{{ actionBusy ? '提交中…' : '确认' }}</button>
                  <button type="button" class="btn btn-sm" :disabled="actionBusy" @click="resetActionForm">取消</button>
                </div>
                <p v-if="actionError" class="err" role="alert">{{ actionError }}</p>
              </form>
            </section>

            <!-- 活动 -->
            <section v-if="acts.length" class="sec block">
              <div class="sec-t">活动</div>
              <div class="tl">
                <div v-for="(a, i) in acts" :key="i" class="tl-item row">
                  <span class="tl-dot" />
                  <div class="tl-main">
                    <div class="tl-text">{{ a.text }}</div>
                    <div class="tl-meta mono">{{ a.author }} · {{ fmtDateTime(a.ts) }} · {{ relTime(a.ts) }}</div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 100; display: flex; justify-content: flex-end; background: var(--overlay); }
.drawer.card { display: flex; flex-direction: column; width: min(520px, 94vw); height: 100%; padding: 0; overflow: hidden; border: 0; border-left: 1px solid var(--line); border-radius: 0; background: var(--surface); box-shadow: calc(-1 * var(--s3)) 0 var(--s7) var(--drawer-shadow); }
/* —— 内嵌模式：同一段 DOM，换成外壳的第三列 ——
   没有 Teleport 时这个 .overlay 就是 .shell 的直接子元素，直接把它摆进 grid-column 3；
   不压暗、不浮起，宽度交给 .shell.has-dock 的列宽定。 */
.overlay.docked { position: static; z-index: auto; grid-column: 3; grid-row: 2; min-width: 0; background: none; }
.overlay.docked .drawer.card { width: 100%; box-shadow: none; }
.d-head { display: flex; align-items: center; gap: var(--s3); padding: var(--s3) var(--s4); border-bottom: 1px solid var(--line); }
.d-id { color: var(--text-2); font-weight: 700; }
.d-body { display: flex; flex-direction: column; gap: var(--s4); padding: var(--s4); overflow-y: auto; }
.d-title-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
.d-title { flex: 1; min-width: 0; font-size: var(--fs-lg); line-height: 1.4; }
.no-plain-title { flex: none; border: 1px solid transparent; cursor: pointer; }
.spec-sec { padding-top: 0; border-top: 0; }
.spec-toggle { display: inline-flex; align-items: center; gap: var(--s1); border: 0; background: none; padding: 0; color: var(--text-3); cursor: pointer; font: inherit; font-size: var(--fs-xs); font-weight: 600; letter-spacing: .1em; text-transform: uppercase; }
.d-spec { margin: 0; color: var(--text-2); font-size: var(--fs-sm); line-height: 1.6; white-space: pre-wrap; }
.d-spec.clamped { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.d-prog { display: flex; align-items: center; gap: var(--s3); }
.d-prog .glow-rail { flex: 1; }
.d-prog .pct { color: var(--text-2); font-size: var(--fs-sm); }
.d-prog .prog-time { display: inline-flex; align-items: center; gap: var(--s1); margin-left: var(--s1); color: var(--text-3); font-size: var(--fs-xs); }
.d-prog .prog-time.info { color: var(--info); }
.d-prog .prog-time.warn { color: var(--warn); }
.d-prog .prog-time.bad { color: var(--bad); }
.d-desc { margin: 0; color: var(--text-2); font-size: var(--fs-base); line-height: 1.6; white-space: pre-wrap; }
.sec { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); }
.sec.block { flex-direction: column; gap: var(--s2); padding-top: var(--s3); border-top: 1px solid var(--line); }
.sec-t { color: var(--text-3); font-size: var(--fs-xs); font-weight: 600; letter-spacing: .1em; text-transform: uppercase; }
.kv { display: flex; align-items: baseline; gap: var(--s2); font-size: var(--fs-base); }
.kv span { min-width: calc(var(--s7) + var(--s3)); color: var(--text-2); }
.kv b { font-weight: 600; }
/* 键值行里塞了图标就得换 flex，不然图标压不到基线上。 */
.kv b.with-icon { display: inline-flex; align-items: center; gap: var(--s1); }
.kv b.warn, .warn { color: var(--warn); }
.note { display: flex; align-items: center; gap: var(--s2); padding: var(--s2) var(--s3); border-radius: var(--r); background: var(--warn-bg); color: var(--warn); font-size: var(--fs-base); }
/* 解除暂缓是好消息,别跟阻塞/暂缓一样刷成警告色 */
.note.ok { background: var(--ok-bg); color: var(--ok); }
.note-when { margin-left: var(--s2); color: var(--text-3); font-size: var(--fs-sm); }
.inline-list, .decision-actions { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
.task-action-form, .task-action-label { display: flex; flex-direction: column; gap: var(--s2); }
.task-action-label { color: var(--text-2); font-size: var(--fs-sm); }
.task-action-form textarea { width: 100%; resize: vertical; }
.task-action-form .err { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.secondary-list { margin-top: var(--s2); }
.dec { display: flex; flex-direction: column; gap: var(--s2); background: var(--surface-2); }
.dec-q { font-size: var(--fs-base); }
.dec-q .did { margin-right: var(--s1); color: var(--text-3); }
.opts { display: flex; flex-direction: column; gap: var(--s2); }
.opt { width: 100%; justify-content: flex-start; padding: var(--s2) var(--s3); background: var(--surface); text-align: left; }
.opt.on { border-color: var(--info); background: var(--info-bg); }
.opt .badge { margin-left: auto; }
/* 选项前的圆点自己画：选中实心、未选空心，比塞一枚图标更贴合单选的语感。 */
.pick { width: 10px; height: 10px; flex: none; margin-right: var(--s2); border: 1.6px solid var(--text-3); border-radius: 50%; }
.opt.on .pick { border-color: var(--info); box-shadow: inset 0 0 0 2.4px var(--info-bg); background: var(--info); }
.dec-done { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1); color: var(--ok); font-size: var(--fs-base); }
.err { color: var(--bad); font-size: var(--fs-sm); }
.err.with-icon { display: inline-flex; align-items: center; gap: var(--s1); }
/* 徽章基类是 inline-block，塞进图标后要改成 flex 才对得齐。 */
.icon-badge { display: inline-flex; align-items: center; gap: var(--s1); }
.small { font-size: var(--fs-sm); }
.doc { padding: 0; background: var(--surface-2); }
.doc-row { display: flex; align-items: center; gap: var(--s2); padding: var(--s2) var(--s3); }
.doc-name { display: flex; align-items: center; gap: var(--s1); flex: 1; border: 0; background: none; color: var(--info); cursor: pointer; font-size: var(--fs-base); text-align: left; }
.doc-view { max-height: 260px; padding: var(--s3); overflow: auto; border-top: 1px solid var(--line); background: var(--bg); }
.doc-view pre { margin: 0; color: var(--text); font-family: var(--mono); font-size: var(--fs-sm); white-space: pre-wrap; word-break: break-word; }
.tl { display: flex; flex-direction: column; gap: var(--s2); }
.tl-item { align-items: flex-start; }
.tl-dot { flex: none; width: var(--s2); height: var(--s2); margin-top: var(--s1); border-radius: 50%; background: var(--info); }
.tl-main { flex: 1; }
.tl-text { font-size: var(--fs-base); }
.tl-meta { margin-top: var(--s1); color: var(--text-3); font-size: var(--fs-xs); }
.cost-row { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; font-size: var(--fs-base); }
.cost-date { color: var(--text-2); font-size: var(--fs-sm); }
.cost-note { flex-basis: 100%; padding-left: var(--s1); color: var(--text-3); font-size: var(--fs-sm); }

/* 抽屉过渡 */
.drawer-enter-active, .drawer-leave-active { transition: opacity .18s ease; }
.drawer-enter-active .drawer, .drawer-leave-active .drawer { transition: transform .18s ease; }
.drawer-enter-from, .drawer-leave-to { opacity: 0; }
.drawer-enter-from .drawer, .drawer-leave-to .drawer { transform: translateX(30px); }
</style>
