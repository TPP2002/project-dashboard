export function createScreenReceiver(onTrigger: (scene: string) => void, onReady: () => void, clock: () => number = () => performance.now()) {
  const last = new Map<string, number>()
  return {
    reset() { last.clear() },
    receive(event: MessageEvent, frame: Window | null, origin: string) {
      if (!frame || event.source !== frame || event.origin !== origin) return
      const data = event.data
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.source !== 'audition-screen') return
      if (data.type === 'ready' && Array.isArray(data.scenes)) { onReady(); return }
      if (data.type !== 'trigger' || typeof data.scene !== 'string' || !data.scene) return
      const at = clock(), previous = last.get(data.scene)
      if (previous !== undefined && at - previous < 80) return
      last.set(data.scene, at)
      onTrigger(data.scene)
    },
  }
}
