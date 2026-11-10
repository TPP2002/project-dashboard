/**
 * 账号与额度页的纯格式化函数(无 DOM、无请求、无 import,便于内存编译测试)。
 *
 * 所有用户可见文案取自施工单【界面文字】,一字不改。字段缺失或为 null 一律显示「读不到」,
 * 绝不因为单个字段坏掉就抛错或白屏。
 *
 * validateLabel / validateKeyFile 的白名单规则与 server/resourcesApi.cjs 里的
 * validateLabel / validateKeyFile 是同一套(见那边同名函数上的互相指明注释);
 * 前后端各写一份,测试各自覆盖同一组合规与不合规用例。
 */

const SLASH = 47
const BACKSLASH = 92
const COLON = 58
const KEY_MAX = 500
const LABEL_MAX = 20

const LABEL_ERROR = '名字最多 20 个字,不能换行,不能以 - 开头'
const KEY_PATH_ERROR = '请填完整路径(盘符开头或 / 开头),不要带引号'
const KEY_EMPTY_ERROR = '请填密钥文件路径'

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}
/** 控制字符:码点 <= 31 或 === 127(含换行、制表符)。 */
function hasControlChars(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0
    if (code <= 31 || code === 127) return true
  }
  return false
}
/** 密钥文件路径里禁止:NUL、换行、回车、三种引号。 */
function hasForbiddenKeyChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) || 0
    if (code === 0 || code === 10 || code === 13) return true
    if (ch === "'" || ch === '"' || ch === '`') return true
  }
  return false
}
/** 盘符加斜杠/反斜杠开头,或以 / 开头。 */
function isAbsolutePath(value: string): boolean {
  const c0 = value.charCodeAt(0)
  if (c0 === SLASH) return true
  const c1 = value.charCodeAt(1)
  const c2 = value.charCodeAt(2)
  const drive = ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) && c1 === COLON
  return drive && (c2 === SLASH || c2 === BACKSLASH)
}
/** 是否含 .. 路径段(按 / 与反斜杠切分)。 */
function hasDotDotSegment(value: string): boolean {
  const parts: string[] = []
  let cur = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) || 0
    if (code === SLASH || code === BACKSLASH) { parts.push(cur); cur = '' }
    else cur += ch
  }
  parts.push(cur)
  return parts.includes('..')
}

function pad2(n: number): string { return String(n).padStart(2, '0') }
/** 千分位、小数最多 2 位。 */
function fmtAmount(n: number): string {
  const rounded = Math.round(n * 100) / 100
  const parts = String(rounded).split('.')
  const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return parts[1] ? `${grouped}.${parts[1]}` : grouped
}
/** Date.parse 后加 8 小时,再取 UTC 各字段 = 北京时间;无效输入 null。 */
function beijingParts(iso: unknown): Date | null {
  if (typeof iso !== 'string' || iso === '') return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return new Date(ms + 8 * 3600 * 1000)
}
/** 'MM-DD HH:mm' 或 null。 */
export function beijingDateTime(iso: unknown): string | null {
  const d = beijingParts(iso)
  if (!d) return null
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}
/** 'HH:mm' 或 null。 */
export function beijingClock(iso: unknown): string | null {
  const d = beijingParts(iso)
  if (!d) return null
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}

interface QuotaLike {
  remaining?: number | null
  unit?: string | null
  usedPercent?: number | null
  resetAt?: string | null
  source?: string | null
}
export interface QuotaView {
  kind: 'remaining' | 'used' | 'both' | 'unknown'
  text: string
  estimate: boolean
  resetText: string | null
}
/** 额度五种:null / source unknown / 两空 → 读不到;只剩余量 / 只已用 / 两者都有;估算带标记。 */
export function quotaView(quota: QuotaLike | null | undefined): QuotaView {
  const unknown: QuotaView = { kind: 'unknown', text: '读不到', estimate: false, resetText: null }
  if (!quota || typeof quota !== 'object') return unknown
  if (quota.source === 'unknown') return unknown
  const remaining = typeof quota.remaining === 'number' && Number.isFinite(quota.remaining) ? quota.remaining : null
  const usedPercent = typeof quota.usedPercent === 'number' && Number.isFinite(quota.usedPercent) ? quota.usedPercent : null
  if (remaining === null && usedPercent === null) return unknown
  const unit = typeof quota.unit === 'string' && quota.unit ? ` ${quota.unit}` : ''
  let kind: QuotaView['kind']
  let text: string
  if (remaining !== null && usedPercent !== null) {
    kind = 'both'
    text = `剩余 ${fmtAmount(remaining)}${unit} · 已用 ${fmtAmount(usedPercent)}%`
  } else if (remaining !== null) {
    kind = 'remaining'
    text = `剩余 ${fmtAmount(remaining)}${unit}`
  } else {
    kind = 'used'
    text = `已用 ${fmtAmount(usedPercent as number)}%`
  }
  const reset = typeof quota.resetAt === 'string' ? beijingDateTime(quota.resetAt) : null
  const resetText = reset ? `重置 ${reset}` : null
  return { kind, text, estimate: quota.source === 'estimate', resetText }
}

