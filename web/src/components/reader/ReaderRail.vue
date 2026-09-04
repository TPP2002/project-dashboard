<script setup lang="ts">
// 右栏:目录 / 提示(分层边注) / 批注 / 拍板(同一张看板卡的 decisions,文档内已填的可一键认账)。
import { computed, ref } from 'vue'
import type { DocBlock } from '@/utils/reader/diff'
import type { ReaderNoteLayer, ReaderAnno, ReaderReportMeta } from '@/api/reader'
import type { Task, Decision } from '@/types'
import { anchorMatch } from '@/utils/reader/anchors'

const props = defineProps<{
  blocks: DocBlock[]
  activeHeading: string | null
  noteLayers: ReaderNoteLayer[]
  hiddenLayers: string[]
  annos: ReaderAnno[]
  report: ReaderReportMeta | null
  task: Task | null
  deciding: Record<string, boolean>
  decideErrors: Record<string, string>
}>()
const emit = defineEmits<{
  (e: 'jump', blockId: string): void
  (e: 'toggle-layer', id: string): void
  (e: 'delete-anno', id: string): void
  (e: 'decide', payload: { did: string; answer: string }): void
}>()

type Tab = 'toc' | 'notes' | 'annos' | 'dec'
const tab = ref<Tab>('toc')

const headings = computed(() => props.blocks.filter((b) => b.heading && b.heading.level <= 3))
const notesFlat = computed(() =>
  props.noteLayers
    .filter((l) => !props.hiddenLayers.includes(l.id))
    .flatMap((l) => l.notes.map((n) => ({ ...n, layerId: l.id, layerName: l.name }))),
)
const kindClass = (k: string) => ({ 纠正: 'n-fix', 冲突: 'n-conf', 改判: 'n-over', 提示: 'n-info', 现状: 'n-now' } as Record<string, string>)[k] || 'n-info'

function blockForAnchor(anchor: string): string | null {
  if (anchor === '全篇') return props.blocks[0]?.id ?? null
  const hit = props.blocks.find((b) => b.heading && anchorMatch(anchor, b.heading.text))
  return hit ? hit.id : null
}

// —— 拍板 —— //
const decisions = computed<Decision[]>(() => props.task?.decisions ?? [])
const pendingCount = computed(() => decisions.value.filter((d) => d.answer == null && !docAnswerOf(d.id) && !supersededOf(d.id)).length)
const docAnswerOf = (did: string) => props.report?.docAnswers?.[did] ?? null
const supersededOf = (did: string) => props.report?.superseded?.[did] ?? null
const anchorOf = (did: string) => props.report?.decisionAnchors?.[did] ?? null
const picked = ref<Record<string, string>>({})
const custom = ref<Record<string, string>>({})
const CUSTOM = '__custom__'
function chosen(d: Decision): string {
  const p = picked.value[d.id]
  if (p === CUSTOM) return (custom.value[d.id] || '').trim()
  return p ?? d.recommended
}
function ack(d: Decision) {
  const doc = docAnswerOf(d.id)
  if (!doc) return
  emit('decide', { did: d.id, answer: `${doc}——负责人已在报告文档内填答,审阅台认账写回` })
}
function decide(d: Decision) {
  const a = chosen(d)
  if (!a) return
  emit('decide', { did: d.id, answer: a })
}
const fmtAt = (iso: string) => iso.replace('T', ' ').slice(0, 16)
const short = (s: string, n = 42) => (s.length > n ? s.slice(0, n) + '…' : s)
</script>

