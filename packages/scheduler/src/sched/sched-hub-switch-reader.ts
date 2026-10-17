import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { schedPaths } from './sched-contract'
import hub from './client/sched-hub-switch.cjs'
import type { HubSwitch, HubSwitchParse } from './client/sched-hub-switch.cjs'

/** 派单员侧开关；缺字段即关，保留旧全关对象的形状，不改变客户端协议。 */
export type SchedulerHubSwitch = HubSwitch & {
  readonly residentActualUsage?: boolean
  /** 实测退回(SCHED-ACTUAL-USAGE-ADMISSION-1010):开时在跑非常驻单按实测×1.3 折算、差额当空闲核;缺字段即关。 */
  readonly actualUsageAdmission?: boolean
}
export interface HubSwitchReader { read(): SchedulerHubSwitch }

/** 派单员侧新开关的键名清单;写坏其中一个就整份按全关(bad-field 口径),与 residentActualUsage 同一读法。 */
const SCHEDULER_ONLY_SWITCHES = ['residentActualUsage', 'actualUsageAdmission'] as const

function parseSchedulerHubSwitch(input: string | Uint8Array): HubSwitchParse & { readonly value: SchedulerHubSwitch } {
  // 先由原解析器校验字节、JSON 和既有字段；不含新开关时原结果原样返回。
  const original = hub.parseHubSwitch(input)
  if (!original.ok) return original
  const text = typeof input === 'string' ? input : Buffer.from(input).toString('utf8')
  const raw = JSON.parse(text.startsWith(String.fromCharCode(0xfeff)) ? text.slice(1) : text) as Record<string, unknown>
  const present = SCHEDULER_ONLY_SWITCHES.filter(key => Object.hasOwn(raw, key))
  if (present.length === 0) return original
  const legacy = { ...raw }
  const enabled: Partial<Record<(typeof SCHEDULER_ONLY_SWITCHES)[number], boolean>> = {}
  for (const key of present) {
    const value = raw[key]
    if (typeof value !== 'boolean') return Object.freeze({
      ok: false, reason: 'bad-field',
      detail: `${key} 要是 true 或 false,收到 ${JSON.stringify(value)}`,
      warnings: Object.freeze([]), value: hub.ALL_OFF,
    })
    if (value) enabled[key] = true
    delete legacy[key]
  }
  const parsed = hub.parseHubSwitch(JSON.stringify(legacy))
  if (!parsed.ok) return parsed
  // false 不增加旧开关对象的字段；true 才启用派单员侧口径，其他未知字段仍由原解析器告警。
  return Object.keys(enabled).length > 0 ? Object.freeze({ ...parsed,
    value: Object.freeze({ ...parsed.value, ...enabled }) }) : parsed
}

export function createHubSwitchReader(options: { share: string; warn?: (message: string) => void; readFile?: (path: string) => string | Uint8Array }): HubSwitchReader {
  const path = join(schedPaths(options.share).control, 'hub.json')
  const readFile = options.readFile ?? ((name: string) => readFileSync(name))
  let warned: string | undefined
  const warn = (signature: string, message: string): void => {
    if (signature === warned) return
    warned = signature
    try { options.warn?.(message) } catch { /* 告警端口不可影响派单 */ }
  }
  return {
    read(): SchedulerHubSwitch {
      try {
        const parsed = parseSchedulerHubSwitch(readFile(path))
        if (!parsed.ok) warn(`parse:${parsed.reason}:${parsed.detail}`, `[sched] 总开关不合法,按全关:${parsed.reason}:${parsed.detail}`)
        else if (parsed.warnings.length) warn(`warnings:${parsed.warnings.join('|')}`, `[sched] 总开关提示:${parsed.warnings.join(';')}`)
        else warned = undefined
        return parsed.value
      } catch (error) {
        if ((error as { code?: string } | null)?.code === 'ENOENT') return hub.ALL_OFF
        const kind = (error as { code?: string } | null)?.code ?? 'unknown'
        warn(`read:${kind}`, `[sched] 总开关读不到,按全关:${kind}`)
        return hub.ALL_OFF
      }
    },
  }
}
