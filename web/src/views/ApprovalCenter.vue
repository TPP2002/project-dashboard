<script setup lang="ts">
// 待拍板中心：列所有 answer===null 的 decision（跨项目）；界面点选 → POST /api/decide。
import Icon from '@/components/Icon.vue'
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useBoardStore } from '@/stores/board'
import ScopeToggle from '@/components/ScopeToggle.vue'
import { humanTitle } from '@/utils/taskTitle'
import { postTaskAction } from '@/api/client'
import { fmtDateTime } from '@/utils/format'
import type { DecisionInfoField } from '@/types'
import type { PendingItem } from '@/utils/derive'

const store = useBoardStore()
const author = ref('看板')
const picked = reactive<Record<string, string>>({})
const customText = reactive<Record<string, string>>({})
const submitting = reactive<Record<string, boolean>>({})
const errors = reactive<Record<string, string>>({})
const requestingInfo = reactive<Record<string, boolean>>({})
const infoErrors = reactive<Record<string, string>>({})
const CUSTOM = '__custom__'

// 默认只看当前项目（跟随顶栏项目切换）；「全部项目」开关可跨项目聚合。
const items = computed(() =>
  store.pendingDecisions.filter((item) => store.centerScopeAll || item.projectId === store.currentProjectId),
)
// 作用域为「当前项目」时，其他项目还剩多少待拍板（提示用户别漏了）。
const otherCount = computed(() => store.pendingDecisions.length - items.value.length)
const keyOf = (item: PendingItem) => `${item.projectId}:${item.task.id}:${item.decision.id}`
const now = ref(Date.now())
let recentTimer: ReturnType<typeof setInterval> | null = null
const undoing = reactive<Record<string, boolean>>({})
const undoErrors = reactive<Record<string, string>>({})
function canUndo(item: PendingItem, at: number) {
  const decidedAt = store.decidedRecently.get(keyOf(item))
  return decidedAt !== undefined && at >= decidedAt && at - decidedAt < 5 * 60_000
}
// 拍板后会离开待拍板列表；仅保留本页五分钟内的回执，让撤销仍有可见入口。
const recentItems = computed(() => {
  const at = Math.max(now.value, Date.now())
  return store.decidedHistory.filter(item => (store.centerScopeAll || item.projectId === store.currentProjectId)
    && canUndo(item, at))
})
onMounted(() => {
  now.value = Date.now()
  recentTimer = setInterval(() => { now.value = Date.now() }, 30_000)
})
onUnmounted(() => { if (recentTimer !== null) clearInterval(recentTimer) })

async function undoDecision(item: PendingItem) {
  const key = keyOf(item)
  if (undoing[key] || !canUndo(item, Date.now())) return
  if (!confirm(`确认撤销 ${item.task.id} 的这条拍板？答案将清空，施工方会重新看到待拍板问题。`)) return
  if (!canUndo(item, Date.now())) return
  undoing[key] = true
  delete undoErrors[key]
  try { await store.undecide(item.projectId, item.task.id, item.decision.id) }
  catch (error) { undoErrors[key] = error instanceof Error ? error.message : String(error) }
  finally { undoing[key] = false }
}

function incomplete(item: PendingItem): boolean {
  return incompleteReason(item).length > 0
}
function incompleteReason(item: PendingItem): DecisionInfoField[] {
  const decision = item.decision
  const missing: DecisionInfoField[] = []
  if (!decision.background || String(decision.background).trim().length < 60) missing.push('background')
  if (!decision.recommendReason || String(decision.recommendReason).trim().length < 30) missing.push('recommendReason')
  const pros = decision.optionPros
  if (!pros || typeof pros !== 'object' || Array.isArray(pros)
    || (decision.options || []).some((option) => typeof pros[option] !== 'string' || !pros[option].trim())) missing.push('optionPros')
  return missing
}
function incompleteDescription(item: PendingItem): string {
  const labels: Record<DecisionInfoField, string> = {
    background: '背景（大白话前因后果）', optionPros: '每选项利弊', recommendReason: '推荐理由',
  }
  const missing = incompleteReason(item).map((field) => {
    const pros = item.decision.optionPros
    if (field === 'optionPros' && pros && typeof pros === 'object' && !Array.isArray(pros)) {
      return item.decision.options
        .filter((option) => typeof pros[option] !== 'string' || !pros[option].trim())
        .map((option) => `「${option}」的利弊`).join('、') || labels[field]
    }
    return labels[field]
  })
  return missing.length ? '缺：' + missing.join('、') : ''
}