<template>
  <aside class="rail">
    <div class="tabs" role="tablist">
      <button type="button" :class="{ on: tab === 'toc' }" @click="tab = 'toc'">目录</button>
      <button type="button" :class="{ on: tab === 'notes' }" @click="tab = 'notes'">提示 <span v-if="notesFlat.length" class="badge compact n">{{ notesFlat.length }}</span></button>
      <button type="button" :class="{ on: tab === 'annos' }" @click="tab = 'annos'">批注 <span v-if="annos.length" class="badge compact info">{{ annos.length }}</span></button>
      <button type="button" :class="{ on: tab === 'dec' }" @click="tab = 'dec'">拍板 <span v-if="pendingCount" class="badge compact warn">{{ pendingCount }}</span></button>
    </div>

    <div v-show="tab === 'toc'" class="pane">
      <div v-if="!headings.length" class="lite">这份报告没有可用的标题。</div>
      <a
        v-for="h in headings"
        :key="h.id"
        href="#"
        class="toc"
        :class="[`l${h.heading!.level}`, { cur: h.id === activeHeading }]"
        @click.prevent="emit('jump', h.id)"
      >{{ h.heading!.text }}<span v-if="h.kind === 'changed'" class="c" title="这个标题相对上一版有改动">改</span></a>
    </div>

    <div v-show="tab === 'notes'" class="pane">
      <div class="layers">
        <button
          v-for="l in noteLayers"
          :key="l.id"
          type="button"
          class="btn btn-sm"
          :class="{ on: !hiddenLayers.includes(l.id) }"
          :title="hiddenLayers.includes(l.id) ? '点击显示这一层' : '点击隐藏这一层'"
          @click="emit('toggle-layer', l.id)"
        >{{ l.name }} · {{ l.notes.length }}</button>
      </div>
      <div class="lite" style="margin: 0 0 var(--s2)">边注只说「现在变成什么、什么时候改的、对读这一节的影响」;点一条跳到那一节。</div>
      <div v-if="!notesFlat.length" class="lite">没有边注(或全部被隐藏)。</div>
      <button
        v-for="(n, i) in notesFlat"
        :key="i"
        type="button"
        class="ncard"
        :class="{ now: n.kind === '现状' }"
        @click="blockForAnchor(n.anchor) && emit('jump', blockForAnchor(n.anchor)!)"
      >
        <div class="a">{{ n.anchor }} · {{ n.layerName }}</div>
        <span class="n-k" :class="kindClass(n.kind)">{{ n.kind }}</span>{{ n.text }}
      </button>
    </div>

    <div v-show="tab === 'annos'" class="pane">
      <div class="lite" style="margin: 0 0 var(--s2)">把鼠标放到任一段落上,点右侧 ✎ 写批注。批注存看板本机账本并同步到对应任务卡;要进仓库用顶部「导出」。</div>
      <div v-if="!annos.length" class="lite">还没有批注。</div>
      <div v-for="a in annos" :key="a.id" class="ncard static">
        <div class="a">
          <button type="button" class="link" @click="emit('jump', a.blockId)">{{ fmtAt(a.at) }} · {{ a.anchor || '(开头)' }}</button>
          <button type="button" class="del" title="删除" @click="emit('delete-anno', a.id)">×</button>
        </div>
        <div v-if="a.quote" class="quote">「{{ short(a.quote, 60) }}」</div>
        <div>{{ a.text }}</div>
      </div>
    </div>

    <div v-show="tab === 'dec'" class="pane">
      <div v-if="!task" class="lite">这份报告没有绑定看板卡{{ report?.task ? `(清单写的是 ${report.task},当前项目看板里没找到)` : '' }}。</div>
      <template v-else>
        <div class="lite" style="margin: 0 0 var(--s2)">来自看板卡 <b class="mono">{{ task.id }}</b> 的待拍板项。「文档里你已填」的一键认账即写回看板,不用重拍。</div>
        <div v-for="d in decisions" :key="d.id" class="dec">
          <div class="lite mono">{{ d.id }}<template v-if="anchorOf(d.id)"> · <button type="button" class="link" @click="blockForAnchor(anchorOf(d.id)!) && emit('jump', blockForAnchor(anchorOf(d.id)!)!)">对应正文 §{{ anchorOf(d.id) }}</button></template></div>
          <div class="q">{{ d.question }}</div>
          <div v-if="d.answer != null" class="st"><span class="badge ok">已拍</span> <span class="ans">{{ d.answer }}</span></div>
          <div v-else-if="supersededOf(d.id)" class="st"><span class="badge n">已失效</span> <span class="ans">{{ supersededOf(d.id) }}</span></div>
          <div v-else-if="docAnswerOf(d.id)" class="st">
            <span class="doc-ans">文档里你已填:{{ docAnswerOf(d.id) }}</span>
            <button type="button" class="btn btn-sm" :disabled="deciding[d.id]" @click="ack(d)">{{ deciding[d.id] ? '写回中…' : '一键认账写回看板' }}</button>
          </div>
          <div v-else class="st">
            <span class="badge warn">待拍</span>
            <div class="opts">
              <label v-for="o in d.options" :key="o" class="opt" :class="{ rec: o === d.recommended }">
                <input type="radio" :name="`${task.id}-${d.id}`" :checked="(picked[d.id] ?? d.recommended) === o" @change="picked[d.id] = o">
                <span>{{ o }}<span v-if="o === d.recommended" class="badge info compact" style="margin-left:4px">推荐</span></span>
              </label>
              <label class="opt">
                <input type="radio" :name="`${task.id}-${d.id}`" :checked="picked[d.id] === CUSTOM" @change="picked[d.id] = CUSTOM">
                <span>其他(自己写)</span>
              </label>
              <input v-if="picked[d.id] === CUSTOM" v-model="custom[d.id]" class="field" placeholder="写下你的答案">
            </div>
            <button type="button" class="btn btn-sm primary" :disabled="deciding[d.id] || !chosen(d)" @click="decide(d)">{{ deciding[d.id] ? '写回中…' : '确认拍板' }}</button>
          </div>
          <div v-if="decideErrors[d.id]" class="err">{{ decideErrors[d.id] }}</div>
        </div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.rail { display: flex; flex-direction: column; min-height: 0; border-left: 1px solid var(--line); background: var(--surface); }
