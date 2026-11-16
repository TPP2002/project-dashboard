/**
 * 调度台耗时估计模型(纯函数、零 I/O、零第三方依赖;只用 node:crypto)。
 * 客户端、派单员、看板仓共用;模型对象必须能 JSON 往返。
 *
 * 模型存什么:
 *   schema    固定 1。
 *   updatedAt 最近一次学习时刻(ISO),没有学过为 null。
 *   scale     区间系数:预测区间按它展宽/收窄,初始 1,自学习只在 [0.7, 4] 内调整。
 *   buckets   分层耗时桶,键形如 'L1|...';{ u: 最后学习时刻毫秒, v: 最近 30 个耗时毫秒(新的在后) }。
 *   starts    每台机器的启动耗时:最近 60 个「授予许可 → 开跑」毫秒(新的在后)。
 *   recent    准确度环:最近 500 条 { t: 结束时刻毫秒, ape: 绝对误差率, inside: 0/1, level: 命中层号 }。
 *   seen      去重键(票据号|执行号),最近 3000 个。
 *
 * 每个数怎么读:
 *   buckets 的键由十层固定顺序拼出(见 LAYER_BASIS);层号越小越具体,预测从第 1 层往下
 *   找第一个样本数够 MIN_SAMPLES 的桶。桶里的 v 按学习先后排列,越靠后越新;加权分位数
 *   按 0.93^(从最新往老数的名次) 加权。scale 越大区间越宽(自学习把约八成命中作为目标)。
 *
 * 怎么重建:
 *   扫共享盘票据 → ticketToSamples 逐张折成样本 → 按 endedAt 升序逐个 learn(先估后学)
 *   → serializeModel 写回。重建不读时钟:学习时刻由样本 endedAt 或调用方传入的 nowMs 决定。
 */
'use strict'

const { createHash } = require('node:crypto')

