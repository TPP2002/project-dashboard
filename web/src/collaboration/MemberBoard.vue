<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { MemberTask, Project, User } from './types'
import { MemberLoader, memberApi } from './member'
import MemberTaskCard from './MemberTaskCard.vue'
const props = defineProps<{ user: User }>()
const projects = ref<Project[]>([])
const projectId = ref('')
const tasks = ref<MemberTask[]>([])
const loading = ref(false)
const writing = ref(false)
const error = ref('')
const notice = ref('')
const revision = ref(0)
const api = memberApi()
const loader = new MemberLoader(api)
const writes = new AbortController()
let refreshEpoch = 0
let disposed = false
let timer: ReturnType<typeof setInterval> | undefined
async function refresh() {
  const epoch = ++refreshEpoch
  const selected = projectId.value
  loading.value = true
  try {
    const snapshot = await loader.load(selected, props.user.projectIds)
    if (!snapshot || disposed || epoch !== refreshEpoch) return
    projects.value = snapshot.projects; projectId.value = snapshot.projectId; tasks.value = snapshot.tasks
  } catch (cause) {
    if (!disposed && epoch === refreshEpoch) {
      tasks.value = []; projects.value = []
      error.value = cause instanceof Error ? cause.message : '读取任务失败'
    }
  } finally { if (epoch === refreshEpoch) loading.value = false }
}
async function mutate(taskId: string, progress?: { percent: number; note: string }) {
  if (writing.value || loading.value || !projectId.value) return
  const selected = projectId.value
  writing.value = true; error.value = ''; notice.value = ''
  try {
    if (progress) await api.progress(selected, taskId, progress.percent, progress.note, writes.signal)
    else await api.claim(selected, taskId, writes.signal)
    if (disposed) return
    revision.value++
    notice.value = progress ? '进度已提交；完成后请等待负责人验收。' : '领取成功'
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : '操作失败'
  } finally {
    // Includes 403/409: never invent ownership or progress; reload current server truth.
    if (!disposed) { await refresh(); writing.value = false }
  }
}
function onProject(event: Event) {
  tasks.value = []
  projectId.value = (event.target as HTMLSelectElement).value
  error.value = ''; notice.value = ''; void refresh()
}
function visibleRefresh() { if (!document.hidden && !writing.value && !loading.value) void refresh() }
watch(() => props.user.projectIds.join('\0'), () => { tasks.value = []; projects.value = []; void refresh() })
onMounted(() => {
  void refresh()
  timer = setInterval(visibleRefresh, 15_000)
  document.addEventListener('visibilitychange', visibleRefresh)
})
onBeforeUnmount(() => {
  disposed = true; refreshEpoch++; loader.cancel(); writes.abort(); clearInterval(timer)
  tasks.value = []; projects.value = []; projectId.value = ''
  document.removeEventListener('visibilitychange', visibleRefresh)
})
</script>
<template>
  <main class="collab collab-page" :aria-busy="loading || writing">
    <h1>我的协作任务</h1>
    <div class="collab-heading">
      <label>授权项目<select :value="projectId" :disabled="loading || writing || !projects.length" @change="onProject"><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
      <button class="btn" :disabled="loading || writing" @click="error = ''; notice = ''; refresh()">刷新任务</button>
    </div>
    <p v-if="error" role="alert" class="collab-error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="loading" role="status">正在核对项目授权并读取任务…</p>
    <p v-else-if="!projects.length">暂无可访问的项目，请联系负责人授权。</p>
    <p v-else-if="!tasks.length">此项目暂无任务。</p>
    <div class="collab-grid">
      <MemberTaskCard v-for="task in tasks" :key="projectId + ':' + task.id + ':' + revision" :task="task" :user-id="user.id" :busy="writing || loading" @claim="mutate" @progress="(id, percent, note) => mutate(id, { percent, note })" />
    </div>
  </main>
</template>
