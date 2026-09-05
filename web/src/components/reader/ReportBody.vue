<script setup lang="ts">
// 报告正文:干净读法为主(负责人 2026-09-05 拍),改动段只留左侧细条;点条看旧文。
// 其它读法(标记改动 / 只看改动 / 并排)与边注摆法(折叠 / 全展 / 只在右栏)由 prefs 切换。
//
// 2026-09-06(READER-USABILITY-ROUND2)三处返工,都是负责人实测撞出来的:
//  ① 段落工具原来悬在段落盒子外 36px 处,中间隔着 10px 死区——鼠标一离开文字按钮就没了,永远点不到。
//     现在按钮落在段落自己的 padding 里,悬停区连成一片。
//  ② 只能整段批注。现在框选文字即弹工具条:批注 / 荧光笔,批注还会记住选区,回来能看见批的是哪句。
//  ③ 荧光笔:选区偏移存本机账本,换读法、换字号都标得回来。
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { DocBlock } from '@/utils/reader/diff'
import type { ReaderNoteLayer, ReaderAnno, ReaderHighlight, MarkColor } from '@/api/reader'
import type { DiffMode, NotesLayout } from '@/stores/reader'
import { renderMarkdown } from '@/utils/reader/markdown'
import { anchorMatch, plainText } from '@/utils/reader/anchors'
import { applyMarks, offsetIn, type MarkSpan } from '@/utils/reader/marks'

const props = defineProps<{
  blocks: DocBlock[]
  noteLayers: ReaderNoteLayer[]
  annos: ReaderAnno[]
  highlights: ReaderHighlight[]
  mode: DiffMode
  notesLayout: NotesLayout
  fontSize: number
  markColor: MarkColor
  prevLabel?: string
  scrollTo?: string | null
}>()
const emit = defineEmits<{
  (e: 'active-heading', id: string | null): void
  (e: 'progress', ratio: number): void
  (e: 'add-anno', payload: { blockId: string; anchor: string; quote: string; text: string; start?: number; end?: number }): void
  (e: 'delete-anno', id: string): void
  (e: 'add-mark', payload: { blockId: string; anchor: string; quote: string; start: number; end: number; color: MarkColor }): void
  (e: 'delete-mark', id: string): void
  (e: 'pick-color', color: MarkColor): void
}>()

const root = ref<HTMLElement | null>(null)
const openOld = ref<Set<string>>(new Set())
const openNotes = ref<Set<string>>(new Set())
/** 正在写的批注:整段批注只有 blockId,框选批注还带选区 */
const composing = ref<{ blockId: string; quote: string; start?: number; end?: number } | null>(null)
const draft = ref('')

const COLORS: { id: MarkColor; label: string }[] = [
  { id: 'yellow', label: '黄' }, { id: 'green', label: '绿' }, { id: 'blue', label: '蓝' }, { id: 'pink', label: '粉' },
]

/** 每段的渲染 HTML(缓存按 block id) */
const html = computed(() => {
  const m = new Map<string, string>()
  for (const b of props.blocks) {
    if (b.kind === 'removed') { m.set(b.id, renderMarkdown(b.old || '')); continue }
    m.set(b.id, renderMarkdown(b.md))
  }
  return m
})
const oldHtml = computed(() => {
  const m = new Map<string, string>()
  for (const b of props.blocks) if (b.old && b.kind !== 'removed') m.set(b.id, renderMarkdown(b.old))
  return m
})

