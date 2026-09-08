<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { fetchHealth, postSettings } from '@/api/client'
import { appearance, setAppearance, WIRE_EVENTS, type AppearanceConfig } from '@/utils/appearance'

const configured = ref<boolean | null>(null)
const loading = ref(true)
const saving = ref(false)

onMounted(async () => {
  try {
    const health = await fetchHealth()
    if (!health.ok || !health.webhook || typeof health.webhook.configured !== 'boolean'
      || !health.webhook.events || WIRE_EVENTS.some(event => typeof health.webhook?.events[event.id] !== 'boolean')) return
    configured.value = health.webhook.configured
    setAppearance('wireEvents', health.webhook.events)
  } catch (_) { /* 无法读取时保留经过校验的本机镜像，配置状态显示未知。 */ }
  finally { loading.value = false }
})

async function setEvent(id: keyof AppearanceConfig['wireEvents'], event: Event) {
  const input = event.target as HTMLInputElement
  if (loading.value || saving.value) { input.checked = appearance.wireEvents[id]; return }
  const previous = { ...appearance.wireEvents }
  const next = { ...previous, [id]: input.checked }
  saving.value = true
  setAppearance('wireEvents', next)
  try {
    const result = await postSettings({ webhookEvents: next })
    if (!result.ok) throw new Error('保存失败')
    setAppearance('wireEvents', result.settings.webhookEvents)
  } catch (_) {
    setAppearance('wireEvents', previous)
    input.checked = previous[id]
    alert('推送选择没能保存，已恢复原来的选择，请稍后再试。')
  } finally { saving.value = false }
}
</script>

<template>
  <h3 class="ac-h">把看板状态推出去</h3>
  <p class="ac-p">看板发生三类事（完工 / 有新待拍板 / 有卡阻塞）时，往你指定的地址发一条 JSON。
    最好玩的用法：接到桌上那条 RGB 灯带上——有活儿等你拍板它就变橙，全绿了它就慢慢呼吸，有卡卡住了它变红。
    这样不用盯着屏幕也知道看板在说什么。</p>
  <div class="ac-line">
    <div class="ac-text"><b>推送地址</b><span>在服务端配（环境变量 <code>DASHBOARD_EVENT_WEBHOOK</code>），界面这里只显示配没配</span></div>
    <span class="badge" :class="configured === true ? 'ok' : 'n'">
      {{ configured === null ? '未知' : configured ? '已配置' : '未配置' }}
    </span>
  </div>
  <div class="ac-line">
    <div class="ac-text"><b>推哪几类事</b><span>不勾就不推</span></div>
    <div class="event-options">
      <label v-for="event in WIRE_EVENTS" :key="event.id" class="ac-switch">
        <input type="checkbox" :checked="appearance.wireEvents[event.id]" :disabled="loading || saving"
          @change="setEvent(event.id, $event)">
        <span class="ac-track" />{{ event.label }}
      </label>
    </div>
  </div>
  <p class="ac-hint">推送在服务端发出，跟浏览器开没开无关——人不在电脑前，灯照样会变。</p>

  <h3 class="ac-h">发出去的长这样</h3>
  <pre class="ac-code">POST &lt;你配的地址&gt;
Content-Type: application/json

{
  "event":   "done",                       // done | pending | block
  "project": "dashboard",
  "projectName": "项目管理看板",
  "task":    "AUD-FUN-PERSONALIZATION",
  "title":   "外观设置只有主题和灯条配色…",
  "status":  "已完工",
  "ts":      "2026-09-07T14:22:31+08:00"
}</pre>
</template>

<style scoped>
.event-options { display: flex; gap: var(--s3); flex-wrap: wrap; }
code { overflow-wrap: anywhere; }
</style>
