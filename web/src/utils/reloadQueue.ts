export function createReloadQueue() {
  const tails = new Map<string, Promise<unknown>>()
  const pending = new Map<string, { detect: boolean; promise: Promise<unknown> }>()

  function enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(run)
    const tail = result.finally(() => { if (tails.get(key) === tail) tails.delete(key) })
    tails.set(key, tail)
    return tail
  }

  function reload<T>(key: string, detect: boolean, run: (detect: boolean) => Promise<T>): Promise<T> {
    const queued = pending.get(key)
    if (queued) {
      queued.detect ||= detect
      return queued.promise as Promise<T>
    }
    const entry = { detect, promise: undefined as unknown as Promise<T> }
    entry.promise = enqueue(key, () => {
      if (pending.get(key) === entry) pending.delete(key)
      return run(entry.detect)
    })
    pending.set(key, entry)
    return entry.promise
  }

  return Object.assign(reload, {
    clearPending() { pending.clear() },
    barrier<T>(key: string, run: () => Promise<T>): Promise<T> {
      pending.delete(key)
      return enqueue(key, run)
    },
  })
}
