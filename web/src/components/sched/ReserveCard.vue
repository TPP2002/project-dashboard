<script setup lang="ts">
import { ref, watch } from 'vue'
import type { CommandInput, MachineSnapshot, ReserveCores } from '@/api/sched'
import { clock } from './format'
const props = defineProps<{ host: MachineSnapshot | null; busy: boolean }>()
const emit = defineEmits<{ command: [input: CommandInput] }>()
const selected = ref<ReserveCores>(props.host?.reservation?.requestedCores ?? 0)
const minutes = ref<60 | 180 | null>(null)
const presets: { cores: ReserveCores; title: string; hint: string }[] = [
  { cores: 0, title: '不留（0 核）', hint: '我不用电脑，全让给重活' }, { cores: 5, title: '留 5 核', hint: '给负责人看文档、聊天' },
  { cores: 10, title: '留 10 核', hint: '给负责人写代码、开会' }, { cores: 15, title: '留 15 核', hint: '给负责人剪视频、跑大程序' },
]
const durations: { value: 60 | 180 | null; title: string }[] = [
  { value: 60, title: '1 小时后取消' }, { value: 180, title: '3 小时后取消' }, { value: null, title: '手动取消前一直留' },
]
watch(() => props.host?.reservation?.requestedCores, value => { if (value !== undefined) selected.value = value })
function apply(cores: ReserveCores, duration = minutes.value) {
  selected.value = cores
  emit('command', { kind: 'reserve', data: { requestedCores: cores, ...(cores > 0 && duration ? { durationMinutes: duration } : {}) } })
}
function chooseDuration(value: 60 | 180 | null) { minutes.value = value; if (selected.value > 0) apply(selected.value, value) }
</script>

<template>
  <div class="reserve-toolbar" role="group" aria-label="我要用电脑，只作用于主机">
    <strong class="reserve-label" title="只作用于主机">我要用电脑</strong>
    <div class="presets" role="group" aria-label="给我留多少核">
      <button v-for="preset in presets" :key="preset.cores" class="sched-btn preset" :class="{ on: selected === preset.cores }"
        :title="`${preset.cores} 核 · ${preset.hint}；新单立刻让出预留，在跑的活不打断，跑完一单腾一单。`"
        :aria-pressed="selected === preset.cores" :disabled="busy || !host" @click="apply(preset.cores)">{{ preset.title }}
      </button>
    </div>
    <div class="durations" role="group" aria-label="什么时候自动取消预留">
      <button v-for="option in durations" :key="String(option.value)" class="sched-btn preset" :class="{ on: minutes === option.value }"
        :aria-pressed="minutes === option.value" :disabled="busy || !host" @click="chooseDuration(option.value)">{{ option.title }}</button>
    </div>
    <button class="sched-btn hold-button" :class="host?.ownerHold ? 'on' : 'warn'" :disabled="busy || !host"
      title="主机上的调度任务立刻全部暂停、不再派新单，副机照常；恢复后按规则补跑撞上暂停的超时用例。提交后请看最近指令的回执。"
      @click="emit('command', { kind: host?.ownerHold ? 'owner-release' : 'owner-hold', data: {} })">
      {{ host?.ownerHold ? '一键恢复主机' : '一键全部暂停' }}
    </button>
    <span class="reserve-status" role="status">
      <template v-if="host?.reservation">已留 {{ host.reservation.fulfilledCores }} 核<template v-if="host.reservation.fulfilledCores !== host.reservation.requestedCores">（已申请 {{ host.reservation.requestedCores }} 核）</template>
        <template v-if="host.reservation.untilAt"> · {{ clock(host.reservation.untilAt) }} 自动取消</template>
        <template v-else-if="host.reservation.requestedCores"> · 手动取消前一直留</template>
      </template>
      <template v-else>尚未读到预留状态</template>
    </span>
  </div>
</template>

<style scoped>
.reserve-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s3); min-width: 0; padding: var(--s2) var(--s3); background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r); }
.reserve-label { font-size: var(--fs-sm); white-space: nowrap; }
.presets, .durations { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.durations { border-left: 1px solid var(--line-strong); padding-left: var(--s3); }
.preset { white-space: nowrap; }
.hold-button { font-weight: 600; }
.reserve-status { margin-left: auto; font-size: var(--fs-xs); color: var(--ok); overflow-wrap: anywhere; text-align: right; }
@media (max-width: 760px) { .reserve-status { flex-basis: 100%; text-align: left; }.durations { border-left: 0; padding-left: 0; } }
</style>
