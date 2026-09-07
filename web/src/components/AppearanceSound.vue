<script setup lang="ts">
import { appearance, setAppearance } from '@/utils/appearance'

const sounds = [
  { label: '有新的待拍板', hint: '清脆的一声「叮」' },
  { label: '有卡完工', hint: '厚一点的一声「咚」' },
  { label: '有卡被卡住', hint: '闷闷的低鸣，提醒但不惊吓' },
]
</script>

<template>
  <h3 class="ac-h">提示音</h3>
  <p class="ac-p">三件事值得出声：有新的待拍板、有卡完工了、有卡被卡住了。声音是现场合成的（几十行代码画出来的波形），
    不下载任何音频文件，也就不会有「哪来的一个 mp3」这种问题。</p>
  <div class="ac-line">
    <div class="ac-text"><b id="appearance-sound">开启提示音</b><span>默认关。开了之后下面三样才生效</span></div>
    <label class="ac-switch"><input type="checkbox" aria-labelledby="appearance-sound" :checked="appearance.sound"
      @change="setAppearance('sound', ($event.target as HTMLInputElement).checked)"><span class="ac-track" /></label>
  </div>
  <div v-for="sound in sounds" :key="sound.label" class="ac-line">
    <div class="ac-text"><b>{{ sound.label }}</b><span>{{ sound.hint }}</span></div>
    <button class="btn btn-sm" type="button" disabled :aria-label="`试听${sound.label}`" title="提示音将在后续接入">试听</button>
  </div>
  <div class="ac-line">
    <div class="ac-text"><b id="appearance-volume">音量</b><span>默认放得很轻，只是一点提示，不是闹钟</span></div>
    <div class="ac-range volume-range">
      <input type="range" min="0" max="100" step="5" :value="appearance.volume" aria-labelledby="appearance-volume"
        @input="setAppearance('volume', Number(($event.target as HTMLInputElement).value))">
      <output class="ac-value">{{ appearance.volume }}%</output>
    </div>
  </div>
  <div class="ac-line">
    <div class="ac-text"><b>静音时段</b><span>这段时间内一律不响，其它设置不受影响</span></div>
    <div class="quiet-times">
      <input class="field time" type="time" :value="appearance.quietStart" aria-label="静音开始时间"
        @change="setAppearance('quietStart', ($event.target as HTMLInputElement).value)">
      <span>到</span>
      <input class="field time" type="time" :value="appearance.quietEnd" aria-label="静音结束时间"
        @change="setAppearance('quietEnd', ($event.target as HTMLInputElement).value)">
    </div>
  </div>
  <p class="ac-hint">同一件事在一秒内连着发生多次（比如批量完工五张卡），只响一声，不会连珠炮。</p>
  <p class="ac-hint">提示音与试听将在后续接入；这里先保存开关、音量和静音时段。</p>
</template>

<style scoped>
.volume-range { width: 200px; }
.quiet-times { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s2); color: var(--text-3); }
.time { width: auto; padding: var(--s1) var(--s2); font-family: var(--mono); font-size: var(--fs-sm); }
</style>
