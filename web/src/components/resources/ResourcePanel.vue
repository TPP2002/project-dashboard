<script setup lang="ts">
import { computed } from 'vue'
import type { PropType } from 'vue'
import {
  beijingClock, beijingDateTime, quotaView, limitViews, loginView, gateView, ladderGroups,
} from '@/utils/resourcesFormat'

/** 本地声明,避免内存编译去解析别的文件里的类型。 */
interface RowState { busy: string | null; line: string; error: boolean; notice: boolean }
interface GroupState { busy: boolean; line: string; error: boolean; notice: boolean }
interface PanelAccount {
  id: string; provider: string; providerName?: string; label?: string; enabled?: boolean
  login?: any; quota?: any; limits?: any; lastUsedAt?: string | null; running?: number | null
}
interface PanelProvider {
  provider: string; providerName?: string; accountCount?: number; enabledCount?: number; gate?: any
}
interface PanelSnapshot {
  formatVersion?: number; generatedAt?: string
  accounts?: PanelAccount[]; providers?: PanelProvider[]; ladders?: any
}

const props = defineProps({
  status: { type: String as PropType<'loading' | 'ready' | 'error'>, required: true },
  data: { type: Object as PropType<PanelSnapshot | null>, default: null },
  errorLine: { type: String, default: '' },
  refreshing: { type: Boolean, default: false },
  rowState: { type: Object as PropType<Record<string, RowState>>, default: () => ({}) },
  groupState: { type: Object as PropType<Record<string, GroupState>>, default: () => ({}) },
})
const emit = defineEmits([
  'refresh-all', 'toggle', 'refresh-account', 'login', 'clear-limit', 'remove', 'add',
  'retry-row', 'retry-group',
])

const EMPTY_ROW: RowState = { busy: null, line: '', error: false, notice: false }
const EMPTY_GROUP: GroupState = { busy: false, line: '', error: false, notice: false }

const accounts = computed(() => props.data?.accounts || [])
const providers = computed(() => props.data?.providers || [])
const showSkeleton = computed(() => props.status === 'loading')
const showFatal = computed(() => props.status === 'error' && !props.data)
const showData = computed(() => !!props.data && !showSkeleton.value && !showFatal.value)
const showRefreshFail = computed(() => showData.value && !!props.errorLine)
const showEmpty = computed(() => showData.value && accounts.value.length === 0)

const lastReadText = computed(() => {
  const clock = beijingClock(props.data?.generatedAt)
  return clock ? `上次读取:北京时间 ${clock}` : '上次读取:读不到'
})

const groups = computed(() => providers.value.map((p) => ({
  provider: p.provider,
  providerName: p.providerName || '读不到',
  enabledCount: typeof p.enabledCount === 'number' ? p.enabledCount : 0,
  accountCount: typeof p.accountCount === 'number' ? p.accountCount : 0,
  gate: gateView(p.gate),
  accounts: accounts.value.filter((a) => a.provider === p.provider),
})))

const providerNames = computed(() => {
  const names: Record<string, string> = {}
  for (const p of providers.value) names[p.provider] = p.providerName || p.provider
  return names
})
const ladderBlocks = computed(() => ladderGroups(props.data?.ladders, providerNames.value))

function rowOf(id: string): RowState { return props.rowState[id] || EMPTY_ROW }
function groupOf(provider: string): GroupState { return props.groupState[provider] || EMPTY_GROUP }
function qv(a: PanelAccount) { return quotaView(a.quota) }
function lv(a: PanelAccount) { return loginView(a.login) }
function lim(a: PanelAccount): string[] { return limitViews(a.limits) }
function runningText(a: PanelAccount): string {
  return typeof a.running === 'number' ? `在跑 ${a.running} 单` : '在跑 读不到'
}
function usedText(a: PanelAccount): string {
  if (!a.lastUsedAt) return '最近使用 从未'
  const dt = beijingDateTime(a.lastUsedAt)
  return dt ? `最近使用 ${dt}` : '最近使用 读不到'
}
function rowBusy(a: PanelAccount): boolean { return !!rowOf(a.id).busy }

function onRefreshAll() { emit('refresh-all') }
function onRetryAll() { emit('refresh-all') }
function onAdd(provider: string) { emit('add', provider) }
function onToggle(a: PanelAccount) { emit('toggle', a.id, !a.enabled) }
function onRefreshAccount(a: PanelAccount) { emit('refresh-account', a.id) }
function onLogin(a: PanelAccount) { emit('login', a.id) }
function onClearLimit(a: PanelAccount) { emit('clear-limit', a.id) }
function onRemove(a: PanelAccount) { emit('remove', a.id) }
function onRetryRow(a: PanelAccount) { emit('retry-row', a.id) }
function onRetryGroup(provider: string) { emit('retry-group', provider) }
</script>

