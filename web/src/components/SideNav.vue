<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import type { QuotaSnapshot } from '@/types/codex'

const store = useBoardStore()
const quota = ref<QuotaSnapshot | null>(null)
const quotaLoading = ref(false)
let quotaTimer: ReturnType<typeof setInterval> | null = null

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

interface NavItem { to?: string; icon?: string; title?: string; badge?: 'pending' | 'unlanded' | 'today'; sep?: string }
const NAV: NavItem[] = [
  { to: '/overview', icon: '🏠', title: '总览' },
  { to: '/kanban', icon: '📋', title: '看板' },
  { to: '/approvals', icon: '❓', title: '待拍板', badge: 'pending' },
  { to: '/toland', icon: '🚀', title: '待落地', badge: 'unlanded' },
  { to: '/daily', icon: '📆', title: '每日成果', badge: 'today' },
  { to: '/insights', icon: '📊', title: '洞察' },
  { to: '/history', icon: '🗂️', title: '拍板历史' },
  { to: '/cpu', icon: '⚡', title: '算力' },
  { to: '/cost', icon: '💰', title: '成本' },
  { to: '/codex', icon: '🤖', title: 'Codex' },
  { sep: '视图' },
  { to: '/activity', icon: '📜', title: '活动流' },
  { to: '/risk', icon: '⚠️', title: '风险' },
  { to: '/waves', icon: '🌊', title: '波次' },
  { to: '/acceptance', icon: '🚦', title: '验收' },
  { to: '/collision', icon: '💥', title: '占用' },
  { to: '/gantt', icon: '📅', title: '甘特' },
  { to: '/deps', icon: '🕸️', title: '依赖' },
  { to: '/search', icon: '🔍', title: '搜索' },
]
</script>

<template>
  <aside class="nav">
    <template v-for="(it, i) in NAV" :key="i">
      <div v-if="it.sep" class="sep">{{ it.sep }}</div>
      <router-link v-else :to="it.to!" class="item" active-class="on">
        <span class="ic">{{ it.icon }}</span>
        <span class="tt">{{ it.title }}</span>
        <span v-if="it.badge === 'pending' && store.pendingCount" class="cnt">{{ store.pendingCount }}</span>
        <span v-if="it.badge === 'unlanded' && store.unlandedCount" class="cnt cnt-blue">{{ store.unlandedCount }}</span>
        <span v-if="it.badge === 'today' && store.todayDoneCount" class="cnt cnt-green">{{ store.todayDoneCount }}</span>
      </router-link>
    </template>
    <div class="spacer" />
    <router-link
      to="/codex"
      class="quota-strip"
      :title="quota?.sampledAt ? `上次 Codex 活动快照：${new Date(quota.sampledAt).toLocaleString()}` : '尚无 Codex 额度快照'"
    >
      <i class="quota-dot" :class="quota?.band || 'unknown'" />
      <span>Codex 额度</span>
      <b>{{ quota?.usedPercent == null ? '未知' : quota.usedPercent + '%' }}</b>
    </router-link>
    <div class="foot mono">v1.0 · 全局看板</div>
  </aside>
</template>

<style scoped>
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px;
  background: var(--bg-soft);
  border-right: 1px solid var(--border);
  overflow: auto;
}
.item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 13px;
}
.item:hover { background: var(--panel); color: var(--text); text-decoration: none; }
.item.on { background: var(--accent-soft); color: var(--text); font-weight: 600; }
.ic { width: 18px; text-align: center; }
.tt { flex: 1; }
.cnt {
  background: var(--warn);
  color: #1a1200;
  font-size: 10px;
  font-weight: 700;
  border-radius: 999px;
  padding: 0 6px;
  line-height: 16px;
}
.cnt-blue { background: #4c8ce0; color: #fff; }
.cnt-green { background: var(--ok); color: #fff; }
.sep { font-size: 11px; color: var(--muted-2); padding: 10px 10px 4px; text-transform: uppercase; letter-spacing: 0.5px; }
.quota-strip { display: flex; align-items: center; gap: 7px; padding: 7px 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--muted); font-size: 10px; }
.quota-strip:hover { background: var(--panel); color: var(--text); text-decoration: none; }
.quota-strip span { flex: 1; }
.quota-strip b { font-family: var(--mono); }
.quota-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--muted-2); }
.quota-dot.green { background: var(--ok); }
.quota-dot.yellow { background: var(--warn); }
.quota-dot.red { background: var(--danger); }
.foot { font-size: 10px; color: var(--muted-2); padding: 8px 10px; }
</style>
