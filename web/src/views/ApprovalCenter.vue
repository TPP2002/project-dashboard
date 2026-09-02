<script setup lang="ts">
// 待拍板中心：列所有 answer===null 的 decision（跨项目）；界面点选 → POST /api/decide。
import { ref, reactive, computed } from 'vue'
import { useBoardStore } from '@/stores/board'
import ScopeToggle from '@/components/ScopeToggle.vue'
import type { PendingItem } from '@/utils/derive'

const store = useBoardStore()
const author = ref('看板')
const picked = reactive<Record<string, string>>({})
const customText = reactive<Record<string, string>>({})
const submitting = reactive<Record<string, boolean>>({})
const errors = reactive<Record<string, string>>({})
const CUSTOM = '__custom__'

// 默认只看当前项目（跟随顶栏项目切换）；「全部项目」开关可跨项目聚合。
const items = computed(() =>
  store.pendingDecisions.filter((item) => store.centerScopeAll || item.projectId === store.currentProjectId),
)
// 作用域为「当前项目」时，其他项目还剩多少待拍板（提示用户别漏了）。
const otherCount = computed(() => store.pendingDecisions.length - items.value.length)
const keyOf = (item: PendingItem) => `${item.projectId}:${item.task.id}:${item.decision.id}`

function incomplete(item: PendingItem): boolean {
  const decision = item.decision as any
  if (!decision.background || String(decision.background).trim().length < 60) return true
  if (!decision.recommendReason || String(decision.recommendReason).trim().length < 30) return true
  if (!decision.optionPros) return true
  for (const option of decision.options || []) if (!(decision.optionPros[option] || '').trim()) return true
  return false
}
function incompleteReason(item: PendingItem): string {
  const decision = item.decision as any
  const missing: string[] = []
  if (!decision.background || String(decision.background).trim().length < 60) missing.push('背景（大白话前因后果）')
  if (!decision.recommendReason || String(decision.recommendReason).trim().length < 30) missing.push('推荐理由')
  if (!decision.optionPros) missing.push('每选项利弊')
  else for (const option of decision.options || []) if (!(decision.optionPros[option] || '').trim()) missing.push(`「${option}」的利弊`)
  return missing.length ? '缺：' + missing.join('、') : ''
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
        <h1>❓ 待拍板</h1>
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

    <div v-if="store.loading" class="loading-list" aria-label="正在加载待拍板事项">
      <div v-for="index in 2" :key="index" class="card loading-card">
        <div class="skel medium" />
        <div class="skel wide" />
        <div class="skel option-skel" />
        <div class="skel option-skel" />
      </div>
    </div>

    <div v-else-if="!items.length" class="empty card">
      <span class="ic">🎉</span>
      {{ store.centerScopeAll ? '所有项目都没有待拍板事项。' : '当前项目没有待拍板事项。' }}<br>
      <span class="empty-help">任务登记新的未答决策后，会带着选项和推荐自动出现在这里。</span>
    </div>

    <div v-else class="decision-list stagger-list">
      <article v-for="item in items" :key="keyOf(item)" class="decision-card card">
        <header class="decision-meta">
          <span class="badge n">{{ item.projectName }}</span>
          <span class="task-id mono">{{ item.task.id }}</span>
          <span class="task-title">{{ item.task.title }}</span>
          <span v-if="incomplete(item)" class="badge warn" :title="incompleteReason(item)">信息不完整</span>
          <span class="decision-id mono">#{{ item.decision.id }}</span>
        </header>

        <h2 class="question">{{ item.decision.question }}</h2>

        <div v-if="incomplete(item)" class="incomplete-note">
          <span class="badge warn">登记缺项</span>
          <span>
            {{ incompleteReason(item) }}
            （登记这条待拍板的对话没按 skill §6.2 给全“三件套”——你仍可拍，但看板界面无法展示完整背景/利弊/推荐理由）
          </span>
        </div>

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
                <span class="pick-mark" aria-hidden="true">{{ chosen(item) === option ? '●' : '○' }}</span>
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
                <span class="pick-mark" aria-hidden="true">{{ isCustom(item) ? '●' : '○' }}</span>
                <span class="option-name">✍️ 其他（自己写答案）</span>
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
.page { width: 100%; max-width: 980px; min-width: 0; display: flex; flex-direction: column; gap: var(--s4); overflow-x: hidden; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s5); }
.page-head p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-md); }
.head-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--s2); }
.author { display: flex; align-items: center; gap: var(--s2); color: var(--text-2); font-size: var(--fs-sm); white-space: nowrap; }
.author .field { width: 124px; }
.other-note { display: flex; align-items: center; gap: var(--s2); background: var(--surface); }
.other-note > span:nth-of-type(2) { flex: 1; }
.other-note b { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.note-glow { position: absolute; inset: 0 0 auto; }
.loading-list, .decision-list { display: flex; flex-direction: column; gap: var(--s3); }
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
.pick-mark { flex: none; color: var(--info); }
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
