import deployment from './client/deployment-config.cjs'
/**
 * 统一调度盘上契约 v1（设计正本 §4、§5.3、§6、§9；含 T2 回报与本机执行扩展）。
 *
 * 全部路径相对 <share>/sched/；UTF-8，无 BOM。JSON 递归按键的 JS 字符序排序，数组保序，
 * T3 能力 cluster-handoff：SubmissionRequest.execution?='local'|'cluster'，缺省 local。
 *   work.type 接受菜单中的冒号（如 test:fast），不是磁盘路径段。只有 cluster 单由派单员交接。
 *   work.workers? 是显式执行并发正整数，能力 cluster-work-workers；requestedCores 是申请核数。
 *   通用提交校验不比较两者大小；集群 CLI 显式 workers 即申请该核数，无显式时测试类沿用
 *   defaultRequestedCores，其余 quotaInject 作业申请 min(quota,4)，单进程作业申请 1。
 *   能力 cluster-granted-cores：工单 payload.grantedCores 为当前 permit.grantedCores（正整数），
 *   与 ticketId 一起登记在 protocol 12 白名单并绑定摘要。work.workers 原样透传且始终优先；
 *   无显式 workers 时，仅 quotaInject===true 的工具按授予核数注入，旧工单无授予时沿用机器配额。
 *   quotaInject 不为 true 的工具保持自身配置并发；e2e 申请 4 核仍保持配置中的单 worker。
 *   granted 后 dispatch-intent 先追加/fsync，再把 data.intent 的规范 JSON 原字节 create-only 写到
 *   intents/<ticketId>--<attemptId>.json；随后 publishLifecycleJob，最后 dispatched。
 *   发布身份 jobId/submissionId 均为 submissionId(ticketId,attemptId)，payload 只含作业白名单。
 *   每拍核对有意图的存活执行（包括已经 dispatched）：无 claim/五态用原号发布；只有 claim 才以
 *   handoff-interrupted、terminal:false 结束交接并重排新执行；五态按实物补 dispatched/started/finished。
 *   failed(reason='执行机重启') 是已确认旧树退出后的恢复结果，结束旧执行再重排到队首。
 *   finished.data 可带 exitCode（安全整数）及 logFile（共享盘相对路径），进入 attempts[].result。
 *   cluster granted 且已有意图接受 cancel-requested；快照先写撤销标记，再将 inbox 迁 quarantine。
 *   执行机在开跑前读 tickets 快照，读失败照常跑；发现标记则归档 failed，派单员记 cancelled。
 *   台账仍只由派单员写；原子发布/迁移仍只有现行生命周期原语。
 *   调度工单领单时在 running.metadata.executionProcess={pid,createdAt} 记录执行树根的 OS 出生身份；
 *   启动先接续中断的 inbox→running 租约；按 0912 Windows 作业对象同组退出事实，根 PID 不存在
 *   即确认旧树终止。根仍存在（含 PID 复用）或探测失败只保留该张 running，下一拍再查，绝不挡接单。
 *   日志记明判据②/③/④及接管的原租约；完整树身份证据和脱钩后代归 T4。
 *   Windows createdAt 保留 OS 原精度，Linux 为启动标识+出生 tick。
 * 无缩进/空格；不收 undefined、非有限数、非 JSON 值。哈希为该规范 JSON 的 UTF-8 sha256。
 * 客户端先读 _control/format.json，版本高于自己就拒写；不可读也拒写，不能当成空队列。
 * _control/format.json = {formatVersion:1,capabilities:string[],createdAt:ISO}：初始化者 create-only，
 *   所有读写方读取；后续升级由 T1b 的唯一写者替换。_control/ 的归属令牌由 T1b 管。
 * _control/dispatcher.json = {machine,createdAt,createdBy}：运维 init create-only，指定派单主机。
 * _control/owner/sched-dispatcher.json：复用 cluster-owner 租约；name/machine 固定
 *   sched-dispatcher，epoch 固定 sched，host 为真实主机，不随集群冷切换改变锁身份。
 * _control/dispatcher-heartbeat.json = {machine,pid,protocol,head,at,tick,cursorSeq,queued,granted,machines,queue,locks}：
 *   派单员在受保护提交内每拍 replace；queued 含 unsatisfiable，granted 只数已授予待开跑。
 *   T7 按 at 超过 60 秒显示失联横幅；tick 是本次进程的成功节拍数，重启从零计数。
 *   machines 是本拍授予后的机器决策快照，含配额/已授予/外部负载/可派核数、超额、CI、新鲜度与在线状态；
 *   每项 {name,preference,quotaCores,grantedCores,externalLoadCores,availableCores,overCommitted,
 *   fresh,online,ci,ownerHold,reservation,heartbeatAt,loadSampledAt,ciRunners,ciReserveCores}。
 *   仅派单主机带 reservation={requestedCores,fulfilledCores,untilAt}，其他机器为 null；无期限为 null。
 *   heartbeatAt/loadSampledAt 取本拍集群读数，缺失为 null。机器按名字排序，不由看板重算准入。
 *   ciRunners/ciReserveCores（UDQ-T4B-CI-LANE-HEADROOM）：前者是心跳里正在跑的 runner 名，认不出或
 *   非 active 为 null；后者是据此按车道余量表给本机 CI 留的核数。两项都是展示字段，可选不升版——
 *   旧心跳（不带这两项）仍合法，读方按「认不出」保守处理。
 *   actualUsageCreditCores（SCHED-ACTUAL-USAGE-ADMISSION-1010）：实测退回开关开且本拍确有退回时
 *   才写的展示字段（退回核数,availableCores 已含它）；开关关/无退回不写键，读方按未知字段忽略。
 *   queue 只含仍参与准入的 queued/unsatisfiable 单，按 band→queuedAt→ticketId 排序，position 从 1 起；
 *   每项 {ticketId,position,band,requestedCores,allowedMachines,queuedAt,state,reason}，普通排队 reason 为 null。
 *   locks[] = {machine,byTicketId}，原样取本拍准入结果，按机器名排序。
 * _staging/：所有原子写的同卷暂存区；先写完整文件，再 link(create-only)/rename(replace)。
 * submit/<idempotencyKey>.json = SubmissionRequest：客户端 create-only，派单员读取。
 *   engine? 表示这张单由哪个平台施工，与 submitter（谁提交的）无关；只收 1–24 位小写字母、
 *   数字或连字符，不限定平台枚举。旧请求缺省时不补字段、不改变序列化字节；子单继承父单记录。
 *   idempotencyKey 为 SAFE_SEGMENT，不能是 . 或 ..；项目+键按 [project,idempotencyKey]
 *   规范 JSON 哈希，前 20 个十六进制字符加 tk- 即 ticketId。无需回读即可知道单号。
 *   同键同内容哈希为重传成功；不同内容冲突。createdAt 也是内容，重传必须保留原请求。
 *   键占用是全共享盘的（文件名没有项目）；归档后派单员仍按台账内哈希拒绝不同内容。
 * submit/_receipts/<key>.json = SubmissionReceipt：派单员 replace，客户端读取；accepted 带
 *   ticketId/contentHash/at，rejected 带 contentHash/reason/at；必须核对自己请求的哈希。
 * submit/_ingested/<UTC 日期>/<key>--<contentHash>.json：派单员最后归档，保留原请求字节；
 *   相同归档只补清理入口，不覆盖异文。非法 UTF-8 或无法解析的 JSON 按原文件字节计算拒收哈希。
 * tickets/<ticketId>.json = TicketSnapshot：派单员 replace，客户端/看板读取；不是事实源，
 *   可由 ledger 完整重建。包含 request、contentHash、state、registerOnly、pauseReasons、
 *   currentAttemptId、attempts、timing、createdAt/updatedAt/endedAt、lastSeq、cancelRequested。
 *   attempts 按执行序号排列，含分段时间、许可、意图、结果；timeline 保留该单所有原始事件。
 *   running + registerOnly:true 表示“施工中”，a1 在挂号时开始，grantedCores=0，不排队；
 *   终局由 finish 指令迁到 passed/failed（UDQ-T6C-REGISTER-ONLY-FINISH）。
 *   请求时刻超前 submitted.at 不超过五分钟（含边界）时照常接收，超过才拒收并说明偏差。
 *   createdAt/首次 queuedAt 取 request.createdAt 与 submitted.at 较早者，传输等待也算排队；
 *   request 中原始时刻保持不变。accountedAt 从该较早时刻起算，防止跨机偏差造成负时长。
 *   pendingQueue={from,timing,segments}|null 保存 finished 非终态到 requeued 之间的等待，
 *   下一执行建立时整段转入它的排队时间。四段字段为 queuedMs/runningMs/pausedMs/slowMs。
 * intents/<ticketId>--<attemptId>.json = DispatchIntent：派单员 create-only，恢复事务读取；
 *   {ticketId,attemptId,submissionId,machine,codeRef,createdAt}，先有同内容 dispatch-intent 台账。
 * beats/<ticketId>--<attemptId>.json = AttemptBeat：树外包装进程/代理 replace，派单员读取；
 *   {ticketId,attemptId,machine,at}，可带 childPid(被包装命令的顶层子进程号；只在已 spawn 且拿得到
 *   pid 时写，拿不到整个字段不写，不许写 null/0/-1)。许可 Permit 放在单子 attempts[].permit 中，不另建文件：
 *   {ticketId,attemptId,token,machine,category,grantedCores,issuedAt}，可带 ciAware（UDQ-T4B-2：授予时该机
 *   CI 在跑，执行侧开跑即整树降到最低优先级、不因 CI 冻住；可选字段不升 formatVersion，旧记录缺省当 false）。
 *   T2 客户端校验当前 running 执行，
 *   并在本机临时目录 create-only 登记消费者 pid；同 pid 或其直接子进程可重复使用。
 * reports/<ticketId>--<attemptId>--<phase>.json = AttemptReport：客户端 create-only，派单员读取；
 *   started={ticketId,attemptId,phase:'started',token,machine,pid,codeRef,at,creationFileTime?,createdAt?,verifier?}；
 *   finished={ticketId,attemptId,phase:'finished',token,machine,result,reason,at}，
 *   result 只许 passed/failed/voided/cancelled。能力 attempt-reports-v1，formatVersion 仍为 1。
 *   每拍全部读齐，在指令与限时预留检查之后、决策之前受保护处理；同执行先 started 后 finished。
 *   核对单子、当前执行、许可令牌/机器、合法迁移，写 started/finished 后写回执；本机结束 terminal:true。
 *   started.data.controller?:{machine,pid,creationFileTime?,createdAt?,verifier?} 同步进入 attempts[].controller，旧事件缺省仍合法。
 *   整组验收在开跑时记录包装器出生身份：Windows 为原始 FILETIME 字符串，POSIX 为原生出生钟标识。
 *   入口逐跳核对祖先身份；仅出生身份及 verifier 字段均缺失的旧记录按原 PID＋直系验收根契约校验并逐次告警。
 *   空值/坏身份不走兼容、不倒填出生时间；共享盘客户端升级且存续旧执行退场后删除兼容，不改变回收/恢复口径。
 *   verifier={pipe,publicKey} 是每次执行独立的管道与验签公钥；私钥不入台账。原生宿主核验 OS 来客、
 *   作业成员及完整出生链，每次回复签入新挑战；结束时关闭核验端、换执行换钥，环境或旧回复不能冒用。
 *   回报 at 是客户端观测时间；事件 at 是派单员受理时间，不允许客户端把全局台账时间推到未来。
 *   已生效回报按对应执行事件补 accepted，不重复追加；坏内容/坏文件名/读失败策略与 commands 一致。
 * reports/_receipts/<同名>.json={name,status:'accepted'|'rejected',at,reason?}：派单员 replace；
 *   rejected 必须带原因。生效身份来自台账；终态的迟到新回报拒收，已经生效的重传仍 accepted。
 *   execution 缺省或 local 且没有 dispatch-intent 的当前执行是本机单子；客户端 allowedMachines 恰为 [hostname]。
 *   派单主机回收本机 running/paused/slow：beat（缺省 startedAt）超过 60 秒后才考察回收。
 *   无本机有效心跳（取不到/机器不是本机/不晚于开跑时刻）只按 controller.pid 判 ESRCH——心跳一定
 *   写在 spawn 之后，没有心跳说明命令还没起来，不存在子进程树；有本机有效心跳且带 childPid 时必须
 *   controller.pid 与 childPid 都为 ESRCH 才写失败终态；有本机有效心跳但不带 childPid 一律不回收。
 *   EPERM/仍存在/探不出/非派单主机不回收，探测不启动子进程。本期本机回收只做「确认整棵执行树
 *   已退出」的保守判据，探不出来就保持占用；主动终止残留进程树与作业对象纳管归 T4。
 * commands/<commandId>.json = SchedulerCommand：看板/客户端 create-only，派单员读取；
 *   {commandId,kind,data,submitter,createdAt,expiresAt}，kind 与 data 联合类型见下。
 *   cancel.data.reason 可选；本机 granted 撤单直接结束，running/paused/slow 写 cancel-requested。
 *   finish 只对 registerOnly 且尚未终态的单子生效：迁到 data.result 的 passed/failed 终态并写
 *   terminal finished 事件（reason 缺省为「只登记单完工」）；非 registerOnly 一律拒绝——那类
 *   单子要走 run 包装与回报链路，不许抄近路绕过许可与回报；已终态幂等，回执 executed、不重复写事件。
 *   同一拍新指令按 createdAt（同刻按 commandId 的 JS 字符序）先后执行；已收到未结清的先按台账顺序续做。
 *   reserve/owner-hold/owner-release 的 machine 必须是配置中的主机，由执行指令的调用方核对。
 *   reserve.data.durationMinutes 可选且只许 60/180；requestedCores=0 时不得带，不带表示直到下次手动修改。
 *   限时预留能力声明为 reservation-expiry。
 *   内容非法（JSON/字段/编号与文件名不符）给 rejected 回执，不入台账、不停机；本进程同编号只拒收一次。
 *   文件名去掉 .json 后不是合法编号，只记日志跳过（每进程每文件名一次），不写回执。
 *   已入台账的编号被改坏仍按编号重用拒绝继续写入，不覆盖原回执；读取失败仍整拍不写。
 * commands/_receipts/<commandId>.json = CommandReceipt：派单员 replace，看板/客户端读取；
 *   {commandId,status:'executed'|'rejected'|'expired',at,reason?}，拒绝/过期必须有原因。
 * ledger/<UTC YYYY-MM-DD>.jsonl：只由派单员追加并 fsync，其他方只读；每行
 *   {v:1,seq,at,type,ticketId?,attemptId?,data,sha256}；哈希排除 sha256 本身，seq 从 1
 *   全局连续递增，at 不倒退，按 at 的 UTC 日期分卷。仅最后文件最后一行允许截断/坏校验和；
 *   读取报告丢弃，下一次追加先截去坏尾，不能让它变成中间坏行。其他损坏一律拒收。
 *   reservation-changed.data 可带 untilAt(ISO)/reason；期限按执行事件 at 加 durationMinutes 计算。
 *   投影 reservationUntil 按机器键保存 untilAt 或 null；不带 untilAt 的修改清掉旧期限。
 *   每拍受理指令后、准入前检查派单主机期限，过期追加一次零核预留事件；停机跨期在重启首拍补记。
 * logs/<UTC YYYY-MM-DD>/<ticketId>--<attemptId>/：执行端写日志，看板/客户端读；清理器仅删
 *   日龄 >90 的日期目录，ledger/tickets 永久保留。bin/：发布端替换单文件客户端，用户执行；
 *   bin/sched.cjs 为零依赖客户端，派单员启动读一次源码字节，内容变化才经 _staging replace 发布。
 *   启动在唯一写者保护下补建 reports/ 与回执目录，并合并 attempt-reports-v1 能力声明。
 *   上述暂存文件和日志不构成业务真相。
 * 本机客户端目录（不在共享盘）：许可消费者默认 <tmp>/sched-permit-consumers/，
 *   <sha256([share绝对路径,ticketId,attemptId,token])>.json={pid}，create-only，执行身份不可复用。
 *   小活池默认 <tmp>/sched-small-job-pool/；pool.lock={pid,at,token} 用 wx 互斥，
 *   tokens/<nonce>.json={pid,cores,at}；锁内清 ESRCH 死令牌、求和、登记，最多 4 核。
 *   锁持有者 ESRCH 或锁龄超过 10 秒可破；释放校验锁 token，不删除后来者的锁。
 * 内容指纹：目标内普通文件（含未跟踪文件），跳过 node_modules/.git/符号链接/目录联接；
 *   按相对 root 的正斜杠路径 JS 字符序排序，条目 [path,fileSha256] 的规范 JSON 再 sha256。
 *   重叠 targets 去重，路径必须在 root 内；空目标目录可哈希，缺失目标报错。
 *
 * 事件 data 的完整联合类型在 SchedulerEventData；票据事件必带 ticketId/attemptId。
 * finished.terminal=false 只结束本次执行，逻辑单仍存活，立即进入重排等待；随后 requeued
 * 分配下一执行号，把结束至重排记录间的等待一并归到新执行，防止断电恢复丢计时。
 * requeued 也能直接结束尚未终结的旧执行（必须显式提供 previousResult），不复活终态票据。
 * requeued.data.rerun（UDQ-T4B d3）：暂停误伤超时的补跑标记——既是每单 1 次预算的占用凭据，
 *   也携带下一次执行只跑这些用例身份（file+titlePath+instanceIndex+sourceSha256）的选择。
 * unsatisfiable 是可恢复的阻塞态，不是终态。暂停原因叠加，自动操作不得解除人工原因；
 * slowed 是纯 ci 暂停的跑分类转低速，仍保留 ci 原因直到 restored。T4 决定何时发这些事件。
 *
 * T4a：beats 可带 token+suspend（sequence、确认状态、各段本机毫秒区间、告警）。派单员只
 *   接收当前许可回报，追加 suspension-observed，不执行进程操作。离线操作记录在本机持久目录。
 *   manualPause 是逻辑单人工意图，ownerHold 是机器意图的快照；意图不等于已确认挂起。
 *   控制端死亡后的流水续做只核对和收尾；KILL_ON_JOB_CLOSE 下不恢复旧进程，重排仍归 T3。
 * T5 远程终止：_control/kill/<ticketId>--<attemptId>.json = RemoteKillInstruction，派单员
 *   create-only(replace 重发)，执行端树外包装进程每拍读取；字段 {schema:1,ticketId,attemptId,
 *   submissionId,machine,source,reason,createdAt}，submissionId 必须与单号/执行号一致。执行端
 *   核对 machine 后立即 ManagedRun.stop()——Windows 作业对象 KILL_ON_JOB_CLOSE 保证整棵树
 *   （含已挂起的故障树）一并退出，随后按 failed + reason 含「远程终止」回报。派单员撤单对
 *   集群 running/paused/slow 不再拒绝：先记 cancel-requested，再发布终止指令并回 executed——
 *   回执只代表指令受理，票据终态由执行回报或下方证据规则落账。派单员每拍终局检查
 *   cancelRequested 的集群单：拿到终止性实物(done/failed/quarantine)立即按实物落账；执行机
 *   消失(实物缺位/仍在 running)时按「指令首次发布后满 REMOTE_KILL_GRACE_MS 仍无回报」判
 *   挂起执行已死，写 failed 终态(reason 含「远程终止」)——绝不以「心跳过期」单独推断；指令发布
 *   之后仍出现更新的 sched 心跳说明执行端活着(只是尚未吃到指令)，该拍不收尾，活着的慢执行因此
 *   不会被误终局。硬超时按 work.type 查 JOB_HARD_TIMEOUT_MS(typecheck 30 分钟、
 *   test 2 小时含 test:fast/test:targeted 等菜单变体，未列出类型不限时)；有效耗时 = measureSuspensionWindow 的 elapsedMs，即只扣除
 *   已确认挂起区间，slow 计入运行。超时先记 cancel-requested 再走同一条终止链路。指令文件在
 *   票据终局后由派单员清理，未终结单子的指令保留作证据。能力声明 remote-kill-v1。
 *   SCHED-MENU-HARD-TIMEOUT-0924(auto 单的时限按项目与菜单项分):auto 单的硬超时先看
 *   菜单项(客户端注册表 sched-projects.cjs)的 hardTimeoutMin(整数分钟，缺省即不限)；菜单没写时
 *   只有 rogue 退回 JOB_HARD_TIMEOUT_MS，其余项目一律不限(与它们今天在挂号机本机跑一致)。
 *   rogue 的菜单项不写 hardTimeoutMin，故 rogue 单的判据与结果逐字节不变。只改 auto 单；
 *   cluster/local 单仍按 jobHardTimeoutMs(work.type) 走老表。
 * 长期占用单(SCHED-MR5-RESIDENT-LEASE-0924，能力 resident-lease-v1)：
 *   SubmissionRequest.resident:true 的单子是「已经在跑、只登记占用」的常驻服务(定时推送、
 *   看板服务器、dev server 这类)。它不交接、不排队、不派发、不回报：派单员在受保护提交里
 *   挂号当拍即授予，许可带 resident:true 且 grantedCores 恰等于 requestedCores(不给弹性)，
 *   于是它计入该机 grantedCores、从队列里消失；台账上就是 granted(许可) 与终局的 finished
 *   两条事件，看板 /sched 页据此可见。约束:只许本机单(execution 缺省)、恰好一台允许机器、
 *   不许带 auto 的 origin/menu、不许用只登记类别(codex-build)。
 *   leases/<ticketId>.json = ResidentLease {schema:1,ticketId,machine,cores,pid,at}：hold 包装端
 *   create/replace 的心跳凭据(核心是「这个文件还在被写」)。派单员每拍按文件 mtime(共享盘时域，
 *   不受跨机钟偏影响；文件缺失时退回许可签发时刻)判活，静默超过
 *   RESIDENT_LEASE_HEARTBEAT_TIMEOUT_MS 就写 finished(voided，reason 含「心跳断超时」)自动销单，
 *   授予的核当拍释放；票据终局后残留的租约文件由派单员清理。该目录不是事实源。
 * 本文件集中声明表和校验器，因工单要求契约唯一正本而不拆成多份可能漂移的协议。
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { MenuItem } from './client/sched-projects.cjs'
import {
  canonicalLifecycleJson, lifecyclePayloadSha256, requireAgentProtocol, requireRecord, requireSafeSegment, requireSha1,
  requireText, SHA1, SHA256, SAFE_SEGMENT, type LifecycleSources,
} from '../bot/cluster-lifecycle-contract'

export { SAFE_SEGMENT }
export type SchedulerSources = LifecycleSources
export const SCHED_FORMAT_VERSION = 1 as const
export const SCHED_CAPABILITIES = [
  'canonical-json-sha256', 'idempotent-submit', 'ledger-sequence-v1', 'ticket-projection-v1',
  'four-phase-timing', 'register-only', 'admission-reservation', 'log-retention-90d',
  'reservation-expiry', 'attempt-reports-v1', 'cluster-handoff', 'cluster-work-workers', 'cluster-granted-cores',
  'attempt-suspension-v1', 'remote-kill-v1',
  // UDQ-T5-BLOCKS-CLUSTER-AGENT-ON-HOST:work 接受 calib 作业的 round/shard(集群跑分按轮次分片
  // 挂号)。旧客户端/旧派单员遇到这些字段按未知字段拒收,能力位用于区分共享盘客户端部署前后。
  'cluster-work-round-shard',
  // SCHED-MR5-RESIDENT-LEASE-0924:常驻服务长期占用单(挂号即授予、心跳续约、断线自动销单)。
  'resident-lease-v1',
  // SCHED-CORES-HISTORY-AUTOCORRECT-1010:按同类活历史实测自动改小申请核数。挂号端只在
  // 共享盘声明了这个能力位时才随请求发 usageKey / requestedCoresOriginal(旧派单员不认识新字段);
  // 既有共享盘由派单员启动时补上(sched-usage-history.ts 的 ensureUsageHistoryCapability)。
  'usage-history-v1',
] as const
// 本方代定（收单复核）：容忍跨机时钟偏差，客户端最多可超前派单员五分钟，不改写原始请求。
export const SUBMIT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000
// 数值均来自设计正本 §5.3；预留四档及只清日志来自 §6.11 / d9 / V-15。
export const READING_FRESHNESS_MS = 30_000
/**
 * 超用标红(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925):在管单实测超过授予 1.5 倍连续满
 * 60 秒标红,持续满 5 分钟派单员打超用告警。标记只活在派单员内存与票据快照/边车缓存里,不进台账。
 */
