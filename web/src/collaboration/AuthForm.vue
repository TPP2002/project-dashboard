<script setup lang="ts">
import { ref } from 'vue'
import { apiJson } from './http'
import type { Session } from './types'
const props = defineProps<{ invite: string; sessionError: string }>()
const emit = defineEmits<{ authenticated: [session: Session] }>()
const registering = ref(!!props.invite)
const inviteToken = ref(props.invite)
const username = ref('')
const displayName = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)
async function submit() {
  if (busy.value) return
  error.value = ''
  if (registering.value && !inviteToken.value.trim()) { error.value = '注册需要邀请码，请向负责人索取'; return }
  if (registering.value && (password.value.length < 12 || password.value.length > 128)) { error.value = '密码需要 12 到 128 个字符'; return }
  busy.value = true
  try {
    const session = await apiJson<Session>(`/api/auth/${registering.value ? 'register' : 'login'}`, {
      username: username.value.trim(), password: password.value,
      ...(registering.value ? { inviteToken: inviteToken.value.trim(), displayName: displayName.value.trim() } : {}),
    })
    if (!session.user || session.mode !== 'collaboration') throw new Error('服务器未建立登录会话，请重试')
    inviteToken.value = ''
    emit('authenticated', session)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '登录失败，请重试' }
  finally { password.value = ''; busy.value = false }
}
</script>
<template>
  <main class="collab collab-auth">
    <h1>{{ registering ? '受邀加入项目看板' : '登录项目看板' }}</h1>
    <p>使用用户名登录，无需邮箱。新成员请先向负责人索取邀请。</p>
    <form class="collab-card collab-form" @submit.prevent="submit">
      <label v-if="registering">邀请码<input v-model="inviteToken" required autocomplete="off" spellcheck="false" :disabled="busy" /></label>
      <label>用户名<input v-model="username" required autocomplete="username" :disabled="busy" /></label>
      <label v-if="registering">显示名<input v-model="displayName" required autocomplete="nickname" :disabled="busy" /></label>
      <label>密码<input v-model="password" required type="password" :minlength="registering ? 12 : undefined" maxlength="128" :autocomplete="registering ? 'new-password' : 'current-password'" :disabled="busy" /></label>
      <small v-if="registering">密码需要 12 到 128 个字符。</small>
      <p v-if="error || sessionError" class="collab-error" role="alert">{{ error || sessionError }}</p>
      <button class="btn" :disabled="busy || (registering && !inviteToken.trim())">{{ busy ? '正在提交…' : registering ? '注册并登录' : '登录' }}</button>
      <button class="btn" type="button" :disabled="busy" @click="registering = !registering; error = ''; password = ''">{{ registering ? '已有账号，去登录' : '使用邀请码注册' }}</button>
    </form>
  </main>
</template>
