/** 唯一写者启动时发布客户端与新增通道；不记业务台账，不初始化一份陌生共享盘。 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import client from './client/sched.cjs'
import { publishLifecycleFileAtomically } from '../bot/cluster-lifecycle-atomic-file'
import { hasCode } from '../bot/cluster-lifecycle-contract'
import { assertWritableFormat, canonicalJson, schedPaths } from './sched-contract'
import { assertSchedulerWritable } from './sched-ledger'

export function publishSchedulerClient(share: string): boolean {
  assertSchedulerWritable(share)
  const paths = schedPaths(share)
  // 静态导入保住换代闭包，磁盘字节则保住发布件与源文件逐字一致。
  if (client.SCHED_FORMAT_VERSION !== 1) throw new Error('[sched] 客户端发布格式不匹配')
  const format = assertWritableFormat(JSON.parse(readFileSync(paths.format, 'utf8')))
  for (const directory of [paths.reports, paths.reportReceipts, paths.bin]) mkdirSync(directory, { recursive: true })
  let changed = false
  // 依赖先落盘，最后发布入口文件；每份字节独立比较，避免无意义的 mtime 变化。
  for (const name of ['deployment-config.cjs', 'sched-projects.cjs', 'sched-menu.cjs', 'sched-hub-switch.cjs', 'sched-snapshot.cjs', 'sched.cjs']) {
    const bytes = readFileSync(fileURLToPath(new URL(`./client/${name}`, import.meta.url)))
    const target = join(paths.bin, name)
    let previous: Buffer | undefined
    try { previous = readFileSync(target) } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
    if (!previous?.equals(bytes)) { publishLifecycleFileAtomically(target, bytes, 'replace', paths.staging); changed = true }
  }
  const capabilities = [...new Set([...format.capabilities, 'attempt-reports-v1', 'cluster-handoff', 'cluster-work-workers', 'cluster-granted-cores', 'attempt-suspension-v1'])]
  if (capabilities.length !== format.capabilities.length) {
    publishLifecycleFileAtomically(paths.format, canonicalJson({ ...format, capabilities }), 'replace', paths.staging)
  }
  return changed
}
