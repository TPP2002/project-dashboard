/**
 * 派单结论的机器复核与最终判决(CODEX-BRIDGE-DISPATCH,2026-09-01)。
 *
 * 【定位】把 code-quality-discipline 元规则 3"自述不算验证"做成机器闸。
 * Codex 交回来的那份 JSON 只当**线索**,真正算数的是派单器自己拿到的证据:
 * 工单哈希、git diff 出来的改动清单、文件在不在、验收命令自己重跑的退出码。
 *
 * 【为什么 judge 是纯函数】证据全是 IO(跑进程、查文件、读 git),混在一起就没法测。
 * 这里只做"证据 → 判决",IO 由 codex-runner / codex-dispatch 负责喂。
 *
 * 【判决优先级(顺序不许调)】
 *   1. 工单被改过        → rejected  (它能自己给自己判过,信任基础没了)
 *   2. 碰禁区 / 越出施工面 → rejected  (**必须压过 blocked**,否则一句"我有问题要问"
 *                                    就能把"顺手改了禁区"洗白)
 *   3. 进程崩了/超时且无结论 → crashed
 *   4. 自述 blocked 或提了开放问题 → blocked (施工段零决策红线:要拍板不算失败)
 *   5. 完工标记没打印    → rejected  (没干完)
 *   6. 说好的产物不在    → rejected
 *   7. 必过断言机器复核没过(含压根没跑起来) → rejected
 *   8. 以上都过          → accepted
 */

export type SelfReportStatus = 'completed' | 'blocked' | 'partial' | 'refused'

export interface SelfReport {
  status: SelfReportStatus
  summary: string
  changedFiles: string[]
  acceptanceResults: { id: string; ran: boolean; passed: boolean; evidence: string }[]
  openQuestions: string[]
  blockers: string[]
}

/** 派单器自己重跑一条验收得到的事实(不是 Codex 说的)。 */
export interface MachineAcceptance {
  id: string
  required: boolean
  /** 命令是否真的跑起来了。人工项、以及起不来的命令都是 false。 */
  ran: boolean
  passed: boolean
  exitCode: number | null
  /** 人工项标 true:不自动跑,不据此否决,只登记。 */
  manual?: boolean
}

export interface JudgeInput {
  slug: string
  taskId: string
  allowedPaths: string[]
  forbiddenPaths: string[]
  expectArtifacts: string[]
  /** 工单文件哈希与派单时刻一致 */
  taskFrozen: boolean
  exitCode: number | null
  timedOut: boolean
  markerPrinted: boolean
  /** git diff 出来的真实改动清单(仓库相对路径) */
  changedFiles: string[]
  /** expectArtifacts 里真实存在的那些 */
  existingArtifacts: string[]
  acceptance: MachineAcceptance[]
  selfReport: SelfReport | null
}

export type FinalStatus = 'accepted' | 'rejected' | 'blocked' | 'crashed'

export interface Judgement {
  slug: string
  taskId: string
  finalStatus: FinalStatus
  /** 判否的理由;accepted 时为空数组。 */
  reasons: string[]
  /** 不否决整单、但要让人看见的事。 */
  warnings: string[]
  forbiddenTouched: string[]
  outsideAllowed: string[]
  missingArtifacts: string[]
  openQuestions: string[]
  acceptance: MachineAcceptance[]
  selfReport: SelfReport | null
}

/** 把 Windows 反斜杠归一成正斜杠,再比 glob。 */
const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')

const REGEX_SPECIAL = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', '?'])

/**
 * 极小 glob:支持 ** (跨目录) 与 * (不跨目录);其余字符按字面量。
 *
 * 逐字符扫而不是几次 replace 串起来:串 replace 要先把 ** 换成一个"不可能出现的占位符"
 * 再换回去,而"不可能出现"这件事没法保证 —— 初版拿了个不可见字符当占位,结果它是个 NUL,
 * 被 lint 的 no-control-regex 当场抓出来。逐字符扫没有这种坑。
 */
