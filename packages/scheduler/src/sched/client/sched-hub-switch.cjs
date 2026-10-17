'use strict'

/**
 * HUB0 总开关解析(卡 SCHED-HUB0-PROJECT-MENU-0924;设计正本 §七)。
 *
 * 开关文件 `<share>/sched/_control/hub.json` 由派单员与客户端每拍读;读文件归调用方(HUB2、HUB3),
 * 这里只把读到的字节解析成开关值。读不到、解析失败、schema 不认识、字段类型不对,一律按全关处理(HUB0-6)。
 * 形状:{ "schema": 1, "portable": "off", "projects": [], "workTypes": [], "managedLoad": false, "ciBorrow": false, "infraOffload": false, "memoryFloor": false, "coresHistoryCorrect": false }
 * - portable 只收 "on"/"off";projects 里的项目名按注册表别名规范化(未登记的保留并记警告);
 * - workTypes 是菜单项 id(如 test、lint:content),不分项目:可搬名单 = projects × workTypes(§七 S3~S6);
 * - 缺的字段取全关时的值;不认识的字段记警告、不影响解析。
 * 纯函数、永不抛错:不读写共享盘、不起子进程、不接进任何运行路径。
 */

const { isUtf8 } = require('node:buffer')
const { normalizeProjectId } = require('./sched-projects.cjs')

const HUB_SWITCH_SCHEMA = 1
const ALL_OFF = Object.freeze({
  schema: HUB_SWITCH_SCHEMA, portable: 'off', projects: Object.freeze([]), workTypes: Object.freeze([]),
  managedLoad: false, ciBorrow: false, infraOffload: false, memoryFloor: false, coresHistoryCorrect: false,
})
const KNOWN_FIELDS = new Set(Object.keys(ALL_OFF))
const PROJECT_NAME = /^[A-Za-z0-9._-]{1,64}$/
const WORK_TYPE = /^[A-Za-z0-9:._-]{1,64}$/
// coresHistoryCorrect(SCHED-CORES-HISTORY-AUTOCORRECT-1010):挂号端按同类活历史实测自动改小申请核数。
const FLAGS = ['managedLoad', 'ciBorrow', 'infraOffload', 'memoryFloor', 'coresHistoryCorrect']
/** 记事本存 UTF-8 时会在文件头写 BOM;源码里不放这个不可见字符。 */
const BOM = String.fromCharCode(0xfeff)

function allOff(reason, detail) {
  return Object.freeze({ ok: false, reason, detail, warnings: Object.freeze([]), value: ALL_OFF })
}

function decode(input) {
  if (typeof input === 'string') return { text: input }
  if (input instanceof Uint8Array) {
    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
    if (!isUtf8(bytes)) return { error: '不是合法的 UTF-8' }
    return { text: bytes.toString('utf8') }
  }
  return { error: `输入要是文本或字节,收到 ${typeof input}` }
}

/** 名单字段:必须是字符串数组、每项过 pattern;去重保序。不通过返回 null。 */
function readList(value, pattern) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !pattern.test(entry))) return null
  return [...new Set(value)]
}

/** 解析开关文件内容。text 为 null/undefined 表示读不到。 */
function parseHubSwitch(text) {
  if (text === null || text === undefined) return allOff('missing', '开关文件读不到,按全关')
  const decoded = decode(text)
  if (decoded.error) return allOff(typeof text === 'string' || text instanceof Uint8Array ? 'bad-json' : 'invalid-input', decoded.error)
  let raw
  try {
    raw = JSON.parse(decoded.text.startsWith(BOM) ? decoded.text.slice(BOM.length) : decoded.text)
  } catch (error) {
    return allOff('bad-json', `JSON 解析失败:${error.message}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return allOff('not-object', '开关文件要是一个 JSON 对象')
  if (raw.schema !== HUB_SWITCH_SCHEMA) return allOff('unknown-schema', `schema 只认 ${HUB_SWITCH_SCHEMA},收到 ${JSON.stringify(raw.schema)}`)
  const warnings = []
  const portable = raw.portable === undefined ? 'off' : raw.portable
  if (portable !== 'on' && portable !== 'off') return allOff('bad-field', `portable 只收 "on" 或 "off",收到 ${JSON.stringify(raw.portable)}`)
  const rawProjects = raw.projects === undefined ? [] : readList(raw.projects, PROJECT_NAME)
  if (rawProjects === null) return allOff('bad-field', 'projects 要是项目名数组(字母、数字、. _ -,1~64 字)')
  const workTypes = raw.workTypes === undefined ? [] : readList(raw.workTypes, WORK_TYPE)
  if (workTypes === null) return allOff('bad-field', 'workTypes 要是菜单项名数组(字母、数字、: . _ -,1~64 字)')
  const flags = {}
  for (const flag of FLAGS) {
    const value = raw[flag] === undefined ? false : raw[flag]
    if (typeof value !== 'boolean') return allOff('bad-field', `${flag} 要是 true 或 false,收到 ${JSON.stringify(raw[flag])}`)
    flags[flag] = value
  }
  const projects = []
  for (const name of rawProjects) {
    const normalized = normalizeProjectId(name)
    if (!normalized.registered) warnings.push(`projects 里的 ${name} 没在注册表登记`)
    else if (normalized.id !== name) warnings.push(`projects 里的 ${name} 按别名记为 ${normalized.id}`)
    if (!projects.includes(normalized.id)) projects.push(normalized.id)
  }
  for (const key of Object.keys(raw)) if (!KNOWN_FIELDS.has(key)) warnings.push(`不认识的字段 ${key},已忽略`)
  const value = Object.freeze({
    schema: HUB_SWITCH_SCHEMA, portable, projects: Object.freeze(projects), workTypes: Object.freeze(workTypes), ...flags,
  })
  return Object.freeze({ ok: true, warnings: Object.freeze(warnings), value })
}

/** 这个项目的这个菜单项在开关下能不能搬(只看开关名单;菜单属性由 sched-menu.cjs 判)。项目可写别名。 */
function portableAllowed(value, project, item) {
  if (!value || value.portable !== 'on' || !Array.isArray(value.projects) || !Array.isArray(value.workTypes)) return false
  const normalized = normalizeProjectId(project)
  return normalized.registered && value.projects.includes(normalized.id) && typeof item === 'string' && value.workTypes.includes(item)
}

module.exports = { HUB_SWITCH_SCHEMA, ALL_OFF, parseHubSwitch, portableAllowed }
