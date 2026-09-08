<script setup lang="ts">
import { appearance, setAppearance } from '@/utils/appearance'
import type { WorkfloorSettings } from '@/workfloor/types'

const worlds = [{ id: 'off', label: '关' }, { id: 'launch', label: '发射场' }, { id: 'mech', label: '机甲装配' }] as const
const times = [{ id: 'theme', label: '跟随主题' }, { id: 'night', label: '始终夜景' }, { id: 'clock', label: '跟随时间' }] as const
const details = [{ id: 'standard', label: '标准' }, { id: 'ultra', label: '极致' }] as const
const heights = [{ id: 'standard', label: '标准' }, { id: 'compact', label: '紧凑' }] as const
const positions = [{ id: 'bottom', label: '任务卡下方' }, { id: 'top', label: '任务卡上方' }] as const
const zooms = [{ id: 1, label: '1×' }, { id: 1.25, label: '1.25×' }, { id: 1.5, label: '1.5×' }, { id: 1.75, label: '1.75×' }, { id: 2, label: '2×' }] as const
const cameras = [{ id: 'fixed', label: '固定' }, { id: 'pan', label: '缓慢横移' }] as const

function choose<K extends keyof WorkfloorSettings>(key: K, value: WorkfloorSettings[K]) {
  setAppearance('workfloor', { ...appearance.workfloor, [key]: value })
}
</script>

<template>
  <h3 class="ac-h">施工现场</h3>
  <p class="ac-p">把当前项目的任务进展放进看板页的一幅施工画面（位置可选），设置立即保存。</p>
  <div class="ac-line">
    <div class="ac-text"><b id="wf-world">世界</b><span>关掉后，看板不再显示这条横幅</span></div>
    <div class="ac-options" role="group" aria-labelledby="wf-world">
      <button v-for="option in worlds" :key="option.id" class="appearance-choice" type="button"
        :aria-pressed="appearance.workfloor.world === option.id" @click="choose('world', option.id)">{{ option.label }}</button>
    </div>
  </div>
  <div class="ac-line">
    <div class="ac-text"><b id="wf-time">昼夜</b><span>跟随时间时，本机早六点至晚六点为白天</span></div>
    <div class="ac-options" role="group" aria-labelledby="wf-time">
      <button v-for="option in times" :key="option.id" class="appearance-choice" type="button"
        :aria-pressed="appearance.workfloor.dayNight === option.id" @click="choose('dayNight', option.id)">{{ option.label }}</button>
    </div>
  </div>
  <div class="ac-line">
    <div class="ac-text"><b id="wf-detail">细节</b><span>标准档减少粒子；极致档显示完整质感</span></div>
    <div class="ac-options two" role="group" aria-labelledby="wf-detail">
      <button v-for="option in details" :key="option.id" class="appearance-choice" type="button"
        :aria-pressed="appearance.workfloor.detail === option.id" @click="choose('detail', option.id)">{{ option.label }}</button>
    </div>
  </div>
  <div class="ac-line">
    <div class="ac-text"><b id="wf-height">高度</b><span>紧凑档保留主体，为任务卡留出空间</span></div>
    <div class="ac-options two" role="group" aria-labelledby="wf-height">
      <button v-for="option in heights" :key="option.id" class="appearance-choice" type="button"
        :aria-pressed="appearance.workfloor.height === option.id" @click="choose('height', option.id)">{{ option.label }}</button>
    </div>
  </div>
  <div class="ac-line">
    <div class="ac-text"><b id="wf-position">位置</b><span>默认贴在页面底部，任务卡先看</span></div>
    <div class="ac-options two" role="group" aria-labelledby="wf-position">
      <button v-for="option in positions" :key="option.id" class="appearance-choice" type="button"
        :aria-pressed="appearance.workfloor.position === option.id" @click="choose('position', option.id)">{{ option.label }}</button>
    </div>
  </div>
  <div class="ac-line">
    <div class="ac-text"><b id="wf-zoom">缩放</b><span>放大后底边对齐、两侧和天空裁掉，占地不变</span></div>
    <div class="ac-options" role="group" aria-labelledby="wf-zoom">
      <button v-for="option in zooms" :key="option.id" class="appearance-choice" type="button"
        :aria-pressed="appearance.workfloor.zoom === option.id" @click="choose('zoom', option.id)">{{ option.label }}</button>
    </div>
  </div>
  <div class="ac-line">
    <div class="ac-text"><b id="wf-camera">镜头</b><span>放大后画面比横幅宽时，镜头在两端之间慢慢来回；系统减少动效时不动</span></div>
    <div class="ac-options two" role="group" aria-labelledby="wf-camera">
      <button v-for="option in cameras" :key="option.id" class="appearance-choice" type="button"
        :aria-pressed="appearance.workfloor.camera === option.id" @click="choose('camera', option.id)">{{ option.label }}</button>
    </div>
  </div>
  <div class="ac-line">
    <div class="ac-text"><b id="wf-sound">音效联动</b><span>跟随「提示音」的总开关与音量</span></div>
    <label class="ac-switch"><input type="checkbox" aria-labelledby="wf-sound" :checked="appearance.workfloor.soundLink"
      @change="choose('soundLink', ($event.target as HTMLInputElement).checked)"><span class="ac-track" /></label>
  </div>
  <p class="ac-hint">当前两个世界展示特效测试台；完整场景、白天配色和音效将在后续接入。系统开启「减少动效」时，画面保持静止。</p>
</template>
