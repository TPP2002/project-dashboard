<script setup lang="ts">
import { computed } from 'vue'
import type { PerksState } from '@/api/perks'
import { autoLabel, todayView, weekCells } from '@/utils/perksFormat'
import type { PerksLine } from '@/utils/perksFormat'

const props = defineProps<{ status: 'loading' | 'ready' | 'error'; data: PerksState | null; errorLine: string; line: PerksLine; acting: boolean; busy: boolean; accountNote: string }>()
const emit = defineEmits<{ run: []; stop: []; retry: []; reload: []; login: [account: string, ids?: string[]]; schedule: [on: boolean]; add: []; manage: [id: string] }>()
const manual = computed(() => props.data?.platforms.filter(p => p.mode === 'manual') || [])
</script>

<template>
  <section class="pk" id="page-perks" role="tabpanel" aria-labelledby="tab-perks">
    <template v-if="!data && status === 'loading'"><div class="res-skeleton card" aria-hidden="true"><div class="skel res-skel wide"></div><div class="skel res-skel medium"></div><div class="skel res-skel wide"></div></div><span class="pk-sr" role="status">正在读取每日福利</span></template>
    <div v-else-if="!data && status === 'error'"><h2>读不到每日福利</h2><p>{{ errorLine }}</p><button class="btn" type="button" @click="emit('reload')">重试</button></div>
    <template v-else-if="data">
      <p v-if="errorLine" class="pk-hint">刷新失败：{{ errorLine }}</p>
      <div class="pk-top"><div class="pk-day"><strong>{{ data.dateLabel }}</strong><span class="pk-stats">已领 <b>{{ data.summary.done }}</b> 家 · 要你处理 <b>{{ data.summary.action }}</b> 家 · 还没校准 <b>{{ data.summary.unverified }}</b> 家</span></div>
        <div class="pk-ctl"><label class="pk-auto"><input type="checkbox" :checked="data.scheduleInstalled" :disabled="acting || busy" @change="emit('schedule', ($event.target as HTMLInputElement).checked)">{{ data.runTimes.length ? autoLabel(data.runTimes) : '自动领' }}</label><button class="btn primary" type="button" :disabled="acting || busy" @click="emit('run')">现在领一次</button></div>
      </div>
      <div v-if="line.text || line.canStop || line.canRetry" class="pk-status" :class="line.kind" aria-live="polite"><span class="pk-status-text">{{ line.text }}</span><button v-if="line.canStop" class="btn btn-sm" type="button" :disabled="acting" @click="emit('stop')"><span class="pk-stop-icon" aria-hidden="true"></span>停止</button><button v-if="line.canRetry" class="btn btn-sm" type="button" :disabled="acting" @click="emit('retry')">再试一次</button><div class="pk-bar" aria-hidden="true"><i :style="{ transform: `scaleX(${line.kind === 'queued' ? 1 : line.progress ?? 0})` }"></i></div></div>
      <p v-if="(data.calibration?.pending || 0) > 0" class="pk-hint">有 {{ data.calibration?.pending }} 家还没校准，领取时只会把它们的网页打开一遍，领不到东西。</p>
      <section v-for="account in data.accounts" :key="account.id" class="pk-account" :aria-label="account.name"><header class="pk-account-head"><h2>{{ account.name }}</h2><span v-if="!account.enabled" class="badge n">已暂停</span><span class="pk-count">领 {{ account.platforms.length }} 家</span><div class="sp"><button class="btn btn-sm" type="button" :disabled="acting || busy" @click="emit('login', account.id)">登录各家</button><button class="btn btn-sm" type="button" @click="emit('manage', account.id)">管理</button></div></header>
        <div v-if="account.enabled" class="pk-rows"><div class="pk-row head"><span>平台</span><span>每天送什么</span><span>今天</span><span>近 7 天</span><span class="pk-sr">操作</span></div><div v-for="platform in account.platforms" :key="platform.id" class="pk-row"><a class="pk-name" :href="platform.url" target="_blank" rel="noopener noreferrer">{{ platform.name }}</a><span class="pk-reward">{{ platform.reward }}</span><div><span class="pk-today"><span class="badge" :class="todayView(platform.today).tone">{{ todayView(platform.today).text }}</span>{{ todayView(platform.today).time }}</span><span v-if="todayView(platform.today).detail" class="pk-reward">{{ todayView(platform.today).detail }}</span></div><span class="pk-week"><i v-for="(cell, index) in weekCells(platform.last7)" :key="index" :class="{ ok: cell.tone === 'ok', act: cell.tone === 'warn', u: cell.tone === 'n' }" :title="cell.label" :aria-label="cell.label"></i></span><button class="btn btn-sm" type="button" :disabled="acting || busy" @click="emit('login', account.id, [platform.id])">登录</button></div></div>
        <div v-if="account.enabled" class="pk-legend"><span><span class="pk-week"><i class="ok"></i></span>领到</span><span><span class="pk-week"><i class="act"></i></span>要你处理</span><span><span class="pk-week"><i class="u"></i></span>还没校准</span><span><span class="pk-week"><i></i></span>没跑</span></div>
      </section>
      <div class="pk-under"><button class="btn btn-sm" type="button" @click="emit('add')">添加账号</button><span>{{ accountNote }}</span></div>
      <div class="pk-folds"><details class="pk-more"><summary>只能在软件里领（{{ manual.length }}）</summary><ul><li v-if="!manual.length">没有</li><li v-for="p in manual" :key="p.id"><a :href="p.url" target="_blank" rel="noopener noreferrer">{{ p.name }}</a>：{{ p.reward }}</li></ul></details><details class="pk-more"><summary>今天的福利变动（{{ data.changes.length }}）</summary><ul><li v-if="!data.changes.length">今天没有变动</li><li v-for="(change, i) in data.changes" :key="i">{{ change.kind === 'added' ? '新增' : change.kind === 'removed' ? '下架' : '变动' }}：{{ change.name }}（{{ change.sourceLabel }}）{{ change.kind === 'changed' ? ` ${change.detail}` : '' }}</li></ul></details><details class="pk-more"><summary>清单上有、你还没接的（{{ data.unintegrated.length }}）</summary><ul><li>想接哪家，告诉 Claude。</li><li v-if="!data.unintegrated.length">没有</li><li v-for="p in data.unintegrated" :key="p.name"><a :href="p.url" target="_blank" rel="noopener noreferrer">{{ p.name }}</a>：{{ p.reward }} · {{ p.cadenceLabel }}</li></ul></details></div>
    </template>
  </section>
