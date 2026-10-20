<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Session } from './types'
import { apiJson, clearAuthContext, onSessionExpired, setAuthContext } from './http'
import { consumeInvite, sessionView } from './flow'
import OwnerHost from './OwnerHost.vue'
import AuthForm from './AuthForm.vue'
import MemberBoard from './MemberBoard.vue'
import AccountMenu from './AccountMenu.vue'
import './collaboration.css'

const AdminPanel = defineAsyncComponent(() => import('./AdminPanel.vue'))

const session = ref<Session | null>(null)
const error = ref('')
const busy = ref(false)
const adminOpen = ref(false)
const invite = ref(consumeInvite(window.location, window.history))
const inviteRevision = ref(0)
const view = computed(() => sessionView(session.value))
let epoch = 0
let checking = false
let timer: ReturnType<typeof setInterval> | undefined
function accept(next: Session) {
  if (next.mode !== 'local' && next.mode !== 'collaboration') throw new Error('服务器未返回有效运行模式')
  if (next.user && !['owner', 'member', 'viewer'].includes(next.user.role)) throw new Error('服务器未返回有效身份')
  setAuthContext(next)
  session.value = next
  error.value = ''
  if (next.user) invite.value = ''
}
function expired() {
  epoch++
  adminOpen.value = false
  session.value = { ok: true, mode: 'collaboration', user: null }
  error.value = '会话已失效，请重新登录'
}
const unsubscribe = onSessionExpired(expired)
async function checkSession() {
  if (checking) return
  checking = true
  const started = epoch
  try {
    const next = await apiJson<Session>('/api/auth/session')
    if (started !== epoch) return
    if (session.value?.user && session.value.user.id !== next.user?.id) {
      clearAuthContext()
      adminOpen.value = false
    }
    accept(next)
  } catch (cause) {
    if (started === epoch && !(cause instanceof DOMException && cause.name === 'AbortError')) error.value = cause instanceof Error ? cause.message : '无法检查登录状态'
  } finally { checking = false }
}
async function logout() {
  busy.value = true
  try {
    await apiJson('/api/auth/logout', {})
    clearAuthContext()
    expired()
    error.value = ''
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '退出失败，请重试' }
  finally { busy.value = false }
}
function authenticated(next: Session) { epoch++; accept(next) }
function onVisible() { if (!document.hidden && session.value?.mode === 'collaboration') void checkSession() }
function onHashChange() {
  const token = consumeInvite(window.location, window.history)
  if (token && !session.value?.user) {
    invite.value = token
    inviteRevision.value++
  }
}
onMounted(() => {
  window.addEventListener('hashchange', onHashChange)
  void checkSession()
  timer = setInterval(onVisible, 30_000)
  document.addEventListener('visibilitychange', onVisible)
})
onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange)
  epoch++
  clearInterval(timer)
  unsubscribe()
  clearAuthContext()
  document.removeEventListener('visibilitychange', onVisible)
})
</script>
<template>
  <main v-if="view === 'loading'" class="collab collab-auth" aria-live="polite">
    <p>{{ error || '正在检查登录状态…' }}</p>
    <button v-if="error" class="btn" @click="checkSession">重试</button>
  </main>
  <AuthForm v-else-if="view === 'login'" :key="inviteRevision" :invite="invite" :session-error="error" @authenticated="authenticated" />
  <template v-else>
    <div v-if="view === 'owner'" class="collab collab-toolbar">
      <button v-if="view === 'owner'" class="btn" @click="adminOpen = !adminOpen">{{ adminOpen ? '返回看板' : '成员与邀请' }}</button>
      <AccountMenu v-if="session?.user" :user="session.user" :busy="busy" @logout="logout" />
      <span v-if="error" role="alert">{{ error }}</span>
    </div>
    <AdminPanel v-if="view === 'owner' && adminOpen" />
    <OwnerHost v-if="view === 'local' || view === 'owner'" v-show="!adminOpen" :key="view + (session?.user?.id || '')" />
    <MemberBoard v-else-if="(view === 'member' || view === 'viewer') && session?.user" :key="view + session.user.id" :user="session.user">
      <template #account><AccountMenu :user="session.user" :busy="busy" @logout="logout" /><span v-if="error" role="alert">{{ error }}</span></template>
    </MemberBoard>
  </template>
</template>
