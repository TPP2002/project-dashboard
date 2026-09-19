<script setup lang="ts">
// 「导入报告」对话框(READER-IMPORT-BUTTON T3):拖拽 / 点选文件 → 逐个串行转换(重库在
// T2 的 convertFile 里按格式动态加载,pdf 较慢,串行才不卡界面)→ 逐份 POST 给 server 落
// 本机数据目录。失败的行显示写给负责人看的中文提示、不参与导入。两种收尾:
//   · 全部导入成功 → emit done,父页面刷新清单、选中第一份、关对话框、给一行提示;
//   · 有导入失败的行 → emit imported,父页面只刷新清单(成功的马上进报告架),
//     对话框保持打开,失败的行与底部汇总留给负责人看,点「关闭」才走(失败的行可原地重试)。
// 其余编排都在 Reader.vue,这里不碰 store。
// 界面规矩:不用 emoji;颜色只用 base.css 令牌;图标只用 web/src/icons 现有精灵;
// 不放过渡与动画,prefers-reduced-motion 无需降级;拖拽区可 Tab 聚焦、回车 / 空格选文件。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { convertFile, ImportError } from '@/utils/reportImport'
import type { ImportResult } from '@/utils/reportImport/types'
import { bytesToBase64, shouldKeepOriginal, summarizeImport } from '@/utils/reportImport/importFlow'
import { importReport } from '@/api/reader'

const props = defineProps<{ project: string }>()
// imported:本轮有成功的导入,父页面刷新清单(成功的马上进报告架),对话框开不开不归它管;
// done:全部成功,父页面刷新清单、选中第一份、关对话框、给一行提示。
const emit = defineEmits<{
  close: []
  imported: []
  done: [result: { message: string; firstKey: string | null }]
}>()

/** 一行 = 一个待导入的文件。转换阶段:等待 → 转换中 → 可导入 / 失败;导入阶段另有 导入中 / 已导入 / 导入失败 */
interface ImportRow {
  id: number
  file: File
  name: string
  size: number
  status: 'waiting' | 'converting' | 'ready' | 'failed'
  converted: ImportResult | null
  warns: string[]               // 转换提示(如「3 张图片未导入」),点开看全文
  title: string                 // 可编辑的标题,默认转换给出的
  hint: string                  // 转换失败时给负责人看的提示
  warningsOpen: boolean         // 「转换提示 N 条」展开没有
  importing: boolean
  imported: boolean
  duplicate: boolean
  importError: string
  note: string                  // 附加提示,如「原件太大没有保存,只导入了文字」
  importKey: string             // 导入成功后 server 给的 key(选中第一份新报告要用)
}

const dialog = ref<HTMLDialogElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const rows = ref<ImportRow[]>([])
const dragging = ref(false)
const submitting = ref(false)
/** 一份都没导入成功时留在对话框里给负责人看的一句话(有成功的就交给页头提示,对话框关闭) */
const summary = ref('')

onMounted(() => dialog.value?.showModal())
onUnmounted(() => dialog.value?.close())
function backdrop(event: MouseEvent) { if (event.target === dialog.value) requestClose() }
function requestClose() { if (!submitting.value) emit('close') }

let seq = 0
let pumping = false

function newRow(file: File): ImportRow {
  return {
    id: ++seq, file, name: file.name, size: file.size, status: 'waiting',
    converted: null, warns: [], title: '', hint: '', warningsOpen: false,
    importing: false, imported: false, duplicate: false, importError: '', note: '', importKey: '',
  }
}

function queueFiles(files: File[]) {
  if (submitting.value || !files.length) return
  rows.value.push(...files.map(newRow))
  void pump()
}

/** 拖拽区同时可点击选文件;键盘回车 / 空格同样打开文件选择 */
function pick() { if (!submitting.value) input.value?.click() }
function onPick(event: Event) {
  const files = (event.target as HTMLInputElement).files
  if (files) queueFiles([...files])
  ;(event.target as HTMLInputElement).value = ''
}
function onDrop(event: DragEvent) {
  dragging.value = false
  const files = event.dataTransfer?.files
  if (files) queueFiles([...files])
}

/** 逐个串行转换:转换全走 T2 的 convertFile,失败按 ImportError.hint 给负责人一句大白话 */
async function pump() {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      const row = rows.value.find((r) => r.status === 'waiting')
      if (!row) break
      row.status = 'converting'
      try {
        // 现读现交:转换器(尤其 pdfjs)会把传入的 ArrayBuffer 转移(detach)走,这块内存
        // 用完即废,不许存下来复用;提交阶段的 base64 由 submit() 另读一份新的。
        const data = await row.file.arrayBuffer()
        row.converted = await convertFile({ name: row.name, data })
        row.warns = row.converted.warnings
        row.title = row.converted.title
        row.status = 'ready'
      } catch (e) {
        row.hint = e instanceof ImportError ? e.hint : `这份文件读不出来,请换一份试试(${e instanceof Error ? e.message : String(e)})`
        row.status = 'failed'
      }
    }
  } finally {
    pumping = false
  }
}

