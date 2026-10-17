<script setup lang="ts">
import { ref, watch } from 'vue'
import type { MemberTask } from './types'
import { canClaim, ownsTask } from './flow'
const props = defineProps<{ task: MemberTask; userId: string; busy: boolean }>()
const emit = defineEmits<{ claim: [taskId: string]; progress: [taskId: string, percent: number, note: string] }>()
const percent = ref(props.task.percent ?? 0)
const note = ref('')
watch(() => props.task.percent, value => { percent.value = value ?? 0 })
</script>
<template>
  <article class="collab-card">
    <h2>{{ task.plainTitle || task.title }}</h2>
    <p v-if="task.plainTitle && task.plainTitle !== task.title">{{ task.title }}</p>
    <p>{{ task.status }} · {{ task.percent ?? 0 }}%</p>
    <p class="collab-description">{{ task.description || '暂无描述' }}</p>
    <p>归属：{{ task.assigneeName || (task.assigneeUserId ? '已由成员领取' : canClaim(task) ? '尚未领取' : '由负责人或施工方跟进') }}</p>
    <button v-if="canClaim(task)" class="btn" :disabled="busy" @click="emit('claim', task.id)">领取任务</button>
    <form v-if="ownsTask(task, userId)" class="collab-form" @submit.prevent="emit('progress', task.id, percent, note)">
      <label>完成进度（0–100）<input v-model.number="percent" type="number" min="0" max="100" step="1" required :disabled="busy" /></label>
      <label>简短留言<textarea v-model="note" maxlength="500" rows="3" :disabled="busy" /></label>
      <p>提交 100% 表示工作完成，仍需等待负责人验收。</p>
      <button class="btn" :disabled="busy">保存进度</button>
    </form>
  </article>
</template>