const WINDOW = 30
const DECAY = 0.93
const MAX_BUCKETS = 4000
const MIN_SAMPLES = [3, 3, 3, 3, 4, 4, 4, 3, 3, 1]
const LEVEL_BASIS = [
  '同命令、同参数、同机器、同核数',
  '同命令、同参数、同核数',
  '同命令、同参数、同机器',
  '同命令、同参数',
  '同命令、同机器、同核数',
  '同命令、同核数',
  '同命令、同机器',
  '同命令',
  '同项目同类活',
  '全部同类活',
]
const STARTS_WINDOW = 60
const RECENT_WINDOW = 500
const SEEN_WINDOW = 3000
const MAX_START_MS = 3600000
const ARGS_SIGNATURE_MAX = 200

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isTimeText(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function argsSignature(args) {
  const text = JSON.stringify(args === undefined ? null : args)
  if (text.length <= ARGS_SIGNATURE_MAX) return text
  return 'h:' + createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function baseOf(input) {
  return input.usageKey !== null && input.usageKey !== undefined ? input.usageKey : input.project + '|' + input.workType
}

function layerSuffixes(input) {
  const base = baseOf(input)
  const args = argsSignature(input.args)
  const machine = input.machine === null || input.machine === undefined ? '?' : input.machine
  const cores = String(input.cores)
  const category = input.category
  const workType = input.workType
  return [
    base + '|' + args + '|' + machine + '|' + cores,
    base + '|' + args + '|' + cores,
    base + '|' + args + '|' + machine,
    base + '|' + args,
    base + '|' + machine + '|' + cores,
    base + '|' + cores,
    base + '|' + machine,
    base,
    input.project + '|' + category + '|' + workType,
    category + '|' + workType,
  ]
}

function bucketKey(layer, suffix) {
  return 'L' + layer + '|' + suffix
}

function machineLayers(layer) {
  return layer === 1 || layer === 3 || layer === 5 || layer === 7
}

function basisOf(n, level) {
  return '最近 ' + n + ' 次' + LEVEL_BASIS[level - 1]
}

function findBucket(model, query) {
  const suffixes = layerSuffixes(query)
  const hasMachine = query.machine !== null && query.machine !== undefined
  for (let index = 0; index < 10; index += 1) {
    const level = index + 1
    if (!hasMachine && machineLayers(level)) continue
    const bucket = model.buckets[bucketKey(level, suffixes[index])]
    if (bucket !== undefined && Array.isArray(bucket.v) && bucket.v.length >= MIN_SAMPLES[index]) {
      return { bucket, level }
    }
  }
  return null
}

/** 加权分位数:values 按学习先后排列(新的在后),按值升序累加权重取第一个越过阈值的值。 */
function weightedQuantile(values, p) {
  const weighted = []
  for (let index = 0; index < values.length; index += 1) {
    weighted.push({ value: values[index], weight: DECAY ** (values.length - 1 - index) })
  }
  weighted.sort((left, right) => left.value - right.value)
  let total = 0
  for (const item of weighted) total += item.weight
  const threshold = p * total - 1e-12
  let accumulated = 0
  for (const item of weighted) {
    accumulated += item.weight
    if (accumulated >= threshold) return item.value
  }
  return weighted[weighted.length - 1].value
}

function evictBuckets(model, touched) {
  const keys = Object.keys(model.buckets)
  if (keys.length <= MAX_BUCKETS) return
  const protectedKeys = new Set(touched)
  const removable = keys.filter(key => !protectedKeys.has(key))
  removable.sort((left, right) => {
    const diff = model.buckets[left].u - model.buckets[right].u
    if (diff !== 0) return diff
    return left < right ? -1 : left > right ? 1 : 0
  })
  let excess = keys.length - MAX_BUCKETS
  for (const key of removable) {
    if (excess <= 0) break
    delete model.buckets[key]
    excess -= 1
  }
}

function pad(value, width) {
  let text = String(value)
  while (text.length < width) text = '0' + text
  return text
}

/** 毫秒 → UTC ISO;只做算术,不读时钟。 */
function isoFromMs(milliseconds) {
  const value = Math.trunc(milliseconds)
  const totalSeconds = Math.floor(value / 1000)
  const millis = value - totalSeconds * 1000
  let days = Math.floor(totalSeconds / 86400)
  let secondOfDay = totalSeconds - days * 86400
  if (secondOfDay < 0) {
    secondOfDay += 86400
    days -= 1
  }
  const hours = Math.floor(secondOfDay / 3600)
  const minutes = Math.floor((secondOfDay % 3600) / 60)
  const seconds = secondOfDay % 60
  const civil = civilFromDays(days)
  return pad(civil.year, 4) + '-' + pad(civil.month, 2) + '-' + pad(civil.day, 2)
    + 'T' + pad(hours, 2) + ':' + pad(minutes, 2) + ':' + pad(seconds, 2)
    + '.' + pad(millis, 3) + 'Z'
}

function civilFromDays(days) {
  const shifted = days + 719468
  const era = Math.floor(shifted / 146097)
  const dayOfEra = shifted - era * 146097
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524)
    - Math.floor(dayOfEra / 146096)) / 365)
  let year = yearOfEra + era * 400
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153)
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1
  const month = monthPrime < 10 ? monthPrime + 3 : monthPrime - 9
  if (month <= 2) year += 1
  return { year, month, day }
}

function createModel() {
  return { schema: 1, updatedAt: null, scale: 1, buckets: {}, starts: {}, recent: [], seen: [] }
}

function serializeModel(model) {
  return JSON.stringify(model)
}

function validateBucket(bucket) {
  if (!isRecord(bucket)) return '耗时桶不是对象'
  if (typeof bucket.u !== 'number' || !Number.isFinite(bucket.u)) return '耗时桶的学习时刻不是有限数'
  if (!Array.isArray(bucket.v)) return '耗时桶的样本不是数组'
  if (bucket.v.length > WINDOW) return '耗时桶样本超过 ' + WINDOW + ' 个'
  for (const value of bucket.v) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '耗时桶出现非有限数'
    if (value < 0) return '耗时桶出现负数耗时'
  }
  return null
}

