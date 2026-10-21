<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { PRIORITIES, LABELS, placePicker, type Priority } from '../utils/taskPriority'
const props = defineProps<{ taskId: string; priority?: Priority; allowed: boolean; announce?: boolean; submit: (priority: Priority) => Promise<unknown> }>()
const opened = ref(false), busy = ref(false), selected = ref(2), notice = ref(''), error = ref('')
const pop = ref<HTMLElement>(), wheel = ref<HTMLElement>()
const position = ref({ left: 0, top: 0, arrow: 40, side: 'right' })
let press: ReturnType<typeof setTimeout> | undefined, toast: ReturnType<typeof setTimeout> | undefined
let anchor: HTMLElement | undefined, suppressUntil = 0, disposed = false
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
function close() { opened.value = false; anchor?.classList.remove('priority-picking'); anchor = undefined }
function scrollTo(index: number, smooth = true) {
  selected.value = Math.max(0, Math.min(4, index))
  wheel.value?.scrollTo({ top: selected.value * 36, behavior: smooth && !reduced() ? 'smooth' : 'auto' })
}
function mark() { if (wheel.value) selected.value = Math.max(0, Math.min(4, Math.round(wheel.value.scrollTop / 36))) }
async function open(card: HTMLElement) {
  if (!props.allowed || busy.value) return
  close(); anchor = card; card.classList.add('priority-picking'); error.value = ''
  position.value = placePicker(card.getBoundingClientRect(), { width: innerWidth, height: innerHeight })
  opened.value = true
  await nextTick()
  if (!opened.value) return
  scrollTo(PRIORITIES.indexOf(props.priority ?? 'medium'), false)
  wheel.value?.focus({ preventScroll: true })
}
function contextmenu(event: MouseEvent) {
  if (!props.allowed) return
  event.preventDefault(); event.stopPropagation(); cancelPress()
  void open(event.currentTarget as HTMLElement)
}
function startPress(event: TouchEvent) {
  cancelPress(); if (!props.allowed || event.touches.length !== 1) return
  const card = event.currentTarget as HTMLElement
  press = setTimeout(() => { suppressUntil = Date.now() + 1500; void open(card) }, 500)
}
function cancelPress() { clearTimeout(press) }
function suppressClick(event: Event) {
  if (Date.now() < suppressUntil) { event.preventDefault(); event.stopImmediatePropagation() }
  suppressUntil = 0
}
async function commit() {
  if (!props.allowed || busy.value) return
  const priority = PRIORITIES[selected.value]!, old = props.priority ?? 'medium'
  close(); if (priority === old) return
  busy.value = true
  try {
    await props.submit(priority)
    if (!disposed && props.announce !== false) { notice.value = `${props.taskId} 优先级：${LABELS[old]} → ${LABELS[priority]}`; clearTimeout(toast); toast = setTimeout(() => { notice.value = '' }, 2400) }
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : '优先级修改失败' }
  finally { busy.value = false }
}
function key(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); close() }
  else if (event.key === 'Enter') { event.preventDefault(); void commit() }
  else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); scrollTo(selected.value + (event.key === 'ArrowUp' ? -1 : 1)) }
}
function outside(event: Event) { if (!pop.value?.contains(event.target as Node)) close() }
function pageScroll(event: Event) { if (!pop.value?.contains(event.target as Node)) close() }
watch(opened, value => {
  if (value) {
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('scroll', pageScroll, true)
    window.addEventListener('resize', close)
    document.addEventListener('keydown', escape)
  } else {
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('scroll', pageScroll, true)
    window.removeEventListener('resize', close)
    document.removeEventListener('keydown', escape)
  }
})
function escape(event: KeyboardEvent) { if (event.key === 'Escape') close() }
watch(() => props.allowed, allowed => { if (!allowed) { close(); cancelPress() } })
onBeforeUnmount(() => {
  disposed = true; close(); cancelPress(); clearTimeout(toast)
  document.removeEventListener('pointerdown', outside, true); document.removeEventListener('scroll', pageScroll, true)
  window.removeEventListener('resize', close); document.removeEventListener('keydown', escape)
})
defineExpose({ contextmenu, startPress, cancelPress, suppressClick })
</script>
<template>
  <Teleport to="body">
    <Transition name="priority-pop">
      <div v-if="opened" ref="pop" class="priority-pop" :class="position.side" :style="{ left: position.left + 'px', top: position.top + 'px', '--arrow': position.arrow + 'px' }" role="dialog" aria-label="设置优先级" @click.stop @keydown.stop="key" @contextmenu.prevent>
        <header>设置优先级<b>{{ taskId }}</b></header>
        <div class="wheelbox"><div class="lens" /><div ref="wheel" class="wheel" tabindex="0" role="listbox" aria-label="优先级" :aria-activedescendant="`priority-${taskId}-${selected}`" @scroll="mark">
          <div class="pad" /><div v-for="(p, i) in PRIORITIES" :id="`priority-${taskId}-${i}`" :key="p" class="opt" :class="{ cur: selected === i }" :data-priority="p" role="option" :aria-selected="selected === i" @click="selected === i ? commit() : scrollTo(i)"><span class="dot" />{{ LABELS[p] }}<small>{{ ['马上做','先做','正常','有空做','不做也行'][i] }}</small></div><div class="pad" />
        </div></div>
        <footer><span>滚轮或上下滑</span><button type="button" class="btn btn-sm primary" @click="commit">确定</button></footer>
      </div>
    </Transition>
    <div v-if="notice || error" class="priority-toast" :role="error ? 'alert' : 'status'" @click.stop="error = ''">{{ error || notice }}</div>
  </Teleport>
