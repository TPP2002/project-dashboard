<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useSchedStore } from '@/stores/sched'
import DispatcherBanner from '@/components/sched/DispatcherBanner.vue'
import AttentionItems from '@/components/sched/AttentionItems.vue'
import MachineCard from '@/components/sched/MachineCard.vue'
import QueueTable from '@/components/sched/QueueTable.vue'
import ReserveCard from '@/components/sched/ReserveCard.vue'
import CodexTickets from '@/components/sched/CodexTickets.vue'
import RecentCommands from '@/components/sched/RecentCommands.vue'
import LedgerTable from '@/components/sched/LedgerTable.vue'
import TicketDrawer from '@/components/sched/TicketDrawer.vue'
import { age, ticketLabel } from '@/components/sched/format'
import '@/components/sched/console.css'

const store = useSchedStore()
const heartbeatAge = computed(() => age(store.snapshot?.dispatcher.heartbeat.at ?? null, store.now))
const online = computed(() => store.snapshot?.machines.filter(machine => machine.online) ?? [])
const offline = computed(() => store.snapshot?.machines.filter(machine => !machine.online) ?? [])
const unassigned = computed(() => store.snapshot?.running.filter(ticket => !ticket.registerOnly && !store.snapshot?.machines.some(machine => machine.name === ticket.machine)) ?? [])
const latestReserve = computed(() => store.commands.find(command => command.input.kind === 'reserve'))
const cancel = (ticketId: string) => store.command({ kind: 'cancel', data: { ticketId } })
const jump = (ticketId: string) => store.command({ kind: 'jump-queue', data: { ticketId } })
onMounted(store.start)
onUnmounted(store.stop)
</script>

<template>
  <main class="sched-page">
    <DispatcherBanner v-if="store.readable && store.snapshot" :heartbeat-at="store.snapshot.dispatcher.heartbeat.at" :now="store.now" />
    <header class="sched-page-head">
      <div><h1>调度台</h1><p>所有项目的重活都在这里排队、派单、记账。副机优先；CI 来了，那台机器上的活暂停让路。</p></div>
      <div class="sched-pills">
        <span v-if="store.readable" class="sched-pill" :class="heartbeatAge !== null && heartbeatAge <= 60000 ? 'ok' : 'bad'">
          {{ heartbeatAge !== null && heartbeatAge <= 60000 ? '派单员在线' : '派单员失联' }} · 心跳 {{ heartbeatAge === null ? '未知' : Math.floor(heartbeatAge / 1000) + ' 秒前' }}
        </span><span class="sched-pill">台账永久 · 日志 90 天</span>
      </div>
    </header>
    <div v-if="store.snapshotError" class="sched-banner bad" role="alert"><div><strong>读不到调度共享盘</strong><p>{{ store.snapshotError }}</p></div>
      <button class="sched-btn" :disabled="store.loading" @click="store.refreshSnapshot">重新读取</button></div>
    <p v-else-if="!store.snapshot" class="sched-empty" role="status">正在读取调度共享盘…</p>
    <p v-if="store.storageError" class="warn" role="status">{{ store.storageError }}</p>
    <p v-if="store.commandError" class="bad" role="alert">{{ store.commandError }}</p>
    <template v-if="store.readable && store.snapshot">
      <details class="sched-howto"><summary>怎么看这一页（流程与图例）</summary>
        <div class="sched-flow">
          <div><b>1 提交</b>对话、Codex 派单器、夜跑、各项目操作台挂号</div><div><b>2 进总队列</b>所有机器共用一条队伍</div>
          <div><b>3 派单员派单</b>副机优先；副机忙、主机够才给主机</div><div><b>4 跑完自动补位</b>空出来就派下一单</div>
          <div><b>5 全部进台账</b>每单可点开看完整经过</div>
        </div>
        <p>运行中、暂停中、低速继续、手动暂停分别标记；机器卡的核数与队列位置均来自派单员本拍快照。</p>
        <p class="sched-note">派单员第 {{ store.snapshot.dispatcher.heartbeat.tick }} 拍 · 台账序号 {{ store.snapshot.dispatcher.heartbeat.cursorSeq }} · 数据位置 {{ store.snapshot.share }}</p>
      </details>
      <AttentionItems :snapshot="store.snapshot" :now="store.now" @open="store.openDetail" />
      <div class="sched-machines"><MachineCard v-for="machine in online" :key="machine.name" :machine="machine" :host="store.snapshot.dispatcher.config.machine"
        :tickets="store.snapshot.running" :now="store.now" :busy="store.busy" @open="store.openDetail" @cancel="cancel" /></div>
      <details v-if="offline.length" class="sched-offline"><summary>离线机器 {{ offline.length }} 台（不参与派单）</summary>
        <div class="sched-machines"><MachineCard v-for="machine in offline" :key="machine.name" :machine="machine" :host="store.snapshot.dispatcher.config.machine"
          :tickets="store.snapshot.running" :now="store.now" :busy="store.busy" @open="store.openDetail" @cancel="cancel" /></div>
      </details>
      <section v-if="unassigned.length" class="sched-card"><h2>等待执行机确认</h2><p v-for="ticket in unassigned" :key="ticket.ticketId">
        <button class="sched-link" @click="store.openDetail(ticket.ticketId)">{{ ticket.title }}</button> · {{ ticketLabel(ticket) }}
        <button class="sched-btn small bad" :disabled="store.busy || ticket.cancelRequested" @click="cancel(ticket.ticketId)">撤单</button>
      </p></section>
      <div class="sched-two-columns">
        <QueueTable :queue="store.snapshot.queue" :locks="store.snapshot.locks" :details="store.queueDetails" :errors="store.queueErrors"
          :now="store.now" :busy="store.busy" @open="store.openDetail" @cancel="cancel" @jump="jump" />
        <div class="sched-stack"><ReserveCard :host="store.host" :legacy="store.snapshot.legacyReserve" :latest="latestReserve" :busy="store.busy" @command="store.command" />
          <CodexTickets :tickets="store.snapshot.registerOnly" :now="store.now" @open="store.openDetail" />
          <RecentCommands :receipts="store.snapshot.recentReceipts" :submitted="store.commands" :now="store.now" :busy="store.busy" @retry="store.retryLegacy" />
        </div>
      </div>
      <LedgerTable :value="store.filters" :data="store.ledger" :page="store.page" :loading="store.ledgerLoading" :error="store.ledgerError"
        @filter="store.applyFilters" @page="store.movePage" @open="store.openDetail" @refresh="store.loadLedger" />
    </template>
    <TicketDrawer v-if="store.detailId" :ticket-id="store.detailId" :ticket="store.detail" :loading="store.detailLoading" :error="store.detailError"
      @close="store.closeDetail" @retry="store.detailId && store.openDetail(store.detailId)" />
  </main>