const readyRows = computed(() => rows.value.filter((r) => r.status === 'ready'))

/** 逐份 POST;单份失败只标那一行并显示 server 的话,不影响其它份 */
async function submit() {
  if (submitting.value || !readyRows.value.length) return
  summary.value = '' // 上一轮的汇总话术清掉,重试期间不残留旧提示
  submitting.value = true
  const results: { ok: boolean; duplicate: boolean }[] = []
  try {
    for (const row of readyRows.value) {
      const converted = row.converted
      if (!converted) continue
      row.importing = true
      try {
        // 原件超过 30MB 就不带 original(server 会拒),只导入文字,并在这行给负责人一句提示
        const keepOriginal = shouldKeepOriginal(row.file.size)
        if (!keepOriginal) row.note = '原件太大没有保存,只导入了文字'
        // 总是重新读一份新的字节:转换阶段那块 ArrayBuffer 已被转换器(尤其 pdfjs)detach,
        // 复用会报「Cannot perform Construct on a detached ArrayBuffer」
        const data = await row.file.arrayBuffer()
        const res = await importReport({
          project: props.project,
          title: row.title.trim() || converted.title,
          fileName: row.name,
          format: converted.format,
          md: converted.md,
          warnings: converted.warnings,
          original: keepOriginal ? { name: row.name, mime: row.file.type, base64: bytesToBase64(data) } : undefined,
        })
        row.imported = true
        row.duplicate = res.duplicate
        row.importKey = res.key
        results.push({ ok: true, duplicate: res.duplicate })
      } catch (e) {
        row.importError = e instanceof Error ? e.message : String(e)
        results.push({ ok: false, duplicate: false })
      } finally {
        row.importing = false
      }
    }
  } finally {
    submitting.value = false
  }
  const message = summarizeImport(results)
  const firstKey = readyRows.value.find((r) => r.imported)?.importKey || null
  const failedCount = results.filter((r) => !r.ok).length
  if (firstKey && !failedCount) {
    // 全部成功:父页面刷新清单、选中第一份、关对话框、给一行提示
    emit('done', { message, firstKey })
    return
  }
  if (firstKey) {
    // 有成功也有失败:清单照常刷新(成功的马上在报告架里),但对话框不自动关——
    // 失败的行和这里的汇总留给负责人看,点「关闭」才走
    summary.value = `${message};${failedCount} 份导入失败,原因见上`
    emit('imported')
    return
  }
  summary.value = message
}

