// Only operation IDs and request digests are stored; never credentials or request text.
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
const storageKey = 'dashboard-owner-operations.v1'
export function operationLedger(storage: StoragePort, uuid: () => string = () => crypto.randomUUID()) {
  const load = (): Record<string, string> => JSON.parse(storage.getItem(storageKey) || '{}')
  return {
    begin(key: string): string {
      const rows = load()
      if (rows[key]) return rows[key]
      if (Object.keys(rows).length >= 256) throw new Error('未确认的操作过多，请先核对执行结果')
      const id = uuid(); rows[key] = id
      storage.setItem(storageKey, JSON.stringify(rows))
      return id
    },
    complete(key: string, id: string): void {
      const rows = load()
      if (rows[key] === id) { delete rows[key]; storage.setItem(storageKey, JSON.stringify(rows)) }
    },
  }
}
export function isOwnerOperation(path: string, method: string): boolean {
  return method === 'POST' && (/^\/api\/dispatch(?:-task|-project)?$/.test(path) || /^\/api\/codex\/(dispatch|say|collect|say-session)$/.test(path) || /^\/api\/(reader|audition)\//.test(path))
}
export async function operationKey(user: string, url: string, body: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([user, url, body]))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('')
}
