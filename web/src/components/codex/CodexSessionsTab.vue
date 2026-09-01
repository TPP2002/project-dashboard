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
    <p v-if="error" class="err">⚠️ {{ error }}</p>
    <div class="layout">
      <aside class="sessions card">
        <button v-for="session in sessions" :key="session.sessionId" class="session" :class="{ on: selectedId === session.sessionId }" @click="selectSession(session.sessionId)">
          <span class="session-top"><b>{{ session.project }}</b><i v-if="session.active" title="最后一条事件在 120 秒内">● 最近还在动</i></span>
          <span class="cwd" :title="session.cwd">{{ cwdTail(session.cwd) }}</span>
          <span class="session-meta"><span>{{ formatAt(session.startedAt) }}</span><span>{{ fmt(session.tokensUsed) }} token</span></span>
          <span class="model">{{ session.model }} · {{ session.reasoningEffort }}</span>
        </button>
        <div v-if="!sessions.length && !loading" class="empty"><span class="big">📭</span><span>最近没有 Codex 会话</span></div>
      </aside>

      <main class="detail card">
        <div v-if="detailLoading && !detail" class="empty">读取会话详情…</div>
        <div v-else-if="!detail" class="empty"><span class="big">🤖</span><span>从左边选择一个会话</span></div>
        <template v-else>
          <header class="detail-head">
            <div><h2>{{ detail.project }}</h2><p><code>{{ detail.sessionId }}</code></p></div>
            <span class="model big-model">{{ detail.model }} · {{ detail.reasoningEffort }}</span>
            <span v-if="detail.active" class="active">● 最近还在动</span>
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
              <textarea v-model="message" maxlength="8000" rows="4" placeholder="给这个 Codex 会话补发一条消息…" aria-label="发给 Codex 会话的消息" />
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
.err { margin: 0 0 10px; color: var(--danger); }
.layout { min-width: 0; display: grid; grid-template-columns: minmax(250px, 330px) minmax(0, 1fr); gap: 14px; align-items: start; }
.sessions { max-height: 760px; overflow-y: auto; box-shadow: none; }
.session { width: 100%; display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; border: 0; border-bottom: 1px solid var(--border-soft); background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.session:hover, .session.on { background: var(--accent-soft); } .session.on { box-shadow: inset 3px 0 var(--accent); }
.session-top, .session-meta, .detail-head, .compose-actions { display: flex; align-items: center; gap: 8px; }
.session-top { justify-content: space-between; } .session-top i, .active { color: var(--ok); font-size: 10px; font-style: normal; }
.cwd { overflow: hidden; color: var(--muted); font: 11px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.session-meta { justify-content: space-between; color: var(--muted-2); font-size: 10px; }
.model { align-self: flex-start; padding: 2px 6px; border: 1px solid var(--border); border-radius: 999px; color: var(--accent); font: 10px var(--mono); }
.detail { min-width: 0; padding: 16px; box-shadow: none; } .detail-head { align-items: flex-start; } .detail-head > div { min-width: 0; flex: 1; }
.detail-head h2 { font-size: 18px; } .detail-head p { margin: 3px 0 0; } .big-model { flex: none; font-size: 11px; }
code { font-family: var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.facts { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 14px; margin: 14px 0; }
.facts div { min-width: 0; } .facts dt { color: var(--muted-2); font-size: 10px; } .facts dd { margin: 2px 0 0; overflow-wrap: anywhere; font-size: 12px; }
.section { min-width: 0; border-top: 1px solid var(--border-soft); margin-top: 14px; padding-top: 12px; }
.section h3 { margin-bottom: 8px; color: var(--muted); font-size: 13px; }
.events { display: flex; flex-direction: column; gap: 7px; max-height: 520px; overflow-y: auto; }
.bubble { max-width: 92%; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-soft); }
.bubble.user { align-self: flex-end; background: var(--accent-soft); } .bubble > span, .tool-event > span { color: var(--muted-2); font-size: 10px; }
.bubble p { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-event { min-width: 0; padding: 7px 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.event-scroll { max-width: 100%; overflow-x: auto; } .event-scroll pre { width: max-content; min-width: 100%; max-height: 260px; margin: 5px 0 0; padding: 7px; background: var(--bg-soft); color: var(--muted); font: 11px/1.5 var(--mono); white-space: pre; }
.folded { color: var(--muted-2); font-size: 10px; } .meta-raw summary { color: var(--muted); cursor: pointer; font-size: 12px; }
.notice { max-height: 240px; margin: 0 0 8px; padding: 8px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-soft); color: var(--muted); white-space: pre-wrap; }
.composer { display: flex; flex-direction: column; gap: 7px; } textarea { width: 100%; resize: vertical; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-soft); color: var(--text); padding: 9px; font: inherit; }
textarea:focus { outline: 1px solid var(--accent); border-color: var(--accent); } .write-warning { color: var(--warn); font-size: 11px; } .compose-actions { justify-content: flex-end; font-size: 11px; }
@media (max-width: 820px) { .layout { grid-template-columns: 1fr; } .sessions { max-height: 340px; } .facts { grid-template-columns: 1fr; } }
</style>
