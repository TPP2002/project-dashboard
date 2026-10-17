import deployment from './client/deployment-config.cjs'
/**
 * CI-RUNNER-JIT-TAKEOVER-0924 第 0 步(只读影子)· 契约表:车道表、标签判定、前置作业表、路径函数。
 *
 * 「CI 作业进调度台排队、一次性工位跑完即撤」方案的第 0 步:先把「接管以后」要用的车道表、
 * 标签判定与路径口径钉成纯数据 + 纯函数,给影子记账与后续步骤共用。本模块是四个新文件里
 * 导入收得最紧的一个(只许 node 内置),第 3、4 步会让代理与派单员导入它,导入越少,
 * 进换代清单(SELF_SOURCES)的文件越少。
 *
 * 只读、无副作用;写盘只发生在影子目录(见 sched-ci-takeover-shadow.ts)。
 */
import { join } from 'node:path'

export const CI_TAKEOVER_REPO: string = deployment.getDeploymentConfig().ci.takeover?.repo ?? ''

export type CiTakeoverLane = 'fast' | 'main' | 'e2e'

export interface CiTakeoverLaneSpec {
  lane: CiTakeoverLane
  label: string
  workType: 'ci:jit:fast' | 'ci:jit:main' | 'ci:jit:e2e'
  category: 'unit-test' | 'e2e-test'
  jobClass: 'vitest' | 'shared'
}

/** 车道表(契约 §6.1 逐字):与 .github/workflows 的 runs-on 对齐,CT3 钉着。 */
export const CI_TAKEOVER_LANES: Readonly<Record<CiTakeoverLane, CiTakeoverLaneSpec>> = deployment.getDeploymentConfig().ci.takeover?.lanes ?? {}

export const CI_TAKEOVER_LANE_ORDER: readonly CiTakeoverLane[] = ['fast', 'main', 'e2e']

/** 系统标签:判定车道前先去掉,比较不分大小写。 */
export const CI_SYSTEM_LABELS: readonly string[] = ['self-hosted', 'windows', 'x64', 'linux', 'macos', 'arm64', 'arm']

/** 夜跑专用标签:带它的是夜跑 runner,不归接管管(计 unmanaged)。 */
export const CI_UNMANAGED_LABELS: readonly string[] = deployment.getDeploymentConfig().ci.takeover?.unmanagedLabels ?? []

export type LaneVerdict = CiTakeoverLane | 'unmanaged' | 'hosted' | 'unknown'

/**
 * 标签判定(契约 §7.1):
 * 1. 去掉系统标签(不分大小写),剩下记为 S(保留原大小写);
 * 2. S 恰为 ['managed-local']/['unmanaged-main']/['managed-e2e'] → fast/main/e2e(车道标签区分大小写);
 * 3. S 含 unmanaged-night → unmanaged;
 * 4. S 恰一个且以 ubuntu-/windows-/macos- 开头 → hosted(GitHub 托管);
 * 5. 其余(含 S 为空)→ unknown。
 */
export function laneOfLabels(labels: readonly string[]): LaneVerdict {
  const system = new Set(CI_SYSTEM_LABELS.map(label => label.toLowerCase()))
  const rest = labels.filter(label => !system.has(label.toLowerCase()))
  if (rest.length === 1) {
    for (const lane of CI_TAKEOVER_LANE_ORDER) if (CI_TAKEOVER_LANES[lane]?.label === rest[0]) return lane
    if (CI_UNMANAGED_LABELS.includes(rest[0]!)) return 'unmanaged'
    if (/^(ubuntu-|windows-|macos-)/.test(rest[0]!)) return 'hosted'
  }
  if (rest.some(label => CI_UNMANAGED_LABELS.includes(label))) return 'unmanaged'
  return 'unknown'
}

/** 前置作业表:job 名 → 必须先 completed 的同 run 前置;不在表里的作业名没有前置。 */
export const CI_JOB_PREREQUISITES: Readonly<Record<string, readonly string[]>> = deployment.getDeploymentConfig().ci.takeover?.prerequisites ?? {}

export function ciTakeoverDir(share: string): string { return join(share, 'sched', 'ci-takeover') }
export function ciTakeoverShadowDir(share: string): string { return join(ciTakeoverDir(share), 'shadow') }
/** 影子日志按 at 的 UTC 日期分卷(ISO 时刻前 10 位即 UTC 日期)。 */
export function shadowLogPath(share: string, at: string): string {
  return join(ciTakeoverShadowDir(share), `${at.slice(0, 10)}.jsonl`)
}
