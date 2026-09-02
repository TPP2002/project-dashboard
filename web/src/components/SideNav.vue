<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import type { QuotaSnapshot } from '@/types/codex'
import NavSettingsPanel, {
  cloneNavGroups,
  loadNavGroups,
  saveNavGroups,
  type NavGroupConfig,
  type NavItemConfig,
} from './NavSettingsPanel.vue'

type BadgeKind = 'pending' | 'unlanded' | 'today'
interface NavItemDefinition { to: string; icon: string; title: string; badge?: BadgeKind }

const NAV_ITEMS = {
  overview: { to: '/overview', icon: '⌂', title: '总览' },
  approvals: { to: '/approvals', icon: '?', title: '待拍板', badge: 'pending' },
  codex: { to: '/codex', icon: '◎', title: 'Codex' },
  daily: { to: '/daily', icon: '☷︎', title: '每日成果', badge: 'today' },
  kanban: { to: '/kanban', icon: '▦', title: '看板' },
  toland: { to: '/toland', icon: '↗', title: '待落地', badge: 'unlanded' },
  history: { to: '/history', icon: '↺', title: '拍板历史' },
  cost: { to: '/cost', icon: '¤', title: '成本' },
  cpu: { to: '/cpu', icon: '⌁', title: '算力' },
  insights: { to: '/insights', icon: '◫', title: '洞察' },
  risk: { to: '/risk', icon: '!', title: '风险' },
  waves: { to: '/waves', icon: '≋', title: '波次' },
  acceptance: { to: '/acceptance', icon: '✓', title: '验收' },
  collision: { to: '/collision', icon: '×', title: '占用' },
  gantt: { to: '/gantt', icon: '▤', title: '甘特' },
  deps: { to: '/deps', icon: '◇', title: '依赖' },
  search: { to: '/search', icon: '⌕', title: '搜索' },
} as const satisfies Record<string, NavItemDefinition>

type NavItemId = keyof typeof NAV_ITEMS
const NAV_STORAGE_KEY = 'board-nav-config'
const KNOWN_NAV_IDS = new Set<NavItemId>(Object.keys(NAV_ITEMS) as NavItemId[])
const DEFAULT_GROUPS: ReadonlyArray<NavGroupConfig<NavItemId>> = [
  { id: 'daily', name: '每天要看', collapsed: false, items: [
    { id: 'overview', visible: true }, { id: 'approvals', visible: true },
    { id: 'codex', visible: true }, { id: 'daily', visible: true },
  ] },
  { id: 'projects', name: '项目管理', collapsed: false, items: [
    { id: 'kanban', visible: true }, { id: 'toland', visible: true }, { id: 'history', visible: true },
  ] },
  { id: 'resources', name: '花销与算力', collapsed: false, items: [
    { id: 'cost', visible: true }, { id: 'cpu', visible: true },
  ] },
  { id: 'analysis', name: '深入分析', collapsed: true, items: [
    { id: 'insights', visible: true }, { id: 'risk', visible: true },
    { id: 'waves', visible: true }, { id: 'acceptance', visible: true },
    { id: 'collision', visible: true }, { id: 'gantt', visible: true },
    { id: 'deps', visible: true }, { id: 'search', visible: true },
  ] },
]

const store = useBoardStore()
const groups = ref<NavGroupConfig<NavItemId>[]>(loadNavGroups(NAV_STORAGE_KEY, KNOWN_NAV_IDS, DEFAULT_GROUPS))
const settingsOpen = ref(false)
const quota = ref<QuotaSnapshot | null>(null)
const quotaLoading = ref(false)
let quotaTimer: ReturnType<typeof setInterval> | null = null

function commitGroups(next: NavGroupConfig<NavItemId>[]) {
  groups.value = next
  saveNavGroups(NAV_STORAGE_KEY, next)
}

function toggleGroup(groupId: string) {
  commitGroups(groups.value.map(group => group.id === groupId ? { ...group, collapsed: !group.collapsed } : group))
}

function renameGroup(groupId: string, name: string) {
  const nextName = name.trim() || '未命名分组'
  commitGroups(groups.value.map(group => group.id === groupId ? { ...group, name: nextName } : group))
}

function addGroup(name: string) {
  const used = new Set(groups.value.map(group => group.id))
  let suffix = 1
  while (used.has(`custom-${suffix}`)) suffix += 1
  commitGroups([...groups.value, { id: `custom-${suffix}`, name, collapsed: false, items: [] }])
}

function setVisibility(groupId: string, itemId: string, visible: boolean) {
  commitGroups(groups.value.map(group => group.id === groupId
    ? { ...group, items: group.items.map(item => item.id === itemId ? { ...item, visible } : item) }
    : group))
}

function moveItem(fromGroupId: string, itemId: string, toGroupId: string, beforeItemId: string | null) {
  let moving: NavItemConfig<NavItemId> | null = null
  const withoutItem = groups.value.map(group => ({
    ...group,
    items: group.items.filter(item => {
      if (group.id === fromGroupId && item.id === itemId) {
        moving = { ...item }
        return false
      }
      return true
    }),
  }))
  if (!moving || !withoutItem.some(group => group.id === toGroupId)) return
  commitGroups(withoutItem.map(group => {
    if (group.id !== toGroupId) return group
    const items = [...group.items]
    const index = beforeItemId ? items.findIndex(item => item.id === beforeItemId) : -1
    items.splice(index < 0 ? items.length : index, 0, moving!)
    return { ...group, items }
  }))
}

function restoreDefaults() {
  commitGroups(cloneNavGroups(DEFAULT_GROUPS))
}

function hasVisibleItems(group: NavGroupConfig<NavItemId>) {
  return group.items.some(item => item.visible)
}

