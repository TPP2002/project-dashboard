<script setup lang="ts">
import { computed, useId } from 'vue'
import { groupDevices } from './deviceGroups'
import type { Device, User } from './types'

const props = defineProps<{ users: User[]; devices: Device[]; busy: boolean }>()
const emit = defineEmits<{ revoke: [id: string] }>()
const now = Date.now()
const prefix = useId()
const groups = computed(() => groupDevices(props.users, props.devices, now))
</script>

<template>
  <div class="dg">
    <section v-for="(group, index) in groups" :key="group.user?.id ?? 'unknown'" class="dg-group" :aria-labelledby="`${prefix}-${index}`">
      <header class="dg-head">
        <span class="dg-av" aria-hidden="true">{{ group.letter }}</span>
        <h3 :id="`${prefix}-${index}`" class="dg-name">{{ group.name }}</h3>
        <span v-if="group.roleText" class="dg-pill" :class="group.user?.role === 'owner' ? 'dg-info' : 'dg-neutral'">{{ group.roleText }}</span>
        <span v-if="group.user?.disabled" class="dg-pill dg-warn">已停用</span>
        <span class="dg-count">{{ group.summary }}</span>
      </header>
      <div v-if="group.live.length" class="dg-list">
        <div v-for="device in group.live" :key="device.id" class="dg-row">
          <span class="dg-label"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m7 10 3 2-3 2 M12.5 14.5H16" /></svg>{{ device.label }}</span>
          <span class="dg-pill" :class="device.state === 'active' ? 'dg-ok' : 'dg-warn'">{{ device.state === 'active' ? '有效' : '已到期' }}</span>
          <span class="dg-when">{{ device.when }}</span>
          <button class="btn dg-button" type="button" :aria-label="'撤销设备 ' + device.label" :disabled="busy" @click="emit('revoke', device.id)">撤销</button>
        </div>
      </div>
      <details v-if="group.revoked.length" class="dg-gone" :class="{ 'dg-after-list': group.live.length }">
        <summary>已撤销 {{ group.revoked.length }} 台</summary>
        <div v-for="device in group.revoked" :key="device.id" class="dg-row dg-off">
          <span class="dg-label"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m7 10 3 2-3 2 M12.5 14.5H16" /></svg>{{ device.label }}</span>
          <span class="dg-pill dg-neutral">已撤销</span>
          <span class="dg-when">{{ device.when }}</span>
          <span></span>
        </div>
      </details>
    </section>
  </div>
</template>

<style scoped>
.dg { display: flex; flex-direction: column; gap: var(--s3); }
.dg-group { border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); overflow: hidden; }
.dg-head { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; padding: var(--s2) var(--s3); background: var(--surface-2); border-bottom: 1px solid var(--line); }
.dg-head:only-child { border-bottom: 0; }
.dg-av { width: 24px; height: 24px; border-radius: 12px; display: grid; place-items: center; font-size: var(--fs-xs); font-weight: 600; background: var(--info-bg); color: var(--info); }
.dg-name { font-size: var(--fs-base); font-weight: 600; margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dg-pill { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-xs); font-weight: 500; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
.dg-pill::before { content: ''; width: 6px; height: 6px; border-radius: 3px; background: currentColor; }
.dg-info { background: var(--info-bg); color: var(--info); }
.dg-neutral { background: var(--surface-3); color: var(--text-2); }
.dg-ok { background: var(--ok-bg); color: var(--ok); }
.dg-warn { background: var(--warn-bg); color: var(--warn); }
.dg-count { margin-left: auto; color: var(--text-2); font-size: var(--fs-sm); }
.dg-row { display: grid; grid-template-columns: minmax(0, 1.4fr) auto minmax(0, 1fr) auto; gap: var(--s3); align-items: center; padding: var(--s2) var(--s3); font-size: var(--fs-sm); border-bottom: 1px solid var(--line); }
.dg-row:last-child { border-bottom: 0; }
.dg-label { display: flex; align-items: center; gap: var(--s2); font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.dg-label svg { width: 16px; height: 16px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.dg-when { color: var(--text-2); }
.dg-off .dg-label { font-weight: 400; color: var(--text-2); }
.dg-gone.dg-after-list { border-top: 1px solid var(--line); }
.dg-gone summary { padding: var(--s2) var(--s3); color: var(--text-2); font-size: var(--fs-sm); cursor: pointer; min-height: 32px; }
.dg-gone summary:focus-visible { outline: 2px solid var(--info); outline-offset: 2px; }
@media (max-width: 760px) {
  .dg-row { grid-template-columns: minmax(0, 1fr) auto; }
  .dg-when { grid-column: 1 / -1; grid-row: 2; }
  .dg-button, .dg-gone summary { min-height: 44px; }
  .dg-gone summary { padding-block: 12px; }
}
</style>
