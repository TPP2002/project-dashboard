import type { ClusterJob } from './cluster-job'
import type { LifecyclePaths, LifecycleSources, LifecycleStateRecord } from './cluster-lifecycle'

/** Agent 只额外携带自更新重试计数；工单判据仍由 cluster-job 独占。 */
export type AgentJob = ClusterJob & { jobId: string; selfUpgradeTried?: number }

export type AgentDirs = LifecyclePaths & { incoming: string; logs: string }

export interface AgentLifecycleCoordinate {
  share: string
  epoch: string
  machine: string
  submissionId: string
}

export interface AgentOwnerClaimOptions {
  share: string
  epoch: string
  machine: string
  pid: number
  host: string
  head: string
  leaseDurationMs?: number
  sources?: LifecycleSources
}

export interface AgentRuntimeOptions {
  share: string
  machine: string
  intervalSec: number
  protocol: number
}

export interface PickedAgentJob {
  job: AgentJob
  file: string
  /** 领单时刚写下的那份在跑记录;作业期间它若凭空消失,归档时靠它补记终态(CLUSTER-RUNNING-RECORD-VANISHED-0911)。 */
  running?: LifecycleStateRecord
  /** 【卡2 P6】本进程内的领单顺序号(nextAgentJob 盖章);回退单插回 held 队列时按它恢复先来后到。 */
  pickedSeq?: number
}

export type UpgradeVerdictKind =
  'newer' | 'older' | 'ghost-forced' | 'same-protocol-changed' | 'same' | 'unknown-protocol'
export interface UpgradeVerdict { upgrade: boolean; kind: UpgradeVerdictKind; reason?: string }

/**
 * 共享盘上「主干(`origin/main`)当前的 `AGENT_PROTOCOL` 是多少」的锚点文件名。
 *
 * 【为什么这个数由派活方写、执行机只读(CLUSTER-AGENT-GHOST-PROTOCOL-FORCE-RELAUNCH,0905 拍板 D)】
 * 判「运行中这个号是不是幽灵」需要知道主干的号,而**执行机答不可靠**:副机的仓库是从共享盘
 * 代码包整体重建的,有没有可信的 `refs/remotes/origin/main` 从来没人验证过(全仓查过:
 * 「主干」这个概念此前只在派活侧出现,执行侧一次都没用过),而副机恰恰是唯一出过幽灵号的机器。
 * 派活方那边则是现成的——`assertNotProtocolPinning` 每次派活前本来就读了主干的协议号。
 * 故:派活方算好写在共享盘,执行机只做整数比较,离线/浅克隆/仓库半残都影响不到判据。
 *
 * 【为什么不塞进工单字段】工单加字段必须同时进 payload 白名单,漏一处就让**每张工单**
 * 被自家校验当场隔离(CLUSTER-ACTIVATION-JOB-QUARANTINE 踩过)。共享盘小锚点有
 * `code-head.txt` / `bundle-head.txt` 的成例,与工单校验面完全解耦。
 */
export const TRUNK_PROTOCOL_ANCHOR = 'trunk-protocol.txt'

/**
 * 解析主干协议号锚点:**只认第一行的纯十进制整数**,其余一律 `undefined`。
 *
 * 严格到这个程度是因为它的下游是「破例允许降级」——判据读错的代价是**按错的数换代码**,
 * 比「没自救」严重。故半截文件、注释行、`v13`、`13.5`、负数一律当没读到,
 * 退回「只向前不自降」的现状(fail-closed)。第二行起允许写人话注释,与 `code-head.txt` 同形。
 */
export function parseTrunkProtocol(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim()
  if (firstLine === undefined || !/^\d+$/.test(firstLine)) return undefined
  return Number(firstLine)
}

