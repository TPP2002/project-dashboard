<script setup lang="ts">
import { computed, ref } from 'vue'
import { inviteLink } from './flow'
const props = defineProps<{ token: string; kind: 'invite' | 'device' | 'reset' }>()
const label = computed(() => props.kind === 'invite' ? '邀请码' : props.kind === 'reset' ? '重置码' : '设备凭据')
defineEmits<{ dismiss: [] }>()
const notice = ref('')
const link = computed(() => props.kind === 'invite' ? inviteLink(window.location.origin, props.token) : '')
async function copy(value: string) {
  try { await navigator.clipboard.writeText(value); notice.value = '已复制' }
  catch { notice.value = '浏览器未允许复制，请选中下方内容手动复制' }
}
</script>
<template>
  <section class="collab-card collab-secret" aria-label="新建凭据" aria-live="polite">
    <h3>{{ label }}{{ kind === 'reset' ? '（只显示这一次）' : '已生成' }}</h3>
    <p>明文仅在本次创建后显示，关闭后无法再次查看。</p>
    <label>{{ label }}<textarea :value="token" readonly spellcheck="false" autocomplete="off" @focus="($event.target as HTMLTextAreaElement).select()" /></label>
    <button class="btn" @click="copy(token)">复制{{ label }}</button>
    <template v-if="link">
      <label>邀请链接<textarea :value="link" readonly spellcheck="false" @focus="($event.target as HTMLTextAreaElement).select()" /></label>
      <button class="btn" @click="copy(link)">复制邀请链接</button>
    </template>
    <p v-else-if="kind === 'reset'">24 小时内有效 · 用一次即作废 · 再生成一个会让这个立即作废。请私下发给对方。</p>
    <p v-else>请将凭据放入安全的本机配置；持有它可以建立负责人会话。不要粘贴到网址、日志或浏览器存储中。丢失后请撤销设备。</p>
    <p role="status">{{ notice }}</p>
    <button class="btn" @click="$emit('dismiss')">我已保存，关闭明文</button>
  </section>
</template>
