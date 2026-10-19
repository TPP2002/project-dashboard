<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { apiJson } from './http'
import { inviteState } from './flow'
import { rememberBrowser } from './rememberBrowser'
import type { AdminData, Device, Invite, Project } from './types'
import ProjectChoices from './ProjectChoices.vue'
import SecretDisplay from './SecretDisplay.vue'
import UserAccess from './UserAccess.vue'
const data = ref<AdminData | null>(null)
const projects = ref<Project[]>([])
const selected = ref<string[]>([])
const hours = ref(24)
const maxUses = ref(1)
const inviteRole = ref<'member' | 'viewer'>('member')
const label = ref('')
const secret = ref<{ token: string; kind: 'invite' | 'device' | 'reset' } | null>(null)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const controller = new AbortController()
async function load() {
  // Do not leave stale permission data editable if refresh fails.
  data.value = null
  const [admin, list] = await Promise.all([
    apiJson<AdminData>('/api/auth/admin', undefined, controller.signal),
    apiJson<{ projects: Project[] }>('/api/projects', undefined, controller.signal),
  ])
  if (controller.signal.aborted) return
  data.value = admin
  projects.value = list.projects
  selected.value = selected.value.filter(id => list.projects.some(project => project.id === id))
}
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''; notice.value = ''; secret.value = null
  try { await action() }
  catch (cause) { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '操作失败' }
  finally { busy.value = false }
}
function refresh() { return run(load) }
function createInvite() {
  return run(async () => {
    const result = await apiJson<{ invite: Invite; token: string }>('/api/auth/invites', { projectIds: selected.value, expiresInHours: hours.value, maxUses: maxUses.value, role: inviteRole.value }, controller.signal)
    if (controller.signal.aborted) return
    secret.value = { token: result.token, kind: 'invite' }
    await load()
  })
}
function createDevice() {
  return run(async () => {
    const result = await apiJson<{ device: Device; token: string }>('/api/auth/devices', { label: label.value.trim() }, controller.signal)
    if (controller.signal.aborted) return
    secret.value = { token: result.token, kind: 'device' }; label.value = ''
    await load()
  })
}
function trustBrowser() {
  return run(async () => {
    notice.value = await rememberBrowser(label.value, load, controller.signal)
  })
}
function revoke(kind: 'invites' | 'devices', id: string) {
  return run(async () => {
    await apiJson(`/api/auth/${kind}/${encodeURIComponent(id)}/revoke`, {}, controller.signal)
    await load(); notice.value = '已撤销'
  })
}
function saveUser(id: string, projectIds: string[], disabled: boolean, role: 'member' | 'viewer') {
  return run(async () => {
    await apiJson(`/api/auth/users/${encodeURIComponent(id)}/access`, { projectIds, disabled, role }, controller.signal)
    await load(); notice.value = '授权已保存'
  })
}
function createReset(id: string) {
  return run(async () => {
    const result = await apiJson<{ resetToken: string }>(`/api/auth/users/${encodeURIComponent(id)}/reset`, {}, controller.signal)
    if (controller.signal.aborted) return
    secret.value = { token: result.resetToken, kind: 'reset' }
    await load()
  })
}
onMounted(refresh)
onBeforeUnmount(() => { controller.abort(); secret.value = null; data.value = null; projects.value = [] })
</script>
<template>
  <main class="collab collab-page" :aria-busy="busy">
    <div class="collab-heading"><h1>成员与邀请</h1><button class="btn" :disabled="busy" @click="refresh">刷新</button></div>
    <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <SecretDisplay v-if="secret" :token="secret.token" :kind="secret.kind" @dismiss="secret = null" />
    <p v-if="!data">{{ busy ? '正在读取管理信息…' : '管理信息尚未加载，请刷新重试。' }}</p>
    <template v-else>
      <h2>邀请新成员</h2>
      <form class="collab-card collab-form" @submit.prevent="createInvite">
        <fieldset class="invite-roles" :disabled="busy"><legend>邀请角色</legend><button type="button" class="btn" :aria-pressed="inviteRole === 'member'" @click="inviteRole = 'member'">成员</button><button type="button" class="btn" :aria-pressed="inviteRole === 'viewer'" @click="inviteRole = 'viewer'">只读访客</button></fieldset>
        <ProjectChoices v-model="selected" :projects="projects" :disabled="busy" />
        <label>有效时长（小时）<input v-model.number="hours" type="number" required min="1" step="1" :disabled="busy" /></label>
        <label>最多使用次数<input v-model.number="maxUses" type="number" required min="1" step="1" :disabled="busy" /></label>
        <button class="btn" :disabled="busy">生成邀请码</button>
      </form>
      <div class="collab-grid">
        <article v-for="item in data.invites" :key="item.id" class="collab-card">
          <h3>邀请 {{ item.id }}</h3>
          <span class="badge info">{{ item.role === 'viewer' ? '只读访客' : '成员' }}</span>
          <p>{{ inviteState(item) }} · 已使用 {{ item.uses }} / {{ item.maxUses }} 次</p>
          <p>到期：{{ new Date(item.expiresAt).toLocaleString() }}</p>
          <p>项目：{{ item.projectIds.map(id => projects.find(project => project.id === id)?.name || id).join('、') || '未授权项目' }}</p>
          <button class="btn" :disabled="busy || item.revoked" @click="revoke('invites', item.id)">撤销邀请</button>
        </article>
      </div>
      <p v-if="!data.invites.length">尚未创建邀请。</p>
      <h2>用户授权</h2>
      <div class="collab-grid"><UserAccess v-for="user in data.users" :key="user.id" :user="user" :projects="projects" :busy="busy" :resets="data.resets" @save="saveUser" @reset="createReset" /></div>
      <h2>负责人设备</h2>
      <p>设备凭据可用于登录；撤销设备会同时撤销它建立的会话。</p>
      <p>仅在自己的常用浏览器中主动开启信任，之后可减少重复登录。主动退出会取消此浏览器信任；其他设备可在下方列表撤销。</p>
      <form class="collab-card collab-form" @submit.prevent="createDevice">
        <label>设备名称<input v-model="label" required placeholder="我的常用浏览器" :disabled="busy" /></label>
        <button class="btn" type="button" :disabled="busy" @click="trustBrowser">信任此浏览器90天</button>
        <small>浏览器信任无需复制凭据；设备名称留空时使用“我的常用浏览器”。</small>
        <button class="btn" :disabled="busy || !label.trim()">手动创建设备凭据</button>
      </form>
      <div class="collab-grid">
        <article v-for="device in data.devices" :key="device.id" class="collab-card">
          <h3>{{ device.label }}</h3><p>{{ device.revoked ? '已撤销' : device.expiresAt && Date.parse(device.expiresAt) <= Date.now() ? '已到期' : '有效' }} · 创建于 {{ new Date(device.createdAt).toLocaleString() }}</p>
          <p v-if="device.expiresAt">到期时间：{{ new Date(device.expiresAt).toLocaleString() }}</p>
          <button class="btn" :disabled="busy || device.revoked" @click="revoke('devices', device.id)">撤销设备</button>
        </article>
      </div>
      <p v-if="!data.devices.length">尚未创建设备凭据。</p>
    </template>
  </main>
</template>
<style scoped>
.invite-roles { border: 0; padding: 0; }.invite-roles legend { margin-bottom: var(--s2); }.invite-roles button { border-radius: 0; }.invite-roles button:first-of-type { border-radius: var(--r) 0 0 var(--r); }.invite-roles button:last-child { border-radius: 0 var(--r) var(--r) 0; }.invite-roles [aria-pressed=true] { background: var(--text); color: var(--bg); }
</style>
