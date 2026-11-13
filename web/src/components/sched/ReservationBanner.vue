<script setup lang="ts">
import { computed } from 'vue'
import type { CommandInput, MachineSnapshot, ReservationChange } from '@/api/sched'
import { reservationBanner } from './reservation'
const props = defineProps<{ host: MachineSnapshot | null; change: ReservationChange | null | undefined; now: number; busy: boolean }>()
const emit = defineEmits<{ command: [input: CommandInput] }>()
const banner = computed(() => reservationBanner(props.host?.reservation, props.change, props.now))
</script>

<template>
  <div v-if="banner" class="sched-banner reservation-banner" :class="banner.tone" role="status">
    <div><strong>{{ banner.title }}</strong><p>{{ banner.detail }}</p></div>
    <button class="sched-btn" :disabled="busy || !host" @click="emit('command', { kind: 'reserve', data: { requestedCores: 0 } })">现在取消</button>
  </div>
</template>

<style scoped>
.reservation-banner { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); }
.reservation-banner.info { border-color: var(--info); background: var(--info-bg); }
.reservation-banner.warn { border-color: var(--warn); background: var(--warn-bg); }
.reservation-banner.bad { border-color: var(--bad); background: var(--bad-bg); }
.reservation-banner p { margin: var(--s2) 0 0; overflow-wrap: anywhere; }
.reservation-banner button { min-height: 32px; }
@media (max-width: 760px) { .reservation-banner { flex-direction: column; align-items: stretch; } .reservation-banner button { width: 100%; min-height: 44px; } }
</style>
