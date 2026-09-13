<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TicketPage } from '@/api/sched'
import type { LedgerPrefs, Period } from './preferences'
import { duration, stamp, stateLabels, tone } from './format'
const props = defineProps<{ value: LedgerPrefs; data: TicketPage | null; page: number; loading: boolean; error: string; exporting: boolean; exportError: string }>()
const emit = defineEmits<{ filter: [value: LedgerPrefs]; page: [direction: -1 | 1]; open: [id: string]; refresh: []; export: [] }>()
const draft = ref({ ...props.value })
const pendingDates = computed(() => draft.value.period === 'custom' && (draft.value.from !== props.value.from || draft.value.to !== props.value.to))
watch(() => props.value, value => { draft.value = { ...value } })
const periods: { value: Period; label: string }[] = [{ value: 'today', label: '今天' }, { value: 'd7', label: '近 7 天' },
  { value: 'd90', label: '近 90 天' }, { value: 'all', label: '全部' }, { value: 'custom', label: '自选日期' }]
function period(value: Period) { draft.value.period = value; emit('filter', { ...draft.value }) }
</script>

<template>
  <section class="sched-card ledger-card">
    <h2>台账 <span class="sched-sub">每一单从挂号到结束；点一行看完整经过</span></h2>
    <form class="ledger-filters" @submit.prevent="emit('filter', { ...draft })">
      <div class="periods" role="group" aria-label="挂号日期范围">
        <button v-for="item in periods" :key="item.value" class="sched-btn chip" :class="{ on: draft.period === item.value }"
          :aria-pressed="draft.period === item.value" type="button" @click="period(item.value)">{{ item.label }}</button>
      </div>
      <label>项目<select v-model="draft.project" @change="emit('filter', { ...draft })"><option value="">全部项目</option>
        <option v-if="draft.project && !data?.filters.projects.includes(draft.project)" :value="draft.project">{{ draft.project }}</option>
        <option v-for="value in data?.filters.projects || []" :key="value" :value="value">{{ value }}</option></select></label>
      <label>机器<select v-model="draft.machine" @change="emit('filter', { ...draft })"><option value="">全部机器</option>
        <option v-if="draft.machine && !data?.filters.machines.includes(draft.machine)" :value="draft.machine">{{ draft.machine }}</option>
        <option v-for="value in data?.filters.machines || []" :key="value" :value="value">{{ value }}</option></select></label>
      <label>派单方<select v-model="draft.submitter" @change="emit('filter', { ...draft })"><option value="">全部派单方</option>
        <option v-if="draft.submitter && !data?.filters.submitters.includes(draft.submitter)" :value="draft.submitter">{{ draft.submitter }}</option>
        <option v-for="value in data?.filters.submitters || []" :key="value" :value="value">{{ value }}</option></select></label>
      <label>结果<select v-model="draft.result" @change="emit('filter', { ...draft })"><option value="">全部结果</option>
        <option v-for="(label, value) in stateLabels" :key="value" :value="value">{{ label }}</option></select></label>
      <template v-if="draft.period === 'custom'">
        <label>挂号日期从<input v-model="draft.from" type="date"></label><label>到<input v-model="draft.to" type="date"></label>
        <button class="sched-btn" type="submit">应用日期</button>
      </template>
    </form>
    <p class="sched-note"><button class="sched-btn small" :disabled="exporting || loading || !!error || !data || pendingDates" @click="emit('export')">{{ exporting ? '正在导出…' : '按当前筛选导出 CSV' }}</button> · 最多 10000 行，导出全部符合筛选的记录；耗时为累计执行时长（毫秒）</p>
    <p v-if="pendingDates" class="sched-note">日期尚未应用，请先应用日期再导出。</p>
    <p v-if="exportError" class="bad" role="alert">{{ exportError }}</p>
    <p v-if="error" class="bad" role="alert">{{ error }} <button class="sched-btn small" @click="emit('refresh')">重新读取</button></p>
    <p v-else-if="loading" class="sched-note" role="status">正在读取台账…</p>
    <div v-if="data && !error" class="sched-table-wrap" :aria-busy="loading">
      <table class="sched-table"><thead><tr><th>单号</th><th>项目</th><th>活</th><th>派单方</th><th>机器</th>
        <th class="r">排队</th><th class="r">执行</th><th class="r">暂停</th><th class="r">低速</th><th>结果</th><th>结束时刻</th></tr></thead>
        <tbody><tr v-for="ticket in data.items" :key="ticket.ticketId" class="clickable" tabindex="0" role="button"
          :aria-label="`查看 ${ticket.title} 的完整经过`" @click="emit('open', ticket.ticketId)" @keydown.enter="emit('open', ticket.ticketId)" @keydown.space.prevent="emit('open', ticket.ticketId)">
          <td class="sched-id">{{ ticket.ticketId }}</td><td>{{ ticket.project }}</td><td>{{ ticket.title }}</td><td class="sched-muted">{{ ticket.submitter }}</td>
          <td>{{ ticket.machine || '尚未派机' }}</td><td class="r">{{ duration(ticket.queuedMs) }}</td><td class="r">{{ duration(ticket.runningMs) }}</td>
          <td class="r">{{ duration(ticket.pausedMs) }}</td><td class="r">{{ duration(ticket.slowMs) }}</td>
          <td :class="tone(ticket.result)">{{ stateLabels[ticket.result] }}<div v-if="ticket.resultReason" class="sched-note">{{ ticket.resultReason }}</div></td><td>{{ stamp(ticket.endedAt) }}</td>
        </tr><tr v-if="!data.items.length"><td colspan="11" class="sched-empty">没有符合筛选的记录</td></tr></tbody>
      </table>
    </div>
    <div class="pager">
      <span>共 {{ data?.total ?? '…' }} 条 · 第 {{ page + 1 }} 页</span>
      <button class="sched-btn small" :disabled="page === 0 || loading" @click="emit('page', -1)">上一页</button>
      <button class="sched-btn small" :disabled="!data?.nextCursor || loading || !!error" @click="emit('page', 1)">下一页</button>
    </div>
    <p class="sched-note">按挂号日期筛选、倒序显示。台账永久保留；每单的运行日志保留 90 天，到期只删日志。</p>
  </section>
</template>

<style scoped>
.ledger-filters, .periods { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
.ledger-filters { margin-bottom: var(--s2); }
.ledger-filters label { display: flex; gap: var(--s1); align-items: center; color: var(--text-3); font-size: var(--fs-xs); }
.ledger-filters select, .ledger-filters input { padding: 2px 6px; max-width: 200px; background: var(--surface-2); border: 1px solid var(--line-strong); border-radius: var(--r); color: var(--text-2); font: inherit; }
.chip { border-radius: 999px; }
.pager { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: var(--s2); font-size: var(--fs-sm); color: var(--text-3); }
.clickable { cursor: pointer; }
.clickable:hover { background: var(--surface-2); }
</style>
