import type { Device, User } from './types'

type DeviceState = 'revoked' | 'expired' | 'active'
type GroupDevice = Device & { state: DeviceState; when: string }
export interface DeviceGroup {
  user: User | null
  letter: string
  name: string
  roleText: string
  live: GroupDevice[]
  revoked: GroupDevice[]
  activeCount: number
  summary: string
}

export function deviceState(device: Device, now: number): DeviceState {
  if (device.revoked) return 'revoked'
  return device.expiresAt && Date.parse(device.expiresAt) <= now ? 'expired' : 'active'
}

export function formatDay(iso: string, now: number): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '未知'
  const year = date.getFullYear()
  const delta = year - new Date(now).getFullYear()
  const monthDay = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return delta === 0 ? monthDay : delta === 1 ? `明年 ${monthDay}` : delta === -1 ? `去年 ${monthDay}` : `${year}-${monthDay}`
}

export function deviceWhen(device: Device, now: number): string {
  const created = `${formatDay(device.createdAt, now)} 创建`
  if (device.revoked) return device.revokedAt ? `${created} · ${formatDay(device.revokedAt, now)} 撤销` : created
  return `${created} · ${formatDay(device.expiresAt || '', now)} 到期`
}

export function groupDevices(users: User[], devices: Device[], now: number): DeviceGroup[] {
  const owners = users.filter(user => user.role === 'owner')
  const ordered = [...owners, ...users.filter(user => user.role !== 'owner')]
  const known = new Set(users.map(user => user.id))
  const makeGroup = (user: User | null, items: Device[]): DeviceGroup => {
    const self = user?.role === 'owner' && owners.length === 1
    const name = user ? (self ? '你' : user.displayName || user.username) : '未知账号'
    const letter = user ? (self ? '你' : Array.from(name)[0] || '?') : '?'
    const roleText = user ? ({ owner: '负责人', member: '成员', viewer: '只读访客' } as const)[user.role] : ''
    const sorted = items.map(device => ({ ...device, state: deviceState(device, now), when: deviceWhen(device, now) }))
      .sort ( (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    const live = [...sorted.filter(device => device.state === 'active'), ...sorted.filter(device => device.state === 'expired')]
    const revoked = sorted.filter(device => device.state === 'revoked')
    const activeCount = live.filter(device => device.state === 'active').length
    const summary = activeCount ? `${activeCount} 台有效` : items.length ? '没有有效设备' : '还没有设备'
    return { user, letter, name, roleText, live, revoked, activeCount, summary }
  }
  const groups = ordered.map(user => makeGroup(user, devices.filter(device => device.userId === user.id)))
  const unknown = devices.filter(device => !device.userId || !known.has(device.userId))
  if (unknown.length) groups.push(makeGroup(null, unknown))
  return groups
}
