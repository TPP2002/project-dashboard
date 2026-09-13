<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { TicketDetail, TicketRelations } from '@/api/sched'
import { duration, stamp, stateLabels, ticketLabel, tone } from './format'
const props = defineProps<{ ticketId: string; ticket: TicketDetail | null; related: TicketRelations | null; loading: boolean; error: string }>()
const emit = defineEmits<{ close: []; retry: []; open: [id: string] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const attempt = computed(() => props.ticket?.attempts.find(item => item.attemptId === props.ticket?.currentAttemptId))
const timings = [{ key: 'queuedMs', label: '排队' }, { key: 'runningMs', label: '执行' }, { key: 'pausedMs', label: '暂停' }, { key: 'slowMs', label: '低速' }] as const
const eventLabels: Record<string, string> = { submitted: '挂号', granted: '授予许可', 'dispatch-intent': '记录派发意图', dispatched: '已投递', started: '开跑',
  paused: '暂停', resumed: '恢复', slowed: '低速继续', restored: '恢复正常优先级', finished: '执行结束', requeued: '重新排队',
  'cancel-requested': '撤单处理中', 'marked-unsatisfiable': '无法满足', 'cleared-unsatisfiable': '恢复排队',
  'command-received': '收到人工指令', 'command-executed': '人工指令已执行', 'command-rejected': '人工指令已拒绝',
  'reservation-changed': '预留变更', 'owner-hold-changed': '全部暂停状态变更' }
onMounted(() => dialog.value?.showModal())
onUnmounted(() => dialog.value?.close())
function backdrop(event: MouseEvent) { if (event.target === dialog.value) emit('close') }
function openParent() { const id = props.ticket?.request.parentTicketId; if (id) emit('open', id) }
</script>

<template>
  <dialog ref="dialog" class="sched-drawer" aria-labelledby="sched-drawer-title" @cancel.prevent="emit('close')" @click="backdrop">
    <div class="drawer-content">
      <header class="drawer-heading"><h2 id="sched-drawer-title">单子详情</h2><button class="sched-btn small" autofocus @click="emit('close')">关闭</button></header>
      <div class="sched-id">{{ ticketId }}</div>
      <p v-if="loading" role="status">正在读取单子快照…</p>
      <p v-else-if="error" class="bad" role="alert">{{ error }} <button class="sched-btn small" @click="emit('retry')">重新读取</button></p>
      <template v-else-if="ticket">
        <p><span class="sched-tag info">{{ ticket.request.project }}</span> <span class="sched-tag" :class="tone(ticket.state)">{{ ticketLabel(ticket) }}</span></p>
        <p class="sched-note">这是打开时的快照 · 更新于 {{ stamp(ticket.updatedAt) }}</p>
        <p v-if="ticket.request.parentTicketId">子单（属于 <button class="sched-link" @click="openParent">{{ ticket.request.parentTicketId }}</button>）</p>
        <section><h3>基本信息</h3><dl class="detail-kv">
          <dt>活</dt><dd>{{ ticket.request.title }}</dd><dt>派单方</dt><dd>{{ ticket.request.submitter }}</dd>
          <dt>工位 / 分支</dt><dd>暂无</dd><dt>任务范围</dt><dd>{{ ticket.request.work.type }} · {{ ticket.request.work.targetPaths.join('、') }}</dd>
          <dt>代码版本</dt><dd class="mono">{{ ticket.request.codeRef.kind === 'content' ? '内容指纹' : '提交版本' }} · {{ ticket.request.codeRef.value }}</dd>
          <dt>执行机</dt><dd>{{ attempt?.permit?.machine || attempt?.intent?.machine || '尚未派机' }}</dd>
          <dt>授予核数</dt><dd>{{ attempt?.grantedCores ?? '暂无' }}</dd>
          <dt>挂号时刻</dt><dd>{{ stamp(ticket.createdAt) }}</dd><dt>结束时刻</dt><dd>{{ stamp(ticket.endedAt) }}</dd>
        </dl></section>
        <p v-if="related && !related.readable" class="warn" role="status">{{ related.reason }}；交接信息仅供核对快照</p>
        <section v-if="related?.handoffs.length"><h3>集群交接</h3>
          <div v-for="handoff in related.handoffs" :key="handoff.attemptId" class="handoff">
            <p class="sched-id">{{ handoff.attemptId }} · {{ handoff.machine }} · {{ handoff.submissionId }}</p>
            <ol class="handoff-steps" aria-label="派发意图 → 已投递"><li><b>派发意图</b><time>{{ handoff.intentAt ? stamp(handoff.intentAt) : '尚无意图事件' }}</time></li>
              <li><b :class="{ 'sched-muted': !handoff.dispatchedAt }">已投递</b><time>{{ handoff.dispatchedAt ? stamp(handoff.dispatchedAt) : '等待投递，尚无投递事件' }}</time></li></ol>
          </div>
        </section>
        <section><h3>子单</h3>
          <p v-if="!related?.children" class="sched-note">子单关系暂不可读</p>
          <ul v-else-if="related.children.length" class="child-tickets"><li v-for="child in related.children" :key="child.ticketId">
            <button class="sched-link" @click="emit('open', child.ticketId)">{{ child.title }}</button> · {{ stateLabels[child.state] }}<div class="sched-id">{{ child.ticketId }}</div>
          </li></ul><p v-else class="sched-empty">没有子单</p>
        </section>
        <section><h3>时长（四段互不重叠）</h3><dl class="detail-kv">
          <template v-for="part in timings" :key="part.key"><dt>{{ part.label }}</dt><dd>{{ duration(ticket.timing[part.key]) }}</dd></template>
        </dl></section>
        <section><h3>时间线</h3>
          <ol v-if="ticket.timeline.length" class="timeline"><li v-for="event in ticket.timeline" :key="event.seq">
            <time>{{ stamp(event.at) }}</time><span>{{ eventLabels[event.type] || event.type }}</span><span v-if="event.attemptId" class="sched-id"> · {{ event.attemptId }}</span>
            <p v-if="typeof event.data.reason === 'string'">{{ event.data.reason }}</p>
            <details class="sched-note"><summary>事件记录</summary><pre>{{ JSON.stringify(event.data, null, 2) }}</pre></details>
          </li></ol><p v-else class="sched-empty">暂无</p>
        </section>
        <section><h3>执行记录</h3>
          <div v-if="ticket.attempts.length" class="sched-table-wrap"><table class="sched-table"><thead><tr><th>执行号</th><th>机器</th><th>开始</th><th>结束</th><th>结果</th></tr></thead>
            <tbody><tr v-for="item in ticket.attempts" :key="item.attemptId"><td>{{ item.attemptId }}</td><td>{{ item.permit?.machine || item.intent?.machine || '尚未派机' }}</td>
              <td>{{ stamp(item.startedAt) }}</td><td>{{ stamp(item.endedAt) }}</td><td>{{ item.result ? (stateLabels[item.result.outcome as keyof typeof stateLabels] || item.result.outcome) : '未结束' }}<p>{{ item.result?.reason }}</p></td></tr></tbody>
          </table>
            <details v-for="item in ticket.attempts" :key="item.attemptId" class="sched-note"><summary>{{ item.attemptId }} 的许可与四段时长</summary><pre>{{ JSON.stringify({ permit: item.permit, timing: item.timing }, null, 2) }}</pre></details>
          </div><p v-else class="sched-empty">暂无</p>
        </section>
        <section><h3>补跑依据</h3><p class="sched-empty">暂无</p></section>
        <section><h3>日志</h3><p class="sched-empty">暂无</p></section>
      </template>
    </div>
  </dialog>
</template>

<style scoped>
.sched-drawer { position: fixed; inset: 0 0 0 auto; width: min(500px, 94vw); max-width: none; height: 100dvh; max-height: none; margin: 0; padding: 0; color: var(--text); background: var(--surface); border: 0; border-left: 1px solid var(--line-strong); box-shadow: -12px 0 30px var(--drawer-shadow); overflow-y: auto; }
.sched-drawer::backdrop { background: var(--overlay); }
.drawer-content { padding: var(--s4) var(--s5); }
.drawer-heading { display: flex; justify-content: space-between; align-items: center; gap: var(--s2); }
.drawer-heading h2 { font-size: var(--fs-md); margin: 0; }
section { margin-top: var(--s4); }
h3 { font-size: var(--fs-sm); color: var(--text-2); margin: 0 0 6px; }
.detail-kv { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 4px 10px; font-size: var(--fs-sm); margin: 0; }
.detail-kv dt { color: var(--text-3); }.detail-kv dd { margin: 0; overflow-wrap: anywhere; }
.timeline { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 2px solid var(--line-strong); }
.timeline li { padding: 3px 0 7px 8px; font-size: var(--fs-sm); }
.timeline time { display: block; color: var(--text-3); font-family: var(--mono); font-size: var(--fs-xs); }
.timeline p { margin: var(--s1) 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: var(--s2); background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r); font-size: var(--fs-xs); }
.handoff-steps { display: flex; gap: var(--s3); list-style: none; padding: 0; font-size: var(--fs-sm); }
.handoff-steps li { flex: 1; min-width: 0; }
.handoff-steps li + li { position: relative; padding-left: var(--s3); }
.handoff-steps li + li::before { content: '→'; position: absolute; left: calc(-1 * var(--s1)); color: var(--text-3); }
.handoff-steps time { display: block; color: var(--text-3); font-size: var(--fs-xs); }
.child-tickets { padding-left: var(--s4); font-size: var(--fs-sm); }
</style>