</template>

<style scoped>
.pk { display: grid; gap: var(--s3); min-width: 0; }
.res-skeleton { display: grid; gap: var(--s3); padding: var(--s4); }
.res-skel.wide { width: 88%; }
.res-skel.medium { width: 56%; }
.pk-top { display: flex; align-items: center; justify-content: space-between; gap: var(--s3) var(--s4); flex-wrap: wrap; }
.pk-day { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap; }
.pk-day strong { font-size: var(--fs-md); }
.pk-stats { color: var(--text-2); font-variant-numeric: tabular-nums; }
.pk-stats b { color: var(--text); font-family: var(--mono); font-weight: 600; }
.pk-ctl { display: flex; align-items: center; gap: var(--s4); flex-wrap: wrap; }
.pk-auto { display: inline-flex; align-items: center; gap: var(--s2); color: var(--text-2); font-size: var(--fs-sm); cursor: pointer; min-height: 44px; }
.pk-auto input { width: 16px; height: 16px; margin: 0; accent-color: var(--text); }
.pk-status { position: relative; display: flex; align-items: center; gap: var(--s3); min-height: 44px; padding: var(--s2) var(--s3); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface); overflow: hidden; }
.pk-status-text { flex: 1; min-width: 0; font-variant-numeric: tabular-nums; }
.pk-status.idle .pk-status-text { color: var(--text-2); }
.pk-status .btn { flex: none; }
.pk-stop-icon { width: 10px; height: 10px; border-radius: 2px; background: currentColor; }
.pk-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: transparent; }
.pk-bar i { display: block; height: 100%; background: var(--spectrum); background-size: 200% 100%; transform-origin: left center; transform: scaleX(0); }
.pk-status.queued .pk-bar i { opacity: .35; }
@media (prefers-reduced-motion: no-preference) {
  .pk-bar i { position: relative; overflow: hidden; transition: transform .4s ease; }
  .pk-bar i::after { content: ''; position: absolute; inset: 0; width: 200%; background: var(--spectrum); animation: pk-flow 3.4s linear infinite; }
  @keyframes pk-flow { to { transform: translateX(-50%); } }
}
.pk-hint { margin: 0; color: var(--warn); font-size: var(--fs-sm); }
.pk-account { border: 1px solid var(--line); border-radius: var(--r); background: var(--surface); min-width: 0; }
.pk-account-head { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; padding: var(--s2) var(--s3); border-bottom: 1px solid var(--line); }
.pk-account-head h2 { margin: 0; font-size: var(--fs-md); }
.pk-count { color: var(--text-2); font-size: var(--fs-sm); }
.pk-account-head .sp { margin-left: auto; display: flex; gap: var(--s2); }
.pk-rows { display: grid; }
.pk-row { display: grid; grid-template-columns: minmax(120px, 1.1fr) minmax(0, 2.4fr) 168px 92px 56px; align-items: center; gap: var(--s3); padding: var(--s1) var(--s3); border-top: 1px solid var(--line); min-width: 0; }
.pk-row:first-child { border-top: 0; }
.pk-row.head { color: var(--text-3); font-size: var(--fs-xs); padding-top: var(--s2); padding-bottom: var(--s2); }
.pk-name { font-weight: 600; color: var(--text); text-decoration: none; overflow-wrap: anywhere; }
@media (hover: hover) { .pk-name:hover { text-decoration: underline; } }
.pk-reward { color: var(--text-2); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.pk-today { display: flex; align-items: center; gap: var(--s2); font-size: var(--fs-sm); color: var(--text-3); font-variant-numeric: tabular-nums; }
.pk-week { display: flex; gap: var(--s1); }
.pk-week i { width: 9px; height: 9px; border-radius: 2px; border: 1px solid var(--line-strong); }
.pk-week i.u { background: repeating-linear-gradient(135deg, var(--text-3) 0 2px, transparent 2px 4px); border-color: var(--text-3); }
.pk-week i.ok { background: var(--ok); border-color: var(--ok); }
.pk-week i.act { background: var(--warn); border-color: var(--warn); border-radius: 50%; }
.pk-legend { display: flex; flex-wrap: wrap; gap: var(--s3); padding: var(--s2) var(--s3); border-top: 1px solid var(--line); color: var(--text-3); font-size: var(--fs-xs); }
.pk-legend span { display: inline-flex; align-items: center; gap: var(--s1); }
.pk-under { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; }
.pk-more { border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2); min-width: 0; }
.pk-more summary { padding: var(--s2) var(--s3); cursor: pointer; color: var(--text-2); font-size: var(--fs-sm); min-height: 44px; }
.pk-more ul { margin: 0; padding: 0 var(--s3) var(--s3) var(--s6); color: var(--text-2); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.pk-folds { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s3); align-items: start; }
.pk-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 900px) {
  .pk-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: var(--s1); padding: var(--s2) var(--s3); }
  .pk-row.head { display: none; }
  .pk-reward { grid-column: 1 / -1; order: 3; }
  .pk-week { order: 4; }
  .pk-row .btn { order: 5; justify-self: end; min-height: 44px; min-width: 44px; }
  .pk-folds { grid-template-columns: minmax(0, 1fr); }
  .pk .btn { min-height: 44px; }
  .pk a { display: inline-flex; align-items: center; min-height: 44px; }
}
@media (max-width: 560px) { .pk-name { grid-column: 1 / -1; } }
</style>
