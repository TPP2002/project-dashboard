<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Collaborator, MemberTask, Project, TaskAction, User } from './types'
import { MemberLoader, memberApi } from './member'
import { drawerActions, groupLanes } from './board'
import MemberTaskCard from './MemberTaskCard.vue'
import MemberDrawer from './MemberDrawer.vue'
import ActionDialog from './ActionDialog.vue'
import CollabIcon from './CollabIcon.vue'
const props = defineProps<{ user: User }>()
const canCreate = computed(() => props.user.role === 'member')
const viewer = computed(() => props.user.role === 'viewer')
const projects = ref<Project[]>([])
const projectId = ref('')
const tasks = ref<MemberTask[]>([])
const loading = ref(false)
const writing = ref(false)
const error = ref('')
const notice = ref('')
const selectedId = ref('')
const voidOpen = ref(false)
const selected = computed(() => tasks.value.find(task => task.id === selectedId.value))
const groups = computed(() => groupLanes(tasks.value))
const lanes = computed(() => groups.value.filter(group => group.name !== '已作废'))
const voided = computed(() => groups.value.find(group => group.name === '已作废')!.tasks)
const dialog = ref<{ action: TaskAction | 'create'; task?: MemberTask; person?: Collaborator } | null>(null)
const api = memberApi()
const loader = new MemberLoader(api)
const writes = new AbortController()
let refreshEpoch = 0
let disposed = false
let timer: ReturnType<typeof setInterval> | undefined
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let opener: HTMLElement | null = null
async function refresh(preserveWriteError = false) {
  const epoch = ++refreshEpoch
  loading.value = true
  try {
    const snapshot = await loader.load(projectId.value, props.user.projectIds)
    if (!snapshot || disposed || epoch !== refreshEpoch) return
    if (projectId.value !== snapshot.projectId) { selectedId.value = ''; dialog.value = null }
    projects.value = snapshot.projects; projectId.value = snapshot.projectId; tasks.value = snapshot.tasks
    if (selectedId.value && !selected.value) { selectedId.value = ''; dialog.value = null }
  } catch (cause) {
    if (!disposed && epoch === refreshEpoch) {
      tasks.value = []; projects.value = []; selectedId.value = ''; dialog.value = null
      const readError = cause instanceof Error ? cause.message : '读取任务失败'
      error.value = preserveWriteError && error.value ? `${error.value}；刷新失败：${readError}` : readError
    }
  } finally { if (epoch === refreshEpoch) loading.value = false }
}
function flash(text: string) { notice.value = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice.value = '' }, 5000) }
async function mutate(taskId: string, action: TaskAction | 'create', body: unknown): Promise<void> {
  if (writing.value || loading.value || !projectId.value) throw new Error('正在读取或提交，请稍后再试')
  if (action === 'create' ? !canCreate.value : !tasks.value.find(task => task.id === taskId)?.actions?.includes(action)) throw new Error('此刻不能执行此操作，请刷新查看')
  writing.value = true; error.value = ''; notice.value = ''
  try {
    if (action === 'create') await api.create(projectId.value, body as { title: string; description?: string }, writes.signal)
    else await api.act(projectId.value, taskId, action, body, writes.signal)
    if (!disposed) flash(action === 'join' ? '已加入协作，可以更新进度和留言了' : '已提交')
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : '操作失败'
    throw cause
  } finally {
    // Re-read after every attempted write, including 403/404/409. No optimistic card state.
    if (!disposed) { await refresh(true); writing.value = false }
  }
}
function action(task: MemberTask, name: TaskAction) {
  if (writing.value || loading.value) return
  const entry = drawerActions(task).find(item => item.action === name)
  if (!entry) return
  if (entry.needs === 'none') { void mutate(task.id, name, {}).catch(() => {}); return }
  dialog.value = { task, action: name }
}
function remove(task: MemberTask, person: Collaborator) { if (task.actions?.includes('removeCollaborator') && !writing.value) dialog.value = { task, action: 'removeCollaborator', person } }
async function submitDialog(body: unknown) {
  const current = dialog.value
  if (!current) throw new Error('操作已关闭')
  await mutate(current.task?.id ?? '', current.action, body)
  if (dialog.value === current) dialog.value = null
}
function open(task: MemberTask) { opener = document.activeElement as HTMLElement; selectedId.value = task.id }
function closeDrawer() { selectedId.value = ''; void nextTick(() => { if (opener?.isConnected) opener.focus() }) }
function onProject(event: Event) {
  tasks.value = []; selectedId.value = ''; dialog.value = null; voidOpen.value = false
  projectId.value = (event.target as HTMLSelectElement).value
  error.value = ''; notice.value = ''; void refresh()
}
function visibleRefresh() { if (!document.hidden && !writing.value && !loading.value) void refresh() }
watch(() => props.user.projectIds.join('\0'), () => { tasks.value = []; projects.value = []; selectedId.value = ''; dialog.value = null; void refresh() })
onMounted(() => { void refresh(); timer = setInterval(visibleRefresh, 15_000); document.addEventListener('visibilitychange', visibleRefresh) })
onBeforeUnmount(() => {
  disposed = true; refreshEpoch++; loader.cancel(); writes.abort(); clearInterval(timer); clearTimeout(noticeTimer)
  tasks.value = []; projects.value = []; projectId.value = ''
  document.removeEventListener('visibilitychange', visibleRefresh)
})
</script>
<template>
  <main class="collab member-board" :aria-busy="loading || writing">
    <header class="member-topbar"><b>看板</b><label class="member-project"><span class="sr-only">项目</span><select :value="projectId" :disabled="loading || writing || !projects.length" @change="onProject"><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label><span class="badge" :class="viewer ? 'n' : 'info'"><CollabIcon v-if="viewer" name="eye" />{{ viewer ? '只读访客' : '成员' }}</span><span class="spacer" /><button v-if="canCreate" class="btn primary" :disabled="!projectId || loading || writing" @click="dialog = { action: 'create' }"><CollabIcon name="plus" />新建卡片</button><slot name="account" /></header>
    <div v-if="error" class="board-error" role="alert">操作或读取失败：{{ error }} <button class="btn btn-sm" :disabled="loading || writing" @click="error = ''; refresh()">重新读取</button></div>
    <p v-if="loading && !projects.length" class="board-empty" role="status">正在核对项目授权并读取任务…</p>
    <p v-else-if="!projects.length" class="board-empty">暂无可访问的项目，请联系负责人授权。</p>
    <div v-else class="member-body">
      <div class="member-lanes" aria-label="任务泳道">
        <section v-for="lane in lanes" :key="lane.name" class="member-lane"><header><i :class="{ active: lane.name === '施工中', warn: lane.name === '待拍板', done: lane.name === '已完工' }" />{{ lane.name }}<span>{{ lane.tasks.length }}</span></header><div class="member-lane-scroll"><MemberTaskCard v-for="task in lane.tasks" :key="task.id" :task="task" :user-id="user.id" :selected="selectedId === task.id" :busy="loading || writing" @open="open(task)" @action="action(task, $event)" /><p v-if="!lane.tasks.length" class="lane-empty">暂无卡片</p></div></section>
        <section class="member-lane void-lane" :class="{ collapsed: !voidOpen }"><header><button class="btn quiet" :aria-expanded="voidOpen" @click="voidOpen = !voidOpen">已作废 {{ voided.length }} 张</button></header><div v-if="voidOpen" class="member-lane-scroll"><MemberTaskCard v-for="task in voided" :key="task.id" :task="task" :user-id="user.id" :busy="loading || writing" :selected="selectedId === task.id" @open="open(task)" @action="action(task, $event)" /></div></section>
      </div>
      <MemberDrawer v-if="selected" :key="projectId + ':' + selected.id" :task="selected" :user="user" :busy="writing || loading" :send="text => mutate(selectedId, 'note', { text })" @close="closeDrawer" @action="action(selected, $event)" @remove="remove(selected, $event)" />
    </div>
    <div v-if="notice" class="member-toast" role="status">{{ notice }}</div>
    <ActionDialog v-if="dialog" :action="dialog.action" :task="dialog.task" :person="dialog.person" :submit="submitDialog" @close="dialog = null" />
  </main>