function navItem(itemId: NavItemId): NavItemDefinition {
  return NAV_ITEMS[itemId]
}

async function loadQuota() {
  if (document.visibilityState !== 'visible' || quotaLoading.value) return
  quotaLoading.value = true
  try {
    const response = await fetch('/api/codex/quota')
    if (response.ok) quota.value = await response.json() as QuotaSnapshot
  } catch (_) { /* 全局提示条保持“未知”，不干扰其它导航。 */ }
  finally { quotaLoading.value = false }
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') loadQuota()
}

onMounted(() => {
  loadQuota()
  quotaTimer = setInterval(loadQuota, 60_000)
  document.addEventListener('visibilitychange', onVisibilityChange)
})
onUnmounted(() => {
  if (quotaTimer) clearInterval(quotaTimer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <aside class="nav">
    <div class="nav-groups">
      <section v-for="group in groups" v-show="hasVisibleItems(group)" :key="group.id" class="nav-group">
        <button
          class="group-toggle"
          type="button"
          :aria-expanded="!group.collapsed"
          @click="toggleGroup(group.id)"
        >
          <span>{{ group.name }}</span><span aria-hidden="true">{{ group.collapsed ? '›' : '⌄' }}</span>
        </button>
        <div v-show="!group.collapsed" class="group-items">
          <router-link
            v-for="item in group.items.filter(entry => entry.visible)"
            :key="item.id"
            :to="navItem(item.id).to"
            class="item"
            active-class="on"
          >
            <span class="ic" aria-hidden="true">{{ navItem(item.id).icon }}</span>
            <span class="tt">{{ navItem(item.id).title }}</span>
            <span v-if="navItem(item.id).badge === 'pending' && store.pendingCount" class="badge warn cnt">{{ store.pendingCount }}</span>
            <span v-if="navItem(item.id).badge === 'unlanded' && store.unlandedCount" class="badge info cnt">{{ store.unlandedCount }}</span>
            <span v-if="navItem(item.id).badge === 'today' && store.todayDoneCount" class="badge ok cnt">{{ store.todayDoneCount }}</span>
          </router-link>
        </div>
      </section>
    </div>

    <div class="nav-bottom">
      <router-link
        to="/codex"
        class="quota-strip"
        :title="quota?.sampledAt ? `上次 Codex 活动快照：${new Date(quota.sampledAt).toLocaleString()}` : '尚无 Codex 额度快照'"
      >
        <i class="quota-dot" :class="quota?.band || 'unknown'" />
        <span>Codex 额度</span>
        <b>{{ quota?.usedPercent == null ? '未知' : quota.usedPercent + '%' }}</b>
      </router-link>
      <button class="settings-entry" type="button" @click="settingsOpen = true">
        <span aria-hidden="true">⚙︎</span><span>菜单设置</span>
      </button>
      <div class="foot mono">v1.0 · 全局看板</div>
    </div>

    <NavSettingsPanel
      :open="settingsOpen"
      :groups="groups"
      :items="NAV_ITEMS"
      @close="settingsOpen = false"
      @rename="renameGroup"
      @add-group="addGroup"
      @visibility="setVisibility"
      @move="moveItem"
      @restore="restoreDefaults"
    />
  </aside>
</template>

<style scoped>
.nav { display: flex; flex-direction: column; min-height: 0; padding: var(--s2); background: var(--surface); border-right: 1px solid var(--line); }
.nav-groups { flex: 1; min-height: 0; overflow-y: auto; }
.nav-group + .nav-group { margin-top: var(--s2); }
.group-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: var(--s2) var(--s2) var(--s1);
  background: transparent;
  border: 0;
  color: var(--text-3);
  cursor: pointer;
  font-family: var(--mono);
  font-size: var(--fs-xs);
  letter-spacing: .1em;
  text-align: left;
  text-transform: uppercase;
  transition: color .14s ease;
}
.group-toggle:hover { color: var(--text); }
.group-items { display: grid; gap: var(--s1); }
.item {
  display: flex;
  align-items: center;
  gap: var(--s2);
  padding: var(--s2) var(--s3);
  border: 1px solid transparent;
  border-radius: var(--r);
  color: var(--text-2);
  font-size: var(--fs-base);
  transition: background .14s ease, border-color .14s ease, color .14s ease;
}
.item:hover { background: var(--surface-2); color: var(--text); text-decoration: none; }
.item.on { background: var(--surface-3); border-color: var(--line); color: var(--text); font-weight: 600; }
.ic { width: var(--s5); color: var(--text-3); font-family: var(--mono); text-align: center; }
.tt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cnt { min-width: var(--s4); padding-inline: var(--s1); text-align: center; }
.nav-bottom { display: grid; gap: var(--s2); padding-top: var(--s2); border-top: 1px solid var(--line); }
.quota-strip,
.settings-entry {
  display: flex;
  align-items: center;
  gap: var(--s2);
  padding: var(--s2);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: transparent;
  color: var(--text-2);
  font-size: var(--fs-xs);
  transition: background .14s ease, color .14s ease;
}
.quota-strip:hover,
.settings-entry:hover { background: var(--surface-2); color: var(--text); text-decoration: none; }
.quota-strip span,
.settings-entry span:last-child { flex: 1; text-align: left; }
.quota-strip b { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.settings-entry { width: 100%; cursor: pointer; }
.quota-dot { width: var(--s2); height: var(--s2); flex: none; border-radius: var(--r-lg); background: var(--text-3); }
.quota-dot.green { background: var(--ok); }
.quota-dot.yellow { background: var(--warn); }
.quota-dot.red { background: var(--bad); }
.foot { padding: 0 var(--s2); color: var(--text-3); font-size: var(--fs-xs); }
</style>