/** 全篇提示 + 每个标题块挂的边注 */
type NoteWithLayer = { anchor: string; kind: string; text: string; layerId: string; layerName: string }
const allNotes = computed<NoteWithLayer[]>(() =>
  props.noteLayers.flatMap((l) => l.notes.map((n) => ({ ...n, layerId: l.id, layerName: l.name }))),
)
const globalNotes = computed(() => allNotes.value.filter((n) => n.anchor === '全篇'))
const notesByBlock = computed(() => {
  const m = new Map<string, NoteWithLayer[]>()
  const pending = allNotes.value.filter((n) => n.anchor !== '全篇')
  const used = new Set<NoteWithLayer>()
  for (const b of props.blocks) {
    if (!b.heading) continue
    const mine = pending.filter((n) => !used.has(n) && anchorMatch(n.anchor, b.heading!.text))
    if (mine.length) { m.set(b.id, mine); mine.forEach((n) => used.add(n)) }
  }
  return m
})
/** 没匹配到任何标题的边注,归到全篇提示末尾(和旧阅读台一致) */
const orphanNotes = computed(() => {
  const used = new Set<NoteWithLayer>()
  for (const arr of notesByBlock.value.values()) arr.forEach((n) => used.add(n))
  return allNotes.value.filter((n) => n.anchor !== '全篇' && !used.has(n))
})
const annosByBlock = computed(() => {
  const m = new Map<string, ReaderAnno[]>()
  for (const a of props.annos) { const arr = m.get(a.blockId) || []; arr.push(a); m.set(a.blockId, arr) }
  return m
})
/** 每段所在的最近标题(给「只看改动」当上下文、给批注当锚) */
const sectionOf = computed(() => {
  const m = new Map<string, string>()
  let cur = ''
  for (const b of props.blocks) { if (b.heading) cur = b.heading.text; m.set(b.id, cur) }
  return m
})

const kindClass = (k: string) => ({ 纠正: 'n-fix', 冲突: 'n-conf', 改判: 'n-over', 提示: 'n-info', 现状: 'n-now' } as Record<string, string>)[k] || 'n-info'
const heavy = (b: DocBlock) => (b.charDiff?.ratio ?? 0) > 0.5

function toggleOld(id: string) { const s = new Set(openOld.value); s.has(id) ? s.delete(id) : s.add(id); openOld.value = s }
function toggleNotes(id: string) { const s = new Set(openNotes.value); s.has(id) ? s.delete(id) : s.add(id); openNotes.value = s }

function focusEditor(id: string) {
  nextTick(() => root.value?.querySelector<HTMLTextAreaElement>(`#anno-editor-${id} textarea`)?.focus())
}
function startAnno(b: DocBlock) {
  composing.value = { blockId: b.id, quote: plainText(b.md || b.old || '').slice(0, 120) }
  draft.value = ''
  focusEditor(b.id)
}
function submitAnno() {
  const c = composing.value
  const text = draft.value.trim()
  if (!c || !text) return
  emit('add-anno', { blockId: c.blockId, anchor: sectionOf.value.get(c.blockId) || '', quote: c.quote, text, start: c.start, end: c.end })
  composing.value = null
  draft.value = ''
}
const fmtAt = (iso: string) => iso.replace('T', ' ').slice(0, 16)

/* ---------------- 框选工具条 ---------------- */
type SelInfo = { blockId: string; start: number; end: number; text: string; x: number; y: number }
/** 选区工具条;markId 有值时是「点在已有荧光笔上」的那一档,只给取消/换色 */
const bar = ref<(SelInfo & { markId?: string }) | null>(null)

