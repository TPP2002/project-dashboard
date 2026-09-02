<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SessionDetail, SessionSummary } from '@/types/codex'

const props = defineProps<{ refreshKey: number; requestedSessionId: string; jumpNonce: number }>()
const emit = defineEmits<{ openJob: [slug: string] }>()
const sessions = ref<SessionSummary[]>([])
const selectedId = ref('')
const detail = ref<SessionDetail | null>(null)
const message = ref('')
const allowWrite = ref(false)
const error = ref('')
const notice = ref('')
const loading = ref(false)
const detailLoading = ref(false)
const sending = ref(false)
const canSend = computed(() => Boolean(detail.value && message.value.trim() && message.value.length <= 8000))

function fmt(value?: number | null) {
  if (value == null) return '—'
  if (value >= 1e8) return (value / 1e8).toFixed(2) + ' 亿'
  if (value >= 1e4) return (value / 1e4).toFixed(1) + ' 万'
  return value.toLocaleString()
}

function formatAt(value?: string | null) {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function cwdTail(cwd: string) {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-2).join('\\') || cwd || '目录未知'
}

function speaker(role?: string) {
  if (role === 'user') return '你'
  if (role === 'assistant') return 'Codex'
  if (role === 'developer') return '开发约定'
  if (role === 'system') return '系统'
  return role || '消息'
}

async function responseText(response: Response): Promise<string> {
  const text = await response.text()
  if (response.ok) return text
  let reason = text || `请求失败（${response.status}）`
  try { reason = JSON.parse(text).error || reason } catch { /* 非 JSON 错误原样显示。 */ }
  throw new Error(reason)
}

async function loadDetail(sessionId: string) {
  detailLoading.value = true
  try {
    const response = await fetch('/api/codex/session?id=' + encodeURIComponent(sessionId) + '&tail=200')
    const body = JSON.parse(await responseText(response)) as SessionDetail
    if (selectedId.value === sessionId) detail.value = body
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { detailLoading.value = false }
}

async function loadSessions(withDetail = true) {
  if (loading.value) return
  loading.value = true
  try {
    const response = await fetch('/api/codex/sessions?limit=100')
    sessions.value = JSON.parse(await responseText(response)) as SessionSummary[]
    if (!sessions.value.some((session) => session.sessionId === selectedId.value)) {
      selectedId.value = sessions.value[0]?.sessionId || ''
      detail.value = null
    }
    if (withDetail && selectedId.value) await loadDetail(selectedId.value)
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { loading.value = false }
}

async function selectSession(sessionId: string) {
  selectedId.value = sessionId
  notice.value = ''
  await loadDetail(sessionId)
}

async function sendMessage() {
  if (!canSend.value || !detail.value) return
  if (allowWrite.value && !window.confirm('本次续聊将允许 Codex 修改原会话目录中的文件。确认继续吗？')) return
  const sessionId = detail.value.sessionId
  const outgoing = message.value
  sending.value = true
  notice.value = ''
  try {
    const response = await fetch('/api/codex/say-session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId, message: outgoing,
        sandboxMode: allowWrite.value ? 'workspace-write' : 'read-only',
      }),
    })
    notice.value = (await responseText(response)).trim() || 'Codex 已处理，但没有返回文本。'
    message.value = ''
    allowWrite.value = false
    await loadSessions(false)
    await loadDetail(sessionId)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { sending.value = false }
}

watch(() => props.refreshKey, () => loadSessions(true), { immediate: true })
watch(() => [props.requestedSessionId, props.jumpNonce], () => {
  if (props.requestedSessionId) selectSession(props.requestedSessionId)
})
</script>