export const OVERUSE_RATIO = 1.5
export const OVERUSE_MARK_AFTER_MS = 60_000
export const OVERUSE_ALERT_AFTER_MS = 5 * 60_000
export const HEAD_PROTECTION_MS = 10 * 60_000
export const HOST_SMALL_JOB_POOL_CORES = 4
export const DISPATCH_TICK_MS = 2_000
export const ATTEMPT_RECLAIM_AFTER_MS = 60_000
/**
 * 授予后未开跑的收回门槛(SCHED-GRANTED-ORPHAN-NO-RECLAIM-0924 / SCHED-GRANTED-NEVER-STARTED-RECLAIM-0924):
 * 本机单授予后这么久既没有开跑回报、也没有任何存活信号,许可按「挂号端没来领」收回。
 * 正常「wait --until granted 后立即 run」的用法在秒级开跑,远不会触线;只登记类(registerOnly)
 * 单挂号即 running、零核,不经过 granted,与本门槛无关。门槛值取卡面建议起点 10 分钟;
 * 台账 P99 核定记录见 docs/plans/SCHED-GRANTED-ORPHAN-NO-RECLAIM-0924-施工记录.md。
 */
export const GRANTED_START_RECLAIM_AFTER_MS = 10 * 60_000
/**
 * 挂号端等待心跳(SCHED-QUEUED-ORPHAN-LIVENESS-1009):exec/run 在排队、授予未开跑期间每
 * WAITING_BEAT_INTERVAL_MS 覆盖写一次 waiting/<单号>.json(seq 递增);派单员每 WAITING_BEAT_CHECK_MS
 * 扫一次,自己观察到 seq 连续 WAITING_BEAT_STALE_MS 不变,就判挂号端已不在——排队的撤单,授予未开跑的收回。
 * 判停更只用派单员自己的时钟(观察到 seq 变化的那一拍),文件里不放时间,绝不拿跨机时间戳相减
 * (SCHED-HUB12-LAUNCH-CLOCK-SKEW-1009 的教训)。没有这个文件的老挂号端照旧按 GRANTED_START_RECLAIM_AFTER_MS。
 */
