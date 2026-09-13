<script setup lang="ts">
import type { EngineGroup, TicketEstimate, TicketSummary } from '@/api/sched'
import CodexTickets from './CodexTickets.vue'
defineProps<{ groups?: EngineGroup[] | null; tickets: TicketSummary[]; estimates: Record<string, TicketEstimate>; now: number }>()
const emit = defineEmits<{ open: [id: string] }>()
</script>

<template>
  <section class="external-tickets">
    <h2 title="只登记、不占核；规矩已写进单子">施工中的外派单 <span class="sched-sub">按施工方分窗口</span></h2>
    <div class="engine-windows">
      <template v-if="groups?.length">
        <CodexTickets v-for="group in groups" :key="group.engine ?? ''" :engine="group.engine" :tickets="group.tickets"
          :estimates="estimates" :now="now" @open="emit('open', $event)" />
      </template>
      <!-- 旧快照尚无分组字段时仍由原窗口承接整批外派单，不能把字段缺失当成没有单。 -->
      <CodexTickets v-else :tickets="tickets" :estimates="estimates" :now="now" @open="emit('open', $event)" />
    </div>
  </section>
</template>

<style scoped>
.external-tickets { min-width: 0; }
.external-tickets h2 { margin: 0 0 var(--s2); font-size: var(--fs-md); display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s2); }
.engine-windows { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr)); gap: var(--s2); }
.engine-window { --engine-accent: var(--chart-4); --engine-bg: color-mix(in srgb, var(--chart-4) 12%, var(--surface)); }
.engine-window:nth-child(3n + 2) { --engine-accent: var(--ok); --engine-bg: var(--ok-bg); }
.engine-window:nth-child(3n) { --engine-accent: var(--info); --engine-bg: var(--info-bg); }
</style>
