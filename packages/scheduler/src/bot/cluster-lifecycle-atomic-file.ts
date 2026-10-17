import { randomUUID } from 'node:crypto'
import { linkSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 共享盘上生命周期文件的**原子发布**。
 *
 * 【为什么不能就地写(CLUSTER-CONTROL-ATOMIC-PUBLISH,2026-09-02)】
 * `writeFileSync(path, data, { flag: 'w' })` 会先把目标截断成 0 字节再往里灌内容。共享盘上那些
 * 文件(ACTIVE control、transition lease 的续租凭据)随时被别的机器读,于是读者有一整段窗口
 * 会读到空文件或半截 JSON。生产侧的表现:agent 起动时读坏 control 直接退出 —— 看门狗五分钟
 * 后能把它拉起来,所以不致命,但那五分钟是白丢的,而且报出来的错长得跟"文件损坏"一模一样。
 *
 * 【窗口有多大 —— 实测数据,不是估计】一写一读两个进程各跑 4 秒(载荷 ~4KB,接近真实 control):
 *   · 就地截断覆写:读 25805 次,**8204 次读到半截(31.8%)**,样本全是长度 0 的空文件;
 *   · 本模块的写法:读 73227 次,**0 次半截**,写者 0 次失败。
 * 这不是"把窗口变小",是消除:rename 在同目录内是原子替换,读者要么看见完整的旧版本,
 * 要么看见完整的新版本,没有中间态。
 *
 * 【Windows 上必须带重试,否则等于把问题换个人承担】目标文件正被别的句柄打开时,rename 覆盖
 * 报 EPERM(本机临时盘与共享盘 `<data directory>` 两处都实测复现)。不重试的话,"读者读坏"
 * 就变成了"写者写失败" —— 上面那 0 次写失败正是退避重试的效果。
 * 重试预算见 RENAME_RETRY_DELAYS_MS(分两段,共约 6 秒)。
 *
 * 【create-only 为什么用硬链接】有些发布点的语义是"这个文件必须还不存在"(原来的 `flag:'wx'`)。
 * rename 会覆盖,语义就变了;硬链接在目标已存在时报 EEXIST,恰好逐字保住原语义,而目标一旦出现
 * 就是完整内容(内容早在临时文件里写完了)。硬链接在本机与共享盘均实测可用。
 *
 * 【临时文件为什么落在父目录】lease 的目录内容被 `snapshotDirectory` 逐字节校验,文件数漂移
 * 即拒绝。临时文件若落在目标同目录,一旦 link 成功而清理失败,就会给那个目录永久留下一个多余
 * 文件,让后续所有原子搬迁失败。放父目录则目标目录自始至终只多出最终那一个文件。
 * (replace 模式不存在这个问题:rename 本身就把临时文件搬走了,不留痕。)
 */

/** 目标已存在时:`replace` 覆盖,`create-only` 拒绝(逐字保留原 `flag:'wx'` 的语义)。 */
export type LifecyclePublishMode = 'replace' | 'create-only'

/**
 * rename 撞上「目标正被别人打开」(Windows 下 EPERM/EACCES)时的固定退避序列:共 75 次重试,请求睡眠合计 5100ms。
 * 前 50 次各 2ms —— 外来占用多数只有几毫秒,这一段与旧预算逐字相同。注意 Windows 上 Atomics.wait(…, 2)
 * 实际睡约 15.5ms(系统计时粒度),所以旧预算的真实值约 0.78 秒,不是旧注释写的 100ms。
 * 后 25 次各 200ms —— CI 副机负载高时,杀软/索引器一次占用能超过 0.78 秒(2026-09-15 一次、2026-09-20 三次
 * MainGate 假红,报错都是这一处 EPERM),这一段把总预算拉到约 6 秒。仍远小于各调用方的计时线
 * (owner lease 90 秒、心跳过期 3 分钟、调度台续租间隔 15 秒),同步睡眠不会拖垮任何一方。
 * 不加随机抖动;预算用尽照旧 fail-closed 抛错。
 */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [
  ...Array.from({ length: 50 }, () => 2),
  ...Array.from({ length: 25 }, () => 200),
]

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  return typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined
}