const globToRe = (pattern: string): RegExp => {
  const source = normalize(pattern)
  let body = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] as string
    if (ch !== '*') {
      body += REGEX_SPECIAL.has(ch) ? '\\' + ch : ch
      continue
    }
    if (source[i + 1] === '*') {
      i += 1
      if (source[i + 1] === '/') i += 1
      body += '(?:.*/)?'
    } else {
      body += '[^/]*'
    }
  }
  return new RegExp('^' + body + '$')
}

export const matchesAny = (filePath: string, patterns: string[]): boolean => {
  const target = normalize(filePath)
  return patterns.some((pattern) => {
    const normalized = normalize(pattern)
    if (normalized.endsWith('/**')) {
      // src/engine/** 覆盖整棵子树(但不含 src/engineering/…)
      const prefix = normalized.slice(0, -3)
      return target === prefix || target.startsWith(prefix + '/')
    }
    return globToRe(normalized).test(target)
  })
}

const STATUSES: SelfReportStatus[] = ['completed', 'blocked', 'partial', 'refused']

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/**
 * 容错解析 Codex 交回来的最后一条消息。
 * 它**应该**是纯 JSON(下发了 output schema),但模型偶尔会裹一层代码围栏或前后加几句话,
 * 为这点小事把整单判崩不值当 —— 捞得出来就用,捞不出来返回 null,由 judge 兜底。
 */
export const parseSelfReport = (raw: string): SelfReport | null => {
  if (!raw || !raw.trim()) return null

  const candidates: string[] = [raw.trim()]
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  const braced = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
  if (braced.startsWith('{')) candidates.push(braced.trim())

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      if (typeof parsed !== 'object' || parsed === null) continue
      const status = STATUSES.includes(parsed.status as SelfReportStatus)
        ? (parsed.status as SelfReportStatus)
        : 'partial' // 状态不在枚举里 = 说不清,一律不当成功
      return {
        status,
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        changedFiles: asStrings(parsed.changedFiles),
        acceptanceResults: Array.isArray(parsed.acceptanceResults)
          ? (parsed.acceptanceResults as Record<string, unknown>[])
              .filter((r) => r && typeof r === 'object')
              .map((r) => ({
                id: typeof r.id === 'string' ? r.id : '',
                ran: r.ran === true,
                passed: r.passed === true,
                evidence: typeof r.evidence === 'string' ? r.evidence : '',
              }))
          : [],
        openQuestions: asStrings(parsed.openQuestions),
        blockers: asStrings(parsed.blockers),
      }
    } catch {
      continue
    }
  }
  return null
}

