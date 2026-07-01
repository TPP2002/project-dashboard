<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { useBoardStore } from '@/stores/board'
import TopBar from '@/components/TopBar.vue'
import SideNav from '@/components/SideNav.vue'
import TaskDrawer from '@/components/TaskDrawer.vue'

const store = useBoardStore()
onMounted(() => store.init())
onBeforeUnmount(() => store.stopStream())
</script>

<template>
  <div class="shell">
    <TopBar class="area-top" />
    <SideNav class="area-nav" />
    <main class="area-main">
      <div v-if="store.loading" class="loading-line" />
      <div v-if="store.error" class="errbar">
        <span>⚠️ {{ store.error }}</span>
        <button class="btn btn-sm" @click="store.refresh()">重试</button>
        <span class="spacer" />
        <button class="btn btn-sm btn-ghost" @click="store.error = null">✕</button>
      </div>
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
    <TaskDrawer />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 208px 1fr;
  grid-template-rows: 52px 1fr;
  height: 100vh;
  overflow: hidden;
}
.area-top { grid-column: 1 / 3; grid-row: 1; }
.area-nav { grid-column: 1; grid-row: 2; }
.area-main { grid-column: 2; grid-row: 2; overflow: auto; padding: 18px 22px; position: relative; }
.errbar {
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(208, 99, 124, 0.12);
  border: 1px solid rgba(208, 99, 124, 0.4);
  color: #f2b8c4;
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  margin-bottom: 14px;
  font-size: 13px;
}
.loading-line { position: absolute; top: 0; left: 0; right: 0; }
</style>
