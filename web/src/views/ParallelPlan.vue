<script setup lang="ts">
/**
 * 可并行任务清单 —— 回答一个问题:**现在能同时派几张卡出去、分别是哪几张。**
 *
 * 负责人不看代码,不可能知道哪张卡碰哪些文件。以前每轮派活都要新开一个对话
 * 重新梳理一遍(他原话:「这一轮派发结束后,又得新开对话,重新梳理」)。
 * 这一页把那件事变成纯规则计算:零额度、卡片一变就重算。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useBoardStore } from '@/stores/board'

interface ReadyCard {
  id: string
  plainTitle: string | null
  title: string
  modelHint: string | null
  groupSize: number
  guessedGroup: boolean
}
interface QueuedCard {
  id: string
  plainTitle: string | null
  title: string
  reason: 'occupied' | 'same-area'
  blockerId: string
  guessed?: boolean
}
interface BlockedCard {
  id: string
  plainTitle: string | null
  title: string
  waitingFor: { id: string; title: string }[]
}
interface RunningCard { id: string; plainTitle: string | null; title: string; branches: string[] }
interface Plan {
  ready: ReadyCard[]
  waitingSameArea: QueuedCard[]
  blocked: BlockedCard[]
  running: RunningCard[]
  stats: { readyCount: number; sameAreaCount: number; blockedCount: number; runningCount: number; withScope: number; candidates: number }
}

const store = useBoardStore()
const plan = ref<Plan | null>(null)
const loading = ref(false)
const error = ref('')
const copied = ref<string | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | null = null
let reqSeq = 0

async function load() {
  const pid = store.currentProjectId
  if (!pid) return
  const seq = ++reqSeq
  loading.value = true
  try {
    const res = await fetch(`/api/parallel?project=${encodeURIComponent(pid)}`)
    const body = await res.json()
    if (seq !== reqSeq) return
    if (!body.ok) throw new Error(body.error || '读取失败')
    plan.value = body
    error.value = ''
  } catch (e) {
    if (seq !== reqSeq) return
    plan.value = null
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (seq === reqSeq) loading.value = false
  }
}

onMounted(load)
watch(() => store.currentProjectId, () => void load())
onUnmounted(() => { if (copyTimer) clearTimeout(copyTimer) })

/** 复制卡号:派活时直接粘给新对话。剪贴板可能被浏览器拒绝,失败要如实说。 */
async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
    copied.value = id
  } catch {
    copied.value = '__failed__'
  }
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copied.value = null }, 1800)
}

async function copyAll() {
  const ids = (plan.value?.ready ?? []).map((card) => card.id).join('\n')
  if (!ids) return
  try {
    await navigator.clipboard.writeText(ids)
    copied.value = '__all__'
  } catch {
    copied.value = '__failed__'
  }
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copied.value = null }, 1800)
}

/** 有多少张卡填了文件范围——没填就只能按卡号猜,要如实告诉负责人。 */
const scopeCoverage = computed(() => {
  const s = plan.value?.stats
  if (!s || !s.candidates) return null
  return { filled: s.withScope, total: s.candidates, allGuessed: s.withScope === 0 }
})

