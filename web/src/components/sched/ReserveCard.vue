<script setup lang="ts">
import { ref, watch } from 'vue'
import type { CommandInput, MachineSnapshot, ReserveCores, SchedSnapshot } from '@/api/sched'
import type { SubmittedCommand } from './preferences'
import { clock } from './format'
const props = defineProps<{ host: MachineSnapshot | null; legacy: SchedSnapshot['legacyReserve']; latest?: SubmittedCommand; busy: boolean }>()
const emit = defineEmits<{ command: [input: CommandInput] }>()
const selected = ref<ReserveCores>(props.host?.reservation?.requestedCores ?? 0)
const minutes = ref<60 | 180 | null>(null)
const presets: { cores: ReserveCores; title: string; hint: string }[] = [
  { cores: 0, title: '全让给重活', hint: '我不用电脑' }, { cores: 5, title: '留四分之一', hint: '看文档、聊天' },
  { cores: 10, title: '留一半', hint: '写代码、开会' }, { cores: 15, title: '留大部分', hint: '剪视频、跑大程序' },
]
const durations: { value: 60 | 180 | null; title: string }[] = [
  { value: 60, title: '1 小时后取消' }, { value: 180, title: '3 小时后取消' }, { value: null, title: '一直到我手动取消' },
]
watch(() => props.host?.reservation?.requestedCores, value => { if (value !== undefined) selected.value = value })
function apply(cores: ReserveCores, duration = minutes.value) {
  selected.value = cores
  emit('command', { kind: 'reserve', data: { requestedCores: cores, ...(cores > 0 && duration ? { durationMinutes: duration } : {}) } })
}
function chooseDuration(value: 60 | 180 | null) { minutes.value = value; if (selected.value > 0) apply(selected.value, value) }
</script>

<template>
  <section class="sched-card reserve-card">
    <h2>我要用电脑 <span class="sched-sub">只作用于主机</span></h2>
    <div class="presets" role="group" aria-label="给我留多少核">
      <button v-for="preset in presets" :key="preset.cores" class="sched-btn preset" :class="{ on: selected === preset.cores }"
        :aria-pressed="selected === preset.cores" :disabled="busy || !host" @click="apply(preset.cores)">
        <span>{{ preset.title }}</span><small>{{ preset.cores }} 核 · {{ preset.hint }}</small>
      </button>
    </div>
    <div v-if="selected > 0" class="durations" role="group" aria-label="什么时候自动取消预留">
      <button v-for="option in durations" :key="String(option.value)" class="sched-btn preset" :class="{ on: minutes === option.value }"
        :aria-pressed="minutes === option.value" :disabled="busy || !host" @click="chooseDuration(option.value)">{{ option.title }}</button>
    </div>
    <p v-if="host?.reservation" class="reserve-line">已申请 <b>{{ host.reservation.requestedCores }}</b> 核、已兑现 <b>{{ host.reservation.fulfilledCores }}</b> 核
      <span v-if="host.reservation.untilAt"> · {{ clock(host.reservation.untilAt) }} 自动取消</span>
      <span v-else-if="host.reservation.requestedCores"> · 一直到我手动取消</span>
    </p>
    <p v-else class="sched-note">尚未读到派单主机的预留快照。</p>
    <p class="sched-note" :class="{ bad: latest?.legacy?.ok === false }">
      旧账本：当前预留 {{ legacy.reservedCores }} 核<span v-if="legacy.reserveExpiresAt"> · {{ clock(legacy.reserveExpiresAt) }} 自动取消</span>。
      <template v-if="latest?.legacy">{{ latest.legacy.ok ? '最近一次同步成功' : '旧账本同步失败，请到最近指令重试同步' }}</template>
      <template v-else>尚无本页同步记录。</template>
    </p>
    <button class="sched-btn hold-button" :class="host?.ownerHold ? 'on' : 'warn'" :disabled="busy || !host"
      @click="emit('command', { kind: host?.ownerHold ? 'owner-release' : 'owner-hold', data: {} })">
      {{ host?.ownerHold ? '我用完了，恢复主机上的活' : '一键全部暂停，我要用电脑' }}
    </button>
    <p class="sched-note">预留：新单立刻不再占你要的核；在跑的活不打断，跑完一单腾一单。</p>
    <details class="sched-note"><summary>一键全部暂停与恢复的作用</summary>
      <p>主机上调度的单子立刻全部停住、不再派新单，副机照常；恢复后测试按规则只补跑撞上暂停的超时用例。操作提交后请看下方回执。</p>
    </details>
  </section>
</template>

<style scoped>
.presets { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.preset { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; padding: 6px 10px; }
.preset small { color: var(--text-3); font-size: var(--fs-xs); }
.durations { display: grid; gap: 6px; margin-top: var(--s2); }
.reserve-line { margin-top: var(--s2); font-size: var(--fs-sm); color: var(--text-2); }
.reserve-line b { color: var(--info); }
.hold-button { padding: 8px 12px; font-weight: 600; margin-top: var(--s3); width: 100%; }
</style>
