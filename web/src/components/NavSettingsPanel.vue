<script lang="ts">
export interface NavItemConfig<T extends string = string> { id: T; visible: boolean }
export interface NavGroupConfig<T extends string = string> {
  id: string
  name: string
  collapsed: boolean
  items: NavItemConfig<T>[]
}

interface StoredNavConfig<T extends string> { version: 1; groups: NavGroupConfig<T>[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function cloneNavGroups<T extends string>(groups: ReadonlyArray<NavGroupConfig<T>>): NavGroupConfig<T>[] {
  return groups.map(group => ({ ...group, items: group.items.map(item => ({ ...item })) }))
}

function normalizeNavGroups<T extends string>(
  value: unknown,
  knownItemIds: ReadonlySet<T>,
  defaults: ReadonlyArray<NavGroupConfig<T>>,
): NavGroupConfig<T>[] | null {
  if (!isRecord(value) || !Array.isArray(value.groups)) return null
  const groupIds = new Set<string>()
  const itemIds = new Set<T>()
  const groups: NavGroupConfig<T>[] = []

  for (const candidate of value.groups) {
    if (!isRecord(candidate) || !Array.isArray(candidate.items)) return null
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    if (!id || groupIds.has(id)) return null
    groupIds.add(id)
    const items: NavItemConfig<T>[] = []
    for (const rawItem of candidate.items) {
      if (!isRecord(rawItem) || typeof rawItem.id !== 'string' || !knownItemIds.has(rawItem.id as T)) continue
      const itemId = rawItem.id as T
      if (itemIds.has(itemId)) continue
      itemIds.add(itemId)
      items.push({ id: itemId, visible: typeof rawItem.visible === 'boolean' ? rawItem.visible : true })
    }
    groups.push({
      id,
      name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : '未命名分组',
      collapsed: candidate.collapsed === true,
      items,
    })
  }
  if (!groups.length) return null

  for (const defaultGroup of defaults) {
    const missing = defaultGroup.items.filter(item => !itemIds.has(item.id))
    if (!missing.length) continue
    let target = groups.find(group => group.id === defaultGroup.id)
    if (!target) {
      target = { id: defaultGroup.id, name: defaultGroup.name, collapsed: defaultGroup.collapsed, items: [] }
      groups.push(target)
    }
    for (const item of missing) {
      target.items.push({ ...item })
      itemIds.add(item.id)
    }
  }
  return groups
}

export function loadNavGroups<T extends string>(
  storageKey: string,
  knownItemIds: ReadonlySet<T>,
  defaults: ReadonlyArray<NavGroupConfig<T>>,
): NavGroupConfig<T>[] {
  try {
    const stored = localStorage.getItem(storageKey)
    if (!stored) return cloneNavGroups(defaults)
    return normalizeNavGroups(JSON.parse(stored), knownItemIds, defaults) ?? cloneNavGroups(defaults)
  } catch (_) {
    return cloneNavGroups(defaults)
  }
}

export function saveNavGroups<T extends string>(storageKey: string, groups: NavGroupConfig<T>[]) {
  const payload: StoredNavConfig<T> = { version: 1, groups }
  try { localStorage.setItem(storageKey, JSON.stringify(payload)) }
  catch (_) { /* 禁用站点存储时，本次会话里的菜单仍保持可用。 */ }
}
</script>

<script setup lang="ts">
import { ref } from 'vue'

interface NavItemPresentation {
  title: string
}

defineProps<{
  open: boolean
  groups: NavGroupConfig[]
  items: Record<string, NavItemPresentation>
}>()

const emit = defineEmits<{
  close: []
  rename: [groupId: string, name: string]
  addGroup: [name: string]
  visibility: [groupId: string, itemId: string, visible: boolean]
  move: [fromGroupId: string, itemId: string, toGroupId: string, beforeItemId: string | null]
  restore: []
}>()

const newGroupName = ref('')
const dragging = ref<{ groupId: string; itemId: string } | null>(null)

function renameGroup(groupId: string, event: Event) {
  emit('rename', groupId, (event.target as HTMLInputElement).value)
}

function addGroup() {
  const name = newGroupName.value.trim()
  if (!name) return
  emit('addGroup', name)
  newGroupName.value = ''
}

function startDrag(event: DragEvent, groupId: string, itemId: string) {
  dragging.value = { groupId, itemId }
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', `${groupId}:${itemId}`)
}

function finishDrag() {
  dragging.value = null
}

function dropBefore(event: DragEvent, toGroupId: string, beforeItemId: string) {
  event.preventDefault()
  const source = dragging.value
  if (!source || source.itemId === beforeItemId) return
  emit('move', source.groupId, source.itemId, toGroupId, beforeItemId)
  finishDrag()
}

function dropAtEnd(event: DragEvent, toGroupId: string) {
  event.preventDefault()
  const source = dragging.value
  if (!source) return
  emit('move', source.groupId, source.itemId, toGroupId, null)
  finishDrag()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="settings-layer" @click.self="emit('close')" @keydown.esc="emit('close')">
      <section class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="nav-settings-title">
        <header class="settings-head">
          <div>
            <h2 id="nav-settings-title">菜单设置</h2>
            <p>拖动左侧手柄可排序或换组；关闭的菜单仍能从地址直接进入。</p>
          </div>
          <button class="btn btn-sm quiet" type="button" aria-label="关闭菜单设置" @click="emit('close')">×</button>
        </header>

        <div class="group-list">
          <section v-for="group in groups" :key="group.id" class="settings-group">
            <div class="group-name-row">
              <label :for="`group-${group.id}`">分组名</label>
              <input
                :id="`group-${group.id}`"
                class="field"
                :value="group.name"
                maxlength="32"
                @input="renameGroup(group.id, $event)"
              >
            </div>
            <div class="item-list" @dragover.prevent @drop="dropAtEnd($event, group.id)">
              <div
                v-for="item in group.items"
                :key="item.id"
                class="setting-item"
                :class="{ dragging: dragging?.itemId === item.id }"
                @dragover.prevent
                @drop.stop="dropBefore($event, group.id, item.id)"
              >
                <span
                  class="drag-handle"
                  role="button"
                  tabindex="0"
                  draggable="true"
                  :aria-label="`拖动${items[item.id]?.title || item.id}`"
                  title="拖动排序或换组"
                  @dragstart="startDrag($event, group.id, item.id)"
                  @dragend="finishDrag"
                >⠿</span>
                <span class="item-title">{{ items[item.id]?.title || item.id }}</span>
                <label class="visibility-toggle">
                  <input
                    type="checkbox"
                    :checked="item.visible"
                    @change="emit('visibility', group.id, item.id, ($event.target as HTMLInputElement).checked)"
                  >
                  <span>{{ item.visible ? '显示' : '隐藏' }}</span>
                </label>
              </div>
              <div v-if="!group.items.length" class="empty-group">把菜单拖到这里</div>
            </div>
          </section>
        </div>

        <form class="add-group" @submit.prevent="addGroup">
          <label class="sr-only" for="new-group-name">新分组名称</label>
          <input id="new-group-name" v-model="newGroupName" class="field" maxlength="32" placeholder="新分组名称">
          <button class="btn" type="submit" :disabled="!newGroupName.trim()">新建分组</button>
        </form>

        <footer class="settings-actions">
          <button class="btn quiet" type="button" @click="emit('restore')">恢复默认</button>
          <button class="btn primary" type="button" @click="emit('close')">完成</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-layer {
  position: fixed;
  z-index: 80;
  inset: 0;
  display: grid;
  place-items: center;
  padding: var(--s4);
  background: color-mix(in srgb, var(--text) 18%, transparent);
}
.settings-panel {
  width: min(640px, calc(100vw - var(--s6)));
  max-height: calc(100vh - var(--s6));
  overflow-y: auto;
  padding: var(--s5);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow);
}
.settings-head { display: flex; align-items: flex-start; gap: var(--s3); margin-bottom: var(--s4); }
.settings-head > div { flex: 1; min-width: 0; }
.settings-head p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-sm); }
.group-list { display: grid; gap: var(--s3); }
.settings-group { padding: var(--s3); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2); }
.group-name-row { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: var(--s2); margin-bottom: var(--s2); }
.group-name-row label { color: var(--text-3); font-family: var(--mono); font-size: var(--fs-xs); letter-spacing: .1em; text-transform: uppercase; }
.group-name-row .field { padding-block: var(--s1); }
.item-list { display: grid; gap: var(--s1); min-height: var(--s6); }
.setting-item {
  display: flex;
  align-items: center;
  gap: var(--s2);
  padding: var(--s2);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r);
  transition: border-color .14s ease, opacity .14s ease;
}
.setting-item:hover { border-color: var(--line-strong); }
.setting-item.dragging { opacity: .45; }
.drag-handle {
  width: var(--s5);
  color: var(--text-3);
  cursor: grab;
  font-family: var(--mono);
  font-size: var(--fs-lg);
  line-height: 1;
  text-align: center;
  user-select: none;
}
.drag-handle:active { cursor: grabbing; }
.item-title { flex: 1; min-width: 0; overflow: hidden; color: var(--text); font-size: var(--fs-base); text-overflow: ellipsis; white-space: nowrap; }
.visibility-toggle { display: inline-flex; align-items: center; gap: var(--s1); color: var(--text-2); cursor: pointer; font-size: var(--fs-sm); }
.visibility-toggle input { accent-color: var(--text); }
.empty-group { padding: var(--s2); color: var(--text-3); font-size: var(--fs-sm); text-align: center; }
.add-group { display: grid; grid-template-columns: 1fr auto; gap: var(--s2); margin-top: var(--s4); }
.settings-actions { display: flex; justify-content: flex-end; gap: var(--s2); margin-top: var(--s4); padding-top: var(--s4); border-top: 1px solid var(--line); }

@media (max-width: 700px) {
  .settings-panel { width: calc(100vw - var(--s4)); max-height: calc(100vh - var(--s4)); padding: var(--s4); }
  .group-name-row { grid-template-columns: 1fr; }
  .add-group { grid-template-columns: 1fr; }
}
</style>