</template>

<style scoped>
.sched-page { display: flex; flex-direction: column; gap: var(--s3); width: 100%; min-width: 0; padding-bottom: var(--s6); }
.sched-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s4); }
.sched-page-head h1 { margin: 0; font-size: var(--fs-xl); }
.sched-page-head p { margin: 2px 0 0; color: var(--text-2); }
.sched-pills { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--s2); }
.sched-pill { border: 1px solid var(--line-strong); border-radius: 999px; padding: 2px 10px; font-size: var(--fs-sm); color: var(--text-2); background: var(--surface); white-space: nowrap; }
.sched-pill.ok { color: var(--ok); }.sched-pill.bad { color: var(--bad); }
.sched-howto { color: var(--text-3); font-size: var(--fs-sm); }.sched-howto summary, .sched-offline summary { cursor: pointer; }
.sched-flow { display: flex; gap: 6px; flex-wrap: wrap; margin: var(--s2) 0; }
.sched-flow > div { flex: 1; min-width: 150px; padding: 6px 10px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); }
.sched-flow b { display: block; color: var(--text); }
.sched-machines { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr)); gap: var(--s4); }
.sched-offline { padding: 6px 12px; border: 1px dashed var(--line-strong); border-radius: var(--r); color: var(--text-3); font-size: var(--fs-sm); }
.sched-offline .sched-machines { margin-top: var(--s2); }
.sched-two-columns { display: grid; grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr); align-items: start; gap: var(--s4); }
.sched-stack { display: grid; gap: var(--s4); min-width: 0; }
@media (max-width: 1150px) { .sched-two-columns { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) { .sched-page-head { flex-direction: column; }.sched-pills { justify-content: flex-start; } }
</style>