export const WAITING_BEAT_INTERVAL_MS = 10_000
export const WAITING_BEAT_STALE_MS = 120_000
export const WAITING_BEAT_CHECK_MS = 10_000
export const LOG_RETENTION_DAYS = 90
export const RESERVATION_LEVELS = [0, 5, 10, 15] as const
export const RERUN_BUDGET = 1
export const DAY_MS = 86_400_000
export const PAUSE_REASONS = ['ci', 'manual', 'owner-hold'] as const
export type PauseReason = typeof PAUSE_REASONS[number]
export const CATEGORIES = ['unit-test', 'e2e-test', 'calib-run', 'perf-bench', 'mutation-test', 'codex-build', 'codex-acceptance', 'other'] as const
export const AUTO_CATEGORIES = ['unit-test', 'e2e-test', 'other'] as const
export const MENU_ARGS_MAX = 64
export const MENU_ARG_MAX_LENGTH = 200
export const SNAPSHOT_READY_TIMEOUT_MS = 60_000
export type Category = typeof CATEGORIES[number]
export interface CategoryPolicy {
  registerOnly: boolean
  rerunTimedOutAfterSuspend: boolean
  slowAfterCiPauseMin: number | null
  defaultCores: number | 'min-quota-12' | 'required'
}
export const CATEGORY_POLICY: Readonly<Record<Category, Readonly<CategoryPolicy>>> = {
  'unit-test': { registerOnly: false, rerunTimedOutAfterSuspend: true, slowAfterCiPauseMin: null, defaultCores: 'min-quota-12' },
  'e2e-test': { registerOnly: false, rerunTimedOutAfterSuspend: true, slowAfterCiPauseMin: null, defaultCores: 4 },
  'calib-run': { registerOnly: false, rerunTimedOutAfterSuspend: false, slowAfterCiPauseMin: 30, defaultCores: 'required' },
  'perf-bench': { registerOnly: false, rerunTimedOutAfterSuspend: false, slowAfterCiPauseMin: 30, defaultCores: 1 },
  'mutation-test': { registerOnly: false, rerunTimedOutAfterSuspend: false, slowAfterCiPauseMin: null, defaultCores: 8 },
  'codex-build': { registerOnly: true, rerunTimedOutAfterSuspend: false, slowAfterCiPauseMin: null, defaultCores: 0 },
  'codex-acceptance': { registerOnly: false, rerunTimedOutAfterSuspend: false, slowAfterCiPauseMin: null, defaultCores: 'required' },
  other: { registerOnly: false, rerunTimedOutAfterSuspend: false, slowAfterCiPauseMin: null, defaultCores: 'required' },
}
export const TERMINAL_STATES = ['passed', 'failed', 'cancelled', 'voided'] as const
export type TicketState = 'queued' | 'granted' | 'running' | 'paused' | 'slow' | 'unsatisfiable' | typeof TERMINAL_STATES[number]
export const STATE_TRANSITIONS: Readonly<Record<TicketState, readonly TicketState[]>> = {
  queued: ['granted', 'cancelled', 'voided', 'failed', 'unsatisfiable'],
  granted: ['running', 'queued', 'cancelled', 'failed', 'voided'],
  running: ['paused', 'slow', 'queued', 'passed', 'failed', 'cancelled', 'voided'],
  paused: ['running', 'slow', 'queued', 'passed', 'failed', 'cancelled', 'voided'],
  slow: ['running', 'paused', 'queued', 'passed', 'failed', 'cancelled', 'voided'],
  unsatisfiable: ['queued', 'cancelled', 'voided', 'failed'],
  passed: [], failed: [], cancelled: [], voided: [],
}
export function assertTransition(from: TicketState, to: TicketState): void {
  if (!STATE_TRANSITIONS[from]?.includes(to)) throw new Error(`[sched] 非法迁移:${from}->${to}`)
}
export type CodeRef = { kind: 'commit'; value: string } | { kind: 'content'; value: string }
export interface SubmissionRequest {
  /** 缺省为本机；auto = 哪台都行，由派单员挑机器。 */
  execution?: 'local' | 'cluster' | 'auto'
  origin?: string
  menu?: { item: string; args: string[]; elastic?: true }
  idempotencyKey: string
  project: string
  submitter: string
  /** 实际施工平台；可选的 1–24 位小写字母、数字或连字符标识，不限定平台枚举。 */
  engine?: string
  category: Category
  title: string
  /**
   * workers 是显式并发(正整数,不与申请核数作大小比较)。
   * round/shard 是集群跑分(deployment.getDeploymentConfig().jobs[work.type]?.needsRound === true)的轮次与分片:round 与 cluster-job 的
   * ROUND_OK 同字符集;shard 形如 's0of3'(第 0 片/共 3 片),两者必须成对出现——
   * 成对规则与「集群 calib 必带」的硬性要求见 validateSubmission。
   */
  work: { type: string; targetPaths: string[]; workers?: number; round?: string; shard?: string }
  requestedCores: number
  allowedMachines: string[]
  codeRef: CodeRef
  parentTicketId?: string
  /**
   * 长期占用单(SCHED-MR5-RESIDENT-LEASE-0924)：常驻服务只登记占用、不派发。只认字面 true；
   * 缺省(旧请求)与 false 都是普通单。requestedCores 就是这台机器要让出来的核数。
   */
  resident?: true
  /**
   * 同类活统计键(SCHED-CORES-HISTORY-AUTOCORRECT-1010):挂号端按 usageKeyFor 算好随请求提交,
   * 1–120 字符;缺省时派单员统计按 `${project}|${work.type}` 兜底。仅共享盘声明
   * usage-history-v1 能力位时才携带(见 SCHED_CAPABILITIES)。
   */
  usageKey?: string
  /** 按历史实测改小前的原申请核数;只在改小时携带,恒为 ≥ requestedCores 的正整数。 */
  requestedCoresOriginal?: number
  resources: { exclusive: ('screen' | 'word-com')[] }
  createdAt: string
}
export interface SchedulerFormat { formatVersion: number; capabilities: string[]; createdAt: string }
export interface DispatcherConfig { machine: string; createdAt: string; createdBy: string }
export interface DispatcherHeartbeat {
  machine: string; pid: number; protocol: number; head: string; at: string
  tick: number; cursorSeq: number; queued: number; granted: number
  machines: DispatcherMachineSnapshot[]
  queue: DispatcherQueueSnapshot[]
  locks: { machine: string; byTicketId: string }[]
}
export interface DispatcherMachineSnapshot {
  name: string; preference: number; quotaCores: number; grantedCores: number; externalLoadCores: number
  availableCores: number; overCommitted: boolean; fresh: boolean; online: boolean
  ci: 'active' | 'idle' | 'unknown'; ownerHold: boolean
  reservation: { requestedCores: number; fulfilledCores: number; untilAt: string | null } | null
  heartbeatAt: string | null; loadSampledAt: string | null
  /** 心跳里正在跑的 CI runner 名(去重排序);认不出、非 active 或旧代理没升级时为 null。 */
  ciRunners: string[] | null
  /** 按 CI 车道余量表给本机 CI 留的核数;`unknown`/空闲为 0,认不出 runner 时等于整机配额。 */
  ciReserveCores: number
  /**
   * 实测退回核数(SCHED-ACTUAL-USAGE-ADMISSION-1010):开关开且本拍确有退回(>0)才写,
   * 关/无退回不写键。展示字段,availableCores 已含这份退回;旧读方按未知字段忽略即可,不升版。
   */
  actualUsageCreditCores?: number
  /**
   * 执行端作业槽快照(SCHED-SLOTS-VISIBLE-ON-DASH-0924):执行心跳带合法 jobSlots 时给
   * { capacity, occupied }(occupied 允许超过 capacity,超占如实保留);旧执行心跳没报 jobSlots 写
   * null,缺键与 null 都表示未知,禁止拿准入回退值 1/0 假装实测值。展示字段,不参与准入;
   * 可选字段不升SCHED_FORMAT_VERSION;部署先更新严格读者,再发布写者;SELF_SOURCES按AGENT_PROTOCOL升号。
   */
  agentSlots?: { capacity: number; occupied: number } | null
}
export interface DispatcherQueueSnapshot {
  ticketId: string; position: number; band: 0 | 1; requestedCores: number; allowedMachines: string[]
  queuedAt: string; state: 'queued' | 'unsatisfiable'; reason: string | null
}
export interface Permit {
  ticketId: string; attemptId: string; token: string; machine: string
  category: Category; grantedCores: number; issuedAt: string
  /** 授予时该机 CI 在跑（UDQ-T4B-2）。只认字面 true；缺省/旧记录 = 老行为（CI 一来就整树冻住）。 */
  ciAware?: true
  /** 长期占用许可（SCHED-MR5-RESIDENT-LEASE-0924）。只认字面 true；只许与 request.resident 同时出现。 */
  resident?: true
}
export interface DispatchIntent {
  ticketId: string; attemptId: string; submissionId: string; machine: string; codeRef: CodeRef; createdAt: string
}
export interface SuspensionObservation {
  sequence: number; at: number; mode: 'running' | 'paused' | 'slow'; reasons: PauseReason[]; ended: boolean
  intervals: { from: number; to: number | null }[]; slowIntervals: { from: number; to: number | null }[]; alert: string | null
}
export interface AttemptBeat { ticketId: string; attemptId: string; machine: string; at: string; childPid?: number; token?: string; suspend?: SuspensionObservation }
/** T5 远程终止指令：派单员发布，执行端每拍读取；machine 不符或校验失败一律忽略，不许让作业陪葬。 */
export interface RemoteKillInstruction {
  schema: 1; ticketId: string; attemptId: string; submissionId: string
  machine: string; source: string; reason: string; createdAt: string
}
export interface PermitVerifier { pipe: string; publicKey: string }
/** 长期占用单的续约凭据：<share>/sched/leases/<ticketId>.json。 */
export interface ResidentLease { schema: 1; ticketId: string; machine: string; cores: number; pid: number; at: string }
/** 挂号端等待心跳：<share>/sched/waiting/<ticketId>.json(SCHED-QUEUED-ORPHAN-LIVENESS-1009);不带时间字段。 */
export interface WaitingBeat { schema: 1; ticketId: string; machine: string; pid: number; seq: number }
export interface AttemptController { machine: string; pid: number; creationFileTime?: string; createdAt?: string; verifier?: PermitVerifier }
export type AttemptReport = { ticketId: string; attemptId: string; token: string; machine: string; at: string } & (
  { phase: 'started'; pid: number; codeRef: CodeRef; creationFileTime?: string; createdAt?: string; verifier?: PermitVerifier }
  | { phase: 'finished'; result: typeof TERMINAL_STATES[number]; reason: string }
)
export type ReportReceipt = { name: string; at: string } & (
  { status: 'accepted'; reason?: string } | { status: 'rejected'; reason: string }
)
type CommandData = {
  'jump-queue': { ticketId: string }; cancel: { ticketId: string; reason?: string }
  finish: { ticketId: string; result: 'passed' | 'failed'; reason?: string }
  'pause-one': { ticketId: string }; 'resume-one': { ticketId: string }
  reserve: { machine: string; requestedCores: typeof RESERVATION_LEVELS[number]; durationMinutes?: 60 | 180 }
  'owner-hold': { machine: string }; 'owner-release': { machine: string }
}
export type SchedulerCommand = { [K in keyof CommandData]: {
  commandId: string; kind: K; data: CommandData[K]; submitter: string; createdAt: string; expiresAt: string
} }[keyof CommandData]
export type CommandReceipt = { commandId: string; at: string } & (
  { status: 'executed' } | { status: 'rejected' | 'expired'; reason: string }
)
export type SubmissionReceipt = { idempotencyKey: string; contentHash: string; at: string } & (
  { status: 'accepted'; ticketId: string } | { status: 'rejected'; reason: string }
)
export const ATTEMPT_RESULTS = ['passed', 'failed', 'voided', 'cancelled', 'handoff-interrupted'] as const
export type AttemptResult = typeof ATTEMPT_RESULTS[number]
/**
 * 一次执行的用量折算(SCHED-CORES-HISTORY-AUTOCORRECT-1010):派单员从代理心跳 attemptLoad
 * 累计出的峰值核数、90 分位核数与读数个数。没有任何读数的执行不带 usage。
 */
