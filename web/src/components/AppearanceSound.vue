<script setup lang="ts">
import { ref } from 'vue'
import { appearance, isAgeThresholds, setAppearance } from '@/utils/appearance'
import { playSound } from '@/utils/sound'

const sounds = [
  { cue: 'ding', label: '有新的待拍板', hint: '清脆的一声「叮」' },
  { cue: 'dong', label: '有卡完工', hint: '厚一点的一声「咚」' },
  { cue: 'low', label: '有卡被卡住', hint: '闷闷的低鸣，提醒但不惊吓' },
] as const

const notifySupported = typeof Notification !== 'undefined'
const notifyBusy = ref(false)
const notifyError = ref('')
const notifyEvents = [
  { kind: 'pending', label: '有新的待拍板' },
  { kind: 'done', label: '有卡完工' },
  { kind: 'block', label: '有卡被卡住' },
] as const
const ageLabels = ['第一档', '第二档', '第三档'] as const
const ageError = ref('')

async function toggleNotify(event: Event) {
  const input = event.target as HTMLInputElement
  const enable = input.checked
  notifyError.value = ''
  if (!enable || !notifySupported) {
    setAppearance('notify', false)
    input.checked = false
    return
  }
  notifyBusy.value = true
  input.checked = false
  try {
    const permission = Notification.permission === 'granted'
      ? 'granted' : await Notification.requestPermission()
    setAppearance('notify', permission === 'granted')
    if (permission === 'denied') {
      notifyError.value = '浏览器拒绝了通知授权，在地址栏左侧的站点设置里放开'
    } else if (permission !== 'granted') {
      notifyError.value = '尚未允许通知，再次打开开关可重新授权'
    }
  } catch (error) {
    setAppearance('notify', false)
    notifyError.value = '通知授权未完成，请在地址栏左侧的站点设置里检查'
    console.warn('通知授权请求失败', error)
  } finally {
    input.checked = appearance.notify
    notifyBusy.value = false
  }
}

function updateAge(index: number, event: Event) {
  const input = event.target as HTMLInputElement
  const next = [...appearance.ageThresholds]
  next[index] = input.valueAsNumber
  if (!isAgeThresholds(next)) {
    input.value = String(appearance.ageThresholds[index])
    ageError.value = '请填写三个严格递增的正整数分钟，每档不超过 525600；已恢复原值'
    return
  }
  ageError.value = ''
  setAppearance('ageThresholds', next)
}
</script>

<template>
  <h3 class="ac-h">提示音与通知</h3>
  <p class="ac-p">三件事值得出声：有新的待拍板、有卡完工了、有卡被卡住了。声音是现场合成的（几十行代码画出来的波形），
    不下载任何音频文件，也就不会有「哪来的一个 mp3」这种问题。</p>
  <div class="ac-line">
    <div class="ac-text"><b id="appearance-sound">开启提示音</b><span>默认关。开了之后下面三样才生效</span></div>
    <label class="ac-switch"><input type="checkbox" aria-labelledby="appearance-sound" :checked="appearance.sound"
      @change="setAppearance('sound', ($event.target as HTMLInputElement).checked)"><span class="ac-track" /></label>
  </div>
  <div v-for="sound in sounds" :key="sound.label" class="ac-line">
    <div class="ac-text"><b>{{ sound.label }}</b><span>{{ sound.hint }}</span></div>
    <button class="btn btn-sm" type="button" :aria-label="`试听${sound.label}`"
      @click="playSound(sound.cue, { preview: true })">试听</button>
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

  <section class="extra-section" aria-labelledby="notify-heading">
    <h3 id="notify-heading" class="ac-h">桌面通知</h3>
    <p v-if="!notifySupported" class="ac-hint" role="status">这个浏览器不支持桌面通知</p>
    <div class="ac-line">
      <div class="ac-text"><b id="appearance-notify">开启桌面通知</b><span>首次打开时，请在浏览器弹出的提示中允许通知</span></div>
      <label class="ac-switch"><input type="checkbox" aria-labelledby="appearance-notify"
        :checked="notifySupported && appearance.notify" :disabled="!notifySupported || notifyBusy" @change="toggleNotify"><span class="ac-track" /></label>
    </div>
    <p v-if="notifyError" class="setting-error" role="alert">{{ notifyError }}</p>
    <div v-for="event in notifyEvents" :key="event.kind" class="ac-line">
      <label class="notify-choice"><input type="checkbox" :checked="appearance.notifyEvents[event.kind]"
        :disabled="!notifySupported || !appearance.notify || notifyBusy"
        @change="setAppearance('notifyEvents', { ...appearance.notifyEvents, [event.kind]: ($event.target as HTMLInputElement).checked })">{{ event.label }}</label>
    </div>
    <p class="ac-hint">静音时段同样对通知生效；点通知直接跳到对应页面</p>
  </section>

  <section class="extra-section" aria-labelledby="age-heading">
    <h3 id="age-heading" class="ac-h">陈旧提醒</h3>
    <p class="ac-hint">施工中的卡多久没动就变色：第一档蓝、第二档琥珀、第三档红</p>
    <div v-for="(label, index) in ageLabels" :key="label" class="ac-line">
      <label :for="`appearance-age-${index}`" class="ac-text"><b>{{ label }}</b></label>
      <div class="age-input"><input :id="`appearance-age-${index}`" class="field" type="number" min="1" max="525600" step="1"
        :value="appearance.ageThresholds[index]" @change="updateAge(index, $event)"><span>分钟</span></div>
    </div>
    <p v-if="ageError" class="setting-error" role="alert">{{ ageError }}</p>
  </section>
</template>

<style scoped>
.volume-range { width: 200px; }
.quiet-times { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s2); color: var(--text-3); }
.time { width: auto; padding: var(--s1) var(--s2); font-family: var(--mono); font-size: var(--fs-sm); }
.extra-section { margin-top: var(--s5); padding-top: var(--s4); border-top: 1px solid var(--line); }
.notify-choice, .age-input { display: flex; align-items: center; gap: var(--s2); }
.age-input { color: var(--text-3); font-size: var(--fs-sm); }
.age-input .field { width: 112px; }
.setting-error { color: var(--bad); font-size: var(--fs-sm); }
</style>
