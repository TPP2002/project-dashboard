import { appearance } from '@/utils/appearance'
import { inQuietHours, shouldThrottle, toGain } from './soundRules'

type Cue = 'ding' | 'dong' | 'low'
type Tone = { type: OscillatorType; frequency: number; level: number; drop?: number }
type Filter = { type: BiquadFilterType; frequency: number }
let audio: AudioContext | undefined
let master: GainNode | undefined
const lastPlayed = new Map<Cue, number>()

/** 只在真正请求发声时创建；导入模块与默认静音都不占用音频设备。 */
function audioOutput(): { context: AudioContext; output: GainNode } | undefined {
  if (!audio || !master) {
    if (typeof AudioContext === 'undefined') return
    const context = new AudioContext()
    try {
      const output = context.createGain()
      output.connect(context.destination)
      audio = context
      master = output
    } catch (error) {
      void context.close().catch(() => {})
      throw error
    }
  }
  return { context: audio, output: master }
}

/** 每个声部自己收尾、断线；所有声部最终只经过同一个主增益。时间单位为秒。 */
function voice(context: AudioContext, output: GainNode, source: AudioScheduledSourceNode,
  at: number, duration: number, attack: number, level: number, filter?: Filter, slow = false) {
  const envelope = context.createGain()
  const end = at + duration
  envelope.gain.setValueAtTime(0, at)
  envelope.gain.linearRampToValueAtTime(level, at + attack)
  if (slow) envelope.gain.linearRampToValueAtTime(0, end)
  else {
    envelope.gain.exponentialRampToValueAtTime(0.0001, end)
    envelope.gain.setValueAtTime(0, end)
  }
  let filtered: BiquadFilterNode | undefined
  if (filter) {
    filtered = context.createBiquadFilter()
    filtered.type = filter.type
    filtered.frequency.setValueAtTime(filter.frequency, at)
    source.connect(filtered)
    filtered.connect(envelope)
  } else source.connect(envelope)
  envelope.connect(output)
  source.onended = () => {
    try { source.disconnect(); filtered?.disconnect(); envelope.disconnect() }
    catch (_) { /* 设备关闭后的清理失败不能影响看板。 */ }
  }
  source.start(at)
  source.stop(end)
}

function tones(context: AudioContext, output: GainNode, at: number, duration: number,
  notes: Tone[], attack = 0.005, filter?: Filter, slow = false) {
  for (const note of notes) {
    const oscillator = context.createOscillator()
    oscillator.type = note.type
    oscillator.frequency.setValueAtTime(note.frequency, at)
    if (note.drop) {
      oscillator.frequency.setValueAtTime(note.frequency, at + duration * 0.65)
      oscillator.frequency.linearRampToValueAtTime(note.frequency * (1 - note.drop), at + duration)
    }
    voice(context, output, oscillator, at, duration, attack, note.level, filter, slow)
  }
}

function synthesize(context: AudioContext, output: GainNode, cue: Cue) {
  const at = context.currentTime
  const ding = (time: number) => tones(context, output, time, 0.38, [
    { type: 'sine', frequency: 1046, level: 0.65 }, { type: 'sine', frequency: 1568, level: 0.35 },
  ])
  const dong = (duration: number) => tones(context, output, at, duration, [
    { type: 'triangle', frequency: 196, level: 0.7 }, { type: 'sine', frequency: 392, level: 0.3 },
  ], 0.005, { type: 'lowpass', frequency: 1200 })
  const low = (time: number, duration: number) => tones(context, output, time, duration, [
    { type: 'sawtooth', frequency: 110, level: 0.7, drop: 0.08 },
  ], duration * 0.25, { type: 'lowpass', frequency: 260 }, true)
  switch (cue) {
    case 'ding': ding(at); break
    case 'dong': dong(0.65); break
    case 'low': low(at, 0.52); break
  }
}

function muted(): boolean {
  const now = new Date()
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return !appearance.sound || inQuietHours(hm, appearance.quietStart, appearance.quietEnd)
}

/** 试听绕过开关、静音时段与事件限频，仍使用本机音量；所有音频失败都静默结束。 */
export async function playSound(cue: Cue, opts?: { preview?: boolean }): Promise<void> {
  try {
    const preview = opts?.preview === true
    if (!preview && (muted() || shouldThrottle(lastPlayed.get(cue), performance.now()))) return
    const target = audioOutput()
    if (!target) return
    if (target.context.state === 'suspended') await target.context.resume()
    if (target.context.state !== 'running') return
    // resume 期间可能改了设置，也可能有同一 cue 在等待；按实际排入音频图的时刻限频。
    const now = performance.now()
    if (!preview && (muted() || shouldThrottle(lastPlayed.get(cue), now))) return
    target.output.gain.setValueAtTime(toGain(appearance.volume), target.context.currentTime)
    synthesize(target.context, target.output, cue)
    if (!preview) lastPlayed.set(cue, now)
  } catch (_) { /* 自动播放被拒、设备不可用或合成失败均不向调用方抛错。 */ }
}
