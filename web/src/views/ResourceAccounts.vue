<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PerksPanel from '@/components/resources/PerksPanel.vue'
import { fetchPerksAvailable, fetchPerksState, postPerksAction } from '@/api/perks'
import type { PerksAction, PerksState } from '@/api/perks'
import { statusLine, validateAccountName } from '@/utils/perksFormat'
import ResourcePanel from '@/components/resources/ResourcePanel.vue'
import ResourceDialog from '@/components/resources/ResourceDialog.vue'
import { fetchResources, postResourceAction } from '@/api/resources'
import type {
  ResourceSnapshot, ResourceAccount, ResourceAction, ResourceRowState, ResourceGroupState,
} from '@/api/resources'
import { isKeyProvider, validateLabel, validateKeyFile, limitViews } from '@/utils/resourcesFormat'

const status = ref<'loading' | 'ready' | 'error'>('loading')
const data = ref<ResourceSnapshot | null>(null)
const errorLine = ref('')
const refreshing = ref(false)
const rowState = ref<Record<string, ResourceRowState>>({})
const groupState = ref<Record<string, ResourceGroupState>>({})

const providers = () => data.value?.providers || []
function findAccount(id: string): ResourceAccount | null {
  return (data.value?.accounts || []).find((a) => a.id === id) || null
}

/**
 * 请求序号:并发读时先发的未必先回,只认最后发出的那次。
 * 已有旧数据时刷新失败不清空旧数据,只在顶部留一条错误提示。
 */
let reqSeq = 0
async function load() {
  const seq = ++reqSeq
  refreshing.value = true
  try {
    const snapshot = await fetchResources()
    if (seq !== reqSeq) return
    data.value = snapshot
    status.value = 'ready'
    errorLine.value = ''
  } catch (e) {
    if (seq !== reqSeq) return
    const msg = e instanceof Error ? e.message : '读取失败'
    errorLine.value = msg
    if (!data.value) status.value = 'error'
  } finally {
    if (seq === reqSeq) refreshing.value = false
  }
}
function refreshAll() { if (!refreshing.value) void load() }