<template>
  <div>
    <p v-if="error" class="error-note"><span class="badge bad">读取失败</span>{{ error }}</p>
    <div class="layout">
      <aside class="sessions card">
        <button v-for="session in sessions" :key="session.sessionId" class="session row" :class="{ on: selectedId === session.sessionId }" @click="selectSession(session.sessionId)">
          <span v-if="session.active" class="glow-edge" />
          <span class="session-top"><b>{{ session.project }}</b><i v-if="session.active" class="badge ok" title="最后一条事件在 120 秒内">● 最近还在动</i></span>
          <span class="cwd" :title="session.cwd">{{ cwdTail(session.cwd) }}</span>
          <span class="session-meta"><span>{{ formatAt(session.startedAt) }}</span><span>{{ fmt(session.tokensUsed) }} token</span></span>
          <span class="badge info model">{{ session.model }} · {{ session.reasoningEffort }}</span>
        </button>
        <div v-if="!sessions.length && loading" class="sessions-loading" aria-label="正在加载 Codex 会话"><div class="skel wide" /><div class="skel session-skel" /><div class="skel session-skel" /></div>
        <div v-else-if="!sessions.length" class="empty"><span class="big">📭</span><span>最近没有 Codex 会话</span><small>本机产生 Codex 活动后，会按时间列在这里。</small></div>
      </aside>

      <main class="detail card">
        <div v-if="detailLoading && !detail" class="detail-loading" aria-label="正在读取会话详情"><div class="skel medium" /><div class="skel wide" /><div class="skel detail-skel" /></div>
        <div v-else-if="!detail" class="empty"><span class="big">🤖</span><span>从左边选择一个会话</span><small>选中后会显示最近事件、原始信息和续聊入口。</small></div>
        <template v-else>
          <header class="detail-head">
            <div><h2>{{ detail.project }}</h2><p><code>{{ detail.sessionId }}</code></p></div>
            <span class="badge info model big-model">{{ detail.model }} · {{ detail.reasoningEffort }}</span>
            <span v-if="detail.active" class="badge ok active">● 最近还在动</span>
          </header>
          <dl class="facts">
            <div><dt>开始</dt><dd>{{ formatAt(detail.startedAt) }}</dd></div>
            <div><dt>最近活动</dt><dd>{{ formatAt(detail.lastActivityAt) }}</dd></div>
            <div><dt>目录</dt><dd :title="detail.cwd"><code>{{ detail.cwd || '未知' }}</code></dd></div>
            <div><dt>来源</dt><dd>{{ detail.originator || '未知' }} · CLI {{ detail.cliVersion || '未知' }}</dd></div>
            <div><dt>累计</dt><dd>{{ fmt(detail.tokensUsed) }} token · {{ detail.sizeBytes.toLocaleString() }} bytes</dd></div>
          </dl>
          <button v-if="detail.job" class="btn btn-sm" @click="emit('openJob', detail.job.slug)">所属工单：{{ detail.job.title }}</button>

          <section class="section">
            <h3>最近 {{ detail.events.length }} 条事件</h3>
            <div class="events">
              <template v-for="(event, index) in detail.events" :key="String(event.ordinal) + index">
                <div v-if="event.type === 'message'" class="bubble" :class="event.role">
                  <span>{{ speaker(event.role) }} · {{ formatAt(event.timestamp) }}</span><p>{{ event.text || '（空消息）' }}</p>
                </div>
                <div v-else-if="event.type === 'custom_tool_call'" class="tool-event">
                  <span>🔧 {{ event.toolName }} · #{{ event.ordinal }}</span>
                  <div class="event-scroll"><pre>{{ event.command }}</pre></div>
                </div>
                <div v-else class="folded"><code>#{{ event.ordinal ?? '—' }}</code> {{ event.summary || event.type }} · {{ formatAt(event.timestamp) }}</div>
              </template>
            </div>
          </section>

          <details class="section meta-raw">
            <summary>session_meta 原文</summary>
            <div class="event-scroll"><pre>{{ JSON.stringify(detail.sessionMeta, null, 2) }}</pre></div>
          </details>

          <section class="section">
            <h3>续聊这个会话</h3>
            <pre v-if="notice" class="notice">{{ notice }}</pre>
            <form class="composer" @submit.prevent="sendMessage">
              <textarea v-model="message" class="field" maxlength="8000" rows="4" placeholder="给这个 Codex 会话补发一条消息…" aria-label="发给 Codex 会话的消息" />
              <label class="write-warning"><input v-model="allowWrite" type="checkbox"> 允许本次续聊修改文件（默认关闭；开启后发送前还会再次确认）</label>
              <div class="compose-actions"><span class="muted">{{ message.length }} / 8000</span><button class="btn btn-primary" :disabled="!canSend || sending">{{ sending ? '发送中…' : '发给 Codex' }}</button></div>
            </form>
          </section>
        </template>
      </main>
    </div>
  </div>
