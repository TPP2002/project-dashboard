<script setup lang="ts">
import { emojiFor, statusTone } from '@/api/schema'
const props = defineProps<{ status: string; small?: boolean }>()
</script>

<template>
  <span class="badge" :class="[statusTone(status), { compact: props.small }]">
    <span>{{ emojiFor(status) }}</span><span>{{ status }}</span>
  </span>
</template>