export interface AttemptUsage {
  peakCores: number
  p90Cores: number
  samples: number
}
export interface RetentionReport { at: string; deleted: string[]; retained: string[]; warnings: { path: string; reason: string }[] }
/** 补跑用例身份（d3）：仓库相对正斜杠文件 + 非空标题路径 + 同名实例序号；sourceSha256 是 CRLF 归一后的源内容指纹。 */
export interface RerunCaseSelection {
  identity: { file: string; titlePath: string[]; instanceIndex: number }
  sourceSha256: string
}
export interface RerunEventData { reason: string; retainedFailures: number; selection: RerunCaseSelection[] }
export interface SchedulerEventData {
  submitted: { request: SubmissionRequest; contentHash: string }
  'rejected-submission': { idempotencyKey: string; contentHash: string; reason: string }
  granted: { permit: Permit }
  'placement-checked': { portable: boolean; reason: string | null; detail?: string; ownerSid?: string }
  'snapshot-ready': { commit: string; base: string; bundle: string; bundleBytes: number }
  'dispatch-intent': { intent: DispatchIntent }
  dispatched: { submissionId: string }
  started: { codeRef: CodeRef; controller?: AttemptController }
  paused: { reason: PauseReason }
  resumed: { reason: PauseReason; actor: 'automatic' | 'operator' }
  slowed: { reason: string }
  restored: { reason: string }
  'suspension-observed': { observation: SuspensionObservation }
  finished: { result: AttemptResult; reason: string; terminal: boolean; exitCode?: number; logFile?: string; usage?: AttemptUsage }
  requeued: { nextAttemptId: string; reason: string; atHead: boolean; previousResult?: AttemptResult; rerun?: RerunEventData }
  'cancel-requested': { reason: string }
  'marked-unsatisfiable': { reason: string }
  'cleared-unsatisfiable': { reason: string }
  'command-received': { command: SchedulerCommand }
  'command-executed': { receipt: CommandReceipt & { status: 'executed' } }
  'command-rejected': { receipt: CommandReceipt & { status: 'rejected' | 'expired' } }
  'reservation-changed': { machine: string; requestedCores: typeof RESERVATION_LEVELS[number]; untilAt?: string; reason?: string }
  'owner-hold-changed': { machine: string; held: boolean }
  'ci-borrow-changed': { machine: string; ticketId: string; attemptId: string; action: 'lent' | 'hold' | 'release'; reason: string }
  'log-retention-run': RetentionReport
}
export type EventType = keyof SchedulerEventData
type GlobalEvent = 'rejected-submission' | 'command-received' | 'command-executed' | 'command-rejected' | 'reservation-changed' | 'owner-hold-changed' | 'ci-borrow-changed' | 'log-retention-run'
export type EventDraft = { [K in EventType]: { at: string; type: K; data: SchedulerEventData[K] }
  & (K extends GlobalEvent ? { ticketId?: never; attemptId?: never } : { ticketId: string; attemptId: string })
}[EventType]
/** at 是真实墙钟；回拨恢复时 recordedAt 仅维持流水文件/游标的单调顺序。 */
export type LedgerEvent = EventDraft & { v: typeof SCHED_FORMAT_VERSION; seq: number; sha256: string; recordedAt?: string }
export function ledgerRecordTime(event: LedgerEvent): string { return event.recordedAt ?? event.at }
export interface Timing { queuedMs: number; runningMs: number; pausedMs: number; slowMs: number }
export type TimingPhase = keyof Timing
export interface TimingSegment { phase: TimingPhase; from: string; to: string; milliseconds: number }
export interface AttemptSnapshot {
  attemptId: string; queuedAt: string; startedAt: string | null; endedAt: string | null
  grantedCores: number; permit: Permit | null; intent: DispatchIntent | null; dispatchedAt: string | null
  codeRef: CodeRef | null; result: { outcome: AttemptResult; reason: string; exitCode?: number; logFile?: string; usage?: AttemptUsage } | null
  controller?: AttemptController
  suspension?: SuspensionObservation
  snapshotReady?: { commit: string; base: string; bundle: string; bundleBytes: number; readyAt: string }
  timing: Timing; segments: TimingSegment[]
}
/**
 * 超用标记(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925):派单员内存状态投出来的展示字段,
 * 不来自台账——重建快照时会没有,下一拍由派单员补回;终态票据与执行号不符的标记一律拒写。
 */