async function requestInfo(item: PendingItem) {
  const key = keyOf(item)
  const missing = incompleteReason(item)
  if (requestingInfo[key] || item.decision.infoRequestedAt || !missing.length) return
  if (!confirm(`这会要求施工方补齐卡 ${item.task.id} 的问题 ${item.decision.id} 的背景、选项利弊或推荐理由，确认发送？`)) return
  requestingInfo[key] = true
  delete infoErrors[key]
  try {
    await postTaskAction(item.projectId, item.task.id, 'request-info', { did: item.decision.id, missing })
    await store.loadBoard(item.projectId, { detect: true })
  } catch (error) {
    infoErrors[key] = error instanceof Error ? error.message : String(error)
  } finally {
    requestingInfo[key] = false
  }
}

function pick(item: PendingItem, option: string) {
  picked[keyOf(item)] = option
  delete errors[keyOf(item)]
}
function isCustom(item: PendingItem) {
  return picked[keyOf(item)] === CUSTOM
}
function chosen(item: PendingItem) {
  const selected = picked[keyOf(item)]
  if (selected === CUSTOM) return (customText[keyOf(item)] || '').trim() || '（自定义答案未填写）'
  return selected ?? item.decision.recommended
}

async function submit(item: PendingItem) {
  const key = keyOf(item)
  if (isCustom(item) && !(customText[key] || '').trim()) {
    errors[key] = '请在"其他"输入框里写下你的答案'
    return
  }
  submitting[key] = true
  delete errors[key]
  try {
    await store.decide(item.projectId, item.task.id, item.decision.id, chosen(item), author.value.trim() || '看板')
  } catch (error) {
    errors[key] = error instanceof Error ? error.message : String(error)
  } finally {
    submitting[key] = false
  }
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1><Icon name="bell" class="head-ic" :size="20" />待拍板</h1>
        <p>每张卡把问题、全部选项、利弊和推荐理由一次摊开；选中后直接确认。</p>
      </div>
      <div class="head-actions">
        <span class="badge warn">{{ items.length }} 条</span>
        <ScopeToggle />
        <label class="author">拍板人
          <input v-model="author" class="field" placeholder="署名">
        </label>
      </div>
    </header>

    <div v-if="!store.centerScopeAll && otherCount" class="other-note card">
      <span class="glow glow-top note-glow" />
      <span>其他项目还有 <b>{{ otherCount }}</b> 条待拍板。</span>
      <button class="btn quiet btn-sm" @click="store.centerScopeAll = true">查看全部项目 →</button>
    </div>

    <section v-if="recentItems.length" class="recently-decided" aria-labelledby="recent-decisions-title">
      <h2 id="recent-decisions-title">刚刚拍板</h2>
      <div class="decision-list">
        <article v-for="item in recentItems" :key="keyOf(item)" class="recent-decision card">
          <div class="decision-meta">
            <span class="badge n">{{ item.projectName }}</span>
            <span class="task-id mono">{{ item.task.id }}</span>
            <span class="task-title">{{ humanTitle(item.task) }}</span>
            <span class="decision-id mono">#{{ item.decision.id }}</span>
          </div>
          <p>{{ item.decision.question }}</p>
          <div class="recent-answer">
            <span>已拍板：<b>{{ item.decision.answer }}</b></span>
            <button class="btn btn-sm quiet" type="button" :disabled="undoing[keyOf(item)]" @click="undoDecision(item)">
              <Icon name="rotateCcw" :size="14" />{{ undoing[keyOf(item)] ? '撤销中…' : '撤销' }}
            </button>
          </div>
          <p v-if="undoErrors[keyOf(item)]" class="error-message" role="alert">{{ undoErrors[keyOf(item)] }}</p>
        </article>
      </div>
    </section>

    <div v-if="store.loading" class="loading-list" aria-label="正在加载待拍板事项">
      <div v-for="index in 2" :key="index" class="card loading-card">
        <div class="skel medium" />
        <div class="skel wide" />
        <div class="skel option-skel" />
        <div class="skel option-skel" />
      </div>
    </div>

    <div v-else-if="!items.length" class="empty card">
      <span class="ic"><Icon name="sparkles" :size="36" /></span>
      {{ store.centerScopeAll ? '所有项目都没有待拍板事项。' : '当前项目没有待拍板事项。' }}<br>
      <span class="empty-help">任务登记新的未答决策后，会带着选项和推荐自动出现在这里。</span>
    </div>

    <div v-else class="decision-list stagger-list">
      <article v-for="item in items" :key="keyOf(item)" class="decision-card card">
        <header class="decision-meta">
          <span class="badge n">{{ item.projectName }}</span>
          <span class="task-id mono">{{ item.task.id }}</span>
          <span class="task-title">{{ humanTitle(item.task) }}</span>
          <span v-if="incomplete(item)" class="badge warn" :title="incompleteDescription(item)">信息不完整</span>
          <button
            v-if="incomplete(item) || item.decision.infoRequestedAt" type="button" class="btn btn-sm"
            :disabled="requestingInfo[keyOf(item)] || !!item.decision.infoRequestedAt" @click="requestInfo(item)"
          ><Icon name="alertTri" :size="14" />{{ item.decision.infoRequestedAt ? '已要求补齐 · ' + fmtDateTime(item.decision.infoRequestedAt) : requestingInfo[keyOf(item)] ? '提交中…' : '要求补齐' }}</button>
          <span class="decision-id mono">#{{ item.decision.id }}</span>
        </header>

        <h2 class="question">{{ item.decision.question }}</h2>

        <div v-if="incomplete(item)" class="incomplete-note">
          <span class="badge warn">登记缺项</span>
          <span>
            {{ incompleteDescription(item) }}
            （登记这条待拍板的对话没按 skill §6.2 给全“三件套”——你仍可拍，但看板界面无法展示完整背景/利弊/推荐理由）
          </span>
        </div>

        <p v-if="infoErrors[keyOf(item)]" class="error-message" role="alert">{{ infoErrors[keyOf(item)] }}</p>

        <section v-if="(item.decision as any).background" class="context-block">
          <h3>背景（大白话）</h3>
          <p>{{ (item.decision as any).background }}</p>
        </section>

        <section class="options-section">
          <h3>选项</h3>
          <div class="options-list">
            <button
              v-for="option in item.decision.options"
              :key="option"
              class="option-card"
              :class="{ selected: chosen(item) === option }"
              type="button"
              @click="pick(item, option)"
            >
              <span class="option-head">
                <span class="pick-mark" :class="{ on: chosen(item) === option }" aria-hidden="true" />
                <span class="option-name">{{ option }}</span>
                <span v-if="item.decision.recommended === option" class="badge ok">推荐</span>
              </span>
              <span v-if="(item.decision as any).optionPros?.[option]" class="option-pros">
                {{ (item.decision as any).optionPros[option] }}
              </span>
            </button>

            <button
              class="option-card custom-option"
              :class="{ selected: isCustom(item) }"
              type="button"
              @click="pick(item, CUSTOM)"
            >
              <span class="option-head">
                <span class="pick-mark" :class="{ on: isCustom(item) }" aria-hidden="true" />
                <span class="option-name with-icon"><Icon name="pencil" :size="14" />其他（自己写答案）</span>
              </span>
              <span v-if="isCustom(item)" class="custom-wrap" @click.stop>
                <textarea
                  v-model="customText[keyOf(item)]"
                  class="field custom-input"
                  placeholder="在这里输入你自己的答案、想法或指令（例如：'先做只做一期的门面拆分，把核心逻辑抽出来后再评估要不要拆更深'）"
                  rows="3"
                />
              </span>
            </button>
          </div>
        </section>

        <section v-if="(item.decision as any).recommendReason" class="recommendation">
          <h3>为什么推荐“{{ item.decision.recommended }}”</h3>
          <p>{{ (item.decision as any).recommendReason }}</p>
        </section>

        <footer class="decision-actions">
          <span v-if="errors[keyOf(item)]" class="error-message"><span class="badge bad">未提交</span>{{ errors[keyOf(item)] }}</span>
          <button class="btn primary" :disabled="submitting[keyOf(item)]" @click="submit(item)">
            {{ submitting[keyOf(item)] ? '提交中…' : '确认拍板：' + chosen(item) }}
          </button>
        </footer>
      </article>
    </div>
  </div>
</template>

<style scoped>
.page { width: 100%; min-width: 0; display: flex; flex-direction: column; gap: var(--s4); overflow-x: hidden; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s5); }
.page-head p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-md); }
.head-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--s2); }
.author { display: flex; align-items: center; gap: var(--s2); color: var(--text-2); font-size: var(--fs-sm); white-space: nowrap; }
.author .field { width: 124px; }
.other-note { display: flex; align-items: center; gap: var(--s2); background: var(--surface); }
.other-note > span:nth-of-type(2) { flex: 1; }
.other-note b { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.note-glow { position: absolute; inset: 0 0 auto; }
/* 决策卡自动分栏：每列不窄于 620（卡里有大段背景和逐项利弊，1920 上正好两列、每列约 826，
   一行字长度最省力；2560 以上自动变三列，窄屏塞不下第二列就自己退回单栏）。
   align-items: start —— 同一行里高矮不一的卡各自保持自然高度，不被最高的那张撑开留白。 */
.loading-list, .decision-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(620px, 100%), 1fr));
  align-items: start;
  gap: var(--s3);
}
.loading-card { display: flex; flex-direction: column; gap: var(--s3); padding: var(--s5); }
.skel.medium { width: 42%; }
.skel.wide { width: 86%; }
.skel.option-skel { height: 58px; }
.empty-help { font-size: var(--fs-sm); }
.decision-card { display: flex; flex-direction: column; gap: var(--s4); padding: var(--s4); background: var(--surface); }
.decision-meta { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s2); }
.task-id { color: var(--text-2); font-size: var(--fs-sm); font-weight: 600; }
.task-title { min-width: 0; font-size: var(--fs-base); font-weight: 600; overflow-wrap: anywhere; }
.decision-id { margin-left: auto; color: var(--text-3); font-size: var(--fs-sm); }
.recently-decided { display: flex; flex-direction: column; gap: var(--s3); }
.recently-decided > h2 { font-size: var(--fs-lg); }
.recent-decision { display: flex; flex-direction: column; gap: var(--s2); }
.recent-decision p { margin: 0; overflow-wrap: anywhere; }
.recent-answer { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); color: var(--ok); }
.question { font-size: var(--fs-lg); line-height: 1.5; }
.incomplete-note { display: flex; align-items: flex-start; gap: var(--s2); padding: var(--s3); border-left: 2px solid var(--warn); border-radius: var(--r); background: var(--warn-bg); color: var(--text-2); font-size: var(--fs-sm); line-height: 1.6; }
.context-block, .recommendation { padding: var(--s3); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2); }
.context-block h3, .recommendation h3, .options-section > h3 { margin-bottom: var(--s2); font-size: var(--fs-md); }
.context-block p, .recommendation p { margin: 0; font-size: var(--fs-md); line-height: 1.7; white-space: pre-line; }
.options-list { display: flex; flex-direction: column; gap: var(--s2); }
.option-card { width: 100%; display: flex; flex-direction: column; align-items: stretch; gap: var(--s2); padding: var(--s3); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2); color: var(--text); font: inherit; text-align: left; cursor: pointer; transition: border-color .14s ease, background .14s ease; }
.option-card:hover { border-color: var(--line-strong); background: var(--surface-3); }
.option-card.selected { border-color: var(--info); background: var(--info-bg); }
.custom-option { border-style: dashed; }
.option-head { display: flex; align-items: center; gap: var(--s2); }
/* 单选点自己画：选中实心、未选空心。它讲的是「选没选中」，不是一枚可点的图标。 */
.pick-mark { width: 11px; height: 11px; flex: none; border: 1.7px solid var(--text-3); border-radius: 50%; }
.pick-mark.on { border-color: var(--info); background: var(--info); box-shadow: inset 0 0 0 2.6px var(--surface); }
.option-name { flex: 1; min-width: 0; font-size: var(--fs-base); font-weight: 600; overflow-wrap: anywhere; }
.option-pros { padding-left: var(--s5); color: var(--text-2); font-size: var(--fs-base); line-height: 1.6; white-space: pre-line; }
.custom-wrap { display: block; padding-left: var(--s5); }
.custom-input { min-height: 72px; resize: vertical; }
.recommendation { background: var(--ok-bg); }
.recommendation h3 { color: var(--ok); }
.decision-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--s3); padding-top: var(--s2); border-top: 1px solid var(--line); }
.error-message { flex: 1; display: flex; align-items: center; gap: var(--s2); color: var(--bad); font-size: var(--fs-sm); }

@media (max-width: 760px) {
  .page-head { flex-direction: column; }
  .head-actions { justify-content: flex-start; }
  .decision-meta { align-items: flex-start; }
  .decision-id { margin-left: 0; }
  .decision-actions { align-items: stretch; flex-direction: column; }
  .decision-actions .btn { width: 100%; }
}
</style>
