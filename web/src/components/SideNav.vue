<script setup lang="ts">
import { useBoardStore } from '@/stores/board'

const store = useBoardStore()
interface NavItem { to?: string; icon?: string; title?: string; badge?: 'pending' | 'unlanded'; sep?: string }
const NAV: NavItem[] = [
  { to: '/overview', icon: '🏠', title: '总览' },
  { to: '/kanban', icon: '📋', title: '看板' },
  { to: '/approvals', icon: '❓', title: '待拍板', badge: 'pending' },
  { to: '/toland', icon: '🚀', title: '待落地', badge: 'unlanded' },
  { to: '/history', icon: '🗂️', title: '拍板历史' },
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
      </router-link>
    </template>
    <div class="spacer" />
    <div class="foot mono">v0.1 · 全局看板</div>
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
.sep { font-size: 11px; color: var(--muted-2); padding: 10px 10px 4px; text-transform: uppercase; letter-spacing: 0.5px; }
.foot { font-size: 10px; color: var(--muted-2); padding: 8px 10px; }
</style>