export interface TicketOveruse {
  attemptId: string; machine: string; grantedCores: number; measuredCores: number
  since: string; sampledAt: string; alertedAt?: string
}
export interface TicketSnapshot {
  formatVersion: 1; ticketId: string; request: SubmissionRequest; contentHash: string
  state: TicketState; registerOnly: boolean; pauseReasons: PauseReason[]; cancelRequested: boolean
  manualPause?: boolean; ownerHold?: boolean
  placement?: { portable: boolean; reason: string | null; detail?: string; ownerSid?: string; checkedAt: string; attemptId: string }
  currentAttemptId: string; attempts: AttemptSnapshot[]; band: 0 | 1; queuedAt: string
  createdAt: string; updatedAt: string; endedAt: string | null; unsatisfiableReason: string | null
  accountedAt: string; pendingQueue: { from: string; timing: Timing; segments: TimingSegment[] } | null
  timing: Timing; lastSeq: number; timeline: LedgerEvent[]
  /** 超用标红:可丢失的展示缓存,口径见 TicketOveruse。 */
  overuse?: TicketOveruse
}
export interface LedgerCursor { seq: number; at: string | null; sha256: string | null }
export type ReadResult<T> = { status: 'ok'; value: T } | { status: 'unreadable'; path: string; reason: string } | { status: 'not-initialized'; path: string }

/** 以下校验同时服务磁盘读入和零依赖客户端，不靠 TS 类型假定外部输入可信。 */
type Check = (value: unknown) => void
export function fields(value: unknown, required: Record<string, Check>, optional: Record<string, Check> = {}): void {
  const record = requireRecord(value, '对象')
  for (const [name, check] of Object.entries(required)) check(record[name])
  for (const name of Object.keys(record)) {
    if (Object.hasOwn(required, name)) continue
    const check = Object.hasOwn(optional, name) ? optional[name] : undefined
    if (!check) throw new Error(`[sched] 未知字段:${name}`)
    check(record[name])
  }
}
export const text: Check = value => { requireText(value, '文本') }
export function segment(value: unknown): string {
  const result = requireSafeSegment(value, '路径段')
  if (result === '.' || result === '..') throw new Error('[sched] 路径段不能是 . 或 ..')
  return result
}
export function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error('[sched] 必须是范围内的安全整数')
  return value as number
}
export function isoTime(value: unknown): string {
  const result = requireText(value, 'ISO 时间')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error('[sched] 时间必须为 UTC 毫秒 ISO')
  return result
}
export function oneOf<T extends string | number | boolean>(values: readonly T[]): Check {
  return value => { if (!values.includes(value as T)) throw new Error(`[sched] 枚举值不合法:${String(value)}`) }
}
export function list(check: Check, minimum = 0, unique = false): Check {
  return value => {
    if (!Array.isArray(value) || value.length < minimum) throw new Error('[sched] 数组不合法')
    value.forEach(item => check(item))
    if (unique && new Set(value).size !== value.length) throw new Error('[sched] 数组含重复项')
  }
}
export function ticketId(value: unknown): string {
  const result = requireText(value, 'ticketId')
  if (!/^tk-[0-9a-f]{20}$/.test(result)) throw new Error('[sched] 单号不合法')
  return result
}
export function attemptId(value: unknown): string {
  const result = requireText(value, 'attemptId')
  if (!/^a[1-9]\d*$/.test(result)) throw new Error('[sched] 执行号不合法')
  integer(Number(result.slice(1)), 1)
  return result
}
export function nextAttemptId(current: string): string { return `a${integer(Number(attemptId(current).slice(1)) + 1, 1)}` }
/**
 * 超用标记(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925)只收契约字段;时间次序不对
 * (起始晚于最近读数、告警早于起始)一样算坏。ticketId 仅边车条目带,快照内标记不带。
 */