function shownTitle(card: { plainTitle: string | null; title: string }) {
  return card.plainTitle || card.title || '(这张卡还没写说明)'
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>🚦 现在能同时派几张</h1>
        <p class="page-subtitle">
          直接复制卡号发给新对话就能开工。这一页是算出来的,不花额度,卡片状态一变就重算。
        </p>
      </div>
      <button class="btn btn-sm" type="button" :disabled="loading" @click="load">
        {{ loading ? '算着…' : '重新算' }}
      </button>
    </header>

    <div v-if="error" class="card error-state">
      <span class="badge bad">读取失败</span>
      <span>{{ error }}</span>
      <button class="btn btn-sm" type="button" @click="load">重试</button>
    </div>

    <div v-else-if="loading && !plan" class="card loading-state">
      <div class="skel wide" /><div class="skel medium" /><div class="skel wide" />
    </div>

    <template v-if="plan">
      <div v-if="scopeCoverage?.allGuessed" class="card warn-notice">
        <span class="badge warn">分组靠猜</span>
        <span>
          这些卡都还没写明会改哪些文件,所以"会不会撞车"是按卡号开头猜的——同一个开头算作一组。
          猜得偏保守:同组里只推一张。等卡片补上文件范围后,这里会精确很多。
        </span>
      </div>

      <section class="card ready-shell">
        <header class="sec-head">
          <div>
            <h2>可以直接派 <span class="count">{{ plan.stats.readyCount }}</span></h2>
            <p>互相不碰同一批文件,可以同时开工。</p>
          </div>
          <button class="btn" type="button" :disabled="!plan.ready.length" @click="copyAll">
            {{ copied === '__all__' ? '已复制全部' : '复制全部卡号' }}
          </button>
        </header>

        <div v-if="!plan.ready.length" class="empty">
          <span class="ic">🈳</span>
          现在没有可以直接派的卡<br>
          <span class="empty-help">要么都有人在做,要么都在等上游——看下面两栏。</span>
        </div>

        <ul v-else class="card-list">
          <li v-for="card in plan.ready" :key="card.id" class="ready-row">
            <div class="row-main">
              <p class="row-title">{{ shownTitle(card) }}</p>
              <div class="row-meta">
                <code class="id">{{ card.id }}</code>
                <span v-if="card.modelHint" class="badge n">🤖 {{ card.modelHint }}</span>
                <span v-if="card.groupSize > 1" class="badge warn">同区还有 {{ card.groupSize - 1 }} 张在等</span>
              </div>
            </div>
            <button class="btn btn-sm" type="button" @click="copyId(card.id)">
              {{ copied === card.id ? '已复制' : '复制卡号' }}
            </button>
          </li>
        </ul>
        <p v-if="copied === '__failed__'" class="copy-failed">
          浏览器拒绝了复制,手动选中卡号复制即可。
        </p>
      </section>

      <section v-if="plan.waitingSameArea.length" class="card">
        <header class="sec-head">
          <div>
            <h2>同一块地方,要排队 <span class="count">{{ plan.waitingSameArea.length }}</span></h2>
            <p>跟别的卡改同一批文件,同时派会互相覆盖。等前面那张完工再派。</p>
          </div>
        </header>
        <ul class="card-list">
          <li v-for="card in plan.waitingSameArea" :key="card.id" class="queued-row">
            <div class="row-main">
              <p class="row-title">{{ shownTitle(card) }}</p>
              <div class="row-meta">
                <code class="id">{{ card.id }}</code>
                <span class="wait-note">
                  {{ card.reason === 'occupied' ? '这块地方正被' : '等同组的' }}
                  <code class="id">{{ card.blockerId }}</code>
                  {{ card.reason === 'occupied' ? '占着' : '' }}
                </span>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="plan.blocked.length" class="card">
        <header class="sec-head">
          <div>
            <h2>在等上游 <span class="count">{{ plan.blocked.length }}</span></h2>
            <p>前置的事还没做完,现在开工也白干。</p>
          </div>
        </header>
        <ul class="card-list">
          <li v-for="card in plan.blocked" :key="card.id" class="queued-row">
            <div class="row-main">
              <p class="row-title">{{ shownTitle(card) }}</p>
              <div class="row-meta">
                <code class="id">{{ card.id }}</code>
                <span class="wait-note">
                  等 <code v-for="dep in card.waitingFor" :key="dep.id" class="id">{{ dep.id }}</code>
                </span>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="plan.running.length" class="card">
        <header class="sec-head">
          <div>
            <h2>已经有人在做 <span class="count">{{ plan.running.length }}</span></h2>
            <p>别重复派。</p>
          </div>
        </header>
        <ul class="card-list">
          <li v-for="card in plan.running" :key="card.id" class="queued-row">
            <div class="row-main">
              <p class="row-title">{{ shownTitle(card) }}</p>
              <div class="row-meta">
                <code class="id">{{ card.id }}</code>
                <span v-if="card.branches.length" class="wait-note">在 {{ card.branches[0] }} 上</span>
              </div>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: var(--s4); }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s4); }
.page-subtitle { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-md); }
.error-state, .loading-state { display: flex; flex-direction: column; gap: var(--s2); padding: var(--s4); }
.error-state { flex-direction: row; align-items: center; flex-wrap: wrap; }
.warn-notice { display: flex; align-items: flex-start; gap: var(--s3); padding: var(--s3) var(--s4); color: var(--text-2); font-size: var(--fs-base); line-height: 1.6; }
.sec-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s4); padding: var(--s4); }
.sec-head h2 { font-size: var(--fs-lg); }
.sec-head p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-sm); }
.count { font-family: var(--mono); color: var(--text-2); font-size: var(--fs-md); }
.card-list { display: flex; flex-direction: column; gap: var(--s2); margin: 0; padding: 0 var(--s4) var(--s4); list-style: none; }
.ready-row, .queued-row { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2); padding: var(--s3); }
.ready-row { border-left: 2px solid var(--ok); }
.queued-row { opacity: .82; }
.row-main { min-width: 0; flex: 1; }
.row-title { margin: 0; font-size: var(--fs-base); overflow-wrap: anywhere; }
.row-meta { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; margin-top: var(--s1); }
.id { font-family: var(--mono); font-size: var(--fs-xs); color: var(--text-3); background: none; border: 0; padding: 0; }
.wait-note { color: var(--text-3); font-size: var(--fs-sm); }
.empty { padding: var(--s6) var(--s4); text-align: center; color: var(--text-3); }
.empty .ic { display: block; margin-bottom: var(--s2); font-size: 26px; opacity: .5; }
.empty-help { font-size: var(--fs-sm); }
.copy-failed { margin: 0 var(--s4) var(--s4); color: var(--warn); font-size: var(--fs-sm); }
@media (max-width: 700px) {
  .page-head, .sec-head { flex-direction: column; align-items: stretch; }
  .ready-row { flex-direction: column; align-items: stretch; gap: var(--s2); }
}
</style>
