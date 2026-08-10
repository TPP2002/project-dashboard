<script setup lang="ts">
/**
 * 算力面板 —— 给负责人一个「我要用电脑,留点资源给我」的开关。
 *
 * 【背景】同一台主机上同时跑着:多个 Claude 对话、多个 Codex 对话、集群作业、跑分,
 * 外加每个项目各自的自托管 CI runner。它们都读同一本「谁占了多少核」的账本,
 * 按剩余核数决定自己开多大并发。
 *
 * 【这个页面干什么】往账本里写一条「这些核归我」的占用。写完之后,**之后启动**的测试
 * 自动缩小并发让路;点释放,资源立刻回池。不打断正在跑的活。
 *
 * 【为什么是手动按钮而不是自动检测】同样是人坐在电脑前,写文档和剪视频对资源的需求
 * 天差地别,自动检测永远在猜意图;点一下,意图就是确定的。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

interface LeaseView {
  holder: string
  cores: number
  pid: number
  since: string
  isReserve: boolean
}
interface CpuStatus {
  hostname: string
  totalCores: number
  quota: number
  used: number
  free: number
  reservedCores: number
  reserveSince: string | null
  reserveExpiresAt: string | null
  leases: LeaseView[]
}

const status = ref<CpuStatus | null>(null)
const error = ref('')
const busy = ref(false)
let timer: number | undefined

/** 预留档位:按整机核数折算,给的是「留多少给我」而不是抽象百分比。 */
const PRESETS = [
  { label: '全让给测试', pct: 0, hint: '我不用电脑,机器随便跑' },
  { label: '留四分之一', pct: 0.25, hint: '轻度使用:看文档、聊天' },
  { label: '留一半', pct: 0.5, hint: '正经干活:写代码、开会' },
  { label: '留大部分', pct: 0.75, hint: '重度使用:剪视频、跑别的大程序' },
]

const total = computed(() => status.value?.totalCores ?? 0)
const reserved = computed(() => status.value?.reservedCores ?? 0)
const othersUsed = computed(() => Math.max(0, (status.value?.used ?? 0) - reserved.value))
const freeCores = computed(() => status.value?.free ?? 0)
/** 条形图按整机核数铺满,让「预留 / 别人在用 / 空闲」三段一眼可比。 */
const pctOf = (n: number) => (total.value > 0 ? Math.min(100, (n / total.value) * 100) : 0)

const activePreset = computed(() => {
  if (total.value === 0) return -1
  return PRESETS.findIndex(p => coresOf(p.pct) === reserved.value)
})

function coresOf(pct: number): number {
  return Math.round(total.value * pct)
}