<template>
  <div class="res-panel">
    <div class="res-toolbar">
      <span class="res-last">{{ lastReadText }}</span>
      <button class="btn btn-sm" type="button" :disabled="refreshing" @click="onRefreshAll">{{ refreshing ? '刷新中…' : '刷新' }}</button>
    </div>

    <span v-if="showSkeleton" class="sr-only" role="status">正在读取账号</span>
    <div v-if="showSkeleton" class="res-skeleton card">
      <div class="skel res-skel wide" />
      <div class="skel res-skel medium" />
      <div class="skel res-skel wide" />
    </div>

    <div v-else-if="showFatal" class="res-error card">
      <h2>读取失败</h2>
      <p>{{ errorLine }}</p>
      <button class="btn btn-sm" type="button" @click="onRetryAll">重试</button>
    </div>

    <template v-if="showData">
      <div v-if="showRefreshFail" class="res-refresh-fail card">
        <span>刷新失败:</span><span>{{ errorLine }}</span>
        <button class="btn btn-sm" type="button" @click="onRetryAll">重试</button>
      </div>

      <div v-if="showEmpty" class="res-empty card">
        <strong>还没有登记任何账号</strong>
        <p>点下面各平台的「添加账号」,登记第一个号。</p>
      </div>

      <div class="res-groups">
        <section v-for="g in groups" :key="g.provider" class="res-group card" :data-provider="g.provider">
          <header class="res-group-head">
            <h3 class="res-group-name">{{ g.providerName }}</h3>
            <span class="res-count">启用 {{ g.enabledCount }} / 共 {{ g.accountCount }}</span>
            <span class="badge" :class="g.gate.tone">{{ g.gate.text }}</span>
            <button class="btn btn-sm" type="button" @click="onAdd(g.provider)">添加账号</button>
          </header>

          <div v-if="groupOf(g.provider).busy || groupOf(g.provider).error || groupOf(g.provider).notice || groupOf(g.provider).line" class="res-notice">
            <template v-if="groupOf(g.provider).busy">添加中…</template>
            <template v-else-if="groupOf(g.provider).notice">
              <span>已打开授权页,在浏览器里点授权后点刷新</span>
              <span class="res-line">{{ groupOf(g.provider).line }}</span>
            </template>
            <template v-else-if="groupOf(g.provider).error">
              <span class="res-bad">{{ groupOf(g.provider).line }}</span>
              <button class="btn btn-sm" type="button" @click="onRetryGroup(g.provider)">重试</button>
            </template>
            <span v-else class="res-fine">{{ groupOf(g.provider).line }}</span>
          </div>

          <p v-if="!g.accounts.length" class="res-group-empty">这个平台还没有账号</p>
          <div v-else class="res-rows">
            <div v-for="a in g.accounts" :key="a.id" class="res-row" :class="{ 'res-off': !a.enabled }" :data-account="a.id">
              <div class="res-row-main">
                <div class="res-row-title">
                  <span class="res-label">{{ a.label || '读不到' }}</span>
                  <span class="res-id mono">{{ a.id }}</span>
                </div>
                <label class="res-switch">
                  <input type="checkbox" role="switch" :checked="!!a.enabled"
                    :aria-label="'启用 ' + (a.label || '读不到')" :disabled="rowBusy(a)" @change="onToggle(a)" />
                  <span>启用</span>
                </label>
                <div class="res-login">
                  <span class="badge" :class="lv(a).tone">{{ lv(a).badge }}</span>
                  <span class="res-fine">{{ lv(a).check }}</span>
                  <span v-if="lv(a).reason" class="res-fine">{{ lv(a).reason }}</span>
                </div>
                <div class="res-quota">
                  <span>{{ qv(a).text }}</span>
                  <span v-if="qv(a).resetText"> · {{ qv(a).resetText }}</span>
                  <span v-if="qv(a).estimate" class="badge n">估算</span>
                </div>
                <div v-if="lim(a).length" class="res-limits">
                  <span v-for="(text, i) in lim(a)" :key="i" class="badge warn">{{ text }}</span>
                </div>
                <div class="res-meta">
                  <span>{{ runningText(a) }}</span>
                  <span>{{ usedText(a) }}</span>
                </div>
              </div>
              <div class="res-actions">
                <button class="btn btn-sm" type="button" :disabled="rowBusy(a)" @click="onRefreshAccount(a)">{{ rowOf(a.id).busy === 'refresh' ? '刷新中…' : '刷新' }}</button>
                <button class="btn btn-sm" type="button" :disabled="rowBusy(a)" @click="onLogin(a)">{{ rowOf(a.id).busy === 'login' ? '登录中…' : '重新登录' }}</button>
                <button v-if="lim(a).length" class="btn btn-sm" type="button" :disabled="rowBusy(a)" @click="onClearLimit(a)">{{ rowOf(a.id).busy === 'clear-limit' ? '处理中…' : '解除限流' }}</button>
                <button class="btn btn-sm" type="button" :disabled="rowBusy(a)" @click="onRemove(a)">{{ rowOf(a.id).busy === 'remove' ? '移除中…' : '移除' }}</button>
              </div>
              <div v-if="rowOf(a.id).notice" class="res-row-notice">
                <span>已打开授权页,在浏览器里点授权后点刷新</span>
                <span class="res-line">{{ rowOf(a.id).line }}</span>
              </div>
              <div v-else-if="rowOf(a.id).error" class="res-row-fail">
                <span class="res-bad">{{ rowOf(a.id).line }}</span>
                <button class="btn btn-sm" type="button" @click="onRetryRow(a)">重试</button>
              </div>
              <div v-else-if="rowOf(a.id).line" class="res-row-line res-fine">{{ rowOf(a.id).line }}</div>
            </div>
          </div>
        </section>
      </div>

      <details class="res-ladders">
        <summary>派单顺序</summary>
        <p class="res-ladders-note">从第 1 格往下找,前一格没有可用账号就用下一格。</p>
        <div v-for="block in ladderBlocks" :key="block.title" class="res-ladder-block">
          <h4>{{ block.title }}</h4>
          <p v-for="(row, i) in block.rows" :key="i" class="res-ladder-row">{{ row }}</p>
        </div>
      </details>
    </template>
  </div>
