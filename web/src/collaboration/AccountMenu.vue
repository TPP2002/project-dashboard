<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { User } from './types'
import PasswordDialog from './PasswordDialog.vue'
import CollabIcon from './CollabIcon.vue'
const props = defineProps<{ user: User; busy?: boolean }>()
defineEmits<{ logout: [] }>()
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const opened = ref(false)
const passwordOpen = ref(false)
const notice = ref('')
const roleLabel = computed(() => ({ owner: '负责人', member: '成员', viewer: '只读访客' })[props.user.role])
let timer: ReturnType<typeof setTimeout> | undefined
function closeMenu() { opened.value = false; trigger.value?.focus() }
function outside(event: MouseEvent) { if (!root.value?.contains(event.target as Node)) opened.value = false }
function closePassword() { passwordOpen.value = false; void nextTick(() => trigger.value?.focus()) }
function changed() { closePassword(); notice.value = '改好了，其他电脑和浏览器上的登录已退出'; clearTimeout(timer); timer = setTimeout(() => { notice.value = '' }, 6000) }
onMounted(() => document.addEventListener('click', outside))
onBeforeUnmount(() => { clearTimeout(timer); document.removeEventListener('click', outside) })
</script>
<template>
  <div ref="root" class="account-menu" @keydown.esc.stop="closeMenu">
    <button ref="trigger" type="button" class="btn account-trigger" :aria-expanded="opened" :disabled="busy" @click="opened = !opened"><span class="account-avatar">{{ (user.displayName || user.username).slice(0, 1) }}</span>{{ user.displayName || user.username }}</button>
    <div v-if="opened" class="account-dropdown"><p>{{ user.displayName || user.username }} · {{ roleLabel }}</p><button type="button" class="btn quiet" @click="opened = false; passwordOpen = true"><CollabIcon name="lock" />修改密码</button><button type="button" class="btn quiet" :disabled="busy" @click="opened = false; $emit('logout')"><CollabIcon name="out" />退出登录</button></div>
    <PasswordDialog v-if="passwordOpen" @close="closePassword" @changed="changed" />
    <p v-if="notice" class="account-notice" role="status">{{ notice }}</p>
  </div>
</template>
<style scoped>
.account-menu { position: relative; }.account-trigger { border-radius: 999px; padding: 4px 10px 4px 5px; }.account-avatar { width: 22px; height: 22px; border-radius: 50%; display: inline-grid; place-items: center; color: var(--chart-on-series); background: var(--chart-1); font-size: var(--fs-xs); }
.account-dropdown { position: absolute; right: 0; top: calc(100% + 6px); width: 220px; z-index: 30; border: 1px solid var(--line-strong); border-radius: var(--r); background: var(--surface); box-shadow: 0 6px 18px var(--drawer-shadow); padding: 4px; display: grid; }.account-dropdown p { padding: 6px 10px; font-size: var(--fs-sm); margin: 0; border-bottom: 1px solid var(--line); }.account-dropdown button { justify-content: flex-start; }
.account-notice { position: fixed; bottom: var(--s5); right: var(--s5); max-width: calc(100vw - 48px); padding: var(--s3); border: 1px solid var(--line); border-radius: var(--r); color: var(--text); background: var(--surface); box-shadow: var(--shadow); z-index: 40; }
</style>