export function validateTicketOveruse(value: unknown): TicketOveruse {
  try {
    fields(value, {
      attemptId, machine: segment, grantedCores: integer,
      measuredCores: v => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('实测核数不合法') },
      since: isoTime, sampledAt: isoTime,
    }, { alertedAt: isoTime, ticketId })
  } catch (error) {
    throw new Error(`[sched] 超用标记不合法:${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const mark = value as TicketOveruse
  if (Date.parse(mark.since) > Date.parse(mark.sampledAt)) throw new Error('[sched] 超用标记不合法:起始时刻晚于最近读数时刻')
  if (mark.alertedAt !== undefined && Date.parse(mark.alertedAt) < Date.parse(mark.since)) throw new Error('[sched] 超用标记不合法:告警时刻早于起始时刻')
  return mark
}
export function deriveTicketId(project: string, key: string): string {
  text(project); segment(key)
  return `tk-${contentHash([project, key]).slice(0, 20)}`
}
export function submissionId(ticket: string, attempt: string): string { return segment(`${ticketId(ticket)}--${attemptId(attempt)}`) }
export function requireHash(value: unknown): void {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error('[sched] SHA256 不合法')
}
export function validateCodeRef(value: unknown): void {
  fields(value, { kind: oneOf(['commit', 'content']), value: text })
  const ref = value as CodeRef
  if (!(ref.kind === 'commit' ? SHA1 : SHA256).test(ref.value)) throw new Error('[sched] 代码版本不合法')
}
/** 心跳是完整的一拍展示缓存；校验形状与排序，不在读写端重算准入。 */
export function validateDispatcherHeartbeat(value: unknown): DispatcherHeartbeat {
  const count: Check = v => { integer(v) }
  const positive: Check = v => { integer(v, 1) }
  const nonNegative: Check = v => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('[sched] 心跳核数或偏好不合法')
  }
  const nullable = (check: Check): Check => v => { if (v !== null) check(v) }
  const boolean = oneOf([true, false])
  fields(value, {
    machine: segment, pid: positive, protocol: v => { requireAgentProtocol(v, 'dispatcher.protocol') },
    head: v => { requireSha1(v, 'dispatcher.head') }, at: isoTime, tick: positive, cursorSeq: count, queued: count, granted: count,
    machines: list(v => fields(v, {
      name: segment, preference: nonNegative, quotaCores: count, grantedCores: count, externalLoadCores: nonNegative,
      availableCores: nonNegative, overCommitted: boolean, fresh: boolean, online: boolean,
      ci: oneOf(['active', 'idle', 'unknown']), ownerHold: boolean,
      reservation: nullable(r => fields(r, { requestedCores: oneOf(RESERVATION_LEVELS), fulfilledCores: nonNegative, untilAt: nullable(isoTime) })),
      heartbeatAt: nullable(isoTime), loadSampledAt: nullable(isoTime),
    }, {
      // 可选：旧心跳（旧派单员节点写下的）不带这两项仍然合法，读方按「认不出」保守处理。
      ciRunners: nullable(list(segment, 0, true)), ciReserveCores: count,
      // 实测退回(SCHED-ACTUAL-USAGE-ADMISSION-1010):可选展示字段,退回 >0 才写,读方按未知字段忽略即可。
      actualUsageCreditCores: nonNegative,
      // 作业槽快照(SCHED-SLOTS-VISIBLE-ON-DASH-0924):可选展示字段,旧心跳缺键仍合法;对象严格只认
      // capacity(正安全整数)/occupied(非负安全整数)两键,多字段与坏值都拒绝,null 表示未知(旧执行心跳)。
      agentSlots: nullable(v => fields(v, { capacity: positive, occupied: count })),
    })),
    queue: list(v => fields(v, {
      ticketId, position: positive, band: oneOf([0, 1]), requestedCores: positive, allowedMachines: list(segment, 1, true),
      queuedAt: isoTime, state: oneOf(['queued', 'unsatisfiable']), reason: nullable(text),
    })),
    locks: list(v => fields(v, { machine: segment, byTicketId: ticketId })),
  })
  const heartbeat = value as DispatcherHeartbeat
  const ordered = (names: string[]): boolean => names.every((name, index) => index === 0 || names[index - 1]! < name)
  if (!ordered(heartbeat.machines.map(machine => machine.name)) || !ordered(heartbeat.locks.map(lock => lock.machine))) {
    throw new Error('[sched] 心跳机器或保护锁未按名字排序')
  }
  for (const machine of heartbeat.machines) {
    if ((machine.name === heartbeat.machine) !== (machine.reservation !== null)
      || (machine.reservation && machine.reservation.fulfilledCores > machine.reservation.requestedCores)) throw new Error('[sched] 心跳预留归属或兑现核数不合法')
  }
  heartbeat.queue.forEach((ticket, index) => {
    if (ticket.position !== index + 1 || (ticket.state === 'queued') !== (ticket.reason === null)) throw new Error('[sched] 心跳排队名次或原因不合法')
  })
  return heartbeat
}
export function canonicalJson(value: unknown): string {
  const inspect = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (Array.isArray(item)) { for (const child of item) inspect(child); return }
    if (typeof item === 'object' && item !== null && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      for (const [key, child] of Object.entries(item)) {
        // 复用的规范编码器用普通对象建结果；拒绝此键以免跨实现丢字段或产生原型赋值。
        if (key === '__proto__') throw new Error('[sched] 禁止 __proto__ 字段')
        inspect(child)
      }
      return
    }
    throw new Error('[sched] 仅接受完整 JSON 值')
  }
  inspect(value)
  return canonicalLifecycleJson(value)
}
export function contentHash(value: unknown): string { canonicalJson(value); return lifecyclePayloadSha256(value) }
// 文件调用方传入原始字节，避免解码替换非法 UTF-8 后失去与归档原件的对应关系。
export function rawContentHash(raw: string | Uint8Array): string { return createHash('sha256').update(raw).digest('hex') }
export function defaultRequestedCores(category: Category, quotaCores?: number): number {
  const rule = CATEGORY_POLICY[category].defaultCores
  if (rule === 'required') throw new Error(`[sched] ${category} 必须指定核数`)
  // SCHED-FULL-QUOTA-TICKET-NEVER-FITS：unit-test 缺省申请不再取满配额。副机是专职算力机（配额=100% 逻辑核），
  // 而 available 扣掉了 externalLoad（监控/心跳等常态噪声 0.2 核），默认申请值卡在 100% 配额上就永远 >available，
  // 结构性排不上（tk-55b68d 空排 40 分钟）。这里只调请求公式、给背景噪声留 1 核缓冲；决策层的
  // available >= requestedCores 与不超订判据一个字不动（不引入任何调度算法层面的容差）。
  if (rule === 'min-quota-12') return Math.min(Math.max(integer(quotaCores, 1) - 1, 1), 12)
  return rule
}
export function validateSubmission(value: unknown): SubmissionRequest {
  fields(value, {
    idempotencyKey: segment, project: text, submitter: text, category: oneOf(CATEGORIES), title: text,
    work: item => {
      fields(item, { type: workType, targetPaths: list(text, 1) }, { workers: v => { integer(v, 1) }, round: segment, shard: shardTag })
      const work = item as SubmissionRequest['work']
      if ((value as { execution?: unknown }).execution === 'auto'
        && (work.workers !== undefined || work.round !== undefined || work.shard !== undefined)) {
        throw new Error('[sched] auto 单 work 只许 type 与 targetPaths')
      }
      // round/shard 是 calib(跑分)专属的成对字段:其他作业带它们多半是手误;而集群 calib
      // 缺了它们会让派单员在受保护的提交事务里构造 ClusterJob 时抛错(validateJob 的
      // needsRound),派单员自己崩掉并进入崩溃重启循环——所以在收单处就拒,不许落盘。
      if (work.round !== undefined || work.shard !== undefined) {
        if (deployment.getDeploymentConfig().jobs[work.type]?.needsRound !== true) throw new Error('[sched] round/shard 仅 calib 作业可携带: work')
        if (work.round === undefined || work.shard === undefined) throw new Error('[sched] round 与 shard 必须成对出现: work')
      }
      // execution 在请求顶层,不在 work 里:这里的 value 才是整张请求(客户端 sched.cjs 同判据)。
      if ((value as { execution?: unknown }).execution === 'cluster' && deployment.getDeploymentConfig().jobs[work.type]?.needsRound === true
        && (work.round === undefined || work.shard === undefined)) {
        throw new Error('[sched] 集群跑分作业必须携带 round 与 shard: work')
      }
    },
    requestedCores: item => { integer(item) }, allowedMachines: list(segment, 1, true), codeRef: validateCodeRef,
    resources: item => fields(item, { exclusive: list(oneOf(['screen', 'word-com']), 0, true) }), createdAt: isoTime,
  }, { parentTicketId: ticketId, execution: oneOf(['local', 'cluster', 'auto']), engine: engineId,
    origin: v => { try { segment(v) } catch { throw new Error('[sched] auto 单 origin 不合法') } }, menu: validateMenuRef,
    resident: optionalTrue,
    // 用量历史键与原申请(SCHED-CORES-HISTORY-AUTOCORRECT-1010):旧请求不带照常;新字段只在
    // 能力位 usage-history-v1 的共享盘上出现,客户端 sched.cjs 的判据与这里逐字相同。
    usageKey: v => { if (typeof v !== 'string' || v.length === 0 || v.length > 120) throw new Error('[sched] usageKey 必须是 1–120 字符') },
    requestedCoresOriginal: v => { if (!Number.isSafeInteger(v) || (v as number) < 1) throw new Error('[sched] requestedCoresOriginal 必须是正整数') } })
  const request = value as SubmissionRequest
  if (request.requestedCoresOriginal !== undefined && request.requestedCoresOriginal < request.requestedCores) {
    throw new Error('[sched] requestedCoresOriginal 必须不小于 requestedCores')
  }
  if (request.category === 'codex-build' ? request.requestedCores !== 0 : request.requestedCores < 1) throw new Error('[sched] 类别与申请核数不一致')
  assertAutoShape(request)
  assertResidentShape(request)
  canonicalJson(request)
  deployment.assertDeploymentSubmission(request)
  return request
}
export function validateMenuRef(value: unknown): void {
  try {
    fields(value, { item: v => {
      if (typeof v !== 'string' || !/^[A-Za-z0-9:._-]{1,64}$/.test(v)) throw new Error('菜单项不合法')
    }, args: v => {
      if (!Array.isArray(v) || v.length > MENU_ARGS_MAX || v.some(arg => typeof arg !== 'string' || arg.length === 0 || arg.length > MENU_ARG_MAX_LENGTH)) {
        throw new Error('受限参数不合法')
      }
    } }, { elastic: oneOf([true]) })
  } catch (error) { throw new Error(`[sched] auto 单 menu 不合法:${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
}
export function assertAutoShape(request: SubmissionRequest): void {
  if (request.execution !== 'auto') {
    if (request.origin !== undefined || request.menu !== undefined) throw new Error('[sched] auto 单专用字段 origin/menu 不许出现在非 auto 单')
    return
  }
  if (!request.origin || !request.menu) throw new Error('[sched] auto 单必须带 origin 与 menu')
  if (!request.allowedMachines.includes(request.origin)) throw new Error('[sched] auto 单 origin 必须在 allowedMachines 中')
  if (!(AUTO_CATEGORIES as readonly string[]).includes(request.category)) throw new Error('[sched] auto 单 category 不允许')
  if (request.menu.item !== request.work.type) throw new Error('[sched] auto 单 menu.item 必须等于 work.type')
  if (request.work.workers !== undefined || request.work.round !== undefined || request.work.shard !== undefined) throw new Error('[sched] auto 单 work 只许 type 与 targetPaths')
  if (request.resources.exclusive.length !== 0) throw new Error('[sched] auto 单 resources.exclusive 必须为空')
  if (request.codeRef.kind !== 'commit') throw new Error('[sched] auto 单 codeRef 必须是 commit')
  if (request.menu.elastic === true && request.category !== 'unit-test') throw new Error('[sched] auto 单只有 unit-test 可带 elastic')
}
/**
 * 长期占用单(SCHED-MR5-RESIDENT-LEASE-0924)的形状:一台机器上已经在跑的常驻服务只登记占用,
 * 所以它必须是本机单、只许一台机器(账按机器扣,不能跨机摊)、不许带 auto 的字段、不许与
 * 「只登记零核」的 codex-build 混。缺省(旧请求)一律不判。
 */
export function assertResidentShape(request: SubmissionRequest): void {
  if (request.resident !== true) return
  if (request.execution !== undefined) throw new Error('[sched] 长期占用单只许本机单(execution 缺省)')
  if (request.allowedMachines.length !== 1) throw new Error('[sched] 长期占用单必须恰好指定一台机器')
  if (request.origin !== undefined || request.menu !== undefined) throw new Error('[sched] 长期占用单不许带 auto 单的 origin/menu')
  // 类别在前、核数在后:codex-build 的申请核数恒为 0(validateSubmission 前面已按类别判过),
  // 若先判「至少 1 核」,那条类别规矩就永远轮不到、成了死代码,报出来的原因也不对症。
  if (request.category === 'codex-build') throw new Error('[sched] 长期占用单不许用只登记类别(codex-build)')
  if (request.requestedCores < 1) throw new Error('[sched] 长期占用单至少要占 1 核')
}
function engineId(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 24 || /[^a-z0-9-]/.test(value)) {
    throw new Error('[sched] engine 必须为 1–24 位小写字母、数字或连字符')
  }
}
/** 作业菜单含 test:fast 等名称；作业名不是路径段，仍不接受空格及命令字符。 */
function workType(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error('[sched] 作业名不合法')
}
/**
 * 跑分分片的提交格式 's<i>of<n>'(单文件名安全;进集群契约时另由 sched-cluster-job 翻成 '<i>/<n>')。
 * 序号 0 ≤ i < n:越界(如 s2of2)与补零(如 s01of2)都拒,收单处与手写客户端判据逐字相同。
 */
function shardTag(value: unknown): string {
  const tag = segment(value)
  const match = /^s(0|[1-9]\d*)of([1-9]\d*)$/.exec(tag)
  if (match === null || Number(match[1]) >= Number(match[2])) throw new Error('[sched] 分片必须是 s<i>of<n>(0 ≤ i < n): shard')
  return tag
}
/** 只判版本/形状；不写盘。所有写入入口必须先过此闸，包括清理与恢复。 */
export function assertWritableFormat(value: unknown): SchedulerFormat {
  const record = requireRecord(value, 'format')
  if (integer(record.formatVersion, 1) > SCHED_FORMAT_VERSION) throw new Error('[sched] 共享盘格式比本代码新，拒绝写入')
  fields(value, { formatVersion: oneOf([SCHED_FORMAT_VERSION]), capabilities: list(text, 0, true), createdAt: isoTime })
  return value as SchedulerFormat
}
export function schedPaths(share: string) {
  const root = join(share, 'sched')
  return {
    root, control: join(root, '_control'), format: join(root, '_control', 'format.json'), staging: join(root, '_staging'),
    submit: join(root, 'submit'), receipts: join(root, 'submit', '_receipts'), ingested: join(root, 'submit', '_ingested'),
    tickets: join(root, 'tickets'), intents: join(root, 'intents'), beats: join(root, 'beats'),
    commands: join(root, 'commands'), commandReceipts: join(root, 'commands', '_receipts'),
    reports: join(root, 'reports'), reportReceipts: join(root, 'reports', '_receipts'),
    ledger: join(root, 'ledger'), logs: join(root, 'logs'), bin: join(root, 'bin'),
    kill: join(root, '_control', 'kill'), leases: join(root, 'leases'), waiting: join(root, 'waiting'),
  }
}
export function snapshotDir(share: string): string { return join(schedPaths(share).root, 'snapshots') }
export function snapshotBundleName(ticket: string): string { return `${ticketId(ticket)}.bundle` }
export function snapshotManifestPath(share: string, ticket: string, attempt: string): string {
  return join(snapshotDir(share), `${submissionId(ticket, attempt)}.json`)
}
export type SnapshotManifest =
  | { schema: 1; ticketId: string; attemptId: string; state: 'ready'; commit: string; base: string;
    bundle: string; bundleBytes: number; createdAt: string }
  | { schema: 1; ticketId: string; attemptId: string; state: 'refused'; reason: string; detail: string; createdAt: string }
const commitHash: Check = value => { if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error('[sched] 提交哈希不合法') }
const bundleFile: Check = value => { if (typeof value !== 'string' || !/^tk-[0-9a-f]{20}[.]bundle$/.test(value)) throw new Error('[sched] 快照包名不合法') }
const bundleBytes: Check = value => { integer(value, 1) }
const shortDetail: Check = value => { if (typeof value !== 'string' || value.length === 0 || value.length > 500) throw new Error('[sched] 详情不合法') }
export function validateSnapshotManifest(value: unknown): SnapshotManifest {
  const record = requireRecord(value, '快照清单')
  if (record.state === 'ready') fields(value, { schema: oneOf([1]), ticketId, attemptId, state: oneOf(['ready']),
    commit: commitHash, base: commitHash, bundle: bundleFile, bundleBytes, createdAt: isoTime })
  else fields(value, { schema: oneOf([1]), ticketId, attemptId, state: oneOf(['refused']),
    reason: v => { if (typeof v !== 'string' || !/^(snapshot-[a-z0-9-]{1,48}|infra-source)$/.test(v)) throw new Error('[sched] 快照拒绝原因不合法') },
    detail: shortDetail, createdAt: isoTime })
  return value as SnapshotManifest
}
export function utcDate(at: string): string { return isoTime(at).slice(0, 10) }
/** 文件路径单列，避免 initializeScheduler 把 JSON 文件误建成目录。 */
export function schedControlPaths(share: string) {
  const control = schedPaths(share).control
  return { dispatcher: join(control, 'dispatcher.json'), heartbeat: join(control, 'dispatcher-heartbeat.json'),
    owner: join(control, 'owner'), ciLanes: join(control, 'ci-lanes.json') }
}
export function ledgerPath(share: string, at: string): string { return join(schedPaths(share).ledger, `${utcDate(at)}.jsonl`) }
export function ticketPath(share: string, id: string): string { return join(schedPaths(share).tickets, `${ticketId(id)}.json`) }
export function logPath(share: string, at: string, ticket: string, attempt: string): string { return join(schedPaths(share).logs, utcDate(at), submissionId(ticket, attempt)) }
export function intentPath(share: string, ticket: string, attempt: string): string { return join(schedPaths(share).intents, `${submissionId(ticket, attempt)}.json`) }
export function beatPath(share: string, ticket: string, attempt: string): string { return join(schedPaths(share).beats, `${submissionId(ticket, attempt)}.json`) }
export function commandPath(share: string, id: string): string { return join(schedPaths(share).commands, `${segment(id)}.json`) }
export function remoteKillPath(share: string, ticket: string, attempt: string): string { return join(schedPaths(share).kill, `${submissionId(ticket, attempt)}.json`) }
export function residentLeasePath(share: string, ticket: string): string { return join(schedPaths(share).leases, `${ticketId(ticket)}.json`) }
export function waitingBeatPath(share: string, ticket: string): string { return join(schedPaths(share).waiting, `${ticketId(ticket)}.json`) }

export function reportName(report: Pick<AttemptReport, 'ticketId' | 'attemptId' | 'phase'>): string {
  oneOf(['started', 'finished'])(report.phase)
  return `${submissionId(report.ticketId, report.attemptId)}--${report.phase}.json`
}
export function parseReportName(name: string): Pick<AttemptReport, 'ticketId' | 'attemptId' | 'phase'> {
  const match = /^(tk-[0-9a-f]{20})--(a[1-9]\d*)--(started|finished)\.json$/.exec(name)
  if (!match) throw new Error('[sched] 回报文件名不合法')
  return { ticketId: ticketId(match[1]), attemptId: attemptId(match[2]), phase: match[3] as AttemptReport['phase'] }
}
export function validateReport(value: unknown): AttemptReport {
  const record = requireRecord(value, '回报')
  oneOf(['started', 'finished'])(record.phase)
  fields(value, { ticketId, attemptId, phase: text, token: text, machine: segment, at: isoTime,
    ...(record.phase === 'started' ? { pid: (v: unknown) => { integer(v, 1) }, codeRef: validateCodeRef }
      : { result: oneOf(TERMINAL_STATES), reason: text }),
  }, record.phase === 'started' ? { creationFileTime: text, createdAt: text, verifier: validatePermitVerifier } : {})
  canonicalJson(value)
  return value as AttemptReport
}
export function validateReportReceipt(value: unknown): ReportReceipt {
  const record = requireRecord(value, '回报回执')
  fields(value, { name: v => { parseReportName(requireText(v, '回报名')) }, status: oneOf(['accepted', 'rejected']), at: isoTime,
    ...(record.status === 'rejected' ? { reason: text } : {}),
  }, record.status === 'accepted' ? { reason: text } : {})
  return value as ReportReceipt
}
export function validateAttemptBeat(value: unknown): AttemptBeat {
  fields(value, { ticketId, attemptId, machine: segment, at: isoTime }, { childPid: v => { integer(v, 1) }, token: text, suspend: validateSuspensionObservation })
  const beat = value as AttemptBeat
  if (beat.suspend !== undefined && (!beat.token || (!beat.suspend.ended && !beat.childPid))) throw new Error('[sched] 挂起回报缺许可或树根')
  return value as AttemptBeat
}
export function validateSuspensionObservation(value: unknown): void {
  const finite = (value: unknown): void => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('[sched] 挂起毫秒值非法') }
  const intervals = (value: unknown): void => {
    list(item => {
      fields(item, { from: finite, to: end => { if (end !== null) finite(end) } })
      const interval = item as { from: number; to: number | null }
      if (interval.to !== null && interval.to < interval.from) throw new Error('[sched] 挂起区间倒退')
    })(value)
  }
  fields(value, { sequence: value => { integer(value, 1) }, at: finite, mode: oneOf(['running', 'paused', 'slow']),
    reasons: list(oneOf(PAUSE_REASONS), 0, true), ended: oneOf([true, false]), intervals, slowIntervals: intervals,
    alert: value => { if (value !== null) text(value) } })
}
export function validateController(value: unknown): void {
  fields(value, { machine: segment, pid: v => { integer(v, 1) } }, { creationFileTime: text, createdAt: text, verifier: validatePermitVerifier })
}
function validatePermitVerifier(value: unknown): void {
  fields(value, { pipe: segment, publicKey: text })
  const verifier = value as PermitVerifier
  if (!/^sched-permit-[0-9a-f]{48}$/.test(verifier.pipe) || verifier.publicKey.length > 4096) throw new Error('[sched] 归属核验端格式非法')
}

