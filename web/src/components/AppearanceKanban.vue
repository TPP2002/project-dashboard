<script setup lang="ts">
import { ref } from 'vue'
import { STATUS_ORDER, DONE_STATUSES, VOID_STATUSES } from '@/api/schema'
import { appearance, setAppearance } from '@/utils/appearance'

const statuses = STATUS_ORDER.filter(status => !DONE_STATUSES.has(status) && !VOID_STATUSES.has(status))
const error = ref('')

function updateLimit(status: string, event: Event) {
  const input = event.target as HTMLInputElement
  const limit = input.valueAsNumber
  if (!Number.isInteger(limit) || limit < 0 || limit > 999) {
    input.value = String(appearance.wipLimits[status] || 0)
    error.value = '请填写 0 到 999 的整数；已恢复原值'
    return
  }
  error.value = ''
  setAppearance('wipLimits', { ...appearance.wipLimits, [status]: limit })
}
</script>

<template>
  <h3 class="ac-h">看板泳道</h3>
  <p class="ac-p">超过上限时泳道头的计数徽章变警示色，只提醒不拦。</p>
  <div v-for="status in statuses" :key="status" class="ac-line">
    <label :for="`appearance-wip-${status}`" class="ac-text"><b>{{ status }}</b><span>在制上限；0 = 不限</span></label>
    <div class="limit-input">
      <input :id="`appearance-wip-${status}`" class="field" type="number" min="0" max="999" step="1"
        :value="appearance.wipLimits[status] || 0" @change="updateLimit(status, $event)"><span>张</span>
    </div>
  </div>
  <p v-if="error" class="setting-error" role="alert">{{ error }}</p>
  <p class="ac-hint">卡龄的三档变色阈值与进度陈旧提醒共用，可在「提示音与通知」中调整。</p>
</template>

<style scoped>
.limit-input { display: flex; align-items: center; gap: var(--s2); color: var(--text-3); font-size: var(--fs-sm); }
.limit-input .field { width: 96px; }
.setting-error { color: var(--bad); font-size: var(--fs-sm); }
</style>
