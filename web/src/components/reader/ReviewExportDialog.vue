<script setup lang="ts">
// 「导出给外脑」对话框(READER-EXPORT-REVIEW):显示文件名与批注条数、前 60 行只读预览,
// 「下载 .md」走 Blob + a[download](不经服务器落盘),「复制到剪贴板」走 navigator.clipboard
// (失败退回:选中预览内容并提示按 Ctrl+C),「关闭」或点背景 / Esc 都能退场。
// 界面规矩:不用 emoji;颜色只用 base.css 令牌;图标只用 web/src/icons 现有精灵;
// 组件里不放任何过渡与动画,prefers-reduced-motion 无需降级。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Icon from '@/components/Icon.vue'

const props = defineProps<{ fileName: string; md: string; annoCount: number }>()
const emit = defineEmits<{ close: [] }>()

/** 预览只给前 60 行,超出显示「…共 N 行」(完整内容随下载 / 复制带走,不受预览截断影响) */
const PREVIEW_LINES = 60
const dialog = ref<HTMLDialogElement | null>(null)
const previewBox = ref<HTMLTextAreaElement | null>(null)
const hint = ref('')
const allLines = computed(() => props.md.split('\n'))
const truncated = computed(() => allLines.value.length > PREVIEW_LINES)
const previewText = computed(() => (truncated.value ? allLines.value.slice(0, PREVIEW_LINES).join('\n') : props.md))

onMounted(() => dialog.value?.showModal())
onUnmounted(() => dialog.value?.close())
function backdrop(event: MouseEvent) { if (event.target === dialog.value) emit('close') }

function download() {
  const blob = new Blob([props.md], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = props.fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  hint.value = '已开始下载'
}
async function copy() {
  hint.value = ''
  try {
    await navigator.clipboard.writeText(props.md)
    hint.value = '已复制全文,可直接去粘贴'
  } catch {
    previewBox.value?.select()
    hint.value = '浏览器没放行剪贴板:已选中预览内容,请按 Ctrl+C 复制'
  }
}
</script>

<template>
  <dialog ref="dialog" class="rex-dialog" aria-labelledby="rex-title" @cancel.prevent="emit('close')" @click="backdrop">
    <div class="rex">
      <header class="rex-head">
        <h2 id="rex-title"><Icon name="download" :size="16" /> 导出给外脑</h2>
        <button type="button" class="btn btn-sm" autofocus @click="emit('close')"><Icon name="x" :size="14" /> 关闭</button>
      </header>
      <p class="rex-meta">
        <span class="mono">{{ props.fileName }}</span>
        <span class="rex-count">共 {{ props.annoCount }} 条批注</span>
      </p>
      <textarea ref="previewBox" class="rex-preview" readonly :value="previewText" aria-label="导出内容预览(前 60 行)" />
      <p v-if="truncated" class="rex-more">…共 {{ allLines.length }} 行</p>
      <p v-if="hint" class="rex-hint" role="status">{{ hint }}</p>
      <footer class="rex-actions">
        <button type="button" class="btn btn-sm primary" @click="download"><Icon name="download" :size="14" /> 下载 .md</button>
        <button type="button" class="btn btn-sm" @click="copy"><Icon name="copy" :size="14" /> 复制到剪贴板</button>
        <button type="button" class="btn btn-sm quiet" @click="emit('close')">关闭</button>
      </footer>
    </div>
  </dialog>
</template>

<style scoped>
.rex-dialog { width: min(760px, 92vw); color: var(--text); background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--r-lg); box-shadow: var(--shadow); padding: var(--s4); }
.rex-dialog::backdrop { background: var(--overlay); }
.rex { display: grid; gap: var(--s3); }
.rex-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); }
.rex-head h2 { margin: 0; font-size: var(--fs-md); display: flex; align-items: center; gap: var(--s2); }
.rex-meta { margin: 0; font-size: var(--fs-sm); color: var(--text-2); display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap; }
.rex-count { color: var(--text-3); }
.rex-preview { width: 100%; height: 320px; resize: vertical; font-family: var(--mono); font-size: var(--fs-xs); line-height: 1.6; color: var(--text); background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r); padding: var(--s2); white-space: pre; overflow: auto; }
.rex-more { margin: 0; font-size: var(--fs-xs); color: var(--text-3); }
.rex-hint { margin: 0; font-size: var(--fs-sm); color: var(--info); }
.rex-actions { display: flex; gap: var(--s2); justify-content: flex-end; flex-wrap: wrap; }
</style>