/** 可选标记只认字面 true：false/null/缺省都不合法，免得「显式假」在两侧读出不同口径。 */
function optionalTrue(value: unknown): void { if (value !== true) throw new Error('[sched] 该标记字段只认字面 true') }
function validatePermit(value: unknown): void {
  fields(value, { ticketId, attemptId, token: text, machine: segment, category: oneOf(CATEGORIES), grantedCores: v => { integer(v) }, issuedAt: isoTime },
    { ciAware: optionalTrue, resident: optionalTrue })
}
function validateIntent(value: unknown): void {
  fields(value, { ticketId, attemptId, submissionId: segment, machine: segment, codeRef: validateCodeRef, createdAt: isoTime })
  const intent = value as DispatchIntent
  if (intent.submissionId !== submissionId(intent.ticketId, intent.attemptId)) throw new Error('[sched] 意图提交号不匹配')
}
export function validateRemoteKillInstruction(value: unknown): RemoteKillInstruction {
  fields(value, { schema: oneOf([1]), ticketId, attemptId, submissionId: segment, machine: segment,
    source: text, reason: text, createdAt: isoTime })
  const instruction = value as RemoteKillInstruction
  if (instruction.submissionId !== submissionId(instruction.ticketId, instruction.attemptId)) throw new Error('[sched] 终止指令提交号不匹配')
  canonicalJson(value)
  return instruction
}
/**
 * 长期占用单的心跳凭据(SCHED-MR5-RESIDENT-LEASE-0924)：hold 包装端在常驻服务活着期间反复刷新它。
 * 写入方是执行机上的 hold 包装进程，读取方是派单员；cores 必须与票据申请核数一致，pid 是常驻服务
 * 进程号(给人看，判定只认文件在不在被写)。at 只作展示，判活用共享盘 mtime，避免跨机钟偏误杀。
 */
export function validateResidentLease(value: unknown): ResidentLease {
  fields(value, { schema: oneOf([1]), ticketId, machine: segment, cores: v => { integer(v, 1) },
    pid: v => { integer(v, 1) }, at: isoTime })
  canonicalJson(value)
  return value as ResidentLease
}
/**
 * 挂号端等待心跳(SCHED-QUEUED-ORPHAN-LIVENESS-1009):字段恰为这五个。machine 与 pid 只给人看,
 * 派单员判活只认 seq 有没有变——所以不带任何时间字段,也就不存在跨机钟偏。
 */