function hostOf(node: Node | null): HTMLElement | null {
  const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null
  return (el?.closest('.blk .body') as HTMLElement) || null
}
function readSelection(): SelInfo | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  const host = hostOf(range.startContainer)
  // 只支持段内选区:跨段的偏移没有共同基准,存下来也标不回去
  if (!host || !host.contains(range.endContainer)) return null
  const start = offsetIn(host, range.startContainer, range.startOffset)
  const end = offsetIn(host, range.endContainer, range.endOffset)
  const text = range.toString().trim()
  if (start < 0 || end <= start || !text) return null
  const blk = host.closest('.blk') as HTMLElement | null
  if (!blk?.id) return null
  const r = range.getBoundingClientRect()
  return { blockId: blk.id, start, end, text, x: r.left + r.width / 2, y: r.top }
}
function onSelect() {
  // 让浏览器先把这一下的选区结算完再读(拖选到边界时 mouseup 与 selection 更新有先后)
  setTimeout(() => {
    const s = readSelection()
    bar.value = s ? { ...s } : (bar.value?.markId ? bar.value : null)
  }, 0)
}
/** 点在已有荧光笔上:直接给取消/换色,不用先框选一遍 */
function onDocClick(e: MouseEvent) {
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && sel.toString().trim()) return // 正在框选,这一档归 onSelect 管
  const el = (e.target as HTMLElement)?.closest?.('mark.hl') as HTMLElement | null
  if (!el) { bar.value = null; return }
  const h = props.highlights.find((x) => x.id === el.dataset.markId)
  if (!h) { bar.value = null; return }
  const r = el.getBoundingClientRect()
  bar.value = { blockId: h.blockId, start: h.start, end: h.end, text: el.textContent || '', x: r.left + r.width / 2, y: r.top, markId: h.id }
}
function barAnno() {
  const s = bar.value
  if (!s || s.markId) return
  composing.value = { blockId: s.blockId, quote: s.text.slice(0, 160), start: s.start, end: s.end }
  draft.value = ''
  bar.value = null
  window.getSelection()?.removeAllRanges()
  focusEditor(s.blockId)
}
/** 涂色;点在已有荧光笔上时就是换色——服务端 add 会把重叠的旧笔顶掉,不用先删一次 */
function barMark(color: MarkColor) {
  const s = bar.value
  if (!s || s.end <= s.start) return
  emit('pick-color', color)
  emit('add-mark', { blockId: s.blockId, anchor: sectionOf.value.get(s.blockId) || '', quote: s.text.slice(0, 160), start: s.start, end: s.end, color })
  bar.value = null
  window.getSelection()?.removeAllRanges()
}
function barClear() {
  const s = bar.value
  if (!s) return
  if (s.markId) emit('delete-mark', s.markId)
  else for (const h of props.highlights) if (h.blockId === s.blockId && h.start < s.end && s.start < h.end) emit('delete-mark', h.id)
  bar.value = null
  window.getSelection()?.removeAllRanges()
}
/** 选区内是否已经有荧光笔(决定要不要给「取消高亮」) */
const barHasMark = computed(() => {
  const s = bar.value
  if (!s) return false
  if (s.markId) return true
  return props.highlights.some((h) => h.blockId === s.blockId && h.start < s.end && s.start < h.end)
})

/* ---------------- 标记回画 ---------------- */
function redraw() {
  const el = root.value
  if (!el) return
  const byBlock = new Map<string, MarkSpan[]>()
  const push = (id: string, s: MarkSpan) => { const arr = byBlock.get(id) || []; arr.push(s); byBlock.set(id, arr) }
  for (const h of props.highlights) push(h.blockId, { id: h.id, start: h.start, end: h.end, cls: `hl hl-${h.color}`, title: '荧光笔 · 点一下可取消' })
  for (const a of props.annos) {
    if (typeof a.start !== 'number' || typeof a.end !== 'number') continue
    push(a.blockId, { id: a.id, start: a.start, end: a.end, cls: 'anno-anchor', title: `批注:${a.text}` })
  }
  // 每段都要走一趟:没有标记的段也得把上一版留下的 <mark> 清干净
  for (const b of props.blocks) {
    const hostEl = el.querySelector<HTMLElement>(`#${b.id} .body`)
    if (!hostEl) continue
    applyMarks(hostEl, (byBlock.get(b.id) || []).slice().sort((x, y) => x.start - y.start))
  }
}
watch(
  () => [props.highlights, props.annos, props.blocks, props.mode, props.notesLayout] as const,
  () => nextTick(redraw),
  { deep: false },
)

// 滚动:进度 + 当前标题
let raf = 0
function onScroll() {
  if (bar.value) bar.value = null // 工具条是钉在视口坐标上的,滚了就不准,直接收起
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    const el = root.value
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    emit('progress', max > 0 ? el.scrollTop / max : 1)
    let cur: string | null = null
    for (const b of props.blocks) {
      if (!b.heading) continue
      const node = el.querySelector<HTMLElement>(`#${b.id}`)
      if (!node) continue
      if (node.offsetTop - el.scrollTop <= 80) cur = b.id
      else break
    }
    emit('active-heading', cur)
  })
}
watch(() => props.scrollTo, (id) => {
  if (!id) return
  nextTick(() => {
    const node = root.value?.querySelector<HTMLElement>(`#${id}`)
    node?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    if (notesByBlock.value.has(id)) { const s = new Set(openNotes.value); s.add(id); openNotes.value = s }
  })
})
watch(() => props.blocks, () => {
  openOld.value = new Set(); openNotes.value = new Set(); composing.value = null; bar.value = null
  root.value?.scrollTo({ top: 0 })
})
/** 点到正文之外(右栏、页头)也要收起工具条 */
function onDocMouseDown(e: MouseEvent) {
  const t = e.target as HTMLElement | null
  if (bar.value && !t?.closest?.('.selbar') && !root.value?.contains(t as Node)) bar.value = null
}
onMounted(() => {
  root.value?.addEventListener('scroll', onScroll, { passive: true })
  document.addEventListener('mousedown', onDocMouseDown)
  nextTick(redraw)
})
onBeforeUnmount(() => {
  root.value?.removeEventListener('scroll', onScroll)
  document.removeEventListener('mousedown', onDocMouseDown)
})
</script>

