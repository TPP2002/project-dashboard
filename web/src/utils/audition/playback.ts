import { ref } from 'vue'
import type { AuditionBatchResult } from '../../types/audition'
import { AuditionPlayer, playbackGap } from './player'
import { clipPath } from './manifest'
import { seededRandom } from './random'
import { auditionFileUrl } from '../../api/audition'

interface Step { group: string; scene: string }
interface PlaybackContext { project: string; payload: AuditionBatchResult; seed: number }
export function useAuditionPlayback(context: () => PlaybackContext | null, select: (step: Step) => void) {
  const player = new AuditionPlayer()
  const playing = ref(false), status = ref(''), notice = ref('')
  let active: AbortController | null = null
  function stop() { active?.abort(); active = null; playing.value = false; status.value = '' }
  async function unlock() {
    try { await player.unlock(true) }
    catch { notice.value = '声音还没开启，请点一下播放按钮' }
  }
  async function run(steps: Step[], mode: 'single' | 'compare' | 'group' | 'fatigue') {
    stop()
    const snapshot = context()
    if (!snapshot || !steps.length) { notice.value = '请先选择一个声音和场景'; return }
    const controller = new AbortController(), signal = controller.signal
    active = controller; playing.value = true; notice.value = ''
    const random = seededRandom(snapshot.seed)
    let failures = 0
    try {
      // 用户手势由页面与画面的捕获监听激活；消息本身不能首次创建上下文。
      const ready = player.unlock()
      status.value = '正在准备声音'
      await ready
      for (const [index, step] of steps.entries()) {
        if (signal.aborted) return
        select(step)
        const scene = snapshot.payload.batch.scenes.find(s => s.id === step.scene)
        const clip = snapshot.payload.batch.clips.find(c => c.group === step.group && c.scene === step.scene)
        status.value = mode === 'fatigue' ? `第 ${index + 1}/20 次` : `正在试听：${scene?.name || '当前场景'}（${index + 1}/${steps.length}）`
        if (!clip || !clip.files.length) {
          failures++
          notice.value = '这一组没有所选场景的声音，暂时无法播放'
        } else {
          try {
            const urls = clip.files.map(file => auditionFileUrl(snapshot.project, clipPath(snapshot.payload.baseDir, file)))
            await player.play(urls, signal, mode === 'fatigue' ? 0.98 + random() * 0.04 : 1)
          } catch (e) {
            if (signal.aborted) return
            failures++
            notice.value = '这个片段没能播放，请检查声音文件后重试'
          }
        }
        if (index < steps.length - 1) {
          const gap = mode === 'fatigue' ? 450 + Math.floor(random() * 651) : mode === 'compare' ? 900 : 800
          await playbackGap(gap, signal)
        }
      }
      status.value = failures ? `试听结束，有 ${failures} 次未能播放` : '本轮试听结束'
    } catch {
      if (!signal.aborted) notice.value = '声音还没开启，请点一下播放按钮'
    } finally {
      if (active === controller) { active = null; playing.value = false }
    }
  }
  async function dispose() { stop(); await player.dispose() }
  return { playing, status, notice, stop, unlock, run, dispose, setVolume: (volume: number) => player.setVolume(volume) }
}
