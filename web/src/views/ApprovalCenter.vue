<script setup lang="ts">
// 待拍板中心：列所有 answer===null 的 decision（跨项目）；界面点选 → POST /api/decide。
import { ref, reactive, computed } from 'vue'
import { useBoardStore } from '@/stores/board'
import type { PendingItem } from '@/utils/derive'

const store = useBoardStore()
const author = ref('看板')
const picked = reactive<Record<string, string>>({})
const customText = reactive<Record<string, string>>({})
const submitting = reactive<Record<string, boolean>>({})
const errors = reactive<Record<string, string>>({})
const CUSTOM = '__custom__'

const items = computed(() => store.pendingDecisions)
const keyOf = (it: PendingItem) => `${it.projectId}:${it.task.id}:${it.decision.id}`

function incomplete(it: PendingItem): boolean {
  const d = it.decision as any
  if (!d.background || String(d.background).trim().length < 60) return true
  if (!d.recommendReason || String(d.recommendReason).trim().length < 30) return true
  if (!d.optionPros) return true
  for (const opt of d.options || []) if (!(d.optionPros[opt] || '').trim()) return true
  return false
}
function incompleteReason(it: PendingItem): string {
  const d = it.decision as any
  const miss: string[] = []
  if (!d.background || String(d.background).trim().length < 60) miss.push('背景（大白话前因后果）')
  if (!d.recommendReason || String(d.recommendReason).trim().length < 30) miss.push('推荐理由')
  if (!d.optionPros) miss.push('每选项利弊')
  else for (const opt of d.options || []) if (!(d.optionPros[opt] || '').trim()) miss.push(`「${opt}」的利弊`)
  return miss.length ? '缺：' + miss.join('、') : ''
}

function pick(it: PendingItem, opt: string) {
  picked[keyOf(it)] = opt
  delete errors[keyOf(it)]
}
function isCustom(it: PendingItem) {
  return picked[keyOf(it)] === CUSTOM
}
function chosen(it: PendingItem) {
  const p = picked[keyOf(it)]
  if (p === CUSTOM) return (customText[keyOf(it)] || '').trim() || '（自定义答案未填写）'
  return p ?? it.decision.recommended
}

async function submit(it: PendingItem) {
  const k = keyOf(it)
  if (isCustom(it) && !(customText[k] || '').trim()) {
    errors[k] = '请在"其他"输入框里写下你的答案'
    return
  }
  submitting[k] = true
  delete errors[k]
  try {
    await store.decide(it.projectId, it.task.id, it.decision.id, chosen(it), author.value.trim() || '看板')
  } catch (e) {
    errors[k] = e instanceof Error ? e.message : String(e)
  } finally {
    submitting[k] = false
  }
}
</script>