<template>
  <section
    ref="root"
    class="doc"
    :class="[`mode-${mode}`, `notes-${notesLayout}`]"
    :style="{ fontSize: fontSize + 'px' }"
    @mouseup="onSelect"
    @keyup="onSelect"
    @click="onDocClick"
  >
    <div class="paper">
      <div v-if="globalNotes.length || orphanNotes.length" class="notes open global">
        <b>全篇提示</b>
        <ul>
          <li v-for="(n, i) in [...globalNotes, ...orphanNotes]" :key="i">
            <span class="n-k" :class="kindClass(n.kind)">{{ n.kind }}</span>{{ n.text }}<span class="n-layer">{{ n.layerName }}</span>
          </li>
        </ul>
      </div>

      <template v-for="b in blocks" :key="b.id">
        <div v-if="mode === 'changes' && b.kind === 'changed' && !b.heading" class="ctx">所在节:{{ sectionOf.get(b.id) || '(开头)' }}</div>
        <div
          :id="b.id"
          class="blk"
          :class="[b.kind, { open: openOld.has(b.id), 'has-anno': annosByBlock.has(b.id), heavy: heavy(b) }]"
        >
          <span
            class="gut"
            :title="b.kind === 'changed' ? `这段相对${prevLabel || '上一版'}有改动,点开看旧文` : b.kind === 'added' ? '这段是新版新增的' : b.kind === 'removed' ? '这段在新版被删掉了' : ''"
            @click="b.kind === 'changed' && toggleOld(b.id)"
          />
          <div class="ptools">
            <button type="button" title="给整段写批注(想批某一句就直接框选那句)" @click="startAnno(b)">✎</button>
            <button v-if="b.kind === 'changed'" type="button" title="看旧文" @click="toggleOld(b.id)">⇄</button>
          </div>

          <div v-if="b.kind === 'removed'" class="old shown">
            <span class="tag">{{ prevLabel || '上一版' }} 已删</span>
            <div v-html="html.get(b.id)" />
          </div>
          <template v-else>
            <div class="new">
              <p
                v-if="b.kind === 'changed' && b.charDiff && !heavy(b) && (mode === 'marks' || mode === 'changes' || mode === 'split')"
                class="body"
                v-html="b.charDiff.newHtml"
              />
              <div v-else class="body" v-html="html.get(b.id)" />
              <button
                v-if="b.heading && notesByBlock.has(b.id) && notesLayout !== 'rail'"
                type="button"
                class="hmark"
                :title="`这一节有 ${notesByBlock.get(b.id)!.length} 条边注,点开`"
                @click="toggleNotes(b.id)"
              >ⓘ {{ notesByBlock.get(b.id)!.length }}</button>
            </div>
            <div v-if="b.kind === 'changed'" class="old">
              <span class="tag">{{ prevLabel || '上一版' }} 旧文</span>
              <div v-if="b.charDiff && !heavy(b)" class="old-text" v-html="b.charDiff.oldHtml" />
              <div v-else v-html="oldHtml.get(b.id)" />
            </div>
          </template>

          <div
            v-if="b.heading && notesByBlock.has(b.id) && notesLayout !== 'rail'"
            class="notes"
            :class="{ open: notesLayout === 'always' || openNotes.has(b.id) }"
          >
            <ul>
              <li v-for="(n, i) in notesByBlock.get(b.id)" :key="i">
                <span class="n-k" :class="kindClass(n.kind)">{{ n.kind }}</span>{{ n.text }}<span class="n-layer">{{ n.layerName }}</span>
              </li>
            </ul>
          </div>

          <div v-if="annosByBlock.has(b.id)" class="annos">
            <div v-for="a in annosByBlock.get(b.id)" :key="a.id" class="anno-card">
              <span class="who">{{ a.author }} · {{ fmtAt(a.at) }}</span>
              <span v-if="a.quote && a.start !== undefined" class="on-quote">「{{ a.quote }}」</span>{{ a.text }}
              <button type="button" class="del" title="删除这条批注" @click="emit('delete-anno', a.id)">×</button>
            </div>
          </div>
          <div v-if="composing?.blockId === b.id" :id="`anno-editor-${b.id}`" class="anno-card editor">
            <div v-if="composing.start !== undefined" class="on-quote sel">批的是这句:「{{ composing.quote }}」</div>
            <textarea v-model="draft" rows="3" placeholder="对这一段的意见:不对在哪 / 要外脑改什么 / 认可" @keydown.ctrl.enter.prevent="submitAnno()" />
            <div class="row">
              <button type="button" class="btn btn-sm primary" @click="submitAnno()">保存批注</button>
              <button type="button" class="btn btn-sm quiet" @click="composing = null">取消</button>
              <span class="lite">存到看板本机账本并同步到对应任务卡;Ctrl+Enter 保存</span>
            </div>
          </div>
        </div>
      </template>
      <div class="tail" />
    </div>

    <!-- 框选工具条:钉在选区上方,按钮一律 mousedown.prevent,不然一按选区就没了 -->
    <div
      v-if="bar"
      class="selbar"
      :style="{ left: bar.x + 'px', top: bar.y + 'px' }"
      @mousedown.prevent
      @click.stop
    >
      <button v-if="!bar.markId" type="button" class="sb-anno" title="对选中的这句写批注" @click="barAnno">✎ 批注</button>
      <span v-if="!bar.markId" class="sb-sep" />
      <button
        v-for="c in COLORS"
        :key="c.id"
        type="button"
        class="sb-dot"
        :class="[`hl-${c.id}`, { on: markColor === c.id }]"
        :title="bar.markId ? '换成' + c.label : c.label + '色荧光笔'"
        @click="barMark(c.id)"
      />
      <button v-if="barHasMark" type="button" class="sb-clear" title="取消这里的荧光笔" @click="barClear">✕ 取消高亮</button>
    </div>
  </section>