</template>

<style scoped>
.error-note { display: flex; align-items: center; gap: var(--s2); margin: 0 0 var(--s3); color: var(--bad); font-size: var(--fs-base); }
.layout { min-width: 0; display: grid; grid-template-columns: minmax(250px, 330px) minmax(0, 1fr); gap: var(--s3); align-items: start; }
.sessions { max-height: 760px; padding: 0; overflow-y: auto; background: var(--surface); box-shadow: none; }
.session { width: 100%; align-items: stretch; flex-direction: column; gap: var(--s1); padding: var(--s3); border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.session:hover, .session.on { background: var(--surface-2); }
.session.on { box-shadow: inset 2px 0 var(--info); }
.session-top, .session-meta, .detail-head, .compose-actions { display: flex; align-items: center; gap: var(--s2); }
.session-top { justify-content: space-between; }
.session-top i { font-style: normal; }
.cwd { overflow: hidden; color: var(--text-2); font: var(--fs-xs) var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.session-meta { justify-content: space-between; color: var(--text-3); font-family: var(--mono); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
.model { align-self: flex-start; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.sessions-loading, .detail-loading { display: flex; flex-direction: column; gap: var(--s3); padding: var(--s4); }
.skel.wide { width: 86%; }
.skel.medium { width: 48%; }
.skel.session-skel { height: 68px; }
.skel.detail-skel { height: 112px; }
.empty { display: flex; flex-direction: column; align-items: center; }
.empty small { margin-top: var(--s1); color: var(--text-3); font-size: var(--fs-sm); }
.detail { min-width: 0; padding: var(--s4); background: var(--surface); box-shadow: none; }
.detail-head { align-items: flex-start; flex-wrap: wrap; }
.detail-head > div { min-width: 0; flex: 1; }
.detail-head h2 { font-size: var(--fs-lg); }
.detail-head p { margin: var(--s1) 0 0; }
.big-model { flex: none; }
code { font-family: var(--mono); color: var(--text-2); overflow-wrap: anywhere; }
.facts { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s2) var(--s4); margin: var(--s4) 0; }
.facts div { min-width: 0; }
.facts dt { color: var(--text-3); font-size: var(--fs-xs); }
.facts dd { margin: var(--s1) 0 0; overflow-wrap: anywhere; font-size: var(--fs-base); }
.section { min-width: 0; margin-top: var(--s4); padding-top: var(--s3); border-top: 1px solid var(--line); }
.section h3 { margin-bottom: var(--s2); color: var(--text-2); font-size: var(--fs-md); }
.events { display: flex; flex-direction: column; gap: var(--s2); max-height: 520px; overflow-y: auto; }
.bubble { max-width: 92%; padding: var(--s2) var(--s3); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2); }
.bubble.user { align-self: flex-end; background: var(--info-bg); }
.bubble > span, .tool-event > span { color: var(--text-3); font-size: var(--fs-xs); }
.bubble p { margin: var(--s1) 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-event { min-width: 0; padding: var(--s2); border: 1px solid var(--line); border-radius: var(--r); }
.event-scroll { max-width: 100%; overflow-x: auto; }
.event-scroll pre { width: max-content; min-width: 100%; max-height: 260px; margin: var(--s1) 0 0; padding: var(--s2); background: var(--surface-2); color: var(--text-2); font: var(--fs-xs)/1.5 var(--mono); white-space: pre; }
.folded { color: var(--text-3); font-size: var(--fs-xs); }
.meta-raw summary { color: var(--text-2); cursor: pointer; font-size: var(--fs-sm); }
.notice { max-height: 240px; margin: 0 0 var(--s2); padding: var(--s2); overflow: auto; border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2); color: var(--text-2); white-space: pre-wrap; }
.composer { display: flex; flex-direction: column; gap: var(--s2); }
textarea.field { min-height: 88px; resize: vertical; }
.write-warning { color: var(--warn); font-size: var(--fs-sm); }
.compose-actions { justify-content: flex-end; font-size: var(--fs-xs); }
@media (max-width: 820px) {
  .layout { grid-template-columns: 1fr; }
  .sessions { max-height: 340px; }
  .facts { grid-template-columns: 1fr; }
}
</style>