<template>
  <div class="approvals">
    <div class="head">
      <h2>❓ 待拍板中心</h2>
      <span class="pill">{{ items.length }} 条</span>
      <span class="spacer" />
      <label class="author">拍板人
        <input v-model="author" placeholder="署名" />
      </label>
    </div>

    <div v-if="!items.length" class="empty card">
      <div class="big">🎉</div>
      <div>当前没有待拍板事项。</div>
    </div>

    <div class="list">
      <div v-for="it in items" :key="keyOf(it)" class="dcard card">
        <div class="dtop">
          <span class="proj pill">{{ it.projectName }}</span>
          <span class="tid mono">{{ it.task.id }}</span>
          <span class="ttitle">{{ it.task.title }}</span>
          <span v-if="incomplete(it)" class="incomplete" :title="incompleteReason(it)">⚠️ 信息不完整</span>
          <span class="did mono">#{{ it.decision.id }}</span>
        </div>
        <div class="q">{{ it.decision.question }}</div>
        <div v-if="incomplete(it)" class="incomplete-note">
          {{ incompleteReason(it) }}
          <span class="muted">（登记这条待拍板的对话没按 skill §6.2 给全"三件套"——你仍可拍，但看板界面无法展示完整背景/利弊/推荐理由）</span>
        </div>
        <div v-if="(it.decision as any).background" class="bg">
          <div class="bg-label">背景（大白话）</div>
          <div class="bg-body">{{ (it.decision as any).background }}</div>
        </div>
        <div class="opts">
          <button
            v-for="o in it.decision.options"
            :key="o"
            class="opt"
            :class="{ on: chosen(it) === o, rec: it.decision.recommended === o }"
            @click="pick(it, o)"
          >
            <div class="opt-row">
              <span class="tick">{{ chosen(it) === o ? '●' : '○' }}</span>
              <span class="opt-name">{{ o }}</span>
              <span v-if="it.decision.recommended === o" class="rectag">推荐</span>
            </div>
            <div v-if="(it.decision as any).optionPros?.[o]" class="opt-pros">
              {{ (it.decision as any).optionPros[o] }}
            </div>
          </button>
          <button
            class="opt opt-custom"
            :class="{ on: isCustom(it) }"
            @click="pick(it, CUSTOM)"
          >
            <div class="opt-row">
              <span class="tick">{{ isCustom(it) ? '●' : '○' }}</span>
              <span class="opt-name">✍️ 其他（自己写答案）</span>
            </div>
            <div v-if="isCustom(it)" class="custom-wrap" @click.stop>
              <textarea
                v-model="customText[keyOf(it)]"
                class="custom-input"
                placeholder="在这里输入你自己的答案、想法或指令（例如：'先做只做一期的门面拆分，把核心逻辑抽出来后再评估要不要拆更深'）"
                rows="3"
              />
            </div>
          </button>
        </div>
        <div v-if="(it.decision as any).recommendReason" class="reason">
          <span class="reason-label">推荐「{{ it.decision.recommended }}」的原因：</span>
          {{ (it.decision as any).recommendReason }}
        </div>
        <div class="drow">
          <span v-if="errors[keyOf(it)]" class="err">⚠️ {{ errors[keyOf(it)] }}</span>
          <span class="spacer" />
          <button class="btn btn-primary" :disabled="submitting[keyOf(it)]" @click="submit(it)">
            {{ submitting[keyOf(it)] ? '提交中…' : '确认拍板：' + chosen(it) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.head h2 { font-size: 18px; }
.author { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.author input { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); border-radius: var(--radius-sm); padding: 5px 9px; width: 120px; }
.list { display: flex; flex-direction: column; gap: 12px; max-width: 820px; }
.dcard { padding: 14px 16px; display: flex; flex-direction: column; gap: 11px; }
.dtop { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.dtop .tid { color: var(--muted); font-weight: 600; }
.dtop .ttitle { font-weight: 600; }
.dtop .did { color: var(--muted-2); font-size: 12px; margin-left: auto; }
.q { font-size: 14px; line-height: 1.5; }
.opts { display: flex; flex-direction: column; gap: 7px; }
.opts .opts-inner { display: none; }
.opt {
  display: flex; text-align: left;
  background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 9px 12px; cursor: pointer; font-size: 13px;
  transition: border-color 0.15s, background 0.15s;
}
.opt.opt-custom { border-style: dashed; }
.custom-wrap { margin-top: 10px; padding-left: 22px; }
.custom-input { width: 100%; box-sizing: border-box; background: var(--panel); border: 1px solid var(--border); color: var(--text); border-radius: var(--radius-sm); padding: 8px 10px; font: inherit; line-height: 1.55; resize: vertical; min-height: 60px; }
.custom-input:focus { outline: none; border-color: var(--accent); }
.opt { flex-direction: column; align-items: stretch; }
.opt-row { display: flex; align-items: center; gap: 9px; }
.opt-name { font-weight: 500; }
.opt-pros { color: var(--muted); font-size: 12px; line-height: 1.55; margin-top: 6px; padding-left: 22px; white-space: pre-line; }
.opt:hover { border-color: var(--accent); }
.opt.on { border-color: var(--accent); background: var(--accent-soft); }
.opt .tick { color: var(--accent); }
.opt .rectag { margin-left: auto; font-size: 11px; color: var(--ok); border: 1px solid var(--ok); border-radius: 999px; padding: 0 7px; }
.bg { background: var(--panel-2); border-left: 3px solid var(--accent); border-radius: var(--radius-sm); padding: 9px 13px; }
.bg-label { font-size: 11px; color: var(--muted-2); margin-bottom: 4px; letter-spacing: 0.4px; }
.bg-body { font-size: 13px; line-height: 1.65; white-space: pre-line; }
.reason { font-size: 12px; color: var(--muted); line-height: 1.6; padding: 8px 12px; background: rgba(255,255,255,0.02); border-radius: var(--radius-sm); }
.reason-label { color: var(--ok); font-weight: 500; }
.incomplete { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(240, 180, 90, 0.15); color: #f0b45a; border: 1px solid rgba(240, 180, 90, 0.4); }
.incomplete-note { font-size: 12px; color: #f0b45a; padding: 8px 12px; background: rgba(240, 180, 90, 0.08); border-radius: var(--radius-sm); border-left: 3px solid #f0b45a; line-height: 1.55; }
.drow { display: flex; align-items: center; gap: 10px; }
.err { color: var(--danger); font-size: 12px; }
</style>