</template>

<style scoped>
.doc { position: relative; overflow: auto; min-height: 0; scroll-behavior: smooth; line-height: 1.7; }
/* 纸面比阅读宽度多留 40px:段落工具就摆在这条边距里,悬停区跟正文连成一片(见文件头 ①) */
.paper { max-width: 820px; margin: 0 auto; padding: var(--s5) var(--s6) 0; }
.tail { height: 40vh; }
.blk { position: relative; padding-left: 14px; padding-right: 40px; margin: 0 0 2px; }
.blk > .gut { position: absolute; left: 0; top: 4px; bottom: 4px; width: 3px; border-radius: 2px; background: transparent; }
.blk.changed > .gut { background: var(--info); cursor: pointer; opacity: .8; }
.blk.changed > .gut:hover { width: 5px; left: -1px; opacity: 1; }
.blk.changed.open > .gut { background: var(--warn); }
.blk.added > .gut { background: var(--ok); }
.blk.removed > .gut { background: var(--bad); }
.mode-clean .blk.changed > .gut { opacity: .35; }
.blk :deep(h1), .blk :deep(h2), .blk :deep(h3), .blk :deep(h4) { margin: var(--s5) 0 var(--s2); scroll-margin-top: 24px; }
.blk :deep(h1) { font-size: 1.45em; } .blk :deep(h2) { font-size: 1.25em; } .blk :deep(h3) { font-size: 1.05em; }
.blk :deep(p), .blk :deep(li) { margin: 0 0 var(--s2); }
.blk :deep(ul), .blk :deep(ol) { padding-left: 1.4em; }
/* 表格:全局 th 是给看板数据表的列头用的(11px + 弱灰 + 等宽大写),套在报告正文上没法读,这里整个重设 */
.blk :deep(table) { border-collapse: collapse; width: 100%; font-size: .95em; margin: var(--s2) 0; }
.blk :deep(th), .blk :deep(td) { border: 1px solid var(--line); padding: 6px 10px; vertical-align: top; text-align: left; color: var(--text); }
.blk :deep(th) { background: var(--surface-2); font-family: inherit; font-size: inherit; font-weight: 600; letter-spacing: normal; text-transform: none; }
/* 提示块:docx 转出来的「退化表格」在渲染层被换成了这个(见 utils/reader/markdown.ts) */
.blk :deep(.callout) { margin: var(--s2) 0; padding: var(--s2) var(--s3); border-left: 3px solid var(--line-strong); border-radius: 0 var(--r-sm) var(--r-sm) 0; background: var(--surface-2); color: var(--text); }
.blk :deep(.callout p:last-child) { margin-bottom: 0; }
.blk :deep(blockquote) { margin: 0 0 var(--s2); padding: var(--s1) var(--s3); border-left: 3px solid var(--line-strong); color: var(--text-2); background: var(--surface-2); border-radius: 0 var(--r-sm) var(--r-sm) 0; }
.blk :deep(ins) { text-decoration: none; }
.blk :deep(del) { color: var(--bad); }
.new { position: relative; }
.hmark { display: inline-flex; align-items: center; gap: 4px; margin: 0 0 var(--s2) 0; padding: 0 8px; border-radius: 10px; border: 1px solid var(--line-strong); background: var(--surface-2); color: var(--text-2); font: inherit; font-family: var(--mono); font-size: var(--fs-xs); cursor: pointer; line-height: 1.7; }
.hmark:hover { background: var(--surface-3); color: var(--text); }
.old { display: none; margin: 0 0 var(--s3); padding: var(--s2) var(--s3); border-radius: var(--r-sm); background: var(--warn-bg); color: var(--text-2); font-size: .92em; border-left: 3px solid var(--warn); }
.old .tag { display: inline-block; font-family: var(--mono); font-size: var(--fs-xs); color: var(--warn); margin-right: var(--s2); }
.old.shown, .blk.open .old { display: block; }
.old :deep(p) { margin: 0; }
.old :deep(h1), .old :deep(h2), .old :deep(h3), .old :deep(h4) { font-size: 1em; margin: 0; font-weight: 600; }
/* 标记改动 */
.mode-marks .blk.changed, .mode-marks .blk.added { background: var(--info-bg); border-radius: var(--r-sm); }
.mode-marks .blk :deep(ins) { background: color-mix(in srgb, var(--info) 22%, transparent); border-bottom: 1px solid var(--info); }
/* 只看改动 */
.mode-changes .blk.same { display: none; }
.mode-changes .blk.changed, .mode-changes .blk.added, .mode-changes .blk.removed { background: var(--info-bg); border-radius: var(--r-sm); margin-bottom: var(--s3); padding-top: 4px; padding-bottom: 4px; }
.mode-changes .blk.changed .old { display: block; }
.mode-changes .blk :deep(ins) { background: color-mix(in srgb, var(--info) 22%, transparent); }
.ctx { display: none; color: var(--text-3); font-size: var(--fs-xs); margin: var(--s3) 0 var(--s1) 14px; }
.mode-changes .ctx { display: block; }
/* 并排 */
.mode-split .paper { max-width: none; padding-left: var(--s4); padding-right: var(--s4); }
.mode-split .blk.changed { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s4); background: var(--info-bg); border-radius: var(--r-sm); padding: var(--s2) 40px var(--s2) 14px; margin-bottom: var(--s3); }
.mode-split .blk.changed .old { display: block; margin: 0; order: -1; }
.mode-split .blk.changed .new { order: 1; }
.mode-split .blk.changed .notes, .mode-split .blk.changed .annos, .mode-split .blk.changed .editor { grid-column: 1 / 3; }
.mode-split .blk :deep(ins) { background: color-mix(in srgb, var(--info) 22%, transparent); }
.blk.heavy .old :deep(del) { text-decoration: none; color: inherit; }
/* 段落工具:摆在段落自己的 padding-right 里。用 opacity 而不是 display,
   悬停区不断档——原来悬在盒子外面,鼠标伸过去的路上按钮就没了(负责人 0905 实测) */