</template>
<style scoped>
.priority-pop { position: fixed; box-sizing: border-box; width: 184px; height: 236px; background: var(--surface); border: 1px solid var(--line-strong); border-radius: 10px; box-shadow: 0 10px 30px var(--drawer-shadow); z-index: 1100; display: grid; grid-template-rows: 53px 128px 53px; --from: -12px; }.priority-pop.left { --from: 12px; }
.priority-pop::after { content: ''; position: absolute; top: var(--arrow); width: 10px; height: 10px; background: var(--surface); border: 1px solid var(--line-strong); transform: rotate(45deg); }.right::after { left: -6px; border-right: 0; border-top: 0; }.left::after { right: -6px; border-left: 0; border-bottom: 0; }
header { padding: 7px 12px; font-size: 12px; color: var(--text-2); border-bottom: 1px solid var(--line); }header b { display: block; color: var(--text); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.wheelbox { position: relative; overflow: hidden; }.wheel { position: absolute; inset: 0; overflow-y: scroll; scroll-snap-type: y mandatory; scrollbar-width: none; overscroll-behavior: contain; outline: none; }.wheel::-webkit-scrollbar { display: none; }.pad { height: 46px; }.opt { height: 36px; scroll-snap-align: center; display: flex; align-items: center; gap: 8px; padding: 0 14px; font-size: 14px; color: var(--text-3); cursor: pointer; }.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--priority-color); flex: none; }[data-priority="optional"] .dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--p3); }.cur { color: var(--text); font-weight: 600; }.opt small { margin-left: auto; font-size: 11px; color: var(--text-3); font-weight: 400; }
.lens { position: absolute; left: 8px; right: 8px; top: 46px; height: 36px; border-radius: 7px; background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line); pointer-events: none; }.wheelbox::before,.wheelbox::after { content: ''; position: absolute; left: 0; right: 0; height: 40px; z-index: 2; pointer-events: none; }.wheelbox::before { top: 0; background: linear-gradient(var(--surface),transparent); }.wheelbox::after { bottom: 0; background: linear-gradient(transparent,var(--surface)); }
footer { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-top: 1px solid var(--line); font-size: 11px; color: var(--text-3); }
.priority-pop-enter-active,.priority-pop-leave-active { transition: opacity .2s ease, transform .22s cubic-bezier(.2,.9,.3,1.2); }.priority-pop-enter-from,.priority-pop-leave-to { opacity: 0; transform: translateX(var(--from)) scale(.96); }
.priority-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 6px 14px; border-radius: 16px; font-size: 13px; z-index: 1200; }
@media (prefers-reduced-motion: reduce) { .priority-pop-enter-active,.priority-pop-leave-active { transition: none; } }
</style>
