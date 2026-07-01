<script setup lang="ts">
// 卡片详情抽屉：task 全字段 + 文档链接(→/api/doc 预览) + 待拍板内联拍板 + 活动时间线。
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { useBoardStore } from '@/stores/board'
import * as derive from '@/utils/derive'
import { statusColor } from '@/api/schema'
import { fetchDoc, docUrl } from '@/api/client'
import { fmtDateTime, relTime } from '@/utils/format'
import StatusBadge from './StatusBadge.vue'
import type { DocRef } from '@/types'

const store = useBoardStore()
const task = computed(() => store.selectedTask)
const pid = computed(() => store.selectedTaskProjectId || '')
const acts = computed(() => derive.activityOfTask(store.selectedBoard, task.value?.id || ''))
// 施工中任务进度戳超 30 分钟没动 = 陈旧
const progStale = computed(() => {
  const lp = (task.value as any)?.lastProgressAt
  if (!lp || task.value?.status !== '施工中') return false
  return Date.now() - new Date(lp).getTime() > 30 * 60 * 1000
})

const hasArr = (a: unknown): a is unknown[] => Array.isArray(a) && a.length > 0

// ---- 内联拍板 ----
const picked = reactive<Record<string, string>>({})
const submitting = reactive<Record<string, boolean>>({})
const derr = reactive<Record<string, string>>({})
async function decide(did: string, options: string[], recommended: string) {
  const answer = picked[did] ?? recommended
  submitting[did] = true
  delete derr[did]
  try {
    await store.decide(pid.value, task.value!.id, did, answer, '看板')
  } catch (e) {
    derr[did] = e instanceof Error ? e.message : String(e)
  } finally {
    submitting[did] = false
  }
}

// ---- 文档预览 ----
const activeDoc = ref<string | null>(null)
const docText = ref('')
const docLoading = ref(false)
const docErr = ref('')
function docPath(d: DocRef) { return typeof d === 'string' ? d : d.path }
function docName(d: DocRef) {
  const p = docPath(d)
  const base = p.split(/[\\/]/).pop() || p
  return typeof d === 'string' ? base : d.title || base
}
async function preview(d: DocRef) {
  const p = docPath(d)
  if (activeDoc.value === p) { activeDoc.value = null; return }
  activeDoc.value = p
  docText.value = ''
  docErr.value = ''
  docLoading.value = true
  try {
    docText.value = await fetchDoc(pid.value, p)
  } catch (e) {
    docErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    docLoading.value = false
  }
}