.ptools { position: absolute; right: 6px; top: 2px; display: flex; gap: 2px; opacity: 0; pointer-events: none; transition: opacity .12s ease; }
.blk:hover .ptools, .blk:focus-within .ptools { opacity: 1; pointer-events: auto; }
.ptools button { width: 26px; height: 26px; border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--surface); color: var(--text-2); cursor: pointer; font-size: 13px; }
.ptools button:hover { background: var(--surface-3); color: var(--text); }
.blk.has-anno { border-right: 2px solid var(--chart-4); }
/* 边注 */
.notes { display: none; margin: 0 0 var(--s3); padding: var(--s2) var(--s3); border: 1px dashed var(--line-strong); border-radius: var(--r); background: var(--surface-2); font-size: .9em; }
.notes.open { display: block; }
.notes.global { margin-top: 0; }
.notes ul { margin: 0; padding-left: 1.2em; } .notes li { margin: 4px 0; }
.n-k { font-family: var(--mono); font-size: var(--fs-xs); padding: 0 5px; border-radius: 3px; margin-right: 6px; }
.n-fix { background: var(--bad-bg); color: var(--bad); } .n-conf { background: var(--warn-bg); color: var(--warn); }
.n-over { background: var(--info-bg); color: var(--chart-4); } .n-info { background: var(--info-bg); color: var(--info); } .n-now { background: var(--warn-bg); color: var(--warn); }
.n-layer { color: var(--text-3); font-family: var(--mono); font-size: var(--fs-xs); margin-left: 6px; }
/* 批注 */
.anno-card { position: relative; margin: var(--s1) 0 var(--s3); padding: var(--s2) var(--s3); background: var(--info-bg); border-left: 3px solid var(--chart-4); border-radius: 0 var(--r-sm) var(--r-sm) 0; font-size: .9em; }
.anno-card .who { color: var(--chart-4); font-family: var(--mono); font-size: var(--fs-xs); margin-right: var(--s2); }
.anno-card .del { position: absolute; right: 6px; top: 4px; border: 0; background: transparent; color: var(--text-3); cursor: pointer; font-size: 14px; }
.anno-card .del:hover { color: var(--bad); }
.anno-card textarea { width: 100%; border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--surface); color: var(--text); font: inherit; padding: var(--s2); resize: vertical; }
.anno-card .row { display: flex; gap: var(--s2); align-items: center; margin-top: var(--s2); flex-wrap: wrap; }
.on-quote { color: var(--text-2); }
.on-quote.sel { display: block; margin-bottom: var(--s2); color: var(--text-3); font-size: var(--fs-xs); }
.lite { color: var(--text-3); font-size: var(--fs-xs); }
/* 荧光笔与批注锚(marks.ts 插进正文的 <mark>) */
.blk :deep(mark.hl) { color: inherit; border-radius: 2px; padding: 0 1px; cursor: pointer; }
.blk :deep(mark.hl-yellow) { background: var(--hl-yellow); }
.blk :deep(mark.hl-green) { background: var(--hl-green); }
.blk :deep(mark.hl-blue) { background: var(--hl-blue); }
.blk :deep(mark.hl-pink) { background: var(--hl-pink); }
.blk :deep(mark.anno-anchor) { background: transparent; color: inherit; border-bottom: 2px dotted var(--chart-4); }
/* 框选工具条 */
.selbar { position: fixed; z-index: 50; transform: translate(-50%, calc(-100% - 8px)); display: flex; align-items: center; gap: 4px; padding: 4px 6px; border: 1px solid var(--line-strong); border-radius: var(--r); background: var(--surface); box-shadow: 0 6px 20px rgba(0, 0, 0, .22); }
.selbar button { border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--text); font: inherit; font-size: var(--fs-sm); padding: 2px 8px; cursor: pointer; white-space: nowrap; }
.selbar button:hover { background: var(--surface-3); }
.sb-sep { width: 1px; height: 18px; background: var(--line); }
.selbar button.sb-dot { width: 20px; height: 20px; padding: 0; border-radius: 50%; border: 1px solid var(--line-strong); }
.selbar button.sb-dot.hl-yellow { background: var(--hl-yellow); } .selbar button.sb-dot.hl-green { background: var(--hl-green); }
.selbar button.sb-dot.hl-blue { background: var(--hl-blue); } .selbar button.sb-dot.hl-pink { background: var(--hl-pink); }
.selbar button.sb-dot.on { outline: 2px solid var(--text); outline-offset: 1px; }
.sb-clear { color: var(--text-2); }
</style>
