<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/Icon.vue'
import { dispatcherHealth } from './format'
const props = defineProps<{ heartbeatAt: string; snapshotAt: number | null; now: number }>()
const health = computed(() => dispatcherHealth({ heartbeatAt: props.heartbeatAt, snapshotAt: props.snapshotAt, now: props.now }))
const lastHeartbeat = computed(() => health.value.heartbeatAgeMs === null ? '未知'
  : `${Math.floor((health.value.heartbeatAgeMs + (health.value.viewAgeMs ?? 0)) / 1000)} 秒前`)
</script>

<template>
  <div v-if="health.kind === 'lost'" class="sched-banner bad" role="alert">
    <Icon name="alertTri" :size="16" />
    <div><strong>派单员失联，新单暂停派发</strong>
      <p>最后心跳 {{ lastHeartbeat }}。已在跑的不受影响；看板上点的指令会排着等它恢复，超过期限仍未执行会明确标出。</p>
    </div>
  </div>
  <div v-else-if="health.kind === 'stale-view' && snapshotAt !== null" class="sched-banner info" role="status">
    看板已有 {{ Math.floor((health.viewAgeMs ?? 0) / 1000) }} 秒没取到调度台的新数据，正在重取；派单员是否在线，取到后再显示。
  </div>
</template>