function validateModel(value) {
  if (!isRecord(value)) return '模型不是对象'
  if (value.schema !== 1) return '模型 schema 不是 1'
  if (!(value.updatedAt === null || isTimeText(value.updatedAt))) return '模型更新时间不合法'
  if (typeof value.scale !== 'number' || !Number.isFinite(value.scale)) return '模型区间系数不是有限数'
  if (value.scale < 0.7 || value.scale > 4) return '模型区间系数超出 [0.7, 4]'
  if (!isRecord(value.buckets)) return '模型缺少桶表'
  const bucketKeys = Object.keys(value.buckets)
  if (bucketKeys.length > MAX_BUCKETS) return '模型桶数超过 ' + MAX_BUCKETS + ' 个'
  for (const key of bucketKeys) {
    const reason = validateBucket(value.buckets[key])
    if (reason !== null) return reason + ':' + key
  }
  if (!isRecord(value.starts)) return '模型缺少启动耗时表'
  for (const key of Object.keys(value.starts)) {
    const list = value.starts[key]
    if (!Array.isArray(list)) return '启动耗时不是数组:' + key
    if (list.length > STARTS_WINDOW) return '启动耗时超过 ' + STARTS_WINDOW + ' 个:' + key
    for (const item of list) {
      if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) return '启动耗时出现非法数值:' + key
    }
  }
  if (!Array.isArray(value.recent)) return '模型缺少准确度环'
  if (value.recent.length > RECENT_WINDOW) return '准确度环超过 ' + RECENT_WINDOW + ' 条'
  for (const item of value.recent) {
    if (!isRecord(item)) return '准确度记录不是对象'
    if (typeof item.t !== 'number' || !Number.isFinite(item.t)) return '准确度记录的时刻不是有限数'
    if (typeof item.ape !== 'number' || !Number.isFinite(item.ape) || item.ape < 0) return '准确度记录的误差率不合法'
    if (!(item.inside === 0 || item.inside === 1)) return '准确度记录的区间命中不是 0/1'
    if (!Number.isInteger(item.level) || item.level < 1 || item.level > 10) return '准确度记录的层号不合法'
  }
  if (!Array.isArray(value.seen)) return '模型缺少去重键表'
  if (value.seen.length > SEEN_WINDOW) return '去重键超过 ' + SEEN_WINDOW + ' 个'
  for (const item of value.seen) {
    if (typeof item !== 'string') return '去重键不是字符串'
  }
  return null
}

function parseModel(text) {
  try {
    if (typeof text !== 'string') return { ok: false, reason: '模型文本不是字符串' }
    const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    let value
    try {
      value = JSON.parse(clean)
    } catch {
      return { ok: false, reason: '模型文件不是合法 JSON' }
    }
    const reason = validateModel(value)
    if (reason !== null) return { ok: false, reason }
    return { ok: true, model: value }
  } catch {
    return { ok: false, reason: '模型文件解析失败' }
  }
}

function validArgs(value) {
  return value === null || (Array.isArray(value) && value.every(item => typeof item === 'string'))
}

function validateSample(sample) {
  if (!isRecord(sample)) return false
  if (!isNonEmptyString(sample.ticketId) || !isNonEmptyString(sample.attemptId)) return false
  if (!isNonEmptyString(sample.project)) return false
  if (!(sample.usageKey === null || isNonEmptyString(sample.usageKey))) return false
  if (!isNonEmptyString(sample.category) || !isNonEmptyString(sample.workType)) return false
  if (!validArgs(sample.args)) return false
  if (!(sample.machine === null || isNonEmptyString(sample.machine))) return false
  if (!Number.isInteger(sample.cores) || sample.cores < 0) return false
  if (!(sample.durationMs === null || (Number.isInteger(sample.durationMs) && sample.durationMs > 0))) return false
  if (!(sample.startMs === null
    || (Number.isInteger(sample.startMs) && sample.startMs >= 0 && sample.startMs <= MAX_START_MS))) return false
  if (!isTimeText(sample.endedAt)) return false
  if (typeof sample.ciAware !== 'boolean') return false
  return true
}