function statusText(row: ImportRow): string {
  if (row.importing) return '导入中'
  if (row.imported) return '已导入'
  if (row.importError) return '导入失败'
  return { waiting: '等待', converting: '转换中', ready: '可导入', failed: '失败' }[row.status]
}
function statusClass(row: ImportRow): string {
  if (row.importing) return 'info'
  if (row.imported) return 'ok'
  if (row.importError) return 'bad'
  return { waiting: 'n', converting: 'info', ready: 'ok', failed: 'bad' }[row.status]
}
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<template>
  <dialog ref="dialog" class="rimp-dialog" aria-labelledby="rimp-title" @cancel.prevent="requestClose" @click="backdrop">
    <div class="rimp">
      <header class="rimp-head">
        <h2 id="rimp-title"><Icon name="file" :size="16" /> 导入报告</h2>
        <button type="button" class="btn btn-sm" :disabled="submitting" autofocus @click="requestClose"><Icon name="x" :size="14" /> 关闭</button>
      </header>
      <p class="rimp-sub">把电脑里的报告文件加进来,转好后点「导入」,几秒后它就会出现在左边的报告架里,可以直接读、写批注。</p>
      <div
        class="rimp-drop"
        :class="{ over: dragging, busy: submitting }"
        role="button"
        tabindex="0"
        aria-label="选择或拖入要导入的文件"
        @click="pick"
        @keydown.enter.prevent="pick"
        @keydown.space.prevent="pick"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <span class="drop-main">把文件拖到这里,或点击选择文件(可一次选多份)</span>
        <span class="drop-sub">支持 md / markdown / txt / html / htm / docx / pdf;扫描件 pdf、.doc、图片不支持</span>
      </div>
      <input ref="input" type="file" multiple hidden accept=".md,.markdown,.txt,.html,.htm,.docx,.pdf" @change="onPick">
      <ul v-if="rows.length" class="rimp-rows">
        <li v-for="row in rows" :key="row.id" class="rimp-row" :class="{ bad: row.status === 'failed' || row.importError }">
          <div class="row-line">
            <span class="row-name" :title="row.name">{{ row.name }}</span>
            <span class="row-size">{{ fmtSize(row.size) }}</span>
            <span class="badge" :class="statusClass(row)">{{ statusText(row) }}</span>
          </div>
          <div v-if="row.status === 'ready'" class="row-edit">
            <input v-model="row.title" class="row-title" maxlength="120" :aria-label="`「${row.name}」导入后的标题`" placeholder="报告标题">
            <button
              v-if="row.warns.length"
              type="button"
              class="btn btn-sm quiet"
              :aria-expanded="row.warningsOpen"
              @click="row.warningsOpen = !row.warningsOpen"
            ><Icon name="alertTri" :size="14" /> 转换提示 {{ row.warns.length }} 条</button>
          </div>
          <ul v-if="row.warningsOpen && row.warns.length" class="row-warns">
            <li v-for="(w, i) in row.warns" :key="i">{{ w }}</li>
          </ul>
          <p v-if="row.status === 'failed'" class="row-err" role="alert">{{ row.hint }}</p>
          <p v-if="row.imported" class="row-note">{{ row.duplicate ? '已导入过,未重复保存' : '已导入' }}</p>
          <p v-if="row.importError" class="row-err" role="alert">{{ row.importError }}</p>
          <p v-if="row.note" class="row-note">{{ row.note }}</p>
        </li>
      </ul>
      <p v-if="summary" class="rimp-hint" role="status">{{ summary }}</p>
      <footer class="rimp-actions">
        <button type="button" class="btn btn-sm primary" :disabled="!readyRows.length || submitting" @click="submit">
          {{ submitting ? '导入中…' : `导入 ${readyRows.length} 份` }}
        </button>
        <button type="button" class="btn btn-sm quiet" :disabled="submitting" @click="requestClose">关闭</button>
      </footer>
    </div>
  </dialog>
</template>

<style scoped>
.rimp-dialog { width: min(680px, 92vw); color: var(--text); background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--r-lg); box-shadow: var(--shadow); padding: var(--s4); }
.rimp-dialog::backdrop { background: var(--overlay); }
.rimp { display: grid; gap: var(--s3); }
.rimp-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); }
.rimp-head h2 { margin: 0; font-size: var(--fs-md); display: flex; align-items: center; gap: var(--s2); }
.rimp-sub { margin: 0; font-size: var(--fs-sm); color: var(--text-2); }
.rimp-drop { display: grid; gap: var(--s1); justify-items: center; padding: var(--s5) var(--s4); border: 1px dashed var(--line-strong); border-radius: var(--r); background: var(--surface-2); cursor: pointer; text-align: center; }
.rimp-drop:hover, .rimp-drop:focus-visible { border-color: var(--text-3); background: var(--surface-3); }
.rimp-drop.over { border-color: var(--text-2); background: var(--surface-3); }
.rimp-drop.busy { opacity: .55; }
.drop-main { font-size: var(--fs-base); font-weight: 600; }
.drop-sub { font-size: var(--fs-xs); color: var(--text-3); }
.rimp-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s2); max-height: 320px; overflow: auto; }
.rimp-row { border: 1px solid var(--line); border-radius: var(--r); padding: var(--s2); display: grid; gap: var(--s1); }
.rimp-row.bad { border-color: var(--bad); }
.row-line { display: flex; align-items: center; gap: var(--s2); }
.row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); font-weight: 600; }
.row-size { color: var(--text-3); font-size: var(--fs-xs); }
.row-edit { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }
.row-title { flex: 1; min-width: 0; font: inherit; font-size: var(--fs-sm); padding: var(--s1) var(--s2); border: 1px solid var(--line-strong); border-radius: var(--r); background: var(--surface); color: var(--text); }
.row-warns { margin: 0; padding-left: var(--s4); color: var(--text-2); font-size: var(--fs-xs); display: grid; gap: 2px; }
.row-err { margin: 0; color: var(--bad); font-size: var(--fs-xs); line-height: 1.5; }
.row-note { margin: 0; color: var(--ok); font-size: var(--fs-xs); }
.rimp-hint { margin: 0; font-size: var(--fs-sm); color: var(--bad); }
.rimp-actions { display: flex; gap: var(--s2); justify-content: flex-end; flex-wrap: wrap; }
</style>