/**
 * 升级边:**只向前不自降** —— 磁盘协议号高于运行中即升级(需完整 SELF_SOURCES 指纹同时变化);
 * 低于则拒绝降级;同号内容变了仍要求显式 bump;读不出号一律拒绝。
 *
 * 【2026-08-30 负责人拍板改判(看板 CLUSTER-TEST-BUDGET-EVIDENCE-FALSE-RED d1,选项 A)】
 * 本函数原先写死成 `running === 12 && onDisk === 13`,其余升序一律拒绝。那个收窄出自
 * `docs/plans/CLUSTER-LIFECYCLE-ATOMIC-CUTOVER-PROOF-设计与施工记录.md` §18
 * (原话「生产规则正确,不得回退」),意图是防止「把别的分支误当升级加载」——**立场保留在此留痕**。
 * 改判理由是那份记录**没有预见的两个后果**,拍板时逐条列明:
 *
 *   ① **副机永久滞留**:执行机 <executor> 曾被派活刷到一个从未合入 main 的分支
 *      (`2a578a92`,该分支把协议抬到 8),按「只升不降」停在 protocol 8。主干是 13,
 *      `8→13` 不在唯一允许的跳变里 ⇒ **它靠自己永远爬不回来**,对所有 main 版本的 test 工单
 *      恒判假红(共享盘上留有 5 张 exitCode=0 / ok=false 的工单实物)。
 *   ② **漏改即静默停更**:下次把 `AGENT_PROTOCOL` 提到 14 时,`12→13` 这两个魔数不跟着改的话,
 *      跑 13 的机器同样落进拒绝分支 ⇒ **全集群悄悄停止自更新,且不报错**。
 *
 * ⚠️ **为什么是单调比较,而不是「只准跳一步(running + 1)」**:后者仍然治不好 ①
 * ——副机是 8、主干是 13,差 5 版,跳一步照样爬不回来,而「副机永久滞留」正是拍板列出的
 * 头号理由。故按 d1 选项 A 的正文「磁盘版本号比运行中的大就升级」落地。
 *
 * 防降级的初衷(分支派活会把磁盘代码换成旧版)由 `older` 分支原样守住,与改判前逐字相同。
 * 「bump 协议号时升级通路必须仍然通」已做成机器闸,见 `tests/unit/bot/clusterOwnerRelaunch.test.ts`。
 *
 * 【2026-09-05 负责人拍板 D:幽灵号的强制换代例外(CLUSTER-AGENT-GHOST-PROTOCOL-FORCE-RELAUNCH)】
 * 「只向前不自降」对**幽灵号**无解:协议号提到 14 又被 revert 回 13,而某台机器正好在那个窗口
 * 把 14 装进内存 ⇒ 全仓再没有任何一份代码写着 14 ⇒ 磁盘上任何版本在它眼里都「更旧」⇒
 * 它被自己的防降级规矩**永久**锁死在一份作废代码上,且**不报错**:照常报心跳、照常接活。
 * 2026-09-02 副机 <executor> 实例(内存 14 / 磁盘 13),最后靠人到机器前手动重启——
 * 而那台机器无人值守、实测没有远程管理通道,唯一通道就是共享目录。
 *
 * 例外只开**一格**:`trunkProtocol`(主干号,由派活方经共享盘带来,见 {@link TRUNK_PROTOCOL_ANCHOR})
 * 存在,且 `running > trunkProtocol`(运行中的号主干上根本没有 = 幽灵),
 * 且 `onDisk === trunkProtocol`(磁盘上这份**正是主干那一份**,不是别人分支的旧码)。
 * 三条缺一即退回 `older` 拒绝——**反方立场(0831 的崩溃循环正是防降级兜住的)一个字没松**。
 */
export function upgradeVerdict(input: {
  running: number
  onDisk: number | undefined
  fingerprintChanged: boolean
  /** 主干(`origin/main`)的协议号;读不到就不给,给不出时一律退回「只向前不自降」。 */
  trunkProtocol?: number
}): UpgradeVerdict {
  const { running, onDisk, fingerprintChanged, trunkProtocol } = input
  // 读不出磁盘协议号(旧版没有这个字面量/文件读失败)⇒ 无从判断新旧,不赌。
  if (onDisk === undefined) {
    return { upgrade: false, kind: 'unknown-protocol', reason: '读不出磁盘协议号，拒绝未知升级' }
  }
  if (onDisk < running) {
    // 幽灵号例外(见头注 0905 拍板 D):运行中的号主干上没有,而磁盘这份正是主干那一份 ⇒ 强制换代。
    // 指纹没变时不换 —— 与下面 `newer` 分支同源:重启换不来新逻辑,只会白丢一次工单。
    if (trunkProtocol !== undefined && running > trunkProtocol && onDisk === trunkProtocol && fingerprintChanged) {
      return { upgrade: true, kind: 'ghost-forced',
        reason: `运行中协议 ${running} 高于主干 ${trunkProtocol}（主干上查无此版本＝幽灵号），`
          + `而磁盘 ${onDisk} 正是主干那一份 ⇒ 破例强制换代，否则本机永远爬不回来` }
    }
    return { upgrade: false, kind: 'older', reason: `磁盘协议 ${onDisk} 旧于运行中 ${running}，拒绝降级` }
  }
  if (onDisk > running) {
    // 协议号更高却算不出指纹变化 = 读协议与算指纹的输入自相矛盾(协议字面量本就在 SELF_SOURCES 里)。
    // 不赌这种矛盾态,按「代码实际没变」处理:重启换不来新逻辑,只会白白丢一次工单。
    return fingerprintChanged
      ? { upgrade: true, kind: 'newer' }
      : { upgrade: false, kind: 'same',
          reason: `磁盘协议 ${onDisk} 高于运行中 ${running}，但代理源码指纹未变，不重启` }
  }
  return fingerprintChanged
    ? { upgrade: false, kind: 'same-protocol-changed', reason: '同协议代码变化必须显式 bump 协议' }
    : { upgrade: false, kind: 'same' }
}