// 切换任务时重置文档预览
watch(task, () => { activeDoc.value = null; docText.value = ''; docErr.value = '' })
// 抽屉开关锁 body 滚动
watch(task, (t) => { document.body.style.overflow = t ? 'hidden' : '' })

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && store.selectedTask) store.closeTask()
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="task" class="overlay" @click.self="store.closeTask()">
        <aside class="drawer">
          <header class="d-head" :style="{ borderTopColor: statusColor(task.status) }">
            <span class="d-id mono">{{ task.id }}</span>
            <StatusBadge :status="task.status" />
            <span class="spacer" />
            <button class="btn btn-sm btn-ghost close" @click="store.closeTask()">✕</button>
          </header>

          <div class="d-body">
            <h2 class="d-title">{{ task.title }}</h2>

            <div class="d-prog">
              <div class="progress"><i :style="{ width: (task.percent || 0) + '%' }" /></div>
              <span class="pct mono">{{ task.percent || 0 }}%</span>
              <span v-if="task.status === '施工中' && (task as any).lastProgressAt" class="prog-time" :class="{ stale: progStale }">
                {{ progStale ? '⚠ 进度' : '进度更新于' }} {{ relTime((task as any).lastProgressAt) }}
              </span>
            </div>

            <p v-if="task.description" class="d-desc">{{ task.description }}</p>

            <!-- 元信息 -->
            <section class="sec">
              <div class="kv" v-if="task.wave"><span>波次</span><b>W{{ task.wave }}</b></div>
              <div class="kv" v-if="task.dates?.design"><span>设计</span><b>{{ task.dates.design }}</b></div>
              <div class="kv" v-if="task.dates?.start"><span>开工</span><b>{{ task.dates.start }}</b></div>
              <div class="kv" v-if="task.dates?.done"><span>完工</span><b>{{ task.dates.done }}</b></div>
              <div class="kv" v-if="task.typecheck !== undefined"><span>类型检查</span><b>{{ task.typecheck ? '✅' : '—' }}</b></div>
              <div class="kv" v-if="task.nextMilestone"><span>下一里程碑</span><b>{{ task.nextMilestone }}</b></div>
            </section>

            <!-- 测试 -->
            <section v-if="task.tests" class="sec block">
              <div class="sec-t">测试</div>
              <div class="row gap-2 wrap">
                <span class="pill">共 {{ task.tests.total ?? 0 }}</span>
                <span class="pill">通过 {{ task.tests.passing ?? 0 }}</span>
                <span class="pill" v-if="task.tests.mustFailFirst">先失败 {{ task.tests.mustFailFirst }}</span>
              </div>
            </section>

            <!-- 分支 / 占用 -->
            <section v-if="hasArr(task.gitBranch) || hasArr(task.worktree) || hasArr(task.prNumbers) || hasArr(task.commitShas) || hasArr(task.fileScope) || hasArr(task.forbiddenZones)" class="sec block">
              <div class="sec-t">分支 / 占用</div>
              <div class="row gap-2 wrap">
                <span v-for="b in task.gitBranch || []" :key="b" class="pill">🌿 {{ b }}</span>
                <span v-for="w in task.worktree || []" :key="w" class="pill">🌲 {{ w }}</span>
                <span v-for="p in task.prNumbers || []" :key="p" class="pill">PR #{{ p }}</span>
                <span v-for="c in task.commitShas || []" :key="c" class="pill">⚙ {{ String(c).slice(0, 8) }}</span>
              </div>
              <div class="row gap-2 wrap" v-if="hasArr(task.fileScope) || hasArr(task.forbiddenZones)" style="margin-top:6px">
                <span v-for="f in task.fileScope || []" :key="f" class="pill scope">📁 {{ f }}</span>
                <span v-for="f in task.forbiddenZones || []" :key="f" class="pill forbid">⛔ {{ f }}</span>
              </div>
            </section>

            <!-- 依赖 / 阻塞 -->
            <section v-if="task.deps && (hasArr(task.deps.dependsOn) || hasArr(task.deps.blockedBy) || hasArr(task.deps.relatedTasks)) || task.blockReason || task.parkedNote" class="sec block">
              <div class="sec-t">依赖 / 阻塞</div>
              <div class="kv" v-if="hasArr(task.deps?.dependsOn)"><span>依赖</span><b>{{ task.deps!.dependsOn!.join(', ') }}</b></div>
              <div class="kv" v-if="hasArr(task.deps?.blockedBy)"><span>被阻塞</span><b class="warn">{{ task.deps!.blockedBy!.join(', ') }}</b></div>
              <div class="kv" v-if="hasArr(task.deps?.relatedTasks)"><span>关联</span><b>{{ task.deps!.relatedTasks!.join(', ') }}</b></div>
              <div class="note" v-if="task.blockReason">🚧 {{ task.blockReason }}</div>
              <div class="note" v-if="task.parkedNote">🅿️ {{ task.parkedNote }}</div>
            </section>

            <!-- 决策（含内联拍板） -->
            <section v-if="hasArr(task.decisions)" class="sec block">
              <div class="sec-t">决策</div>
              <div v-for="d in task.decisions" :key="d.id" class="dec">
                <div class="dec-q"><span class="did mono">#{{ d.id }}</span> {{ d.question }}</div>
                <template v-if="d.answer == null">
                  <div class="opts">
                    <button
                      v-for="o in d.options" :key="o" class="opt"
                      :class="{ on: (picked[d.id] ?? d.recommended) === o, rec: d.recommended === o }"
                      @click="picked[d.id] = o"
                    >{{ (picked[d.id] ?? d.recommended) === o ? '●' : '○' }} {{ o }}
                      <span v-if="d.recommended === o" class="rectag">推荐</span>
                    </button>
                  </div>
                  <div class="row gap-2">
                    <span v-if="derr[d.id]" class="err">⚠️ {{ derr[d.id] }}</span>
                    <span class="spacer" />
                    <button class="btn btn-primary btn-sm" :disabled="submitting[d.id]" @click="decide(d.id, d.options, d.recommended)">
                      {{ submitting[d.id] ? '提交中…' : '拍板：' + (picked[d.id] ?? d.recommended) }}
                    </button>
                  </div>
                </template>
                <div v-else class="dec-done">✅ 已拍板：<b>{{ d.answer }}</b><span v-if="d.decidedAt" class="mono"> · {{ d.decidedAt }}</span></div>
              </div>
            </section>

            <!-- 文档 -->
            <section v-if="hasArr(task.docs)" class="sec block">
              <div class="sec-t">文档</div>
              <div v-for="(d, i) in task.docs" :key="i" class="doc">
                <div class="doc-row">
                  <button class="doc-name" @click="preview(d)">📄 {{ docName(d) }}</button>
                  <a class="pill" :href="docUrl(pid, docPath(d))" target="_blank" rel="noopener">打开 ↗</a>
                </div>
                <div v-if="activeDoc === docPath(d)" class="doc-view">
                  <div v-if="docLoading" class="muted small">加载中…</div>
                  <div v-else-if="docErr" class="err">{{ docErr }}</div>
                  <pre v-else>{{ docText }}</pre>
                </div>
              </div>
            </section>

            <!-- 活动 -->
            <section v-if="acts.length" class="sec block">
              <div class="sec-t">活动</div>
              <div class="tl">
                <div v-for="(a, i) in acts" :key="i" class="tl-item">
                  <span class="tl-dot" />
                  <div class="tl-main">
                    <div class="tl-text">{{ a.text }}</div>
                    <div class="tl-meta mono">{{ a.author }} · {{ fmtDateTime(a.ts) }} · {{ relTime(a.ts) }}</div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex; justify-content: flex-end; z-index: 100; }