/** 同步小睡。这里刻意用同步:发布过程本身是同步 API,不能中途把控制权交出去。 */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function discard(path: string): void {
  try { unlinkSync(path) } catch { /* 清理失败不掩盖真正的错误 */ }
}

/**
 * 把 `contents` 原子地发布到 `targetPath`。
 *
 * 绝不创建目录:父目录不存在就抛错(fail-closed) —— 生命周期的目录结构由各自的事务负责建立,
 * 这里默默 mkdir 会把"路径算错了"这类 bug 藏起来。
 */
export function publishLifecycleFileAtomically(
  targetPath: string,
  contents: string | Uint8Array,
  mode: LifecyclePublishMode,
  /**
   * 临时文件的落点。缺省见下方注释;**目标所在目录或其父目录被 fail-closed 扫描器盯着时必须显式指定**
   * ——否则等于把"读到半截 JSON"换成"扫描器撞见临时文件"(CLUSTER-LIFECYCLE-BARE-JSON-WRITES)。
   * 典型:五态工单落在 `machines/<machine>/<state>/`,那一层被 `strictStateFiles` 盯着(非 .json 即抛),
   * 而它的父目录 `machines/<machine>` 又被 `assertKnownStateDirectories` 盯着(非目录即抛)
   * ——两个缺省落点都不能用,必须给 `_staging`。
   *
   * ⚠ 必须与目标**同卷**:create-only 走 `linkSync`,跨卷会 EXDEV。
   */
  stagingDirectoryOverride?: string,
  /** 退避睡眠。缺省真睡(同步);测试注入假实现,免得真等。 */
  sleep: (milliseconds: number) => void = sleepSync,
): void {
  const targetDirectory = dirname(targetPath)
  // replace 的临时文件放同目录(rename 会把它搬走,不留痕);create-only 放父目录,理由见文件头注。
  const stagingDirectory = stagingDirectoryOverride
    ?? (mode === 'replace' ? targetDirectory : dirname(targetDirectory))
  const staging = join(stagingDirectory, `.lifecycle-publish-${randomUUID()}.tmp`)

  try {
    writeFileSync(staging, contents, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    throw new Error(
      `[cluster-lifecycle] 原子发布失败(临时文件写不下):${targetPath}:${errorMessage(error)}`,
      { cause: error },
    )
  }

  let retries = 0
  let sleptMs = 0
  try {
    if (mode === 'create-only') {
      // 目标已存在 ⇒ EEXIST,与原来的 flag:'wx' 逐字同义。
      linkSync(staging, targetPath)
      return
    }
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(staging, targetPath)
        return
      } catch (error) {
        const code = errorCode(error)
        // Windows:目标正被别的句柄打开 ⇒ EPERM/EACCES。这是瞬时的,按固定序列退避重试,序列用尽才抛。
        if ((code !== 'EPERM' && code !== 'EACCES') || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
        const delayMs = RENAME_RETRY_DELAYS_MS[attempt]!
        sleep(delayMs)
        retries++
        sleptMs += delayMs
      }
    }
  } catch (error) {
    // 重试过就把次数与请求睡眠总和写进报错,CI 日志里一眼分清「根本没重试」与「重试满了仍被占」。
    // 放在最前面而不是句末:Windows 的 rename 报错自带两条很长的路径,句末的内容会被日志工具当长行省略。
    const tried = retries > 0 ? `(改名撞占用,已退避重试 ${retries} 次、请求睡眠合计 ${sleptMs}ms)` : ''
    throw new Error(
      `[cluster-lifecycle] 原子发布失败${tried}:${targetPath}:${errorMessage(error)}`,
      { cause: error },
    )
  } finally {
    // rename 成功时临时文件已经不在了(unlink 会 ENOENT,被 discard 吞掉);
    // link 成功或任何一步失败时,这里负责不留残骸。
    discard(staging)
  }
}