function learn(model, sample, nowMs) {
  if (!validateSample(sample)) return { learned: false, reason: 'invalid' }
  const dedupeKey = sample.ticketId + '|' + sample.attemptId
  if (model.seen.includes(dedupeKey)) return { learned: false, reason: 'duplicate' }
  const endedAtMs = Date.parse(sample.endedAt)
  const learnedAtMs = nowMs === undefined ? endedAtMs : nowMs

  if (sample.durationMs !== null && !sample.ciAware) {
    // 先估后学:这里读到的桶里还没有本条样本。
    const prediction = predictRun(model, {
      project: sample.project,
      usageKey: sample.usageKey,
      category: sample.category,
      workType: sample.workType,
      args: sample.args,
      machine: sample.machine,
      cores: sample.cores,
    })
    if (prediction !== null) {
      const inside = prediction.low <= sample.durationMs && sample.durationMs <= prediction.high
      const factor = Math.exp(0.05 * ((inside ? 0 : 1) - 0.2))
      model.scale = Math.min(4, Math.max(0.7, model.scale * factor))
      model.recent.push({
        t: endedAtMs,
        ape: Math.abs(prediction.p50 - sample.durationMs) / sample.durationMs,
        inside: inside ? 1 : 0,
        level: prediction.level,
      })
      if (model.recent.length > RECENT_WINDOW) model.recent.splice(0, model.recent.length - RECENT_WINDOW)
    }
  }

  if (sample.durationMs !== null && !sample.ciAware) {
    const suffixes = layerSuffixes(sample)
    const touched = []
    for (let index = 0; index < 10; index += 1) {
      const key = bucketKey(index + 1, suffixes[index])
      touched.push(key)
      let bucket = model.buckets[key]
      if (bucket === undefined) {
        bucket = { u: learnedAtMs, v: [] }
        model.buckets[key] = bucket
      }
      bucket.u = learnedAtMs
      bucket.v.push(sample.durationMs)
      if (bucket.v.length > WINDOW) bucket.v.splice(0, bucket.v.length - WINDOW)
    }
    evictBuckets(model, touched)
  }

  if (sample.startMs !== null && sample.machine !== null) {
    const starts = model.starts[sample.machine] === undefined ? [] : model.starts[sample.machine]
    starts.push(sample.startMs)
    if (starts.length > STARTS_WINDOW) starts.splice(0, starts.length - STARTS_WINDOW)
    model.starts[sample.machine] = starts
  }

  model.seen.push(dedupeKey)
  if (model.seen.length > SEEN_WINDOW) model.seen.splice(0, model.seen.length - SEEN_WINDOW)
  model.updatedAt = isoFromMs(Math.max(learnedAtMs, endedAtMs))
  return { learned: true }
}

function predictRun(model, query) {
  const found = findBucket(model, query)
  if (found === null) return null
  const values = found.bucket.v
  const p50 = weightedQuantile(values, 0.5)
  const p10 = weightedQuantile(values, 0.1)
  const p90 = weightedQuantile(values, 0.9)
  const scale = model.scale
  return {
    p50,
    low: Math.max(1, Math.round(p50 - (p50 - p10) * scale)),
    high: Math.round(p50 + (p90 - p50) * scale),
    n: values.length,
    level: found.level,
    basis: basisOf(values.length, found.level),
  }
}

function predictRemaining(model, query, elapsedMs) {
  const found = findBucket(model, query)
  if (found === null) return null
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  const values = found.bucket.v
  const longer = values.filter(value => value > elapsed)
  const n = values.length
  const basis = basisOf(n, found.level)
  if (longer.length >= 3) {
    const remaining = longer.map(value => value - elapsed)
    return {
      remainingMs: weightedQuantile(remaining, 0.5),
      lowMs: weightedQuantile(remaining, 0.1),
      highMs: weightedQuantile(remaining, 0.9),
      tail: false,
      level: found.level,
      n,
      basis,
    }
  }
  return {
    remainingMs: Math.max(30000, Math.round(0.5 * elapsed)),
    lowMs: Math.max(5000, Math.round(0.15 * elapsed)),
    highMs: Math.round(2 * elapsed),
    tail: true,
    level: found.level,
    n,
    basis,
  }
}

function predictStartMs(model, machine, fallbackMs) {
  const values = machine !== null && machine !== undefined ? model.starts[machine] : undefined
  if (!Array.isArray(values) || values.length < 5) return fallbackMs
  const sorted = values.slice().sort((left, right) => left - right)
  const rank = Math.min(sorted.length, Math.ceil(0.95 * sorted.length))
  const cap = sorted[rank - 1]
  let sum = 0
  for (const value of values) sum += Math.min(value, cap)
  return Math.round(sum / values.length)
}

