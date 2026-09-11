<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/Icon.vue'
import { age } from './format'
const props = defineProps<{ heartbeatAt: string; now: number }>()
const elapsed = computed(() => age(props.heartbeatAt, props.now))
</script>

<template>
  <div v-if="elapsed === null || elapsed > 60000" class="sched-banner bad" role="alert">
    <Icon name="alertTri" :size="16" />
    <div><strong>派单员失联，新单暂停派发</strong>
      <p>最后心跳 {{ elapsed === null ? '未知' : Math.floor(elapsed / 1000) + ' 秒前' }}。已在跑的不受影响；看板上点的指令会排着等它恢复，超过期限仍未执行会明确标出。</p>
    </div>
  </div>
</template>
