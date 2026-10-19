<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ProjectChoices from './ProjectChoices.vue'
import type { Project, User, Reset } from './types'
const props = defineProps<{ user: User; projects: Project[]; busy: boolean; resets?: Reset[] }>()
const emit = defineEmits<{ save: [id: string, projectIds: string[], disabled: boolean, role: 'member' | 'viewer']; reset: [id: string] }>()
const projectIds = ref<string[]>([])
const role = ref<'member' | 'viewer'>('member')
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
const reset = computed(() => props.resets?.find(item => item.userId === props.user.id && !item.used && Date.parse(item.expiresAt) > now.value))
const expires = computed(() => {
  if (!reset.value) return ''
  const date = new Date(reset.value.expiresAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
})
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 1000) })
onBeforeUnmount(() => clearInterval(timer))
const access = ref<'enabled' | 'disabled'>('enabled')
watch(() => props.user, user => {
  projectIds.value = [...user.projectIds]
  role.value = user.role === 'viewer' ? 'viewer' : 'member'
  access.value = user.disabled ? 'disabled' : 'enabled'
}, { immediate: true })
</script>
<template>
  <form class="collab-card collab-form" @submit.prevent="emit('save', user.id, projectIds, access === 'disabled', role)">
    <h3>{{ user.displayName || user.username }} <small>（{{ user.username }}）</small></h3>
    <p v-if="user.role === 'owner'">负责人 · 此处不能取消负责人权限或禁用负责人。</p>
    <template v-else>
      <label>角色<select v-model="role" :disabled="busy"><option value="member">成员</option><option value="viewer">只读访客</option></select></label>
      <ProjectChoices v-model="projectIds" :projects="projects" :disabled="busy" />
      <label>账号访问状态<select v-model="access" required :disabled="busy"><option value="enabled">启用</option><option value="disabled">禁用</option></select></label>
      <button class="btn" :disabled="busy">保存授权</button>
      <button class="btn" type="button" :disabled="busy" @click="emit('reset', user.id)">生成重置码</button>
      <small v-if="reset">有一个未使用的重置码，{{ expires }} 到期</small>
    </template>
  </form>
</template>
