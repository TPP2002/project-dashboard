<script setup lang="ts">
import { ref, watch } from 'vue'
import ProjectChoices from './ProjectChoices.vue'
import type { Project, User } from './types'
const props = defineProps<{ user: User; projects: Project[]; busy: boolean }>()
const emit = defineEmits<{ save: [id: string, projectIds: string[], disabled: boolean] }>()
const projectIds = ref<string[]>([])
const access = ref<'enabled' | 'disabled'>('enabled')
watch(() => props.user, user => {
  projectIds.value = [...user.projectIds]
  access.value = user.disabled ? 'disabled' : 'enabled'
}, { immediate: true })
</script>
<template>
  <form class="collab-card collab-form" @submit.prevent="emit('save', user.id, projectIds, access === 'disabled')">
    <h3>{{ user.displayName || user.username }} <small>（{{ user.username }}）</small></h3>
    <p v-if="user.role === 'owner'">负责人 · 此处不能取消负责人权限或禁用负责人。</p>
    <template v-else>
      <ProjectChoices v-model="projectIds" :projects="projects" :disabled="busy" />
      <label>账号访问状态<select v-model="access" required :disabled="busy"><option value="enabled">启用</option><option value="disabled">禁用</option></select></label>
      <button class="btn" :disabled="busy">保存授权</button>
    </template>
  </form>
</template>
