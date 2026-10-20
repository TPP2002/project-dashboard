<script setup lang="ts">
import type { Project } from './types'
const props = defineProps<{ projects: Project[]; modelValue: string[]; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
function toggle(id: string, event: Event) {
  const selected = (event.target as HTMLInputElement).checked
  emit('update:modelValue', selected ? [...new Set([...props.modelValue, id])] : props.modelValue.filter(value => value !== id))
}
</script>
<template>
  <fieldset :disabled="disabled" class="collab-choices">
    <legend>可访问的项目</legend>
    <p v-if="!projects.length">暂无项目</p>
    <label v-for="project in projects" :key="project.id"><input type="checkbox" :aria-label="project.name" :checked="modelValue.includes(project.id)" @change="toggle(project.id, $event)" />{{ project.name }}</label>
  </fieldset>
</template>
