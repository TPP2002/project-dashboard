<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { JobDetail, JobSummary } from '@/types/codex'
import { acceptanceLabel, jobGroupKey, selfReportStatusLabel } from './jobPresentation.js'

const props = defineProps<{ refreshKey: number; requestedSlug: string; jumpNonce: number }>()
const emit = defineEmits<{ openSession: [sessionId: string] }>()
const jobs = ref<JobSummary[]>([])
const selectedSlug = ref('')
const detail = ref<JobDetail | null>(null)
const message = ref('')
const error = ref('')
const notice = ref('')
const refreshing = ref(false)
const detailLoading = ref(false)
const sending = ref(false)
const collecting = ref(false)
const redispatching = ref(false)
const editingTask = ref(false)
const taskText = ref('')
const jsonError = ref('')
const completedExpanded = ref(false)
const logOpen = ref(false)
const logLoaded = ref(false)
const logLoading = ref(false)
const logError = ref('')

const canSend = computed(() => Boolean(detail.value && message.value.trim() && message.value.length <= 8000))
const attentionGroups = computed(() => [
  { key: 'stalled', title: '失联了', items: jobs.value.filter((job) => jobGroupKey(job) === 'stalled') },
  { key: 'running', title: '还在干', items: jobs.value.filter((job) => jobGroupKey(job) === 'running') },
  { key: 'waiting', title: '等你收', items: jobs.value.filter((job) => jobGroupKey(job) === 'waiting') },
  { key: 'rejected', title: '没通过', items: jobs.value.filter((job) => jobGroupKey(job) === 'rejected') },
])
const completedJobs = computed(() => jobs.value.filter((job) => jobGroupKey(job) === 'completed'))
const attentionCount = computed(() => attentionGroups.value.reduce((total, group) => total + group.items.length, 0))

function statusOf(job: JobSummary) {
  const group = jobGroupKey(job)
  if (group === 'stalled') return { icon: '🚨', label: '失联了', cls: 'stalled' }
  if (group === 'running') return { icon: '🔄', label: '还在干', cls: 'running' }
  if (group === 'waiting') return { icon: '⏳', label: '等你收', cls: 'waiting' }
  if (group === 'completed') return { icon: '✅', label: '已完成', cls: 'passed' }
  return { icon: '❌', label: '没通过', cls: 'rejected' }
}

function resetLog() {
  logOpen.value = false
  logLoaded.value = false
  logLoading.value = false
  logError.value = ''
  if (detail.value) detail.value.tail = ''
}

function formatAt(value?: string | null) {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

async function responseText(response: Response): Promise<string> {
  const text = await response.text()
  if (response.ok) return text
  let reason = text || `请求失败（${response.status}）`
  try { reason = JSON.parse(text).error || reason } catch { /* 非 JSON 错误原样显示。 */ }
  throw new Error(reason)
}

async function loadDetail(slug: string, includeTail = false): Promise<boolean> {
  detailLoading.value = true
  try {
    const response = await fetch('/api/codex/job?slug=' + encodeURIComponent(slug) + '&tail=' + (includeTail ? '1' : '0'))
    const text = await responseText(response)
    if (selectedSlug.value === slug) {
      const incoming = JSON.parse(text) as JobDetail
      if (!includeTail || !logOpen.value) incoming.tail = ''
      detail.value = incoming
      logLoaded.value = includeTail && logOpen.value
    }
    error.value = ''
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    return false
  } finally { detailLoading.value = false }
}

async function loadJobs(withDetail = true) {
  if (refreshing.value) return
  refreshing.value = true
  try {
    const response = await fetch('/api/codex/jobs')
    jobs.value = JSON.parse(await responseText(response)) as JobSummary[]
    if (!jobs.value.some((job) => job.slug === selectedSlug.value)) {
      selectedSlug.value = jobs.value.find((job) => jobGroupKey(job) !== 'completed')?.slug || ''
      resetLog()
      detail.value = null
    }
    if (withDetail && selectedSlug.value) await loadDetail(selectedSlug.value, logOpen.value)
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { refreshing.value = false }
}

async function selectJob(slug: string) {
  const selected = jobs.value.find((job) => job.slug === slug)
  if (selected && jobGroupKey(selected) === 'completed') completedExpanded.value = true
  resetLog()
  selectedSlug.value = slug
  detail.value = null
  notice.value = ''
  await loadDetail(slug, false)
}

async function onLogToggle(event: Event) {
  const target = event.currentTarget as HTMLDetailsElement
  logOpen.value = target.open
  if (!target.open) {
    logLoaded.value = false
    logError.value = ''
    if (detail.value) detail.value.tail = ''
    return
  }
  if (!detail.value || logLoaded.value || logLoading.value) return
  const slug = detail.value.slug
  logLoading.value = true
  logError.value = ''
  const loaded = await loadDetail(slug, true)
  if (!loaded && selectedSlug.value === slug && logOpen.value) logError.value = error.value
  if (selectedSlug.value === slug) logLoading.value = false
}

async function sendMessage() {
  if (!canSend.value || !detail.value) return
  const slug = detail.value.slug
  const outgoing = message.value
  sending.value = true
  notice.value = ''
  try {
    const response = await fetch('/api/codex/say', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, message: outgoing }),
    })
    const reply = await responseText(response)
    if (detail.value?.slug === slug) {
      const at = new Date().toISOString()
      detail.value.chat.push(
        { at, direction: 'out', text: outgoing },
        { at, direction: 'in', text: reply || '（Codex 未返回文本）' },
      )
    }
    message.value = ''
    await loadJobs(false)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { sending.value = false }
}

