<script setup lang="ts">
import { computed, ref } from 'vue'
import PriorityBadge from '../components/PriorityBadge.vue'
import PriorityPicker from '../components/PriorityPicker.vue'
import type { Priority } from '../utils/taskPriority'
import type { MemberTask, TaskAction } from './types'
import { cardPrimaryAction } from './board'
import AvatarStack from './AvatarStack.vue'
const props = defineProps<{ task: MemberTask; userId: string; busy: boolean; selected?: boolean; setPriority?: (priority: Priority) => Promise<unknown> }>()
const picker = ref<InstanceType<typeof PriorityPicker>>()
async function submitPriority(priority: Priority) {
  if (!props.setPriority) throw new Error('优先级操作不可用')
  await props.setPriority(priority)
}
defineEmits<{ open: []; action: [action: TaskAction] }>()
const primary = computed(() => cardPrimaryAction(props.task))
const mine = computed(() => props.task.assigneeUserId === props.userId)
const collaborating = computed(() => !mine.value && props.task.collaborators?.some(person => person.userId === props.userId))
</script>
<template>
  <article class="member-card" :class="{ mine, collaborating, selected }" :data-priority="task.priority" :data-priority-edge="!mine && !collaborating" tabindex="0" aria-label="打开任务详情" @click="$emit('open')" @keydown.enter.self="$emit('open')" @keydown.space.self.prevent="$emit('open')"
    @contextmenu="picker?.contextmenu($event)" @touchstart.passive="picker?.startPress($event)" @touchend="picker?.cancelPress()" @touchmove="picker?.cancelPress()" @touchcancel="picker?.cancelPress()" @click.capture="picker?.suppressClick($event)">
    <div class="priority-card-head"><span class="task-id">{{ task.id }}</span><PriorityBadge :priority="task.priority" /></div><h3>{{ task.plainTitle || task.title }}</h3>
    <div class="card-status"><span class="badge n compact">{{ task.status }}</span><span>{{ task.percent ?? 0 }}%</span></div>
    <div class="member-progress" :aria-label="`进度 ${task.percent ?? 0}%`"><i :style="{ width: `${task.percent ?? 0}%` }" /></div>
    <AvatarStack :task="task" :user-id="userId" />
    <button v-if="primary" type="button" class="btn btn-sm" :disabled="busy" @click.stop="$emit('action', primary)">{{ primary === 'claim' ? '领取' : '更新进度' }}</button>
    <PriorityPicker ref="picker" :task-id="task.id" :priority="task.priority" :allowed="!!task.actions?.includes('priority') && !busy" :announce="false" :submit="submitPriority" />
  </article>
</template>
<style scoped>
.member-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 9px 10px; display: grid; gap: 6px; cursor: pointer; position: relative; overflow-wrap: anywhere; }
.member-card:hover { border-color: var(--line-strong); }.member-card.selected { border-color: var(--info); box-shadow: 0 0 0 1px var(--info); }
.member-card.mine::before, .member-card.collaborating::before { content: ''; position: absolute; left: -1px; top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: linear-gradient(180deg,var(--spec-active)); background-size: 100% 200%; animation: member-edge 5s linear infinite; }.member-card.collaborating::before { opacity: .5; }
.task-id { font-family: var(--mono); font-size: var(--fs-xs); color: var(--text-3); }.member-card h3 { margin: 0; font-size: var(--fs-sm); line-height: 1.45; }
.card-status { display: flex; justify-content: space-between; gap: 6px; color: var(--text-2); font-size: var(--fs-xs); }.member-card > button { justify-self: start; min-height: 28px; }
.member-progress { height: 4px; border-radius: 2px; background: var(--surface-3); overflow: hidden; }.member-progress i { display: block; height: 100%; background: linear-gradient(90deg,var(--spec-active)); background-size: 200% 100%; animation: member-progress 4s linear infinite; }
@keyframes member-edge { to { background-position: 0 -200%; } }@keyframes member-progress { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .member-card::before, .member-progress i { animation: none; } }
</style>