const route = useRoute()
const router = useRouter()
const perksAvailable = ref(false)
const isPerks = computed(() => perksAvailable.value && route.query.tab === 'perks')
const perksStatus = ref<'loading' | 'ready' | 'error'>('loading')
const perksData = ref<PerksState | null>(null)
const perksError = ref('')
const perksNote = ref('')
const accountNote = ref('')
const acting = ref(false)
const nowMs = ref(Date.now())
const line = computed(() => perksData.value ? statusLine(perksData.value, nowMs.value, perksNote.value) : { kind: 'idle', text: '', canStop: false, canRetry: false, progress: null })
const perksBusy = computed(() => Boolean(perksData.value?.activity || (perksData.value?.job && perksData.value.job.finishedAt === null)))
let perksSeq = 0
let perksTimer: ReturnType<typeof setTimeout> | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null
let noteTimer: ReturnType<typeof setTimeout> | null = null
let lastPerksAction: PerksAction | null = null
let mounted = false
let disposed = false
function stopPerksTimer() { if (perksTimer) clearTimeout(perksTimer); perksTimer = null }
function schedulePerks() {
  stopPerksTimer()
  if (!mounted || !isPerks.value || document.visibilityState !== 'visible') return
  perksTimer = setTimeout(() => { void loadPerks() }, perksBusy.value ? 1000 : 5000)
}
async function loadPerks() {
  const seq = ++perksSeq
  try {
    const result = await fetchPerksState()
    if (seq !== perksSeq) return
    perksData.value = result
    perksStatus.value = 'ready'
    perksError.value = ''
  } catch (e) {
    if (seq !== perksSeq) return
    perksError.value = e instanceof Error ? e.message : '读取失败'
    if (!perksData.value) perksStatus.value = 'error'
  } finally { if (seq === perksSeq) schedulePerks() }
}
function clearNote() { perksNote.value = ''; if (noteTimer) clearTimeout(noteTimer); noteTimer = null }
async function perksAction(body: PerksAction, dialog = false): Promise<boolean> {
  if (acting.value) return false
  acting.value = true
  if (body.action === 'run' || body.action === 'login' || body.action === 'schedule') lastPerksAction = body
  const result = await postPerksAction(body)
  acting.value = false
  if (!result.ok) {
    if (dialog) perksDialogError.value = `没保存：${result.error || '操作失败'}`
    else {
      perksNote.value = body.action === 'stop' ? result.error || '操作失败' : `没办成：${result.error || '操作失败'}`
      if (noteTimer) clearTimeout(noteTimer)
      noteTimer = setTimeout(clearNote, 30_000)
    }
    return false
  }
  clearNote()
  await loadPerks()
  return true
}
function selectTab(tab: 'accounts' | 'perks') {
  const query = { ...route.query }
  if (tab === 'perks') query.tab = 'perks'; else delete query.tab
  void router.replace({ query })
}
function onVisibilityChange() {
  if (document.visibilityState === 'visible') { if (isPerks.value) void loadPerks(); else void load() }
  else { stopPerksTimer(); ++perksSeq }
}
let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  perksAvailable.value = await fetchPerksAvailable()
  if (disposed) return
  mounted = true
  if (isPerks.value) { if (document.visibilityState === 'visible') void loadPerks() } else void load()
  timer = setInterval(() => {
    if (!isPerks.value && document.visibilityState === 'visible') void load()
  }, 60_000)
  clockTimer = setInterval(() => { nowMs.value = Date.now() }, 1000)
  document.addEventListener('visibilitychange', onVisibilityChange)
})
watch(() => route.query.tab, () => {
  if (!mounted) return
  stopPerksTimer(); ++perksSeq
  if (document.visibilityState === 'visible') { if (isPerks.value) void loadPerks(); else void load() }
})
onUnmounted(() => {
  disposed = true
  mounted = false
  ++perksSeq
  if (timer) clearInterval(timer)
  if (clockTimer) clearInterval(clockTimer)
  if (noteTimer) clearTimeout(noteTimer)
  stopPerksTimer()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

const perksDialogOpen = ref(false)
const perksDialogId = ref<string | null>(null)
const perksDialogOriginalName = ref('')
const perksDialogDefault = ref(false)
const perksDialogName = ref('')
const perksDialogPlatforms = ref<string[]>([])
const perksDialogPaused = ref(false)
const perksDialogError = ref('')
function openPerksDialog(id?: string) {
  const account = perksData.value?.accounts.find(a => a.id === id)
  perksDialogId.value = account?.id || null
  perksDialogOriginalName.value = account?.name || ''
  perksDialogDefault.value = account?.isDefault || false
  perksDialogName.value = account?.name || ''
  perksDialogPlatforms.value = account ? [...account.platformIds] : []
  perksDialogPaused.value = account ? !account.enabled : false
  perksDialogError.value = ''
  perksDialogOpen.value = true
}
async function submitPerksDialog() {
  const error = validateAccountName(perksDialogName.value)
  if (error) { perksDialogError.value = error; return }
  if (!perksDialogPlatforms.value.length) { perksDialogError.value = '至少选一家'; return }
  const name = perksDialogName.value.trim()
  const body: PerksAction = perksDialogId.value ? { action: 'account-update', id: perksDialogId.value, name, platformIds: perksDialogPlatforms.value, ...(!perksDialogDefault.value ? { enabled: !perksDialogPaused.value } : {}) } : { action: 'account-add', name, platformIds: perksDialogPlatforms.value }
  if (await perksAction(body, true)) {
    perksDialogOpen.value = false
    if (body.action === 'account-add') accountNote.value = `已添加「${name}」。在它那一栏点「登录各家」登录。`
  }
}

function setRow(id: string, patch: Partial<ResourceRowState>) {
  const current = rowState.value[id] || { busy: null, line: '', error: false, notice: false }
  rowState.value = { ...rowState.value, [id]: { ...current, ...patch } }
}
function setGroup(provider: string, patch: Partial<ResourceGroupState>) {
  const current = groupState.value[provider] || { busy: false, line: '', error: false, notice: false }
  groupState.value = { ...groupState.value, [provider]: { ...current, ...patch } }
}
function rowIdle(id: string): boolean { return !rowState.value[id]?.busy }
function groupIdle(provider: string): boolean { return !groupState.value[provider]?.busy }

// 重试 = 用同样参数重发,所以把每个行/分组最后一次动作记下来。
const lastRowAction: Record<string, { body: ResourceAction; busy: string }> = {}
const lastGroupAction: Record<string, { body: ResourceAction; provider: string }> = {}

type Target = { kind: 'row'; id: string } | { kind: 'group'; provider: string }

async function act(body: ResourceAction, target: Target, busy: string) {
  if (target.kind === 'row') {
    if (!rowIdle(target.id)) return
    lastRowAction[target.id] = { body, busy }
    setRow(target.id, { busy, line: '', error: false, notice: false })
  } else {
    if (!groupIdle(target.provider)) return
    lastGroupAction[target.provider] = { body, provider: target.provider }
    setGroup(target.provider, { busy: true, line: '', error: false, notice: false })
  }
  const result = await postResourceAction(body)
  const line = result.lastLine || ''
  const notice = result.ok && (body.action === 'add' || body.action === 'login')
    && (result.pending === true || line.includes('授权页'))
  const okLine = line
  const failLine = line || result.error || ''
  if (target.kind === 'row') {
    setRow(target.id, result.ok
      ? { busy: null, line: okLine, error: false, notice }
      : { busy: null, line: failLine, error: true, notice: false })
  } else {
    setGroup(target.provider, result.ok
      ? { busy: false, line: okLine, error: false, notice }
      : { busy: false, line: failLine, error: true, notice: false })
  }
  if (result.ok) void load()
}

function onToggle(id: string, enabled: boolean) {
  const body: ResourceAction = { action: enabled ? 'enable' : 'disable', id }
  void act(body, { kind: 'row', id }, 'toggle')
}
function onRefreshAccount(id: string) { void act({ action: 'refresh', id }, { kind: 'row', id }, 'refresh') }
function onLogin(id: string) { void act({ action: 'login', id }, { kind: 'row', id }, 'login') }
function onRetryRow(id: string) {
  const last = lastRowAction[id]
  if (last) void act(last.body, { kind: 'row', id }, last.busy)
}
function onRetryGroup(provider: string) {
  const last = lastGroupAction[provider]
  if (last) void act(last.body, { kind: 'group', provider }, 'add')
}

// —— 三个弹窗 ——
const addOpen = ref(false)
const addProvider = ref('')
const addLabel = ref('')
const addKeyFile = ref('')
const addError = ref('')
function openAdd(provider: string) {
  addProvider.value = provider
  addLabel.value = ''
  addKeyFile.value = ''
  addError.value = ''
  addOpen.value = true
}
function submitAdd() {
  const labelError = validateLabel(addLabel.value)
  if (labelError) { addError.value = labelError; return }
  const body: ResourceAction = { action: 'add', provider: addProvider.value }
  if (addLabel.value.trim()) body.label = addLabel.value.trim()
  if (isKeyProvider(addProvider.value)) {
    const keyError = validateKeyFile(addKeyFile.value)
    if (keyError) { addError.value = keyError; return }
    body.keyFile = addKeyFile.value
  }
  addError.value = ''
  addOpen.value = false
  void act(body, { kind: 'group', provider: addProvider.value }, 'add')
}

const removeOpen = ref(false)
const removeTarget = ref<{ id: string; label: string } | null>(null)
function openRemove(id: string) {
  const account = findAccount(id)
  removeTarget.value = { id, label: account?.label || '读不到' }
  removeOpen.value = true
}
function submitRemove() {
  if (!removeTarget.value) return
  const id = removeTarget.value.id
  removeOpen.value = false
  void act({ action: 'remove', id }, { kind: 'row', id }, 'remove')
}

const clearOpen = ref(false)
const clearTarget = ref<ResourceAccount | null>(null)
const clearChoice = ref('all')
function openClear(id: string) {
  clearTarget.value = findAccount(id)
  clearChoice.value = 'all'
  clearOpen.value = true
}
function clearOptions(): Array<{ value: string; text: string }> {
  const limits = clearTarget.value?.limits || []
  return [
    { value: 'all', text: '全部限流' },
    ...limits.map((l) => ({ value: l.model || '读不到', text: limitViews([l])[0] })),
  ]
}
function submitClear() {
  if (!clearTarget.value) return
  const id = clearTarget.value.id
  const body: ResourceAction = { action: 'clear-limit', id }
  if (clearChoice.value !== 'all') body.model = clearChoice.value
  clearOpen.value = false
  void act(body, { kind: 'row', id }, 'clear-limit')
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1>账号与额度</h1>
      <div v-if="perksAvailable" class="tabs" role="tablist" aria-label="账号与额度分页">
        <button id="tab-acct" class="btn quiet tab-button" :class="{ on: !isPerks }" type="button" role="tab" :aria-selected="!isPerks" aria-controls="page-acct" @click="selectTab('accounts')">账号管理</button>
        <button id="tab-perks" class="btn quiet tab-button" :class="{ on: isPerks }" type="button" role="tab" :aria-selected="isPerks" aria-controls="page-perks" @click="selectTab('perks')">每日福利</button>
      </div>
    </header>

    <ResourcePanel
      v-if="!isPerks"
      id="page-acct"
      :status="status"
      :data="data"
      :error-line="errorLine"
      :refreshing="refreshing"
      :row-state="rowState"
      :group-state="groupState"
      @refresh-all="refreshAll"
      @toggle="onToggle"
      @refresh-account="onRefreshAccount"
      @login="onLogin"
      @clear-limit="openClear"
      @remove="openRemove"
      @add="openAdd"
      @retry-row="onRetryRow"
      @retry-group="onRetryGroup"
    />
    <PerksPanel v-else :status="perksStatus" :data="perksData" :error-line="perksError" :line="line" :acting="acting" :busy="perksBusy" :account-note="accountNote"
      @run="perksAction({ action: 'run' })" @stop="perksAction({ action: 'stop' })" @retry="lastPerksAction && perksAction(lastPerksAction)" @reload="loadPerks"
      @login="(account, ids) => perksAction({ action: 'login', account, ids })" @schedule="on => perksAction({ action: 'schedule', on })" @add="openPerksDialog()" @manage="openPerksDialog" />

    <ResourceDialog class="perks-dialog" :open="perksDialogOpen" :title="perksDialogId ? `管理「${perksDialogOriginalName}」` : '添加账号'" @close="perksDialogOpen = false">
      <label class="res-field-row"><span>名字</span><input v-model="perksDialogName" class="field" type="text" maxlength="20" /></label>
      <div class="res-field-row"><span>领哪几家</span><label v-for="platform in perksData?.selectablePlatforms || []" :key="platform.id" class="res-choice"><input v-model="perksDialogPlatforms" type="checkbox" :value="platform.id" /><span>{{ platform.name }}</span></label></div>
      <label v-if="perksDialogId && !perksDialogDefault" class="res-choice"><input v-model="perksDialogPaused" type="checkbox" /><span>暂停领取</span></label>
      <p v-if="perksDialogError" class="res-bad">{{ perksDialogError }}</p>
      <template v-slot:actions><button class="btn btn-sm primary" type="button" :disabled="acting" @click="submitPerksDialog">{{ perksDialogId ? '保存' : '添加' }}</button><button class="btn btn-sm" type="button" @click="perksDialogOpen = false">取消</button></template>
    </ResourceDialog>

    <ResourceDialog :open="addOpen" title="添加账号" @close="addOpen = false">
      <label class="res-field-row">
        <span>平台</span>
        <select v-model="addProvider" class="field">
          <option v-for="p in providers()" :key="p.provider" :value="p.provider">{{ p.providerName }}</option>
        </select>
      </label>
      <label class="res-field-row">
        <span>名字</span>
        <input v-model="addLabel" class="field" type="text" placeholder="不填则按序号命名" />
      </label>
      <template v-if="isKeyProvider(addProvider)">
        <label class="res-field-row">
          <span>密钥文件路径</span>
          <input v-model="addKeyFile" class="field" type="text" placeholder="文件的完整路径" />
        </label>
        <p class="res-hint">密钥由你自己放进文件,看板不读文件内容</p>
      </template>
      <p v-else class="res-hint">添加后会自动打开授权页,在浏览器里点授权。</p>
      <p v-if="addError" class="res-bad">{{ addError }}</p>
      <template v-slot:actions>
        <button class="btn btn-sm primary" type="button" @click="submitAdd">添加</button>
        <button class="btn btn-sm" type="button" @click="addOpen = false">取消</button>
      </template>
    </ResourceDialog>

    <ResourceDialog :open="removeOpen" title="移除账号" @close="removeOpen = false">
      <p v-if="removeTarget">确定移除 {{ removeTarget.label }}({{ removeTarget.id }})?</p>
      <p class="res-hint">只从登记里拿掉,账号目录和登录凭据留在原处,不删。</p>
      <template v-slot:actions>
        <button class="btn btn-sm" type="button" @click="submitRemove">确认移除</button>
        <button class="btn btn-sm" type="button" @click="removeOpen = false">取消</button>
      </template>
    </ResourceDialog>

    <ResourceDialog :open="clearOpen" title="解除限流" @close="clearOpen = false">
      <p class="res-hint">只清掉派单器里的限流标记,不会恢复平台那边的额度。</p>
      <label v-for="option in clearOptions()" :key="option.value" class="res-choice">
        <input v-model="clearChoice" type="radio" name="res-clear-choice" :value="option.value" />
        <span>{{ option.text }}</span>
      </label>
      <template v-slot:actions>
        <button class="btn btn-sm" type="button" @click="submitClear">解除</button>
        <button class="btn btn-sm" type="button" @click="clearOpen = false">取消</button>
      </template>
    </ResourceDialog>
  </div>
</template>

<style scoped>
.page { width: 100%; min-width: 0; display: flex; flex-direction: column; gap: var(--s4); }
.page-head { display: flex; align-items: center; justify-content: flex-start; gap: var(--s2) var(--s4); flex-wrap: wrap; }
.page-head h1 { margin: 0; font-size: var(--fs-xl); }
.tabs { display: flex; gap: var(--s1); padding: var(--s1); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2); max-width: 100%; }
.tab-button { flex: 0 1 92px; min-width: 0; }
.tab-button.on { background: var(--surface); color: var(--text); border-color: var(--line-strong); font-weight: 600; }
@media (max-width: 900px) { .tabs .btn, .perks-dialog .btn, .perks-dialog .res-choice, .perks-dialog .res-field-row input { min-height: 44px; } }
.res-field-row { display: grid; gap: var(--s1); font-size: var(--fs-sm); color: var(--text-2); }
.res-hint { margin: 0; color: var(--text-2); font-size: var(--fs-sm); }
.res-bad { margin: 0; color: var(--bad); font-size: var(--fs-sm); }
.res-choice { display: flex; align-items: center; gap: var(--s2); font-size: var(--fs-sm); color: var(--text-2); }
</style>