async function load() {
  try {
    const res = await fetch('/api/cpu')
    const body = await res.json()
    if (!body.ok) throw new Error(body.error || '读取失败')
    status.value = body.cpu
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function apply(cores: number, minutes?: number) {
  busy.value = true
  try {
    const res = await fetch('/api/cpu', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minutes ? { cores, minutes } : { cores }),
    })
    const body = await res.json()
    if (!body.ok) throw new Error(body.error || '设置失败')
    status.value = body.cpu
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

function fmtSince(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`
}

onMounted(() => {
  load()
  timer = window.setInterval(load, 5000)
})
onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer)
})
</script>

<template>
  <div class="wrap">
    <header class="head">
      <h2>算力</h2>
      <span v-if="status" class="host mono">{{ status.hostname }} · {{ status.totalCores }} 核</span>
    </header>

    <p v-if="error" class="err">{{ error }}</p>

    <section v-if="status" class="card">
      <div class="bar" :title="`整机 ${total} 核`">
        <div class="seg seg-mine" :style="{ width: pctOf(reserved) + '%' }" />
        <div class="seg seg-others" :style="{ width: pctOf(othersUsed) + '%' }" />
        <div class="seg seg-free" :style="{ width: pctOf(freeCores) + '%' }" />
      </div>
      <div class="legend">
        <span><i class="dot dot-mine" />留给我 {{ reserved }} 核</span>
        <span><i class="dot dot-others" />测试在用 {{ othersUsed }} 核</span>
        <span><i class="dot dot-free" />空闲 {{ freeCores }} 核</span>
      </div>
      <p v-if="reserved > 0" class="since">
        已预留 {{ fmtSince(status.reserveSince) }}
        <template v-if="status.reserveExpiresAt">· 到期后自动释放</template>
      </p>
    </section>

    <section v-if="status" class="card">
      <h3>给我留多少</h3>
      <div class="presets">
        <button
          v-for="(p, i) in PRESETS"
          :key="p.label"
          class="preset"
          :class="{ on: activePreset === i }"
          :disabled="busy"
          :title="p.hint"
          @click="apply(coresOf(p.pct))"
        >
          <span class="pl">{{ p.label }}</span>
          <span class="pc mono">{{ coresOf(p.pct) }} 核</span>
        </button>
      </div>
      <p class="note">
        点完立刻生效:<strong>之后启动</strong>的测试会自动缩小并发让路,正在跑的活不打断。
      </p>
      <div class="timed">
        <span class="tl">临时预留(到点自动还给测试):</span>
        <button class="mini" :disabled="busy" @click="apply(coresOf(0.5), 60)">留一半 · 1 小时</button>
        <button class="mini" :disabled="busy" @click="apply(coresOf(0.5), 180)">留一半 · 3 小时</button>
        <button class="mini danger" :disabled="busy || reserved === 0" @click="apply(0)">立刻释放</button>
      </div>
    </section>

    <section v-if="status" class="card">
      <h3>现在谁在占</h3>
      <table v-if="status.leases.length" class="tb">
        <thead>
          <tr><th>占用方</th><th class="r">核数</th><th class="r">起始</th></tr>
        </thead>
        <tbody>
          <tr v-for="l in status.leases" :key="l.holder + l.pid">
            <td>
              <span v-if="l.isReserve" class="tag">我</span>
              <span class="mono">{{ l.isReserve ? '负责人预留' : l.holder }}</span>
            </td>
            <td class="r mono">{{ l.cores }}</td>
            <td class="r mono">{{ fmtSince(l.since) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">账本是空的,整机都可以用来跑测试。</p>
      <p class="note">
        配额上限 {{ status.quota }} 核(整机 {{ status.totalCores }} 核留一成半给系统和日常操作)。
        超过上限的占用是单独授权的重活,不受此限。
      </p>
    </section>
  </div>
</template>

<style scoped>
.wrap { padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; max-width: 860px; }
.head { display: flex; align-items: baseline; gap: 10px; }
h2 { font-size: 18px; margin: 0; }
h3 { font-size: 13px; margin: 0 0 10px; color: var(--muted); font-weight: 600; }
.host { font-size: 12px; color: var(--muted-2); }
.err { color: var(--warn); font-size: 13px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px; }

.bar { display: flex; height: 22px; border-radius: 4px; overflow: hidden; background: var(--bg-soft); }
.seg { height: 100%; transition: width 0.3s ease; }
.seg-mine { background: #4c8ce0; }
.seg-others { background: var(--warn); }
.seg-free { background: #2f6f43; }
.legend { display: flex; gap: 16px; margin-top: 8px; font-size: 12px; color: var(--muted); }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }
.dot-mine { background: #4c8ce0; }
.dot-others { background: var(--warn); }
.dot-free { background: #2f6f43; }
.since { font-size: 12px; color: var(--muted-2); margin: 8px 0 0; }

.presets { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.preset {
  display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
  padding: 10px 12px; border-radius: var(--radius-sm);
  border: 1px solid var(--border); background: var(--bg-soft); color: var(--text);
  cursor: pointer; text-align: left;
}
.preset:hover:not(:disabled) { border-color: #4c8ce0; }
.preset.on { border-color: #4c8ce0; background: var(--accent-soft); font-weight: 600; }
.preset:disabled { opacity: 0.5; cursor: default; }
.pl { font-size: 13px; }
.pc { font-size: 11px; color: var(--muted-2); }

.note { font-size: 11px; color: var(--muted-2); margin: 10px 0 0; line-height: 1.6; }
.timed { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.tl { font-size: 12px; color: var(--muted); }
.mini {
  padding: 5px 10px; font-size: 12px; border-radius: var(--radius-sm);
  border: 1px solid var(--border); background: var(--bg-soft); color: var(--text); cursor: pointer;
}
.mini:hover:not(:disabled) { border-color: #4c8ce0; }
.mini:disabled { opacity: 0.45; cursor: default; }
.mini.danger:hover:not(:disabled) { border-color: var(--warn); color: var(--warn); }

.tb { width: 100%; border-collapse: collapse; font-size: 12px; }
.tb th { text-align: left; color: var(--muted-2); font-weight: 500; padding: 4px 6px; border-bottom: 1px solid var(--border); }
.tb td { padding: 5px 6px; border-bottom: 1px solid var(--border); }
.r { text-align: right; }
.tag {
  display: inline-block; background: #4c8ce0; color: #fff; font-size: 10px;
  border-radius: 3px; padding: 0 5px; margin-right: 6px; line-height: 15px;
}
.empty { font-size: 12px; color: var(--muted-2); margin: 0; }
</style>