async function collectJob() {
  if (!detail.value || detail.value.running || detail.value.collected) return
  const slug = detail.value.slug
  collecting.value = true
  notice.value = ''
  try {
    const response = await fetch('/api/codex/collect', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug }),
    })
    notice.value = (await responseText(response)).trim() || '收单完成'
    await loadJobs(true)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { collecting.value = false }
}

/**
 * 这单现在能不能复派(CODEX-STALLED-JOB-REDISPATCH,2026-09-02 拍板「只对两条铁证放开」)。
 *
 * 以前这里直接看 `detail.running`,而**尸体的 running 永远是 true** —— 监工被强杀/机器重启时
 * 收尾记录写不下去,于是面板左边已经把它标红成「失联了」,右边的复派按钮却一直是灰的,没法处置。
 * 现在改成看服务端给的「确定已死」:只有两条铁证(进程号没了 / 超时没收尾)才置它。
 * 软判据「很久没动静」照旧标红给人看,但**不放开按钮** —— 那条对正在跑长活的单同样成立,
 * 一旦误判就是对着还活着的单重复派出一单 Codex,直接烧额度。
 */
const canRedispatch = computed(() => {
  if (!detail.value || redispatching.value) return false
  if (!detail.value.running) return true
  return detail.value.confirmedDead === true
})

/** 按钮灰着的时候告诉人为什么灰 —— 只给一个灰按钮,等于没解释。 */
const redispatchBlockedWhy = computed(() => {
  if (!detail.value || canRedispatch.value || redispatching.value) return ''
  if (detail.value.liveness === 'stalled') {
    return `这单看着像失联，但依据只是「${detail.value.stalledReason ?? '很久没有新动静'}」——`
      + '也可能它正在跑一个很慢的活。硬派会有重复派单烧额度的风险，'
      + '所以先确认它确实停了（进程没了，或超过了这单允许的时长），按钮才会亮。'
  }
  return '这单还在跑，跑完或确认它已经停了才能复派。'
})

