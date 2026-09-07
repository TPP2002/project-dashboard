<script setup lang="ts">
import { appearance, setAppearance, WIRE_EVENTS, type AppearanceConfig } from '@/utils/appearance'

function setEvent(id: keyof AppearanceConfig['wireEvents'], event: Event) {
  setAppearance('wireEvents', { ...appearance.wireEvents, [id]: (event.target as HTMLInputElement).checked })
}
</script>

<template>
  <h3 class="ac-h">把看板状态推出去</h3>
  <p class="ac-p">看板发生三类事（完工 / 有新待拍板 / 有卡阻塞）时，往你指定的地址发一条 JSON。
    最好玩的用法：接到桌上那条 RGB 灯带上——有活儿等你拍板它就变橙，全绿了它就慢慢呼吸，有卡卡住了它变红。
    这样不用盯着屏幕也知道看板在说什么。</p>
  <div class="ac-line">
    <div class="ac-text"><b>推送地址</b><span>在服务端配（环境变量 <code>DASHBOARD_EVENT_WEBHOOK</code>），界面这里只显示配没配</span></div>
    <span class="badge n">未配置</span>
  </div>
  <div class="ac-line">
    <div class="ac-text"><b>推哪几类事</b><span>不勾就不推</span></div>
    <div class="event-options">
      <label v-for="event in WIRE_EVENTS" :key="event.id" class="ac-switch">
        <input type="checkbox" :checked="appearance.wireEvents[event.id]" @change="setEvent(event.id, $event)">
        <span class="ac-track" />{{ event.label }}
      </label>
    </div>
  </div>
  <p class="ac-hint">推送在服务端发出，跟浏览器开没开无关——人不在电脑前，灯照样会变。</p>
  <p class="ac-hint">本页先保存事件选择，推送与配置状态读取将在后续接入，当前不会发送。</p>

  <h3 class="ac-h">发出去的长这样</h3>
  <pre class="ac-code">POST &lt;你配的地址&gt;
Content-Type: application/json

{
  "event":   "done",                       // done | pending | block
  "project": "dashboard",
  "task":    "AUD-FUN-PERSONALIZATION",
  "title":   "外观设置只有主题和灯条配色…",
  "ts":      "2026-09-07T14:22:31+08:00"
}</pre>
</template>

<style scoped>
.event-options { display: flex; gap: var(--s3); flex-wrap: wrap; }
code { overflow-wrap: anywhere; }
</style>
