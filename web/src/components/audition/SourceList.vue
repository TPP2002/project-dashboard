<script setup lang="ts">
import type { AuditionSource } from '@/types/audition'
import { needsAttribution, safeSourceUrl } from '@/utils/audition/manifest'
defineProps<{ sources: AuditionSource[] }>()
</script>
<template>
  <p v-if="!sources.length">这段声音还没有填写来源。</p>
  <article v-for="(source, index) in sources" :key="index" class="source">
    <h4>{{ source.title || '未填标题' }} <span v-if="needsAttribution(source.license)" class="badge warn">需署名</span></h4>
    <dl>
      <dt>平台</dt><dd>{{ source.platform || '未填写' }}</dd><dt>作者</dt><dd>{{ source.author || '未填写' }}</dd>
      <dt>授权</dt><dd>{{ source.license || '未填写' }}</dd>
      <dt>授权链接</dt><dd><a v-if="safeSourceUrl(source.licenseUrl)" :href="safeSourceUrl(source.licenseUrl)" target="_blank" rel="noopener noreferrer">查看授权说明</a><span v-else>未填有效链接</span></dd>
      <dt>原链接</dt><dd><a v-if="safeSourceUrl(source.url)" :href="safeSourceUrl(source.url)" target="_blank" rel="noopener noreferrer">查看原始声音</a><span v-else>未填有效链接</span></dd>
      <dt>改动</dt><dd>{{ source.mods || '未填写' }}</dd>
      <dt>署名内容</dt><dd>{{ source.attribution || '未填写' }}</dd>
    </dl>
  </article>
</template>
<style scoped>
.source { margin-top: var(--s3); border: 1px solid var(--line); border-radius: var(--r); padding: var(--s3); }
h4 { margin: 0 0 var(--s2); }
dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--s2) var(--s3); margin: 0; font-size: var(--fs-sm); }
dt { color: var(--text-2); } dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
a { color: var(--info); }
</style>
