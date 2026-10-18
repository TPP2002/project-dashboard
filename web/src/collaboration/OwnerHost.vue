<script setup lang="ts">
import { createApp, onBeforeUnmount, onMounted, ref, type App as VueApp } from 'vue'
import { createPinia, disposePinia } from 'pinia'
import { cancelAuthRequests } from './http'

const target = ref<HTMLElement | null>(null)
const error = ref('')
let app: VueApp | null = null
let disposed = false
const pinia = createPinia()
onMounted(async () => {
  try {
    // Neither owner router guards nor board stores run on the member/login path.
    const [{ default: App }, { default: router }] = await Promise.all([import('../App.vue'), import('../router')])
    if (disposed || !target.value) return
    app = createApp(App).use(pinia).use(router)
    app.mount(target.value)
  } catch { if (!disposed) error.value = '看板加载失败，请刷新页面重试' }
})
onBeforeUnmount(() => {
  disposed = true
  app?.unmount()
  cancelAuthRequests()
  disposePinia(pinia)
  pinia.state.value = {}
})
</script>
<template><div class="collab-owner"><p v-if="error" role="alert">{{ error }}</p><div ref="target" /></div></template>
