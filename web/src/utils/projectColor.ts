/** size 须为正整数；沿用项目面板的哈希，保证既有项目的后备色不变。 */
export function hashIndex(id: string, size: number): number {
  let hash = 0
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0
  return hash % size
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

/** paletteIds 非空；override 是已由设置入口校验过的调色盘 id。 */
export function pickProjectColor({ projectId, override, registry, paletteIds }: {
  projectId: string
  override?: string | null
  registry?: unknown
  paletteIds: readonly string[]
}): { source: 'override' | 'registry' | 'hash'; value: string } {
  if (override) return { source: 'override', value: `var(--project-${override})` }
  if (isHexColor(registry)) return { source: 'registry', value: registry }
  return { source: 'hash', value: `var(--project-${paletteIds[hashIndex(projectId, paletteIds.length)]})` }
}

/** 输入为六位 hex；RGB 通道使用 0..255。 */
export function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

export function rgbToHex(rgb: readonly [number, number, number]): string {
  return '#' + rgb.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')
}

/** a/b 为六位 hex，t 在 0..1；各通道线性插值后四舍五入。 */
export function mixHex(a: string, b: string, t: number): string {
  const left = hexToRgb(a)
  const right = hexToRgb(b)
  return rgbToHex([
    left[0] + (right[0] - left[0]) * t,
    left[1] + (right[1] - left[1]) * t,
    left[2] + (right[2] - left[2]) * t,
  ])
}

export function lighten(hex: string, t: number): string {
  return mixHex(hex, '#ffffff', t)
}

export function darken(hex: string, t: number): string {
  return mixHex(hex, '#000000', t)
}

/** 首尾同色闭环，流光绕一圈后不会在接缝处跳色。 */
export function marqueeStops(hex: string): string[] {
  return [hex, lighten(hex, .3), hex, darken(hex, .25), hex]
}

/** 只解析单个 var(--name)；读不到值时保留原式，读取方式由调用方注入。 */
export function resolveVarColor(value: string, read: (name: string) => string): string {
  const match = /^var\((--[\w-]+)\)$/.exec(value)
  return match ? read(match[1]).trim() || value : value
}