function median(values) {
  if (values.length === 0) return null
  const sorted = values.slice().sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function accuracySummary(model) {
  const n = model.recent.length
  const apes = model.recent.map(item => item.ape)
  return {
    n,
    medianApe: n === 0 ? null : median(apes),
    within30: n === 0 ? null : apes.filter(value => value <= 0.3).length / n,
    within50: n === 0 ? null : apes.filter(value => value <= 0.5).length / n,
    intervalHit: n === 0 ? null : model.recent.filter(item => item.inside === 1).length / n,
    scale: model.scale,
    updatedAt: model.updatedAt,
  }
}

function ticketToSamples(ticket, options) {
  if (!isRecord(ticket) || !isRecord(ticket.request)) return []
  if (!isNonEmptyString(ticket.ticketId)) return []
  const request = ticket.request
  if (!isNonEmptyString(request.project) || !isNonEmptyString(request.category)) return []
  if (!isRecord(request.work) || !isNonEmptyString(request.work.type)) return []
  const usageKey = isNonEmptyString(request.usageKey) ? request.usageKey : null
  const args = isRecord(request.menu) && Array.isArray(request.menu.args)
    && request.menu.args.every(item => typeof item === 'string') ? request.menu.args.slice() : null
  const normalize = options !== null && typeof options === 'object' && typeof options.normalizeProject === 'function'
    ? options.normalizeProject : null
  const project = normalize === null ? request.project : normalize(request.project)
  if (!isNonEmptyString(project)) return []
  const attempts = Array.isArray(ticket.attempts) ? ticket.attempts : []
  const samples = []
  for (const attempt of attempts) {
    if (!isRecord(attempt) || !isNonEmptyString(attempt.attemptId)) continue
    if (!isTimeText(attempt.startedAt) || !isTimeText(attempt.endedAt)) continue
    const permit = isRecord(attempt.permit) ? attempt.permit : null
    const intent = isRecord(attempt.intent) ? attempt.intent : null
    const machine = permit !== null && isNonEmptyString(permit.machine) ? permit.machine
      : intent !== null && isNonEmptyString(intent.machine) ? intent.machine : null
    const ciAware = permit !== null && permit.ciAware === true
    const timing = isRecord(attempt.timing) ? attempt.timing : null
    let durationMs = null
    if (isRecord(attempt.result) && attempt.result.outcome === 'passed' && timing !== null
      && Number.isInteger(timing.runningMs) && timing.runningMs >= 0
      && Number.isInteger(timing.slowMs) && timing.slowMs >= 0
      && timing.runningMs + timing.slowMs > 0) {
      durationMs = timing.runningMs + timing.slowMs
    }
    let startMs = null
    if (permit !== null && isTimeText(permit.issuedAt)) {
      const issuedAtMs = Date.parse(permit.issuedAt)
      const startedAtMs = Date.parse(attempt.startedAt)
      if (startedAtMs >= issuedAtMs) {
        const diff = startedAtMs - issuedAtMs
        startMs = diff > MAX_START_MS ? null : diff
      }
    }
    if (durationMs === null && startMs === null) continue
    const cores = Number.isInteger(attempt.grantedCores) && attempt.grantedCores >= 0 ? attempt.grantedCores : 0
    samples.push({
      ticketId: ticket.ticketId,
      attemptId: attempt.attemptId,
      project,
      usageKey,
      category: request.category,
      workType: request.work.type,
      args,
      machine,
      cores,
      durationMs,
      startMs,
      endedAt: attempt.endedAt,
      ciAware,
    })
  }
  return samples
}

module.exports = {
  WINDOW,
  DECAY,
  MAX_BUCKETS,
  MIN_SAMPLES,
  LEVEL_BASIS,
  createModel,
  serializeModel,
  parseModel,
  learn,
  predictRun,
  predictRemaining,
  predictStartMs,
  accuracySummary,
  ticketToSamples,
}