export function validateWaitingBeat(value: unknown): WaitingBeat {
  fields(value, { schema: oneOf([1]), ticketId, machine: segment, pid: v => { integer(v, 1) }, seq: v => { integer(v) } })
  return value as WaitingBeat
}
/** 指令首次发布后的宽限等待：活执行端应在一个心跳周期(15s)内读到并回报，宽限届满仍无任何
 *  终止性实物才按「执行方已消失」收尾。90s = 6 个心跳周期，容得下单次共享盘抖动。 */
export const REMOTE_KILL_GRACE_MS = 90_000
/**
 * 长期占用单的心跳断线时限(SCHED-MR5-RESIDENT-LEASE-0924)：hold 包装端缺省每 30 秒续约一次
 * (见客户端 sched.cjs 的 hold)，静默 120 秒 = 连丢 4 拍才自动销单——取「宁可留一会儿、
 * 不可误销正在跑的服务」。这个默认值是可调口径，取舍见施工记录与待定点文件。
 */
export const RESIDENT_LEASE_HEARTBEAT_TIMEOUT_MS = 120_000
/** 作业硬超时上限(毫秒)，按 request.work.type 查表；未列出的类型不限时。有效耗时扣除已确认挂起区间。 */
export const JOB_HARD_TIMEOUT_MS: Readonly<Record<string, number>> = { typecheck: 30 * 60_000, test: 2 * 3_600_000 }
/** work.type 可带菜单冒号(test:fast/test:targeted 都是 test 族)；族内共享上限，其余精确匹配。 */
export function jobHardTimeoutMs(type: string): number | undefined {
  if (Object.hasOwn(JOB_HARD_TIMEOUT_MS, type)) return JOB_HARD_TIMEOUT_MS[type]!
  return type.startsWith('test:') ? JOB_HARD_TIMEOUT_MS.test! : undefined
}
/**
 * 菜单项写的硬超时(SCHED-MENU-HARD-TIMEOUT-0924)：hardTimeoutMin 是整数分钟，缺省即不限时；
 * 只有正整数分钟才算数(0、负数、非整数一律按没写处理，绝不把坏数据当成「立刻超时」)。
 */
export function menuHardTimeoutMs(item: Pick<MenuItem, 'hardTimeoutMin'> | null | undefined): number | undefined {
  const minutes = item?.hardTimeoutMin
  if (minutes === undefined || !Number.isSafeInteger(minutes) || minutes < 1) return undefined
  return minutes * 60_000
}
export function validateCommand(value: unknown): SchedulerCommand {
  const data: Record<keyof CommandData, Check> = {
    'jump-queue': v => fields(v, { ticketId }), cancel: v => fields(v, { ticketId }, { reason: text }),
    finish: v => fields(v, { ticketId, result: oneOf(['passed', 'failed']) }, { reason: text }),
    'pause-one': v => fields(v, { ticketId }), 'resume-one': v => fields(v, { ticketId }),
    reserve: v => fields(v, { machine: segment, requestedCores: oneOf(RESERVATION_LEVELS) }, { durationMinutes: oneOf([60, 180]) }),
    'owner-hold': v => fields(v, { machine: segment }), 'owner-release': v => fields(v, { machine: segment }),
  }
  fields(value, { commandId: segment, kind: oneOf(Object.keys(data)), data: v => { requireRecord(v, '指令 data') }, submitter: text, createdAt: isoTime, expiresAt: isoTime })
  const command = value as SchedulerCommand
  data[command.kind](command.data)
  if (command.kind === 'reserve' && command.data.requestedCores === 0 && command.data.durationMinutes !== undefined) throw new Error('[sched] 零核预留不能带期限')
  if (command.expiresAt < command.createdAt) throw new Error('[sched] 指令期限早于创建时间')
  return command
}
export function validateCommandReceipt(value: unknown, statuses: readonly string[] = ['executed', 'rejected', 'expired']): void {
  const receipt = requireRecord(value, '指令回执')
  fields(value, { commandId: segment, status: oneOf(statuses), at: isoTime, ...(receipt.status === 'executed' ? {} : { reason: text }) })
}
const reason: Check = v => fields(v, { reason: text })
/** finished 事件的可选 usage(SCHED-CORES-HISTORY-AUTOCORRECT-1010):核数非负、读数个数为正整数。 */
const usageCheck: Check = v => fields(v, {
  peakCores: item => { if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) throw new Error('[sched] usage.peakCores 必须是非负数') },
  p90Cores: item => { if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) throw new Error('[sched] usage.p90Cores 必须是非负数') },
  samples: item => { if (!Number.isSafeInteger(item) || (item as number) < 1) throw new Error('[sched] usage.samples 必须是正整数') },
})
/** requeued.data.rerun（d3）的形状校验：身份三元组 + 64 位十六进制源指纹 + 非空选择。 */
function rerunCaseFile(value: unknown): void {
  text(value)
  const file = value as string
  if (file.includes('\\') || file.includes('..') || file.startsWith('/') || /^[A-Za-z]:/.test(file)
    || file.split('/').some(part => part === '' || part === '.')) {
    throw new Error('[sched] 补跑用例文件必须是仓库内相对路径(正斜杠,不含 ..)')
  }
}
function validateRerunCaseSelection(value: unknown): void {
  fields(value, {
    identity: candidate => fields(candidate, {
      file: rerunCaseFile,
      titlePath: list(part => {
        if (typeof part !== 'string' || part === '') throw new Error('[sched] 补跑标题路径必须是非空文本')
      }, 1),
      instanceIndex: candidate => { integer(candidate) },
    }),
    sourceSha256: requireHash,
  })
}
function validateRerunEventData(value: unknown): void {
  fields(value, { reason: text, retainedFailures: candidate => { integer(candidate) }, selection: list(validateRerunCaseSelection, 1) })
}
const eventChecks: Record<EventType, Check> = {
  submitted: v => fields(v, { request: validateSubmission, contentHash: requireHash }),
  'rejected-submission': v => fields(v, { idempotencyKey: segment, contentHash: requireHash, reason: text }),
  granted: v => fields(v, { permit: validatePermit }), 'dispatch-intent': v => fields(v, { intent: validateIntent }),
  'placement-checked': v => {
    fields(v, { portable: oneOf([true, false]), reason: r => {
      if (r !== null && (typeof r !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(r))) throw new Error('[sched] 可搬原因不合法')
    } }, { detail: shortDetail, ownerSid: sid => {
      if (typeof sid !== 'string' || !/^S-1-[0-9]+(-[0-9]+)+$/.test(sid)) throw new Error('[sched] 所有者 SID 不合法')
    } })
    const data = v as SchedulerEventData['placement-checked']
    if (data.portable !== (data.reason === null)) throw new Error('[sched] 可搬结论与原因冲突')
  },
  'snapshot-ready': v => fields(v, { commit: commitHash, base: commitHash, bundle: bundleFile, bundleBytes }),
  dispatched: v => fields(v, { submissionId: segment }), started: v => fields(v, { codeRef: validateCodeRef }, { controller: validateController }),
  paused: v => fields(v, { reason: oneOf(PAUSE_REASONS) }),
  resumed: v => fields(v, { reason: oneOf(PAUSE_REASONS), actor: oneOf(['automatic', 'operator']) }),
  slowed: reason, restored: reason,
  'suspension-observed': v => fields(v, { observation: validateSuspensionObservation }),
  finished: v => fields(v, { result: oneOf(ATTEMPT_RESULTS), reason: text, terminal: oneOf([true, false]) }, {
    exitCode: value => { if (!Number.isSafeInteger(value)) throw new Error('[sched] 退出码必须是安全整数') }, logFile: text,
    usage: usageCheck,
  }),
  requeued: v => fields(v, { nextAttemptId: attemptId, reason: text, atHead: oneOf([true, false]) },
    { previousResult: oneOf(ATTEMPT_RESULTS), rerun: validateRerunEventData }),
  'cancel-requested': reason, 'marked-unsatisfiable': reason, 'cleared-unsatisfiable': reason,
  'command-received': v => fields(v, { command: validateCommand }),
  'command-executed': v => fields(v, { receipt: r => validateCommandReceipt(r, ['executed']) }),
  'command-rejected': v => fields(v, { receipt: r => validateCommandReceipt(r, ['rejected', 'expired']) }),
  'reservation-changed': v => fields(v, { machine: segment, requestedCores: oneOf(RESERVATION_LEVELS) }, { untilAt: isoTime, reason: text }),
  'owner-hold-changed': v => fields(v, { machine: segment, held: oneOf([true, false]) }),
  'ci-borrow-changed': v => fields(v, { machine: segment, ticketId, attemptId, action: oneOf(['lent', 'hold', 'release']), reason: text }),
  'log-retention-run': v => fields(v, { at: isoTime, deleted: list(text), retained: list(text), warnings: list(w => fields(w, { path: text, reason: text })) }),
}
const GLOBAL_EVENTS: readonly EventType[] = ['rejected-submission', 'command-received', 'command-executed', 'command-rejected', 'reservation-changed', 'owner-hold-changed', 'ci-borrow-changed', 'log-retention-run']
export function validateEventDraft(value: unknown): EventDraft {
  const record = requireRecord(value, '事件')
  oneOf(Object.keys(eventChecks))(record.type)
  const type = record.type as EventType
  fields(value, { at: isoTime, type: text, data: eventChecks[type], ...(GLOBAL_EVENTS.includes(type) ? {} : { ticketId, attemptId }) })
  canonicalJson(value)
  return value as EventDraft
}
/** 校验和错与语义错分开，读台账时只有前者可以作为损坏尾行丢弃。 */
export function eventWithoutChecksum(event: LedgerEvent): Omit<LedgerEvent, 'sha256'> {
  const { sha256: _checksum, ...payload } = event
  return payload
}
export function validateLedgerEvent(value: unknown): LedgerEvent {
  const record = requireRecord(value, '台账行')
  fields(value, { v: oneOf([1]), seq: v => { integer(v, 1) }, at: isoTime, type: text, data: v => { requireRecord(v, '事件 data') }, sha256: requireHash }, { ticketId, attemptId, recordedAt: isoTime })
  if (record.recordedAt !== undefined && String(record.recordedAt) < String(record.at)) throw new Error('[sched] 流水记录时间早于墙钟')
  const { v: _version, seq: _seq, sha256: _hash, recordedAt: _recordedAt, ...draft } = record
  validateEventDraft(draft)
  return value as LedgerEvent
}