interface LimitLike {
  model?: string | null
  until?: string | null
  kind?: string | null
  source?: string | null
}
const KIND_LABEL: Record<string, string> = {
  'rate-limit': '限流',
  'quota-exhausted': '额度用完',
  'login-required': '需要登录',
  'other': '受限',
}
/** 每条限流一个徽章文字;整号用『整号』;placeholder 末尾加(估计)。 */
export function limitViews(limits: unknown): string[] {
  if (!Array.isArray(limits)) return []
  return limits.map((raw) => {
    const rec: LimitLike = (raw && typeof raw === 'object') ? raw as LimitLike : {}
    const model = typeof rec.model === 'string' && rec.model
      ? (rec.model === '*' ? '整号' : rec.model)
      : '读不到'
    const kind = KIND_LABEL[String(rec.kind)] || '受限'
    const until = typeof rec.until === 'string' ? beijingDateTime(rec.until) : null
    const tail = `至 ${until || '读不到'}`
    const estimate = rec.source === 'placeholder' ? '(估计)' : ''
    return `${model}${kind}${tail}${estimate}`
  })
}

interface LoginLike {
  status?: string | null
  checkedAt?: string | null
  reason?: string | null
}
export interface LoginView {
  badge: string
  tone: 'ok' | 'bad' | 'n'
  check: string
  reason: string
}
/** 登录三态与未核对;原因只在非正常时带出。 */
export function loginView(login: LoginLike | null | undefined): LoginView {
  const rec: LoginLike = (login && typeof login === 'object') ? login : {}
  const status = rec.status
  let badge = '登录 未知'
  let tone: LoginView['tone'] = 'n'
  if (status === 'ok') { badge = '登录 正常'; tone = 'ok' }
  else if (status === 'broken') { badge = '登录 失效'; tone = 'bad' }
  const dt = typeof rec.checkedAt === 'string' ? beijingDateTime(rec.checkedAt) : null
  const check = dt ? `核对 ${dt}` : '未核对'
  const rawReason = typeof rec.reason === 'string' ? rec.reason : ''
  const reason = rawReason && status !== 'ok' ? rawReason : ''
  return { badge, tone, check, reason }
}

interface GateLike {
  open?: boolean | null
  reason?: string | null
  reopensAt?: string | null
}
export interface GateView { text: string; tone: 'ok' | 'warn' | 'n' }
/** 闸三态:可派单 / 暂停派单(原因与恢复时刻) / 派单状态读不到。 */
export function gateView(gate: GateLike | null | undefined): GateView {
  const rec: GateLike = (gate && typeof gate === 'object') ? gate : {}
  const reason = typeof rec.reason === 'string' && rec.reason ? rec.reason : ''
  if (rec.open === true) return { text: '可派单', tone: 'ok' }
  if (rec.open === false) {
    let text = '暂停派单'
    if (reason) text += ':' + reason
    const reopens = typeof rec.reopensAt === 'string' ? beijingDateTime(rec.reopensAt) : null
    if (reopens) text += ',' + reopens + ' 恢复'
    return { text, tone: 'warn' }
  }
  return { text: '派单状态读不到' + (reason ? ':' + reason : ''), tone: 'n' }
}

interface LadderCellLike { provider?: string | null; model?: string | null }
interface LaddersLike {
  light?: unknown
  standard?: unknown
  hard?: unknown
}
export interface LadderGroup { title: string; rows: string[] }
/** 派单顺序:三档相同合成一块,不同则各一块;每格『第 N 格 平台名 · 模型』。 */
export function ladderGroups(
  ladders: LaddersLike | null | undefined,
  providerNames: Record<string, string> | null | undefined,
): LadderGroup[] {
  const names = providerNames || {}
  const src: LaddersLike = (ladders && typeof ladders === 'object') ? ladders : {}
  const rowsOf = (cells: unknown): string[] => {
    if (!Array.isArray(cells)) return []
    return cells.map((raw, index) => {
      const rec: LadderCellLike = (raw && typeof raw === 'object') ? raw as LadderCellLike : {}
      const provider = typeof rec.provider === 'string' ? rec.provider : ''
      const name = names[provider] || provider || '读不到'
      const model = typeof rec.model === 'string' && rec.model ? rec.model : '读不到'
      return `第 ${index + 1} 格 ${name} · ${model}`
    })
  }
  const light = rowsOf(src.light)
  const standard = rowsOf(src.standard)
  const hard = rowsOf(src.hard)
  const same = JSON.stringify(light) === JSON.stringify(standard) && JSON.stringify(standard) === JSON.stringify(hard)
  if (same) return [{ title: '轻档 / 标准档 / 难档(相同)', rows: light }]
  return [
    { title: '轻档', rows: light },
    { title: '标准档', rows: standard },
    { title: '难档', rows: hard },
  ]
}

/** deepseek 与 claude 添加时必填密钥文件路径。 */
export function isKeyProvider(provider: string): boolean {
  return provider === 'deepseek' || provider === 'claude'
}

/** 名字:可空,trim 后 1-20 字、无控制字符、不以 - 开头。返回错误文案或 null。 */
export function validateLabel(text: unknown): string | null {
  if (isBlank(text)) return null
  if (typeof text !== 'string') return LABEL_ERROR
  const trimmed = text.trim()
  if (trimmed.length < 1 || trimmed.length > LABEL_MAX) return LABEL_ERROR
  if (hasControlChars(text) || trimmed.startsWith('-')) return LABEL_ERROR
  return null
}
/** 密钥文件路径:非空、绝对路径、<=500、无禁用字符、无 .. 段。返回错误文案或 null。 */
export function validateKeyFile(text: unknown): string | null {
  if (isBlank(text)) return KEY_EMPTY_ERROR
  if (typeof text !== 'string') return KEY_PATH_ERROR
  if (text.length > KEY_MAX) return KEY_PATH_ERROR
  if (hasForbiddenKeyChars(text)) return KEY_PATH_ERROR
  if (!isAbsolutePath(text)) return KEY_PATH_ERROR
  if (hasDotDotSegment(text)) return KEY_PATH_ERROR
  return null
}
