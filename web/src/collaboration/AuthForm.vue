<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { apiJson } from './http'
import { passwordProblem } from './board'
import type { Session } from './types'
const props = defineProps<{ invite: string; sessionError: string }>()
const emit = defineEmits<{ authenticated: [session: Session] }>()
const registering = ref(!!props.invite)
const inviteToken = ref(props.invite)
const username = ref('')
const displayName = ref('')
const password = ref('')
const resetting = ref(false)
const resetToken = ref('')
const confirm = ref('')
const error = ref('')
const busy = ref(false)
const controller = new AbortController()
function changeMode(mode: 'login' | 'register' | 'reset') {
  registering.value = mode === 'register'; resetting.value = mode === 'reset'
  password.value = ''; confirm.value = ''; resetToken.value = ''; error.value = ''
}
async function submit() {
  if (busy.value) return
  error.value = ''
  if (registering.value && !inviteToken.value.trim()) { error.value = '注册需要邀请码，请向负责人索取'; return }
  if (registering.value || resetting.value) {
    error.value = passwordProblem(password.value, resetting.value ? confirm.value : password.value)
    if (error.value) return
  }
  if (resetting.value && !resetToken.value.trim()) { error.value = '请填写负责人给你的重置码'; return }
  busy.value = true
  try {
    const session = await apiJson<Session>(`/api/auth/${resetting.value ? 'reset-password' : registering.value ? 'register' : 'login'}`, resetting.value ? { resetToken: resetToken.value.trim(), newPassword: password.value } : {
      username: username.value.trim(), password: password.value,
      ...(registering.value ? { inviteToken: inviteToken.value.trim(), displayName: displayName.value.trim() } : {}),
    }, controller.signal)
    if (controller.signal.aborted) return
    if (!session.user || session.mode !== 'collaboration') throw new Error('服务器未建立登录会话，请重试')
    inviteToken.value = ''
    emit('authenticated', session)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '登录失败，请重试' }
  finally { password.value = ''; confirm.value = ''; resetToken.value = ''; busy.value = false }
}
onBeforeUnmount(() => { controller.abort(); password.value = ''; confirm.value = ''; resetToken.value = ''; inviteToken.value = '' })
</script>
<template>
  <main class="collab collab-auth">
    <h1>{{ resetting ? '用重置码设新密码' : registering ? '受邀加入项目看板' : '登录项目看板' }}</h1>
    <p>使用用户名登录，无需邮箱。新成员请先向负责人索取邀请。</p>
    <form class="collab-card collab-form" @submit.prevent="submit">
      <label v-if="registering">邀请码<input v-model="inviteToken" required autocomplete="off" spellcheck="false" :disabled="busy" /></label>
      <label v-if="resetting">重置码（找负责人要）<input v-model="resetToken" required autocomplete="off" spellcheck="false" :disabled="busy" /></label>
      <label v-else>用户名<input v-model="username" required autocomplete="username" :disabled="busy" /></label>
      <label v-if="registering">显示名<input v-model="displayName" required autocomplete="nickname" :disabled="busy" /></label>
      <label>{{ resetting ? '新密码（至少 6 位）' : '密码' }}<input v-model="password" required type="password" :minlength="registering || resetting ? 6 : undefined" maxlength="128" :autocomplete="registering || resetting ? 'new-password' : 'current-password'" :disabled="busy" /></label>
      <label v-if="resetting">再输一次<input v-model="confirm" required type="password" minlength="6" maxlength="128" autocomplete="new-password" :disabled="busy" /></label>
      <small v-if="registering">密码需要 6 到 128 个字符，不要求混合字母数字。</small>
      <small v-if="resetting">重置码 24 小时内有效、只能用一次；设好后旧的登录全部失效。</small>
      <p v-if="error || sessionError" class="collab-error" role="alert">{{ error || sessionError }}</p>
      <button class="btn primary" :disabled="busy || (registering && !inviteToken.trim())">{{ busy ? '正在提交…' : resetting ? '设新密码并登录' : registering ? '注册并登录' : '登录' }}</button>
      <button class="btn quiet" type="button" :disabled="busy" @click="changeMode(registering || resetting ? 'login' : 'register')">{{ registering || resetting ? '返回登录' : '使用邀请码注册' }}</button>
      <button v-if="!resetting && !registering" class="btn quiet" type="button" :disabled="busy" @click="changeMode('reset')">有重置码？设新密码</button>
    </form>
  </main>
</template>
