const cancelled = () => new DOMException('试听已停止', 'AbortError')

/** 等待解码时也能立即停止；迟到的解码结果只能进缓存，不能再启动声音。 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(cancelled()) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => { cleanup(); if (!signal.aborted) resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
  })
}
export function playbackGap(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancelled()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

export class AuditionPlayer {
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private volume = 70
  private buffers = new Map<string, Promise<AudioBuffer>>()
  private variants = new Map<string, number>()
  private fetches = new Set<AbortController>()
  private sources = new Set<AudioBufferSourceNode>()

  /** 只有手势入口能首次创建；画面消息只能使用已经激活的上下文。 */
  async unlock(fromGesture = false): Promise<void> {
    if (!this.context) {
      if (!fromGesture) throw new Error('请先点一下开启声音')
      this.context = new AudioContext()
      this.gain = this.context.createGain()
      this.gain.gain.value = this.volume / 100
      this.gain.connect(this.context.destination)
    }
    if (this.context.state === 'suspended') await this.context.resume()
    if (this.context.state !== 'running') throw new Error('请点一下播放按钮开启声音')
  }
  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(100, volume))
    if (this.gain) this.gain.gain.value = this.volume / 100
  }
  private buffer(url: string): Promise<AudioBuffer> {
    const cached = this.buffers.get(url)
    if (cached) return cached
    const context = this.context
    if (!context) return Promise.reject(new Error('请先开启声音'))
    const controller = new AbortController()
    this.fetches.add(controller)
    const request = fetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('声音文件暂时无法读取')
      return context.decodeAudioData(await response.arrayBuffer())
    }).catch(error => { this.buffers.delete(url); throw error }).finally(() => { this.fetches.delete(controller) })
    this.buffers.set(url, request)
    return request
  }
  async play(urls: string[], signal: AbortSignal, rate = 1): Promise<void> {
    if (!urls.length || urls.length > 4) throw new Error('这个片段的声音文件数量有误')
    if (!this.context || !this.gain) throw new Error('请先点一下开启声音')
    const key = JSON.stringify(urls), next = this.variants.get(key) ?? 0
    const index = next % urls.length
    const buffer = await abortable(this.buffer(urls[index]), signal)
    if (signal.aborted) throw cancelled()
    const source = this.context.createBufferSource()
    source.buffer = buffer; source.playbackRate.value = rate; source.connect(this.gain)
    this.sources.add(source)
    return new Promise((resolve, reject) => {
      const cleanup = () => { signal.removeEventListener('abort', abort); source.onended = null; this.sources.delete(source); source.disconnect() }
      const abort = () => { source.stop(); cleanup(); reject(cancelled()) }
      source.onended = () => { cleanup(); resolve() }
      signal.addEventListener('abort', abort, { once: true })
      source.start()
      // 真正播出才推进轮换；取消解码不能跳过下一份素材。
      this.variants.set(key, index + 1)
      if (signal.aborted) abort()
    })
  }
  async dispose() {
    for (const request of this.fetches) request.abort()
    for (const source of this.sources) source.stop()
    this.buffers.clear(); this.variants.clear()
    if (this.context && this.context.state !== 'closed') await this.context.close()
    this.context = null; this.gain = null
  }
}
