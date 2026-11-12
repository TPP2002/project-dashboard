import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { deviceState, formatDay, deviceWhen, groupDevices } from '../src/collaboration/deviceGroups'
import type { Device, User } from '../src/collaboration/types'

const now = new Date(2026, 9, 27, 12).getTime()
const day = (year: number, month: number, date: number) => new Date(year, month - 1, date, 12).toISOString()
const user = (id: string, role: User['role'], displayName: string, disabled = false): User => ({ id, username: id, displayName, role, projectIds: ['T1'], disabled })
const device = (id: string, userId: string, createdAt = day(2026, 10, 1), expiresAt = day(2027, 1, 18), revoked = false): Device => ({ id, userId, label: id, createdAt, expiresAt, revoked })

test('states and local date text', () => {
  const active = device('a', 'demo'); const expired = { ...active, expiresAt: new Date(now).toISOString() }; const revoked = { ...expired, revoked: true, revokedAt: day(2026, 10, 27) }
  assert.equal(deviceState(active, now), 'active'); assert.equal(deviceState(expired, now), 'expired'); assert.equal(deviceState(revoked, now), 'revoked')
  for (const [year, expected] of [[2026, '10-01'], [2027, '明年 10-01'], [2025, '去年 10-01'], [2024, '2024-10-01']] as const) assert.equal(formatDay(day(year, 10, 1), now), expected)
  assert.equal(formatDay('bad', now), '未知')
  assert.equal(deviceWhen(active, now), '10-01 创建 · 明年 01-18 到期')
  assert.equal(deviceWhen(expired, now), '10-01 创建 · 10-27 到期')
  assert.equal(deviceWhen(revoked, now), '10-01 创建 · 10-27 撤销')
  assert.equal(deviceWhen({ ...revoked, revokedAt: undefined }, now), '10-01 创建')
})

test('groups preserve people and device ordering and distinguish all summaries', () => {
  const users = [user('zhou', 'member', '小周', true), user('demo', 'owner', '负责人'), user('lin', 'viewer', '阿林'), user('none', 'member', '𠮷祥'), user('gone', 'member', '小陈')]
  const ds = [device('old', 'zhou', day(2026, 9, 1)), device('expired', 'zhou', day(2026, 10, 20), day(2026, 10, 25)), device('new', 'zhou', day(2026, 10, 2)), device('revoked', 'zhou', day(2026, 10, 3), undefined, true), device('one', 'lin'), device('gone', 'gone', undefined, undefined, true), device('stray', 'missing')]
  const groups = groupDevices(users, ds, now)
  assert.deepEqual(groups.map(g => g.name), ['你', '小周', '阿林', '𠮷祥', '小陈', '未知账号'])
  assert.equal(groups[0].letter, '你'); assert.equal(groups[0].roleText, '负责人'); assert.equal(groups[0].summary, '还没有设备')
  assert.equal(groups[1].user?.disabled, true); assert.deepEqual(groups[1].live.map(d => d.id), ['new', 'old', 'expired']); assert.deepEqual(groups[1].revoked.map(d => d.id), ['revoked']); assert.equal(groups[1].activeCount, 2); assert.equal(groups[1].summary, '2 台有效')
  assert.equal(groups[2].summary, '1 台有效'); assert.equal(groups[2].live.length, 1); assert.equal(groups[2].roleText, '只读访客')
  assert.equal(groups[3].letter, '𠮷'); assert.equal(groups[3].summary, '还没有设备'); assert.equal(groups[4].summary, '没有有效设备'); assert.equal(groups[4].live.length, 0); assert.equal(groups[4].revoked.length, 1)
  assert.equal(groups[5].letter, '?'); assert.equal(groups[5].roleText, '')
  assert.equal(groupDevices(users, [], now).length, users.length)
  assert.deepEqual(groupDevices([user('a', 'owner', '甲'), user('b', 'owner', '乙')], [], now).map(g => [g.name, g.letter]), [['甲', '甲'], ['乙', '乙']])
  assert.deepEqual(groupDevices(users, [device('x', 'zhou'), device('y', 'zhou')], now)[1].live.map(d => d.id), ['x', 'y'])
})

test('component and integration retain the specified structure', async () => {
  const source = await readFile(new URL('../src/collaboration/DeviceGroups.vue', import.meta.url), 'utf8')
  const admin = await readFile(new URL('../src/collaboration/AdminPanel.vue', import.meta.url), 'utf8')
  const types = await readFile(new URL('../src/collaboration/types.ts', import.meta.url), 'utf8')
  for (const name of ['group', 'head', 'av', 'name', 'count', 'list', 'row', 'gone']) assert.match(source, new RegExp(`class="dg-${name}(?:"| )`))
  assert.match(source, /<details\b/); assert.doesNotMatch(source, /<details\b[^>]*\bopen\b/); assert.match(source, /:aria-label="[^\"]*撤销设备/); assert.match(source, /aria-hidden/); assert.match(source, /:focus-visible/)
  assert.doesNotMatch(source, /transition\s*:\s*all|#[0-9a-f]|\brgb\s*\(|\bhsl\s*\(|:global|TODO|占位|[\u{1F300}-\u{1FAFF}]/iu)
  if (/transition\s*:/.test(source)) { assert.match(source, /prefers-reduced-motion/); for (const m of source.matchAll(/(\d*\.?\d+)s\b/g)) assert.ok(Number(m[1]) <= 0.2) }
  for (const m of source.matchAll(/(?<!:)class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) assert.ok(c === 'dg' || c.startsWith('dg-') || c === 'btn', c)
  assert.match(admin, /<DeviceGroups[^>]*:users="data.users"[^>]*:devices="data.devices"[^>]*:busy="busy"[^>]*@revoke="[^\"]*revoke\('devices'/)
  assert.doesNotMatch(admin, /v-for="device in data.devices"|尚未创建设备凭据|负责人设备/); assert.match(admin, /<h2>设备<\/h2>/); assert.match(admin, /信任此浏览器90天/); assert.match(admin, /主动退出会取消此浏览器信任/)
  assert.match(types, /userId\?: string/); assert.match(types, /revokedAt\?: string/)
})