export const judge = (input: JudgeInput): Judgement => {
  const reasons: string[] = []
  const warnings: string[] = []

  const forbiddenTouched = input.changedFiles.filter((f) => matchesAny(f, input.forbiddenPaths))
  const outsideAllowed = input.changedFiles.filter(
    (f) => !matchesAny(f, input.allowedPaths) && !matchesAny(f, input.forbiddenPaths),
  )
  const missingArtifacts = input.expectArtifacts.filter(
    (a) => !input.existingArtifacts.map(normalize).includes(normalize(a)),
  )
  const openQuestions = input.selfReport?.openQuestions ?? []

  const base = {
    slug: input.slug,
    taskId: input.taskId,
    forbiddenTouched,
    outsideAllowed,
    missingArtifacts,
    openQuestions,
    acceptance: input.acceptance,
    selfReport: input.selfReport,
  }

  // 可选项失败只记一笔,不影响判决走向。
  for (const item of input.acceptance) {
    if (!item.required && !item.manual && (!item.ran || !item.passed)) {
      warnings.push('可选断言 ' + item.id + ' 未通过(ran=' + item.ran + ', exit=' + String(item.exitCode) + ')')
    }
    if (item.manual) warnings.push('断言 ' + item.id + ' 是人工项,派单器没跑,需要人核')
  }

  // 1. 工单被改过 —— 信任基础没了,一票否决。
  if (!input.taskFrozen) {
    reasons.push('工单文件在施工期间被改动过(哈希对不上)。收单方能改自己的工单 = 能自判验收通过,整单不予采信。')
    return { ...base, finalStatus: 'rejected', reasons, warnings }
  }

  // 2. 越界 —— 必须压过 blocked。
  if (forbiddenTouched.length > 0) {
    reasons.push('改动碰到禁区:' + forbiddenTouched.join(', '))
  }
  if (outsideAllowed.length > 0) {
    reasons.push('改动越出施工面(allowedPaths 之外):' + outsideAllowed.join(', '))
  }
  if (reasons.length > 0) {
    return { ...base, finalStatus: 'rejected', reasons, warnings }
  }

  // 3. 进程崩了/超时且什么都没交回来。
  if ((input.timedOut || (input.exitCode !== null && input.exitCode !== 0)) && input.selfReport === null) {
    reasons.push(
      input.timedOut
        ? '进程超时被杀,且没有交回任何结论'
        : 'codex exec 退出码 ' + String(input.exitCode) + ',且没有交回任何结论',
    )
    return { ...base, finalStatus: 'crashed', reasons, warnings }
  }

  // 4. 要拍板 —— 不是失败,是停下来等人。
  if (input.selfReport && (input.selfReport.status === 'blocked' || openQuestions.length > 0)) {
    reasons.push('收单方有待拍板的问题,按施工段零决策红线停在这里等人拍。')
    return { ...base, finalStatus: 'blocked', reasons, warnings }
  }

  // 5~7. 到这里它自称干完了,逐条查它到底干没干完。
  if (!input.markerPrinted) {
    reasons.push('没有打印完工标记 —— 按契约它就不算跑完(可能中途被打断,或自己判断没做完)。')
  }
  if (missingArtifacts.length > 0) {
    reasons.push('说好要产出的文件不存在:' + missingArtifacts.join(', '))
  }
  for (const item of input.acceptance) {
    if (!item.required || item.manual) continue
    if (!item.ran) {
      reasons.push('必过断言 ' + item.id + ' 压根没跑起来(空过不算过)')
    } else if (!item.passed) {
      reasons.push('必过断言 ' + item.id + ' 机器复核未通过(exit=' + String(item.exitCode) + ')')
    }
  }
  if (input.selfReport && input.selfReport.status === 'refused') {
    reasons.push('收单方明确拒绝执行:' + (input.selfReport.summary || '未说明理由'))
  }

  if (reasons.length > 0) return { ...base, finalStatus: 'rejected', reasons, warnings }
  return { ...base, finalStatus: 'accepted', reasons, warnings }
}

/**
 * 下发给 codex exec --output-schema 的结论形状。
 * 与 SelfReport 一一对应;改这里必须同步改 SelfReport 与 parseSelfReport。
 */
export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'changedFiles', 'acceptanceResults', 'openQuestions', 'blockers'],
  properties: {
    status: {
      type: 'string',
      enum: ['completed', 'blocked', 'partial', 'refused'],
      description: 'completed=按施工面干完了; blocked=有必须人来拍板的问题; partial=只做了一部分; refused=拒绝执行',
    },
    summary: {
      type: 'string',
      description: '给不懂代码的负责人看的中文短段落,200 字以内;只回答“这活是干什么的、干完了没有、有没有需要人处理的问题”。不要写文件名、路径、命令、测试编号、错误码、代码符号、英文缩写或其他技术术语;技术细节放其他字段。没有需要人处理的问题也要明确写出来。',
    },
    changedFiles: { type: 'array', items: { type: 'string' }, description: '你改动过的文件(仓库相对路径)' },
    acceptanceResults: {
      type: 'array',
      description: '逐条如实填;派单器会自己重跑复核,谎报会被当场抓出来',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'ran', 'passed', 'evidence'],
        properties: {
          id: { type: 'string' },
          ran: { type: 'boolean', description: '你有没有真的跑过这条命令' },
          passed: { type: 'boolean' },
          evidence: { type: 'string', description: '命令输出的结尾统计行,原文粘贴' },
        },
      },
    },
    openQuestions: {
      type: 'array',
      items: { type: 'string' },
      description: '需要人拍板的选择题。**填了这个就一定要把 status 交 blocked**,不许自己挑一个做下去',
    },
    blockers: { type: 'array', items: { type: 'string' }, description: '把你卡住的客观障碍(环境坏了、依赖缺失等)' },
  },
} as const
