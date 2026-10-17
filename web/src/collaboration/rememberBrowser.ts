import { apiJson } from './http'
import type { Device } from './types'

/** Explicit owner action. The server owns the device cookie; this flow only reads public metadata. */
export async function rememberBrowser(
  label: string,
  refreshDevices: () => Promise<void>,
  signal: AbortSignal,
  request: typeof apiJson = apiJson,
): Promise<string> {
  if (signal.aborted) throw new DOMException('操作已取消', 'AbortError')
  const response = await request<{ ok: true; device: Device }>(
    '/api/auth/remember-device', { label: label.trim() || '我的常用浏览器' }, signal,
  )
  if (signal.aborted) throw new DOMException('操作已取消', 'AbortError')
  await refreshDevices()
  if (signal.aborted) throw new DOMException('操作已取消', 'AbortError')
  return response.device.expiresAt
    ? `已设置此浏览器信任；到期：${new Date(response.device.expiresAt).toLocaleString()}`
    : '已设置此浏览器信任，有效期90天。'
}