async function dispatchAgain(modifiedText?: string) {
  if (!canRedispatch.value || !detail.value) return
  const dead = detail.value.confirmedDead === true
  const confirmText = dead
    ? `这单已确认停了（${detail.value.stalledReason ?? '进程不在了'}）。复派会覆盖上一次的运行产物，并真的再派出一单 Codex（要花额度）。确认继续吗？`
    : '复派会覆盖上一次的运行产物。确认继续吗？'
  if (!window.confirm(confirmText)) return
  const slug = detail.value.slug
  redispatching.value = true
  try {
    const body: { slug: string; taskText?: string } = { slug }
    if (modifiedText !== undefined) body.taskText = modifiedText
    const response = await fetch('/api/codex/dispatch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const result = JSON.parse(await responseText(response))
    notice.value = `已复派 ${result.slug}`
    editingTask.value = false
    await loadJobs(false)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { redispatching.value = false }
}

async function openTaskEditor() {
  if (!canRedispatch.value || !detail.value) return
  jsonError.value = ''
  try {
    const response = await fetch('/api/codex/task?slug=' + encodeURIComponent(detail.value.slug))
    const body = JSON.parse(await responseText(response))
    taskText.value = body.text
    editingTask.value = true
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
}

async function submitEditedTask() {
  try {
    const parsed = JSON.parse(taskText.value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层必须是 JSON 对象')
    jsonError.value = ''
  }
  catch (cause) {
    jsonError.value = 'JSON 不合法：' + (cause instanceof Error ? cause.message : String(cause))
    return
  }
  await dispatchAgain(taskText.value)
}

watch(() => props.refreshKey, () => loadJobs(true), { immediate: true })
watch(() => [props.requestedSlug, props.jumpNonce], () => {
  if (props.requestedSlug) selectJob(props.requestedSlug)
})
</script>

<template>
  <div>
    <p v-if="error" class="err">⚠️ {{ error }}</p>
    <div class="layout">
      <aside class="jobs card">
        <template v-if="jobs.length">
          <div v-if="attentionCount === 0" class="attention-empty">目前没有需要你处理的工单</div>
          <section v-for="group in attentionGroups" v-show="group.items.length" :key="group.key" class="job-group">
            <h3>{{ group.title }}</h3>
            <button v-for="job in group.items" :key="job.slug" class="job" :class="{ on: selectedSlug === job.slug }" @click="selectJob(job.slug)">
              <span class="job-title">{{ job.title }}</span>
              <span class="job-meta"><code>{{ job.slug }}</code><span class="badge" :class="statusOf(job).cls">{{ statusOf(job).icon }} {{ statusOf(job).label }}</span></span>
              <span v-if="job.liveness === 'stalled' && job.stalledReason" class="job-stalled">{{ job.stalledReason }}</span>
            </button>
          </section>
          <section v-if="completedJobs.length" class="job-group completed-group">
            <button class="completed-toggle" :aria-expanded="completedExpanded" @click="completedExpanded = !completedExpanded">
              ✅ 已完成 {{ completedJobs.length }} 单{{ completedExpanded ? '(点一下收起)' : '(点开看)' }}
            </button>
            <div v-if="completedExpanded">
              <button v-for="job in completedJobs" :key="job.slug" class="job" :class="{ on: selectedSlug === job.slug }" @click="selectJob(job.slug)">
                <span class="job-title">{{ job.title }}</span>
                <span class="job-meta"><code>{{ job.slug }}</code><span class="badge passed">✅ 已完成</span></span>
              </button>
            </div>
          </section>
        </template>
        <div v-if="!jobs.length && !refreshing" class="empty"><span class="big">📭</span><span>还没有 Codex 工单</span></div>
      </aside>

      <main class="detail card">
        <div v-if="detailLoading && !detail" class="empty">读取工单详情…</div>
        <div v-else-if="!detail" class="empty"><span class="big">🤖</span><span>从左边选择一张工单</span></div>
        <template v-else>
          <header class="detail-head">
            <div><h2>{{ detail.title }}</h2><p><code>{{ detail.slug }}</code><span v-if="detail.taskId"> · {{ detail.taskId }}</span> · {{ formatAt(detail.dispatchedAt) }}</p></div>
            <span class="badge" :class="statusOf(detail).cls">{{ statusOf(detail).icon }} {{ statusOf(detail).label }}</span>
          </header>
          <div class="actions">
            <button v-if="detail.threadId" class="btn btn-sm" @click="emit('openSession', detail.threadId)">对应会话</button>
            <button v-if="!detail.running && !detail.collected" class="btn btn-primary btn-sm" :disabled="collecting" @click="collectJob">{{ collecting ? '收单中…' : '收单' }}</button>
            <button class="btn btn-sm" :disabled="!canRedispatch" @click="dispatchAgain()">{{ redispatching ? '复派中…' : '复派' }}</button>
            <button class="btn btn-sm" :disabled="!canRedispatch" @click="openTaskEditor">改了再派</button>
          </div>
          <p v-if="redispatchBlockedWhy" class="why-blocked">{{ redispatchBlockedWhy }}</p>
          <pre v-if="notice" class="notice">{{ notice }}</pre>

          <section class="section purpose">
            <h3>这单要做什么</h3>
            <p>{{ detail.goal || detail.title }}</p>
          </section>
          <section v-if="detail.plainSummary" class="section plain-summary">
            <h3>这单结果</h3>
            <p>{{ detail.plainSummary }}</p>
          </section>
          <section class="section">
            <h3>这单检查了什么</h3>
            <div v-if="detail.acceptance.length" class="acceptance">
              <p v-for="item in detail.acceptance" :key="item.id" class="check-result">
                <span aria-hidden="true">{{ item.passed ? '✅' : '❌' }}</span>
                <span>{{ acceptanceLabel(item) }}</span>
              </p>
            </div>
            <p v-else class="muted">还没有检查结果</p>
            <details v-if="detail.acceptance.length" class="technical-details">
              <summary>检查编号和退出码(给工程师看的)</summary>
              <ul>
                <li v-for="item in detail.acceptance" :key="'technical-' + item.id">
                  <code>{{ item.id }}</code>
                  <span v-if="item.kind"> · {{ item.kind }}</span>
                  <span v-if="item.required === false"> · 可选</span>
                  <span v-if="item.exitCode != null"> · 退出码 {{ item.exitCode }}</span>
                </li>
              </ul>
            </details>
          </section>
          <section class="section self-report">
            <h3>Codex 自己怎么判断</h3>
            <p class="self-status">{{ selfReportStatusLabel(detail.selfReport?.status) }}</p>
            <details v-if="detail.selfReport?.summary" class="technical-details">
              <summary>Codex 的技术说明(看不懂可以跳过)</summary>
              <p class="summary">{{ detail.selfReport.summary }}</p>
            </details>
          </section>
          <details class="section log-details" :open="logOpen" @toggle="onLogToggle">
            <summary>运行记录(出问题时给工程师看的)</summary>
            <p v-if="logLoading" class="muted log-message">正在读取运行记录…</p>
            <p v-else-if="logError" class="err log-message">{{ logError }}</p>
            <div v-else-if="logOpen && logLoaded" class="log-scroll"><pre class="log">{{ detail.tail || '暂无运行记录' }}</pre></div>
          </details>
          <section class="section">
            <h3>续聊</h3>
            <div class="chat">
              <div v-for="(item, index) in detail.chat" :key="(item.at || '') + index" class="bubble" :class="item.direction">
                <span>{{ item.direction === 'out' ? '你' : 'Codex' }} · {{ formatAt(item.at) }}</span><p>{{ item.text }}</p>
              </div>
              <p v-if="!detail.chat.length" class="muted">还没有补发消息</p>
            </div>
            <form class="composer" @submit.prevent="sendMessage">
              <textarea v-model="message" maxlength="8000" rows="4" placeholder="给这张工单补发一条消息…" aria-label="发给 Codex 的消息" />
              <div class="compose-actions"><span class="muted">{{ message.length }} / 8000</span><button class="btn btn-primary" :disabled="!canSend || sending">{{ sending ? '发送中…' : '发给 Codex' }}</button></div>
            </form>
          </section>
        </template>
      </main>
    </div>

    <div v-if="editingTask" class="modal" role="dialog" aria-modal="true" aria-label="修改工单 JSON">
      <div class="editor card">
        <h2>修改工单 JSON 后复派</h2>
        <p>提交会保存这份 JSON，并覆盖上一次运行产物。</p>
        <textarea v-model="taskText" rows="18" spellcheck="false" />
        <p v-if="jsonError" class="err">{{ jsonError }}</p>
        <div class="compose-actions"><button class="btn" @click="editingTask = false">取消</button><button class="btn btn-primary" :disabled="redispatching" @click="submitEditedTask">校验并复派</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.err { margin: 0 0 10px; color: var(--danger); }
.layout { min-width: 0; display: grid; grid-template-columns: minmax(230px, 300px) minmax(0, 1fr); gap: 14px; align-items: start; }
.jobs { overflow: hidden; box-shadow: none; }
.job-group + .job-group { border-top: 1px solid var(--border-soft); }
.job-group > h3 { margin: 0; padding: 9px 12px 5px; color: var(--muted); font-size: 12px; }
.attention-empty { padding: 12px; color: var(--ok); font-size: 12px; }
.completed-toggle { width: 100%; padding: 11px 12px; border: 0; background: transparent; color: var(--text); text-align: left; cursor: pointer; font-weight: 600; }
.completed-toggle:hover { background: var(--accent-soft); }
.job { width: 100%; display: flex; flex-direction: column; gap: 7px; padding: 11px 12px; border: 0; border-bottom: 1px solid var(--border-soft); background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.job:hover, .job.on { background: var(--accent-soft); } .job.on { box-shadow: inset 3px 0 var(--accent); }
.job-title { font-weight: 600; line-height: 1.35; } .job-meta, .compose-actions, .detail-head, .actions { display: flex; align-items: center; gap: 8px; }
.job-meta { justify-content: space-between; color: var(--muted); font-size: 11px; }
code { font-family: var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.job-stalled { display: block; margin-top: 3px; color: var(--danger); font-size: 11px; line-height: 1.4; }
.badge.stalled { color: var(--danger); font-weight: 600; }
.badge.running { color: var(--accent); } .badge.waiting { color: var(--warn); } .badge.passed { color: var(--ok); } .badge.rejected { color: var(--danger); }
.detail { min-width: 0; padding: 16px; box-shadow: none; } .detail-head { align-items: flex-start; } .detail-head > div { min-width: 0; flex: 1; }
.detail-head h2 { font-size: 18px; overflow-wrap: anywhere; } .detail-head p { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
.actions { flex-wrap: wrap; margin-top: 10px; }
.notice { margin: 12px 0 0; padding: 9px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-soft); color: var(--muted); white-space: pre-wrap; }
.why-blocked { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.section { min-width: 0; border-top: 1px solid var(--border-soft); margin-top: 14px; padding-top: 12px; }
.section h3 { margin-bottom: 8px; font-size: 13px; color: var(--muted); }
.purpose p { margin: 0; font-size: 15px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.plain-summary { padding: 13px; border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: var(--radius-sm); background: var(--accent-soft); }
.plain-summary h3 { color: var(--text); }
.plain-summary p { margin: 0; font-size: 17px; font-weight: 600; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.acceptance { display: flex; flex-direction: column; gap: 7px; }
.check-result { display: flex; align-items: flex-start; gap: 7px; margin: 0; line-height: 1.45; }
.self-status { margin: 0; font-size: 16px; font-weight: 600; }
.technical-details { margin-top: 9px; color: var(--muted); font-size: 12px; }
.technical-details > summary, .log-details > summary { cursor: pointer; }
.technical-details ul { margin: 8px 0 0; padding-left: 20px; }
.technical-details .summary { margin-top: 8px; padding: 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-soft); }
.summary { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.log-details > summary { color: var(--muted); font-size: 13px; font-weight: 600; }
.log-message { margin: 9px 0 0; }
.log-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-soft); }
.log { width: max-content; min-width: 100%; max-height: 330px; margin: 0; padding: 10px; overflow-y: auto; color: var(--muted); font: 11px/1.55 var(--mono); white-space: pre; }
.chat { display: flex; flex-direction: column; gap: 8px; max-height: 360px; overflow: auto; padding: 2px; }
.bubble { max-width: 88%; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-soft); }
.bubble.out { align-self: flex-end; background: var(--accent-soft); } .bubble > span { color: var(--muted-2); font-size: 10px; } .bubble p { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.composer { display: flex; flex-direction: column; gap: 7px; margin-top: 10px; } textarea { width: 100%; resize: vertical; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-soft); color: var(--text); padding: 9px; font: inherit; }
textarea:focus { outline: 1px solid var(--accent); border-color: var(--accent); } .compose-actions { justify-content: flex-end; font-size: 11px; }
.modal { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 20px; background: rgba(0, 0, 0, 0.55); }
.editor { width: min(780px, 100%); padding: 16px; } .editor h2 { font-size: 16px; } .editor p { color: var(--muted); font-size: 12px; } .editor textarea { font: 12px/1.5 var(--mono); }
@media (max-width: 820px) { .layout { grid-template-columns: 1fr; } .jobs { max-height: 300px; overflow-y: auto; } }
</style>