.drawer { width: min(520px, 94vw); height: 100%; background: var(--bg-soft); border-left: 1px solid var(--border); display: flex; flex-direction: column; box-shadow: -10px 0 40px rgba(0, 0, 0, 0.4); }
.d-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border); border-top: 3px solid var(--border); }
.d-id { color: var(--muted); font-weight: 700; }
.d-body { padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
.d-title { font-size: 17px; line-height: 1.4; }
.d-prog { display: flex; align-items: center; gap: 10px; }
.d-prog .progress { flex: 1; }
.d-prog .pct { font-size: 12px; color: var(--muted); }
.d-prog .prog-time { font-size: 11px; color: var(--muted-2); margin-left: 4px; }
.d-prog .prog-time.stale { color: var(--warn); }
.d-desc { color: var(--muted); font-size: 13px; line-height: 1.6; margin: 0; white-space: pre-wrap; }
.sec { display: flex; flex-wrap: wrap; gap: 8px 18px; }
.sec.block { flex-direction: column; gap: 8px; border-top: 1px solid var(--border-soft); padding-top: 12px; }
.sec-t { font-size: 12px; color: var(--muted-2); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.kv { display: flex; gap: 8px; font-size: 13px; align-items: baseline; }
.kv span { color: var(--muted); min-width: 62px; }
.kv b { font-weight: 600; }
.kv b.warn, .warn { color: var(--warn); }
.note { font-size: 13px; color: var(--warn); background: rgba(245, 166, 35, 0.1); border-radius: var(--radius-sm); padding: 7px 10px; }
.pill.scope { color: #7fd3c4; }
.pill.forbid { color: var(--danger); border-color: rgba(208, 99, 124, 0.4); }
.dec { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; display: flex; flex-direction: column; gap: 9px; background: var(--panel); }
.dec-q { font-size: 13px; }
.dec-q .did { color: var(--muted-2); margin-right: 4px; }
.opts { display: flex; flex-direction: column; gap: 6px; }
.opt { text-align: left; background: var(--panel-2); border: 1px solid var(--border); color: var(--text); border-radius: var(--radius-sm); padding: 7px 10px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 7px; }
.opt.on { border-color: var(--accent); background: var(--accent-soft); }
.opt .rectag { margin-left: auto; font-size: 10px; color: var(--ok); border: 1px solid var(--ok); border-radius: 999px; padding: 0 6px; }
.dec-done { font-size: 13px; color: var(--ok); }
.err { color: var(--danger); font-size: 12px; }
.small { font-size: 12px; }
.doc { border: 1px solid var(--border-soft); border-radius: var(--radius-sm); overflow: hidden; }
.doc-row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; }
.doc-name { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 13px; flex: 1; text-align: left; }
.doc-view { border-top: 1px solid var(--border-soft); padding: 10px; max-height: 260px; overflow: auto; background: var(--bg); }
.doc-view pre { margin: 0; font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; color: var(--text); }
.tl { display: flex; flex-direction: column; gap: 10px; }
.tl-item { display: flex; gap: 9px; }
.tl-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin-top: 5px; flex: none; }
.tl-main { flex: 1; }
.tl-text { font-size: 13px; }
.tl-meta { font-size: 11px; color: var(--muted-2); margin-top: 2px; }

/* 抽屉过渡 */
.drawer-enter-active, .drawer-leave-active { transition: opacity 0.2s ease; }
.drawer-enter-active .drawer, .drawer-leave-active .drawer { transition: transform 0.22s ease; }
.drawer-enter-from, .drawer-leave-to { opacity: 0; }
.drawer-enter-from .drawer, .drawer-leave-to .drawer { transform: translateX(30px); }
</style>