</template>

<style scoped>
.res-panel { display: grid; gap: var(--s3); min-width: 0; }
.res-toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); flex-wrap: wrap; }
.res-last { color: var(--text-2); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.res-skeleton { display: grid; gap: var(--s3); padding: var(--s4); }
.res-skel.wide { width: 88%; }
.res-skel.medium { width: 56%; }
.res-error, .res-refresh-fail { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; }
.res-error h2 { margin: 0; font-size: var(--fs-md); color: var(--bad); }
.res-error p, .res-refresh-fail span:nth-child(2) { margin: 0; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.res-refresh-fail > span:first-child { color: var(--bad); }
.res-empty { display: grid; gap: var(--s2); }
.res-empty strong { color: var(--text); }
.res-empty p { margin: 0; color: var(--text-2); font-size: var(--fs-sm); }
.res-groups { display: grid; gap: var(--s3); min-width: 0; }
.res-group { display: grid; gap: var(--s2); min-width: 0; }
.res-group-head { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; }
.res-group-name { margin: 0; font-size: var(--fs-md); }
.res-count { color: var(--text-2); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.res-group-head > :last-child { margin-left: auto; }
.res-notice { display: grid; gap: var(--s1); padding: var(--s2) var(--s3); border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); font-size: var(--fs-sm); }
.res-line { display: block; color: var(--text-2); overflow-wrap: anywhere; }
.res-bad { color: var(--bad); overflow-wrap: anywhere; }
.res-fine { color: var(--text-2); font-size: var(--fs-sm); }
.res-group-empty { margin: 0; padding: var(--s3); color: var(--text-3); font-size: var(--fs-sm); text-align: center; }
.res-rows { display: grid; gap: var(--s2); min-width: 0; overflow-x: auto; }
.res-row { display: grid; gap: var(--s2); padding: var(--s3); border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); min-width: 0; }
.res-row.res-off { color: var(--text-3); }
.res-row-main { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; min-width: 0; }
.res-row-title { display: grid; gap: var(--s1); min-width: 0; }
.res-label { font-weight: 600; }
.res-id { color: var(--text-3); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.res-switch { display: inline-flex; align-items: center; gap: var(--s1); color: var(--text-2); font-size: var(--fs-sm); white-space: nowrap; }
.res-login, .res-quota, .res-limits, .res-meta { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
.res-meta { color: var(--text-2); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.res-actions { display: flex; gap: var(--s2); flex-wrap: wrap; }
.res-row-notice { display: grid; gap: var(--s1); color: var(--text-2); font-size: var(--fs-sm); }
.res-row-fail { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; font-size: var(--fs-sm); }
.res-ladders { padding: var(--s3) var(--s4); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2); }
.res-ladders summary { cursor: pointer; }
.res-ladders-note { color: var(--text-2); font-size: var(--fs-sm); }
.res-ladder-block h4 { margin: var(--s3) 0 var(--s1); font-size: var(--fs-sm); color: var(--text-2); }
.res-ladder-row { margin: 0; color: var(--text-2); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
@media (max-width: 900px) {
  .res-row-main { flex-direction: column; align-items: flex-start; }
  .res-group-head > :last-child { margin-left: 0; }
}
</style>
