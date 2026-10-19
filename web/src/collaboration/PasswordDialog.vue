<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { apiJson, ApiError } from './http'
import { passwordProblem } from './board'
import ModalShell from './ModalShell.vue'
const emit = defineEmits<{ close: []; changed: [] }>()
const currentPassword = ref('')
const newPassword = ref('')
const confirm = ref('')
const error = ref('')
const busy = ref(false)
const controller = new AbortController()
async function save() {
  if (busy.value) return
  error.value = passwordProblem(newPassword.value, confirm.value)
  if (!currentPassword.value) error.value = '请填写当前密码'
  if (error.value) return
  busy.value = true
  try {
    await apiJson('/api/auth/password', { currentPassword: currentPassword.value, newPassword: newPassword.value }, controller.signal)
    if (!controller.signal.aborted) emit('changed')
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof ApiError && cause.status === 400
      ? `${cause.message}（请检查当前密码后重试，不会把你踢下线）` : cause instanceof Error ? cause.message : '修改失败，请重试'
  } finally { busy.value = false; currentPassword.value = ''; newPassword.value = ''; confirm.value = '' }
}
onBeforeUnmount(() => { controller.abort(); currentPassword.value = ''; newPassword.value = ''; confirm.value = '' })
</script>
<template>
  <ModalShell title="修改密码" @close="$emit('close')"><form class="collab-form" @submit.prevent="save">
    <label>当前密码<input v-model="currentPassword" type="password" required autocomplete="current-password" maxlength="128" :disabled="busy" /></label>
    <label>新密码（至少 6 位）<input v-model="newPassword" type="password" required minlength="6" maxlength="128" autocomplete="new-password" :disabled="busy" /></label>
    <label>再输一次新密码<input v-model="confirm" type="password" required minlength="6" maxlength="128" autocomplete="new-password" :disabled="busy" /></label>
    <small>改好后，你在其他电脑和浏览器上的登录会全部退出，这台保持登录。</small>
    <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
    <footer class="collab-dialog-foot"><button type="button" class="btn quiet" @click="$emit('close')">取消</button><button class="btn primary" :disabled="busy">{{ busy ? '提交中…' : '保存新密码' }}</button></footer>
  </form></ModalShell>
</template>