</template>
<style scoped>
.member-board { height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
.member-topbar { display: flex; align-items: center; gap: var(--s3); padding: var(--s2) var(--s3); border-bottom: 1px solid var(--line); background: var(--bg); flex: none; flex-wrap: wrap; }.member-project { max-width: 280px; }.member-topbar .badge { display: inline-flex; gap: 4px; align-items: center; }
.member-body { display: flex; min-height: 0; flex: 1; position: relative; overflow: hidden; }.member-lanes { display: flex; align-items: stretch; gap: var(--s2); padding: var(--s3); min-width: 0; flex: 1; overflow-x: auto; overflow-y: hidden; }
.member-lane { flex: 1 0 210px; min-width: 210px; display: flex; flex-direction: column; min-height: 0; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r); }.member-lane > header { display: flex; align-items: center; gap: 6px; padding: 8px 9px; border-bottom: 1px solid var(--line); font-size: var(--fs-sm); font-weight: 600; flex: none; }.member-lane > header span { margin-left: auto; font-family: var(--mono); color: var(--text-2); font-size: var(--fs-xs); }.member-lane > header i { width: 8px; height: 8px; background: var(--n); border-radius: 2px; }.member-lane > header i.active { background: var(--info); }.member-lane > header i.warn { background: var(--warn); }.member-lane > header i.done { background: var(--ok); }
.member-lane-scroll { flex: 1; overflow-y: auto; min-height: 0; padding: 7px; display: flex; flex-direction: column; gap: 7px; }.member-lane-scroll > * { flex: none; }.void-lane.collapsed { flex: 0 0 auto; min-width: auto; }.void-lane > header { padding: 2px; }.lane-empty { color: var(--text-3); text-align: center; font-size: var(--fs-xs); }.board-error { color: var(--bad); background: var(--bad-bg); padding: var(--s2) var(--s3); max-height: 20vh; overflow: auto; flex: none; }.board-empty { padding: var(--s3); }
.member-toast { position: fixed; bottom: var(--s5); left: 50%; transform: translateX(-50%); background: var(--text); color: var(--bg); border-radius: var(--r); padding: var(--s2) var(--s3); font-size: var(--fs-sm); z-index: 20; max-width: calc(100vw - 32px); }
</style>
