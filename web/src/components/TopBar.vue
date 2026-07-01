<script setup lang="ts">
import { useBoardStore } from '@/stores/board'
import ConnDot from './ConnDot.vue'

const store = useBoardStore()
function onProject(e: Event) {
  store.selectProject((e.target as HTMLSelectElement).value)
}
</script>

<template>
  <header class="topbar">
    <div class="brand">📋&nbsp;<b>项目看板</b></div>
    <div class="proj" v-if="store.projectList.length">
      <select :value="store.currentProjectId ?? ''" @change="onProject">
        <option v-for="p in store.projectList" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
    </div>
    <span class="spacer" />
    <ConnDot :state="store.conn" />
    <button class="btn btn-sm btn-ghost refresh" @click="store.refresh()" title="刷新全部">↻</button>
    <router-link to="/approvals" class="bell" :class="{ hot: store.pendingCount > 0 }" title="待拍板中心">
      ❓<span v-if="store.pendingCount" class="dot">{{ store.pendingCount }}</span>
    </router-link>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 16px;
  background: var(--bg-soft);
  border-bottom: 1px solid var(--border);
}
.brand { font-size: 15px; }
.proj select {
  background: var(--panel-2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 5px 10px;
  font-size: 13px;
  cursor: pointer;
}
.refresh { font-size: 15px; padding: 3px 8px; }
.bell {
  position: relative;
  font-size: 16px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  color: var(--text);
}
.bell:hover { background: var(--panel-2); text-decoration: none; }
.bell.hot { color: var(--warn); }
.bell .dot {
  position: absolute;
  top: -3px;
  right: -5px;
  background: var(--warn);
  color: #1a1200;
  font-size: 10px;
  font-weight: 700;
  border-radius: 999px;
  padding: 0 5px;
  line-height: 15px;
  min-width: 15px;
  text-align: center;
}
</style>