.tabs { display: flex; border-bottom: 1px solid var(--line); }
.tabs button { flex: 1; border: 0; background: transparent; padding: var(--s2) 0; font: inherit; font-size: var(--fs-sm); color: var(--text-2); cursor: pointer; border-bottom: 2px solid transparent; }
.tabs button.on { color: var(--text); border-bottom-color: var(--text); font-weight: 600; }
.pane { overflow: auto; padding: var(--s3); font-size: var(--fs-sm); min-height: 0; }
.toc { display: block; color: var(--text-2); text-decoration: none; padding: 3px 6px; border-radius: var(--r-sm); border-left: 2px solid transparent; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc.l2 { padding-left: 16px; } .toc.l3 { padding-left: 28px; font-size: var(--fs-xs); }
.toc:hover { background: var(--surface-2); color: var(--text); }
.toc.cur { border-left-color: var(--text); color: var(--text); font-weight: 600; background: var(--surface-2); }
.toc .c { float: right; color: var(--info); font-family: var(--mono); font-size: var(--fs-xs); }
.layers { display: flex; gap: var(--s1); flex-wrap: wrap; margin-bottom: var(--s2); }
.btn.on { background: var(--surface-3); border-color: var(--line-strong); font-weight: 600; }
.ncard { display: block; width: 100%; text-align: left; border: 0; border-left: 3px solid var(--info); background: var(--surface-2); padding: 6px 8px; margin-bottom: 6px; border-radius: 0 var(--r-sm) var(--r-sm) 0; cursor: pointer; font: inherit; font-size: var(--fs-sm); color: var(--text); line-height: 1.5; }
.ncard.now { border-left-color: var(--warn); }
.ncard:hover { background: var(--surface-3); }
.ncard.static { cursor: default; border-left-color: var(--chart-4); position: relative; }
.ncard .a { font-family: var(--mono); font-size: var(--fs-xs); color: var(--text-3); display: flex; justify-content: space-between; align-items: center; }
.ncard .quote { color: var(--text-3); font-size: var(--fs-xs); margin: 2px 0; }
.link { border: 0; background: transparent; color: var(--info); cursor: pointer; font: inherit; font-size: inherit; padding: 0; }
.del { border: 0; background: transparent; color: var(--text-3); cursor: pointer; font-size: 14px; }
.del:hover { color: var(--bad); }
.n-k { font-family: var(--mono); font-size: var(--fs-xs); padding: 0 5px; border-radius: 3px; margin-right: 6px; }
.n-fix { background: var(--bad-bg); color: var(--bad); } .n-conf { background: var(--warn-bg); color: var(--warn); }
.n-over { background: var(--info-bg); color: var(--chart-4); } .n-info { background: var(--info-bg); color: var(--info); } .n-now { background: var(--warn-bg); color: var(--warn); }
.dec { border: 1px solid var(--line); border-radius: var(--r); padding: var(--s2) var(--s3); margin-bottom: var(--s2); background: var(--surface-2); }
.dec .q { font-weight: 600; line-height: 1.45; margin: 2px 0 4px; }
.dec .st { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.dec .ans { color: var(--text-2); }
.doc-ans { font-size: var(--fs-xs); color: var(--ok); background: var(--ok-bg); padding: 2px 6px; border-radius: var(--r-sm); }
.opts { display: grid; gap: 4px; width: 100%; }
.opt { display: flex; gap: 6px; align-items: flex-start; padding: 4px 6px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); cursor: pointer; font-size: var(--fs-xs); line-height: 1.4; }
.opt.rec { border-color: var(--info); }
.opt input { margin-top: 2px; }
.err { color: var(--bad); font-size: var(--fs-xs); margin-top: 4px; }
.lite { color: var(--text-3); font-size: var(--fs-xs); }
</style>
