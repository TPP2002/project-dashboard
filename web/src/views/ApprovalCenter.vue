<script setup lang="ts">
// 待拍板中心：列所有 answer===null 的 decision（跨项目）；界面点选 → POST /api/decide。
import { ref, reactive, computed } from 'vue'
import { useBoardStore } from '@/stores/board'
import type { PendingItem } from '@/utils/derive'

const store = useBoardStore()
const author = ref('看板')
const picked = reactive<Record<string, string>>({})
const submitting = reactive<Record<string, boolean>>({})
const errors = reactive<Record<string, string>>({})

const items = computed(() => store.pendingDecisions)
const keyOf = (it: PendingItem) => `${it.projectId}:${it.task.id}:${it.decision.id}`

function pick(it: PendingItem, opt: string) {
  picked[keyOf(it)] = opt
  delete errors[keyOf(it)]
}
function chosen(it: PendingItem) {
  return picked[keyOf(it)] ?? it.decision.recommended
}

async function submit(it: PendingItem) {
  const k = keyOf(it)
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
          <span class="did mono">#{{ it.decision.id }}</span>
        </div>
        <div class="q">{{ it.decision.question }}</div>
        <div class="opts">
          <button
            v-for="o in it.decision.options"
            :key="o"
            class="opt"
            :class="{ on: chosen(it) === o, rec: it.decision.recommended === o }"
            @click="pick(it, o)"
          >
            <span class="tick">{{ chosen(it) === o ? '●' : '○' }}</span>
            {{ o }}
            <span v-if="it.decision.recommended === o" class="rectag">推荐</span>
          </button>
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
.opt {
  display: flex; align-items: center; gap: 9px; text-align: left;
  background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 9px 12px; cursor: pointer; font-size: 13px;
  transition: border-color 0.15s, background 0.15s;
}
.opt:hover { border-color: var(--accent); }
.opt.on { border-color: var(--accent); background: var(--accent-soft); }
.opt .tick { color: var(--accent); }
.opt .rectag { margin-left: auto; font-size: 11px; color: var(--ok); border: 1px solid var(--ok); border-radius: 999px; padding: 0 7px; }
.drow { display: flex; align-items: center; gap: 10px; }
.err { color: var(--danger); font-size: 12px; }
</style>
