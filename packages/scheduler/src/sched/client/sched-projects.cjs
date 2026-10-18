'use strict'
const deployment = require('./deployment-config.cjs').getDeploymentConfig()
const HOST_MACHINE = deployment.hostMachine
const SPARE_MACHINE = deployment.spareMachine
const PROJECTS = deployment.projects

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

deepFreeze(PROJECTS)
const PROJECT_IDS = Object.freeze(PROJECTS.map((entry) => entry.id))
const BY_NAME = new Map()
for (const entry of PROJECTS) {
  BY_NAME.set(entry.id, entry)
  for (const alias of entry.aliases) BY_NAME.set(alias, entry)
}

/** 看板 id 与别名规范化(C1):认得的返回看板 id;不认得的原样返回并标未登记。大小写敏感,与票据里的写法一致。 */
function normalizeProjectId(id) {
  if (typeof id !== 'string') return { id: '', registered: false }
  const entry = BY_NAME.get(id)
  return entry ? { id: entry.id, registered: true } : { id, registered: false }
}

/** 按 id 或别名取项目;不认得返回 null。 */
function getProject(id) {
  return typeof id === 'string' ? BY_NAME.get(id) ?? null : null
}

/** 取某项目的某个菜单项(项目可写别名);没有返回 null。 */
function getMenuItem(projectId, itemId) {
  const entry = getProject(projectId)
  return entry?.menu.find((candidate) => candidate.id === itemId) ?? null
}

module.exports = { HOST_MACHINE, SPARE_MACHINE, PROJECTS, PROJECT_IDS, normalizeProjectId, getProject, getMenuItem }
