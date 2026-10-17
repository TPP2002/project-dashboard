# 跨机调度协议正本：scheduler-remote.v1

本单只冻结可执行消息契约、类型、纯判据和合成夹具。**没有实现远程调度、SSH 连接、网关、节点、daemon、文件同步、持久化或原生 watchdog，也没有切换生产。** 三个后续工位共同引用 `packages/scheduler/src/protocol/contract.cjs` 和同名 `contract.d.cts`；不得复制一份后各自修改。不依赖私有仓库、构建产物或 node_modules，运行时仅使用 Node 内置模块。

## 导出与模块职责

| 导出 | 输入 → 返回 | 失败行为 |
| --- | --- | --- |
| `PROTOCOL_VERSION` | 固定 `scheduler-remote.v1` | 无版本猜测/降级 |
| `canonicalJson` / `contentHash` | 外部 JSON 值 → 排序 JSON / 小写 SHA256 | 非 JSON、超限、危险键抛 `ProtocolValidationError` |
| `envelopeHash` | envelope 去掉自身 contentHash → SHA256 | 包含连接和执行身份；不是业务哈希 |
| `validateRequest(kind,input)` | kind 对应 payload → 脱离输入引用的结构化值 | 未知 kind/字段、坏值拒绝 |
| `BINDING_STAGES` / `ROUTES` | 各 kind 的阶段白名单 / 固定发送方与接收方 | 缺失阶段/错方向不能靠 allowedKinds 放行 |
| `validateResponse(request,response)` | 已认证请求与回复 → 关联正确的回复 | 校验 scope、requestId/请求哈希、阶段身份、对象范围或挑战；不认证、不做 IO |
| `validateLifecycleSnapshot` / `toLifecycleStatusSnapshot` | 只读机器事实 → 严格 wire 值 / 现有 readMachines 结构 | null 心跳映射为 undefined；未知 CPU 不补零 |
| `toOriginProbeResult` | 已认证且关联正确的来源证明 + cloud 保存的排队执行号 → 原 OriginProbeResult | 只转换事实；不从 wire SID/trusted 认证，不替代原生核验 |
| `validateEnvelope(input,context)` | envelope + SSH 可信上下文 → `{envelope,transport,operation}` | 身份/代际/连接/哈希错配抛错 |
| `encodeFrame` / `decodeFrame` | 合法 envelope ↔ UTF8 单行 | 不做身份认证；解码后仍须 validateEnvelope |
| `validateResult` / `validateLease` / `validateProjection` | 外部值 → 严格值 | 只做形状校验，不授予执行 |
| `operationIdentity` | immutable envelope → `{operationKey,operationHash}` | live-only 不适用 |
| `initialProtocolState` | authorityId/epoch/nodeId → 初始事务视图 | 不建立连接或读盘 |
| `acceptSessionReply` | 本地保存的 open + 首个认证业务 ACK → 客户端连接状态提案 | durable/pending/错请求/错连接不能完成握手；重复 ACK 不刷新存活 |
| `prepareAcceptance` | 事务视图、外部消息、TrustContext、本机接收单调时刻 → ready/duplicate/ignored/rejected | 拒绝携带 reason；没有 ACK 或领域效果 |
| `completeAcceptance` / `replayResult` | 准备结果 + 回执 → 新事务视图 / 绑定新 transport 的原业务回执 | 不做 IO，也不证明 durable |
| `isBusinessSuccess` | 合法回执 → boolean | 只有 business_accepted 为 true |
| `isFactFresh` / `evaluateProjection` | 本机接收事实 + 当前上下文 → boolean / allowed 判定 | 未知、旧代际、回退、过期均关闭 |
| `evaluateExecutionLease` | lease + LeaseContext → 拒绝或 deadline/watermarks | 只消费本机 outstanding challenge |
| `evaluateActiveExecutionLease` | 本机保存的已接受结果 + 当前上下文 → allowed/deadline | 不续约，不移动 deadline |
| `validateJobResult` / `evaluateResidentReservation` | 严格交接结果 / 驻留身份与本机核验上下文 → 结果 / 保留占用判据 | 不用断联推断应用退出，不触发杀进程 |
| `READ_KINDS` / `validateReadManifest` / `validateObjectDirectory` | 固定逻辑对象目录与严格分页结构 | 不接受路径或未知对象种类 |
| `authorizeProjectionRead` / `verifyProjectionObject` | 请求/完整字节 + 服务端保存的不可变 manifest + 可信上下文 → 授权 / 已核哈希字节 | 过期、缺对象、版本/大小/哈希错拒绝；返回 domainValidated=false |
| `dispatcherCompatibilityIdentity` | authorityHost、ownerMachine、权威进程显示身份 → 兼容配置及心跳身份字段 | machine 始终是 Windows 操作目标，不改变准入 |
| `validateLocalSemanticRequest` | CLI 语义请求 → 严格请求 | 拒绝自报 SID、传输 session/sequence/messageId 和原生观察 |
| `evaluateNativeRelease` | started + 业务 ACK + 同游标投影 + 已接受原生租约 → 纯 release 判据 | 缺证、取消、时钟错域或已消费一律拒绝；不实际释放子进程 |

所有参数、联合返回类型及仅定义的端口均在侧车类型中完整列出，没有 `any` payload。`json.cjs` 管 canonical/边界；`schema.cjs` 管有限基础类型；`business.cjs` 保留原提交/指令/回报；`identities.cjs`/`resident.cjs` 管阶段、来源和驻留；`job-result.cjs` 管真实结果/补跑结构；`machine-facts.cjs` 管只读机器事实；`messages.cjs` 冻结 kind 映射；`routes.cjs`/`correlation.cjs` 管固定方向及请求回复关联；`envelope.cjs` 管认证上下文/帧；`state.cjs` 管事务提案；`lease.cjs`/`native-release.cjs` 管有限判据；`read-manifest.cjs` 管对象目录/授权/完整性；`local-ipc.cjs` 管语义调用白名单。上述模块无文件、进程、网络写入；没有空 cloud/gateway/node 实现。

## 帧、信任与连接

每帧是 canonical JSON 的 UTF8 字节，加**一个 LF**；不接受 BOM、CRLF、多行、重复键、非 canonical 拼写或缺尾 LF。包含 LF 最大 **524288 字节（512 KiB）**；流式接收方必须在缓冲超过此上限时立即关闭/拒收，不能先无限积累再调用解码器。frame 不允许裸日志，诊断走独立 stderr。规范 JSON 递归按 JS 字符序排序键、数组保序、无空格，有限数沿用 JSON.stringify 的数值表示。内容哈希是该 UTF8 JSON 的 SHA256。

对象只接受普通/null 原型、可枚举自身数据属性；拒绝 getter、symbol、循环、稀疏/扩展数组、undefined、bigint、函数、非有限数和孤立 UTF16 代理项。递归深度最多 32、节点 50000、数组 4096、通用单串 262144 个 UTF16 单元，整体 JSON 512 KiB。业务进一步限长：id/segment 128，令牌 256，普通说明 4096，标题 1024，目标 256 项且每项 1024，菜单 64 个参数且每项 200；读取块最多 131072 字节。字段定义中更窄的限制优先。出生身份是正十进制 uint64 FILETIME 字符串；PID 为正 uint32；计数/序号是安全整数。拒绝任意层级的 `__proto__`、`prototype`、`constructor`。未知字段和未知操作一律拒绝，不透传扩展包。

envelope 必填：

```text
protocolVersion authorityId authorityEpoch nodeId nodeSession
messageId sequence kind contentHash payload
```

`contentHash` 覆盖 envelope 除 contentHash 自身的全部字段，包括 session、sequence、messageId、epoch 和 execution。绑定消息的 execution 是带 stage 的严格联合，由 `BINDING_STAGES`/类型 `KindBindingMap` 唯一规定：

| 身份 | 精确字段 | 真实可用阶段 |
| --- | --- | --- |
| SubmissionIdentity | stage=submission、ticketId、submissionHash、project | 已接收原始提交，尚未授予；不带 attempt/token/controller |
| GrantedAttemptIdentity | stage=granted、ticketId、attemptId、permitToken | 已授予，交接/快照/启动准备；没有 controller |
| StartedExecutionIdentity | stage=started、ticketId、attemptId、permitToken、controller={pid,creationFileTime} | Windows 控制端已真实创建并核验；started/finished、停树、续租、执行心跳 |
| ResidentIdentity | stage=resident、ticketId、attemptId、permitToken、renewer={pid,creationFileTime}、source | grant 后直接续驻留占用；不是 StartedExecutionIdentity，不带 controller |

受管执行顺序固定为 submission → origin/source request/proof → grant → handoff/snapshot → 真实 controller FILETIME → report.started → 持久业务 ACK + 同游标投影 + native lease → 原生门禁唯一一次 release 子进程。前置阶段禁止 controller 字段，不允许补 0、假 PID、假出生时间或空 token；不是把出生身份改为可选字段。启动失败尚无 controller 时，用 granted 阶段的交接 failed/quarantine 事实收尾，不能伪造 report.finished。重复出现在 payload 的 ticket/attempt/token/controller/birth 必须与当前阶段身份一致。started.pid 是 controller；resident.pid 按现存 hold 实现是实际续约包装进程，必须等于 ResidentIdentity.renewer.pid，不能冒充原已运行应用 PID。

驻留走独立顺序：resident submission → grant → 从 OS 取得真实续约者 PID/FILETIME 与原始来源证明 → resident.renewal；不发送 started，不纳入执行 Job Object，不发有限执行租约，不因登记而接管或杀原已运行应用。permitToken 仅绑定已授予的驻留占用，不构成执行授权。source 的 submissionHash 必须与 cloud 已保存的原始 resident submission 相同，renewer 与提交者来源须由可信 Windows 端核验；更换续约者须重新认证、核验当前占用并保存新出生身份，不接受旧包装器继续续约。失联/过期/renewer 退出都不证明应用已安全停止。evaluateResidentReservation 对未知或不匹配一律 retain；只有独立、当拍且出生身份一致的实际应用退出核验才返回可释放，适配器还须按原业务规则在 fence 内落账。旧文件模式按租约 mtime 到期作账务回收的路径不能在云模式充当物理停树证明；本单不改旧算法，不把那条旧路径宣称为已完成核验。

只读 artifact/log 在来源准备、已授予和已启动阶段均有用途，采用这三个严格身份的联合；访问对象仍由服务端对象登记表绑定该票据/阶段和配置根，读文件不是启动/续租授权。StateProjection.attempts 也区分 granted 与 started：前者可以是 granted 或启动前终态，不带出生身份；running/paused/slow 必须是 started。不能为了满足投影字段而编造未启动的执行进程。

`validateEnvelope(input,{principal,localRole,authorityId,authorityEpoch,allowedNodes,activeSession,lastSequence})` 的 principal 来自 SSH 服务端可信固定启动参数/固定凭据配置。其字段是 `{id,role,nodeIds,machines,allowedKinds,nativeObservation?,readAccess?}`。role/localRole 为 cloud/windows/client，固定配置在消息之外；`ROUTES` 固定方向与 allowedKinds 权限必须同时满足。原生事实还要求受信执行 node 的 nativeObservation=true；普通 CLI 不能凭 allowedKinds 提升为执行 node。allowedNodes 与 principal.nodeIds 都必须显式非空；payload 中 machine/ownerMachine 及 lifecycle 中全部配置机器还必须属于 principal.machines。消息中没有 principal/role/trusted 认证字段；来源证明中的 observedOwnerSid 仅为 Windows 核验后采得的事实，不能认证消息发送者。authenticated node 仍不能越过 cloud 的票据/令牌/菜单/任务归属业务核验；身份校验不等于业务许可。

来源取证固定为 SourceProof 严格联合：original-object-acl 带原始提交对象的 ObjectRef，ipc-peer 带经认证调用的 callId；两者均绑定 proofId、原始 submissionHash、observedOwnerSid。Windows 必须对原提交对象 ACL 或 OS 已认证 IPC 对端 SID 取证，再关联不可变提交哈希。不能由 gateway 以自己的账户重写副本后 Get-Acl，把网关所有者当提交者；旧 intake 硬链接及 portable 探测归档原件保留来源所有者的语义必须保留。cloud 持久保存提交→proof→grant 关联；仅有结构正确的 source 字段不是来源已认证。首次 origin.request 可不带尚未取得的 source，Windows 按 SubmissionIdentity.submissionHash 找到本机原件/已认证调用取证并在 origin.proof 必带 source；缺原件或 peer 取证记录返回 unknown，不用重写副本补证。后续请求若带已保存 source，回复必须精确一致；所有 proof 校验与 submission 身份同一哈希。resident.source 与 cloud 原始提交记录的关联由后续业务层核验。

取证无法完成时 origin.proof 使用 verdict=unknown、source=null、detail；不填假 SID、假对象或空令牌。verified/mismatch 必须有真实 SourceProof 与 observedOwnerSid。unknown 本身不能作为 trusted 或跨机授予证明；toOriginProbeResult 映射为 failed，后续按原准入/钉本机规则保守处理，不由 wire 改写原算法。

首次只接受 sequence=1 的 `session.open {replacesSession:null,sessionGeneration:1}`。更换连接需要新的 nodeSession，明确声明替换当前 session，并增加持久化 generation；旧 session 退休不可复活。同一个 nodeSession 不能靠增 generation 重新启用。cloud 在提交替换后关闭旧连接；来自旧连接的全部执行/live 消息拒绝。收到 open 不等于已完成握手：客户端须等该 open 的业务接受回执才能发送其他帧。

sequence 在连接内严格增加，允许缺口；旧值/等值不会刷新 lastSeen。`transport.disposition` 是初步分类，不能独自更新存活时间；必须使用 prepareAcceptance 的最终结果。未知 session 不自动建立。新 session 使旧 live observation 水位失效，但持久的 waiting tombstone、业务去重索引与 session generation 不清除。老连接上报 wall-clock at 仅展示，不能覆盖 cloud 事件钟或接收单调钟。

两个方向有各自的 sequence/lastSequence 和接收状态，不把云回包序号与 Windows 发包序号混在一条计数里。客户端用 acceptSessionReply 把经认证且绑定本地 pending open 的 business_accepted/applied 首个回包建立为接收状态；不能仅从任意回包抽取 nodeSession 填进 context。pending open 必须本地保存原 messageId/hash，重试不改内容；再次收到同 ACK 不重建时效或水位。之后的回包继续走本方向同一共享状态机。

session.open 的连接替换与 business_accepted/applied 回执须在同一提交中落地，completeAcceptance 不允许用 durable/pending 回执完成这个提案。sessionResult 单独缓存原握手结果；丢失 ACK 后同 open 可返回原结果，不能把它误作新 session 或刷新 lastSeen。拒绝握手发生在提交前，保持旧连接事实不变。

## 完整 kind / payload / 重放策略

`I` 是 immutable；`L` 是 live-only，断线时丢弃、不得离线排队或重包装重放；`Q` 是有界查询/回复；`H` 是握手。阶段栏是 execution 允许的 stage，破折号表示禁止携带 execution。C/W/U 分别为 cloud/Windows/client，精确方向以导出的 ROUTES 为准。

| kind | payload 语义（精确字段见 PayloadMap） | 策略 | 阶段 | 方向 |
| --- | --- | --- | --- | --- |
| session.open | replacesSession、sessionGeneration | H | — | W/U→C |
| submission | 原 SubmissionRequest 全部字段及可选 work/menu/usage/resident/engine 等字段 | I | — | W/U→C |
| command | 原 SchedulerCommand 全部 kind/data/期限字段 | I | — | W/U→C |
| report.started / report.finished | 原 started/finished 回报；保留 codeRef、verifier、result/reason | I | started | W→C |
| waiting.upsert / waiting.delete | 原 schema/ticketId/machine/pid/seq；delete 不带 pid | L | — | W→C |
| execution.heartbeat | 原 AttemptBeat，保留 suspend 全部区间、原因、告警字段 | L | started | W→C |
| resident.renewal | 原 ResidentLease 全部字段，execution 另绑真实 renewer 和 source | L | resident | W→C |
| origin.request | requestId/timeoutMs/machine/project/codeRef，可选已保存 source | Q | submission | C→W |
| origin.proof | machine/requestId/observationSequence/observedAt/verdict/ownerMachine/codeRef/source；verified/mismatch 带 observedOwnerSid，unknown 带 detail | L | submission | W→C |
| machine.observation | machine/observedAt/observationSequence/lifecycle，详见下表 | L | — | W→C |
| process.stop-request | requestId/timeoutMs/machine/action=observe或stop/reason | Q | started | C→W |
| process.stop-proof | machine/requestId/observationSequence/observedAt/verdict/method/evidenceHash | L | started | W→C |
| handoff.intent / handoff.publish | 完整 HandoffPublish，含原 submission、permit、快照及可选 queueRank/rerun | I | granted | C→W |
| handoff.observe-request | 交接身份、requestId/timeoutMs、expected 生命周期身份及有界 legacyIdentities | Q | granted | C→W |
| handoff.observe | 交接身份、requestId/observationSequence/observedAt/state/identity，可选结果、日志、执行根观察 | L | granted | W→C |
| handoff.quarantine | 交接身份、requestId/timeoutMs、expected、reason/createdAt | I | granted | C→W |
| snapshot.request | requestId/timeoutMs/machine/project/codeRef | Q | granted | C→W |
| snapshot.metadata | schema/ticketId/attemptId/requestId/createdAt；ready 带 commit/base/bundle/bundleBytes/object，refused 带 reason/detail | I | granted | W→C |
| launch.notice | 原 AutoLaunchNotice 全部字段 | I | granted | W→C |
| artifact.read / log.read | requestId/object={objectId,hash,size}/offset/length | Q | 三阶段联合 | C↔W，U→C |
| artifact.chunk / log.chunk | 同一 requestId、对象、范围、dataBase64/chunkHash | Q | 同请求 | C↔W，C→U |
| state.read | requestId/afterCursor={seq,hash}/limit，可选 ticketId | Q | — | W/U→C |
| state.snapshot | requestId 和完整 StateProjection，attempts 严格区分已授予与已启动 | Q | — | C→W/U |
| projection.catalog | requestId/authority-read scope/snapshotId/pageToken/selectors/limit/knownObjects | Q | — | W/U→C |
| projection.manifest | requestId/scope/snapshotId/ledgerCursor/issuedAt/expiresAt/entries/nextPageToken | Q | — | C→W/U |
| projection.read | requestId/scope/snapshotId/ledgerCursor/entry/offset/length | Q | — | W/U→C |
| projection.chunk | 同一版本、entry、范围，dataBase64/chunkHash | Q | — | C→W/U |
| lease.challenge | challenge/challengeSequence/ledgerSeq/requestedTtlMs/instances | L | started | W→C |
| lease.renewal | 完整 ExecutionLease（stage=started） | L | started | C→W |
| result | 下文四类回执及原请求身份 | Q | — | W→C，C→W/U |

command.kind 只接受 jump-queue、cancel、finish、pause-one、resume-one、reserve、owner-hold、owner-release。它们保留原票据/机器意图语义；cancel 不能被当成无需出生身份即可直接杀任意 PID 的 RPC。真正停树在 Windows 用已核验完整 execution 执行，再回 stop-proof。不存在 read(path)、write(path)、exec(shell)、全目录覆盖或生命周期目录同步操作。work.targetPaths 和 menu.args 是原菜单的业务参数，**不是**任意文件读取/命令执行授权；cloud 和 Windows 必须用公开配置的项目根、菜单白名单、受限参数解析器核验，缺配置拒绝，不把字符串拼成 shell。

机器 observation 是认证节点的事实采样，不是由它接管 cloud 调度决策：cloud 仍按原 schedulerInputs 计算 quota/available、授予、预留、锁和队列，wire 不再提供一个可绕过计算的 availableCores 摘要。origin.proof 的 verified 只能由 Windows OS 核验结果产生；客户端给出同名 JSON 字段不能变成证据。process.stop-proof 必须来自 Windows 作业对象核验；method 固定 windows-job-object，unknown/超时不是 tree-exited。云端 Linux 同 PID 不具有任何 Windows 进程证明力。

### 与 readMachines / handoff / auto / snapshot 的字段对照

机器事实采用 `LifecycleSnapshotFact`，在字段层面复用现存 `LifecycleStatusSnapshot`，没有泛型 record，也不传整个可写生命周期目录。Windows 在既有唯一 authority 下核验 owner/heartbeat 身份链并读取后才发事实。protocol 不得填本包常量代替实际运行代理号；head 必须是实际代理提交。`toLifecycleStatusSnapshot` 仅把 wire heartbeat=null 转为既有类型的 heartbeat=undefined，其余字段原样保留；它不认证也不证明事实新鲜，调用前仍须通过 envelope/状态机/freshness。

| 现存消费者 / 输入 | wire 字段与保留语义 |
| --- | --- |
| LifecycleStatusSnapshot.control | namespace=jobs-v12、lifecycleSchema=12、epoch、ACTIVE、codeVersion、configuredMachines、createdAt、createdBy；全为只读事实，不是 cloud 写许可 |
| applyPlacementChecks / OriginProbeResult | origin.proof 在认证、原生核验和请求关联之后由 toOriginProbeResult 转回原 owner/failed 结论；ownerSid 取 observedOwnerSid，trusted 由 verified/mismatch 转换而非接受 wire 自报 trusted。原 queued attemptId 取 cloud 发请求时保存的上下文，回调前仍核对当前票据/执行号；前置消息不伪造 permit/controller |
| LifecycleMachineStatus | machine、heartbeat（wire null 表示没有有效心跳）、fault（record-corrupt/identity-drift/record-missing）、五态 counts={inbox,running,done,failed,quarantine}；配置机器必须完整且唯一 |
| LifecycleAgentIdentitySnapshot / agentProtocolsFrom | heartbeat.machine/state/at/pid/**protocol/head**/ownerPid/ownerToken；故障或缺心跳保持 undefined，不用最低号或零冒充读数。ownerToken 仅用于只读身份链，不可用于 cloud 取得 jobs-v12 写权 |
| schedulerInputs / dispatcherDecisionSnapshot | heartbeat.load 的 CPU 整组 cores/busyCores/busyPct/windowSec=30/sampledAt；缺采样时整组缺省，禁止半组或补零；ci 保留 state/ciWorkers/observedAt/stateSince/runners/stale/staleSince |
| agentSlots / CI yield | jobSlots={max,running}（原 1..64 与 running≤max 判据）；可选 ciYield={ciWorkers,since}；未采得 slots 保持缺省，不填 1/0 假实测 |
| 内存与 managed load | load.memory={totalMb,freeMb,windowSec=30,sampledAt}；attemptLoad={schema,sampledAt,windowSec,attempts:[ticketId,attemptId,cores]}；ciTreeLoad={schema,sampledAt,windowSec,cores,workers}；全部有限且有界，缺值不认作空闲 |
| handoffPublication / clusterJobForTicket | HandoffPublish 带完整原 submission、原 permit（含 token/category/授予核数/ciAware/resident）、codeRef、queueRank、rerun.selection；Windows 继续用原菜单和转换器生成 jobs-v12 payload，不接收任意 payload/shell。新协议不取代接收端 agent protocol 字段闸 |
| preflightAutoHandoff | 使用同一机器 heartbeat.protocol 与原最低版本策略；snapshot.metadata.ready 保留 ticket/attempt/commit/base/**bundle/bundleBytes**，额外绑定 object.id/hash/size。bundle 仅允许由票据号导出的固定 basename，绝非任意路径；bundleBytes 必须等于对象 size。Windows 发 ready 前必须核验已配置根下普通文件的大小和 hash，cloud 用该认证事实供原 preflight 对账 |
| auto 交接 | submission.execution=auto 时仍带 origin/menu.item/menu.args/elastic；交接目标不得为 origin，snapshot 必须 ready，交接 codeRef 必须等于快照 commit；请求、快照和许可身份同时匹配 |
| AutoLaunchNotice / 启动前失败 | launch.notice 保留原 schema/ticket/attempt/submissionId/machine/token/launchedAt，绑定 granted 身份。handoff.observe 可返回 inbox/claim/transition/failed/quarantine，无需伪造 PID；只有实际采得执行根时才带 executionProcess={pid,createdAt} |
| observeHandoff / 身份对账 | observe-request 带严格 LifecycleIdentityFact expected 和最多 8 个已知 legacyIdentities；observe 回复携带原生命周期身份（namespace/schema/epoch/jobId/submissionId/machine/codeVersion/createdAt/createdBy/payloadSha256）。原双态/transition/claim-only 保留；unknown 不是 absent。回复 identity 必须是 expected 或明确列出的 legacy，不能只比单号 |

后续 cloud adapter 可以直接把 `toLifecycleStatusSnapshot` 的输出供现有 readMachines 消费，并保留原 agentProtocolsFrom/准入/preflight 逻辑；本单只证明结构契约，实际核心集成和测试仍由主控完成。Windows 的事实所有权和 jobs-v12 唯一写者没有转移。

### 云端主动请求的 wire 承载与关联

本协议采用固定 stdio 连接上的**有类型请求/回复**，没有另开任意 RPC，也没有把工作指令塞入 StateProjection。CloudRequest 联合包含 origin.request、process.stop-request、handoff.intent/publish/observe-request/quarantine、snapshot.request、artifact/log.read；CloudReply 联合包含这些主动请求以及 result/state.snapshot/lease.renewal/projection.manifest/projection.chunk/有界 chunk。ReplyKindMap/TypedReply 将每种请求与其数据回复或 result 关联；issue 与 validateResponse 的类型返回由请求 kind 决定，origin 请求不能返回停树证明。CloudAuthorityPort.issue 与 GatewayPort.receive/respond 是同一组 envelope 的端口，不增加未校验 JSON。

云侧 `issue` 在 owner.commit 之外发请求；Windows 通过 receive 收到后，先按固定 cloud principal、ROUTES、allowedKinds、node/epoch/session 和 phase 验证，再做对应本机操作，respond 送回 NodeReply。NodeReply 只允许 result、origin.proof、process.stop-proof、handoff.observe、snapshot.metadata 和 artifact/log.chunk。客户端普通调用方无权 issue 云指令，即使它的 allowedKinds 被误配为全部也会被方向闸拒绝。等待业务回执时遇到主动请求，gateway 按固定 handler 处理，再继续等原回执，不把主动请求误当调用成功。

每个主动请求有 requestId 和 1..60000ms timeoutMs；一个业务请求的 requestId 在完成前稳定不变，snapshot 的 metadata 回复也保留原 requestId；不可变 handoff 的 requestId/timeoutMs 是原内容的一部分，重传必须保留。所有双向结构化回复先 authenticate，再 `validateResponse`：scope 必须相同；非 result 用 requestId（lease 用 challenge/sequence/ledger/instances），且阶段身份必须完全相同；读取再比对象+范围，origin 再比机器+代码，handoff 再比 intent/submission/owner/authorityHost/lifecycleEpoch 和预期身份。result 用原 request.messageId/contentHash 及 operationKey/hash 精确关联。超时、未知、断线不代表执行成功/进程退出；不允许消费迟到回复来刷新本机租约。请求/回复的各自方向序号独立递增，不复制请求 sequence 充当回复序号。

handoff.intent 只在 Windows 记录并确认有界 typed 交接意图，**不发布 jobs-v12 工单、不启动执行**；handoff.publish 在 cloud 已持久化意图后调用现有 Windows 发布原语，返回该操作的业务 result。两者都携带 expected 完整生命周期身份；Windows 以原公共核心及对应 agent protocol 字段闸生成 payload 后，必须核验身份及 payloadSha256 与 expected 相同才可发布，不能忽略 expected 或相信客户端任意 payload。observe-request 返回只读观察；quarantine 按 expected 完整身份核验后调用现行隔离原语。cloud 自己的意图仍在自己的 ledger 内落账，不获得生命周期目录写权。停树请求 action=observe 只核验，action=stop 只能对完整 started 身份执行原生整树操作。

ownerMachine 是 Windows jobs-v12 生命周期权威机器；authorityHost 是云调度进程真实宿主。两者字段和职责独立，不能按字符串相等合并。cloud 唯一写调度 ledger/queue/permit/receipt；Windows 唯一写 jobs-v12 生命周期，不复制给云端再次写。handoff intent/publish/observe/quarantine 不是任意生命周期文件写入口。

dispatcher-config.machine 与兼容 dispatcher-heartbeat.machine 固定映射 ownerMachine，因为现 server/schedApi 会把 config.machine 作为 reserve/owner-hold/release 操作目标。不得填 Ubuntu authorityHost。dispatcherCompatibilityIdentity 返回这两组兼容身份字段；heartbeat.pid/protocol/head 表示云调度进程的显示身份，不可用于 Windows 进程核验；agent protocol/head 仍来自 machine.observation 的 Windows 生命周期事实。authorityHost 独立保存在 RuntimeScope 配套投影/交接字段；部署时 ownerMachine 必须显式选择已配置的 Windows 目标，缺配置拒绝，无自动挑选。此映射不改变 CATEGORY_POLICY、配额、预留、锁或原准入算法。

handoff.observe.result 使用严格 JobResult：ok、可空 exitCode、reason、notStarted、refused、rerunPlan，以及原机器/时间/耗时/日志/产物/CI 摘要。notStarted 精确为 {attemptId,state:'granted',waitedMs}，只允许 ok=false、exitCode=null，不带 refused/rerunPlan；refused 要求 ok=false/exitCode=2。rerunPlan 保留 complete、eligible 的 identity/sourceSha256/overlapMs、各类超时数、retainedFailures、sharedHookTimeouts、notes，不能只保留退出码。result.notStarted.attemptId 与 granted 身份必须一致；旧 exitCode 别名若同时存在须等于 result.exitCode。logFile/command 仅观察文本，不授予读路径或执行能力。结果原件（含完整原 SuspendRecord 等较大细节）由 resultObject 指向 job-result 对象，suspensionObject 可指向该原始记录，不能无声丢弃原件；字节读取后必须运行原结果/挂起/补跑校验再使用。目录显示 done/failed 但缺少结果原件/必要字段时只能 unknown/retain，不能推定通过或安全退出。

旧 handoff 仅观察到 jobs running 就写 started 的分支**不得在云模式沿用**；reconcile 此时返回 await-started-report。granted 的 running 观察仅表示 jobs-v12 目录状态，不是 StartedExecutionIdentity、PID 出生证明或子进程已获准执行。尚未启动失败仍通过 granted handoff result.notStarted 收尾；真正已启动后的 report.finished/stop/lease 必须持完整出生身份。

快照/日志/产物用 objectId+hash+size 表示，Windows 配置负责解析对象到批准存储根；wire 没有实际绝对路径。范围必须完全在 size 内，length 正且不超过 128 KiB；响应 base64 字节数和 chunkHash 必须吻合。请求/响应绑定同一 requestId、阶段身份、对象和范围；读完后还必须核验整对象 hash/size，不因单块正确就接受整体。snapshot 的 bundle/bundleBytes 只保留固定 basename/大小供原 preflight 对账，实际访问仍由 objectId 解析；旧路径不得直接穿过网关。state.snapshot 是同步许可判据的完整、有界执行投影，不是整本账本；主动指令走 CloudRequest。超 1024 个执行的完整投影本版拒绝，不能截断还标 complete=true。

## 有界权威读取目录

StateProjection 是执行门禁的有界许可视图，包含 cancelRequested，但不冒充 CLI/UI 所需的完整票据或整个账本。空队列的配置/心跳查询走 projection.catalog/read：scope 固定为 {kind:'authority-read',authorityId,authorityEpoch}，禁止 execution，不需要票号、令牌或 PID。票据级 artifact/log.read 继续保留原三阶段对象读取语义。两类读取都只能解析服务端登记的 ObjectRef，绝不接受客户端路径或任意 JSON RPC。

ProjectionObjectBodyMap 冻结以下有限逻辑种类。索引统一为 ObjectDirectory {schema:1,snapshotId,ledgerCursor,entries,nextPageToken}；entries 使用同一 ReadEntry，至多 64 项，继续页必须沿用 snapshotId。它不是全量列表承诺，也不复制一套 UI DTO。完整原领域体通过对象分块取得，目录条目不是把所有领域字段塞进 envelope。

| 固定 kind | 对象内容 / 必须复用的既有领域校验 |
| --- | --- |
| ticket-index / ticket | 分页目录 / 完整原 TicketSnapshot（request/contentHash/attempts/timeline 等全部字段）；使用原 ticket/readTicket 形状、提交哈希、deriveTicketId、currentAttemptId、事件与计时守恒校验，禁止自行缩减 |
| scheduler-format | 原 SchedulerFormat，运行 assertWritableFormat/能力闸；不能把 remote 版本当原 format 版本 |
| dispatcher-config / dispatcher-heartbeat | 原 DispatcherConfig / 完整 DispatcherHeartbeat，运行原配置 reader 与 validateDispatcherHeartbeat；兼容 machine 映射见上文 |
| command-receipt-index / command-receipt | 分页回执目录 / 原 CommandReceipt，运行 validateCommandReceipt；传输 result 不能代替命令业务结果 |
| ledger-index / ledger-segment | 分页分段目录 / readonly LedgerEvent[]；每段固定 segmentId/fromSeq/throughSeq，throughSeq≤manifest cursor，逐事件 validateLedgerEvent 并用原账本重放/校验链，校验跨段衔接与截止点；不读增长中的文件尾 |
| hub-switch / ci-policy / memory-floor | 原 HubSwitch、原策略对象；memory-floor 的 selector 必带 view=config/state，分别返回原配置或 {formatVersion,at,machines} 状态边车（MemoryFloorObjectBodies）。复用公开 hub-switch reader、parseCiPolicy、parseMemoryFloorConfig 与原 statusMemoryFloor 新鲜度/形状校验，不改变冻结/共存/内存准入 |
| managed-overuse / usage-history / project-trunk-head | 项目范围的原 {formatVersion,at,tickets:TicketOveruse[]}（条目保留 ticketId）、UsageHistoryFile、原 trunk head 字符串；复用 validateTicketOveruse、statusOveruse 新鲜度/逐项检查、既有 usage/trunk reader 校验和排序/历史上限，不跨项目混装 |
| execution-index / snapshot-metadata | 指定 ticket+attempt 的分页对象目录 / 原快照语义及 ObjectRef；读到旧 manifest 体后仍调用 validateSnapshotManifest，对 wire metadata 用本协议 snapshot 校验 |
| artifact-manifest / artifact-zip | 原 ArtifactManifestBody（files/rejected/truncated/detail 等保留）/ zip 字节；原产物 manifest/path/zip 检查继续负责解包安全，不把 ObjectRef 视为任意写授权 |
| log-descriptor / log-segment | 严格 LogDescriptorBody（encoding、totalBytes、分页 segments 与同版本 cursor）/ 原始 UTF8 日志字节；按段核对顺序、范围、整对象哈希，缺段不作完整日志 |
| job-result | 原结果完整细节及原挂起记录；JobResult/原结果、挂起和 validateRerunPlan 校验分别执行；有界字节正确不等于领域可信 |

ticket-index 必须覆盖其授权范围内 queued、unsatisfiable、registerOnly、resident、各 terminal 票据，而不只是 StateProjection.attempts 中的许可。owner 的 waitFor 依据不可变 ledger segment 截止 cursor 取事件；node 的 waitFor 从获授权完整 ticket.timeline 中按 afterSeq 取该票据事件，不能因此获得全局账本权限。readTicket 取得原 TicketSnapshot；validatePermit 取得原 cancelRequested、permit.machine/category、request.work.type，继续执行原验证。不能因某票据不在执行投影中而把它当不存在。范围内无对象时返回空目录；无读取权限、未配置、过期/丢失页或对象必须明确失败，不能伪装空队列。

读取流程：catalog 用 selectors（最多 32）、limit（1..64）、snapshotId/pageToken 或首次 null；cloud 在权限内冻结版本，回复 manifest，含 issuedAt/expiresAt、cursor、每项 ObjectRef={objectId,hash,size}、audience 与 contentType。pageToken 由 cloud 生成并绑定主体、selector、版本及页，不能解析为路径；后续页不得切版本。validateResponse 校验 requestId、scope、selector/limit、固定 snapshot 和分块关联。knownObjects 只供命中哈希缓存，不能绕过当前 manifest/授权/有效期。目录内的子条目若不在当前服务端 manifest 页，必须以同 snapshot 的 typed catalog 获取对应条目；不能由客户端提交一份索引就使服务端信任其成员。

所有分块与请求绑定同一 snapshotId、ledgerCursor、完整 ReadEntry、offset、length（1..128 KiB）；服务端用**自己保存的** manifest 调 authorizeProjectionRead，不能用请求者提交的 manifest 作授权依据。每块校验 base64 长度与 chunkHash，完成后 verifyProjectionObject 校验完整 hash/size 与显式 maxObjectBytes，返回 domainValidated=false。调用方在完整、已核字节上复用上述原严格 validator，不能把裸 bytes 描述为已经做过领域校验；zip/log 的 hash 也不证明执行结果或停树。零字节对象通过整对象核验，不伪造正长度读取。过期、缺块、错范围、对象被替换、总长/整哈希错误均拒绝；禁止把两个版本的块拼起来，禁止失败后把缓存刷新为新事实。

权限来自固定 principal.readAccess：owner 管理主体可读授权 authority 的所有固定目录种类；node 只能由 windows principal 使用，显式配置 machine、projects 与 authorityKinds。全局 ledger-index/ledger-segment 永远 owner-only。authority audience 仅限 scheduler-format/dispatcher-config/dispatcher-heartbeat/hub-switch/ci-policy/memory-floor，且 node 必须显式列入 authorityKinds；ticket/回执/执行索引、结果、日志、产物、usage/trunk/overuse 采用 project 或 machine-project audience，须项目成员资格，后者另需匹配受信 machine；敏感对象可进一步设 owner audience。索引与每个子对象/每个分块都重新检查权限，不能由可读目录推导所有子项可读。catalog 实现必须过滤/拒绝未授权 selectors 和条目，不能先暴露全目录再只拦 bytes。

云 UI 同机仍可直接读权威 sched 目录及既有 reader，无须绕 Windows 镜像。Windows 只按当前需求订阅有限票据、heartbeat、policy、index；复用 ObjectRef hash 缓存和游标增量，有界分页/分块，不每拍传全账本/全票据。在 3Mbps 链路下也不以整目录重传作为默认实现。执行投影的 complete 只针对明确门禁视图，不是“全量 UI 同步完成”；丢失读缓存不授权执行或释放占用。

## 幂等、ACK 与提交边界

结果精确区分：

* `durably_received`：请求的不可变身份/输入已持久接收，附 durableSeq；不是已授予、已取消或已执行业务。
* `business_accepted`：业务提交完成，附 businessCursor 和 typed outcome（submission/command/report/applied/object）。CLI 语义成功只认此值。
* `business_rejected`：附 businessCursor 和原因；不当成 CLI 成功。
* `business_pending`：附 businessCursor、原因和 1..60000ms retryAfterMs；不是成功，不能据此开跑。

四者均绑定 messageId、envelopeHash、operationKey、operationHash；非 immutable 操作后二者均为 null。accepted 的提交/指令/回报必须返回对应 outcome 类型。客户端还须匹配本次请求身份、结果 ticket/attempt/commandId，再解释业务含义。command 接受只是意图落账，不能伪报执行已停止。

operationKey = canonical JSON 数组 `[authorityId,kind,...naturalIdentity]`：submission 用全局 idempotencyKey（不拼 project，保留原全盘占键语义），command 用 commandId，report 用 ticketId/attemptId（phase 在 kind 中），handoff 用 intentId，snapshot/launch 用 ticketId/attemptId。operationHash 覆盖 authorityId/kind/payload/execution，**排除** epoch、nodeId、session、messageId、sequence。其作用域是同一个稳定 authority 的整个业务命名空间；同业务由另一个已授权节点重送仍不能造成第二份执行。cloud 持久层的 operationKey 唯一索引必须是 authority 全局，而不是每连接或每节点一份。

messageId 的去重作用域是 authority+node；它的语义指纹覆盖 kind/payload/execution 与 authority/node，但不覆盖 session/sequence/epoch。跨连接重发相同 messageId、相同内容，在新连接握手后返回原业务结果；同 messageId 改内容拒绝，即使重新算了 envelopeHash。不同 messageId 相同 operationKey/hash 也只返回原业务结果。相同 operationKey 异 hash 永久冲突。已终局的业务结果和原 businessCursor 不可改；重放只重绑当前 messageId/envelopeHash，不推进业务游标。领域拒绝也是可重放结果；pending 可以经后续真实提交变终局。

纯状态机保留以下互相独立的水位：连接 activeSession/sessionGeneration/retiredSessions，传输 lastSequence，接收 lastSeenMonotonicMs，业务 businessCursor，message 指纹，operation 身份/原结果，waiting 的 seq/deleted 墓碑，liveStream 的 observationSequence。ready 的新事实才更新 lastSeen；重复业务、重复消息、乱序、旧 session 和被墓碑压住的 upsert 都不能刷新。即使新 transport 带相同 operation，仍不算新的存活证据。墓碑 seq 必须大于欲删除的 upsert；后续客户端在新连接也必须延续该票据 seq，不能重置为零躲过删除。新同票据 waiter 需先取得持久水位后再增加。offline 期间不排队 waiting/beat/renewal/机器事实；恢复连接重新采样。

ignored 是传输/实时事实拒绝，nextState 可含已消费序号/负事实水位，只有 business_rejected 可完成；不为被旧传输丢弃的 immutable 操作占业务键。新 transport 可重发它。rejected 是边界校验失败，没有可提交提案。duplicate 且无原结果说明不可变请求仅接收未完成，不能编造 accepted；读取/恢复 durable inbox 后继续原业务处理，返回真实 pending 或持久的原结果。live 重复不需存离线重放结果。

`prepareAcceptance`/`completeAcceptance` 都只是**事务提案**。后续 cloud 必须实现 `DurableAcceptancePort.commit({expectedRevision,prepared,result,nextState},options)`：在现有 owner fencing 同步提交区内，再检查全局 operation 唯一约束、输入版本、活动 session/epoch 与 revision，把领域事件、不可变 inbox/身份预留、去重结果、游标、session/墓碑水位原子或可恢复地提交并 fsync；完成之后才能 ACK。durably_received 也必须先提交输入及 operationHash 预留；业务未完成时 result=null，不让另一份同键异文趁窗口进入。不能把 completeAcceptance 的内存返回值、write 调用开始、文件存在、Node timer 或测试 fixture 当 fsync 证明。IO/CAS/fencing 失败不发成功 ACK；重启从已提交 inbox/结果恢复。live payload 不存为待执行 inbox，只提交必要的去重/墓碑水位和当拍领域事件。

ProtocolState 是有限事务视图，不是本单提供的数据库。后续 adapter 从持久索引装入所需 node 状态及 authority-global 相关 message/operation/墓碑命中项，在同一 fence 下完成比较和落账；纯函数不能证明该视图完整。命中索引必须跨重启可恢复，不能因视图条数/帧上限而清空历史去重、退休 session 或 tombstone。溢出时拒绝并加载正确的有界视图，禁止无声淘汰。cloud 重启增加 authorityEpoch，清空旧进程的接收单调时效，要求重新握手/采样；保留 authority 业务索引。不得用旧进程的 monotonic 数字作本次进程的新鲜证据。

## 有限执行租约与投影

ExecutionLease 必须绑定 authorityId/authorityEpoch/nodeId/nodeSession、ticketId/attemptId/permitToken、controller 的 PID+FILETIME、ledgerSeq、challenge/challengeSequence、leaseId/leaseSequence，以及 gatewayInstance/nodeInstance。leaseSequence 和 challengeSequence 是当前连接/实例下严格递增的安全正整数。leaseId 不得复用。ledgerSeq 必须匹配本机发出的该次 challenge，且不低于调用方所需的最小领域水位；不得把“另一张单引起的全局新事件”无条件解释为当前许可失效，也不得允许比许可所需水位旧的投影。

Windows 原生 watchdog 发送 challenge **之前**在自身时钟域保存 LocalChallengeRecord：完整身份、实例、clockId、clockDomain=native-stopwatch、本机 monotonic sentAt 和 requestedTtlMs。C# Stopwatch 与 Node performance.now 的基点不同，不能互减、转存后直接复用或由 Node 代记 sentAt。wire 不携带可信 sentAt，不能从 ACK 的时间、远程时钟、文件 mtime 或重启后的缓存重建它。默认 TTL=30000ms，最大 60000ms，实际租约不得超过请求 TTL。

`evaluateExecutionLease` 以 `sentAtMonotonicMs + lease.ttlMs` 为唯一本机截止点；到边界即过期。收到迟到 ACK 的 now 不会再得到一个完整 TTL。必须同时核对未消费 challenge、challenge/lease 高水位、consumedLeaseIds、ledger 水位、实例/session/epoch、clockId、单调时钟未回退、实际控制端出生身份和已知的新鲜本机事实；ExecutionFact 还须匹配本机 machine+ticket+attempt+token+birth，不能拿另一执行的新鲜事实代替。缺任何条件 fail closed。成功返回新水位，Windows 必须在允许动作前消费并保存它们，不能并发接受两次同 challenge。需要延长时先发新的 challenge，旧 lease 不能重新接受。

`evaluateActiveExecutionLease` 只复核 Windows 本机已接受并保存的结果，deadline 不移动。该参数不是任意 wire 值；不能把服务端传来的 allowed/deadline 当本机接受结果。gateway/node 重启实例变更、session 替换、epoch 改变或 monotonic clockId 改变都使旧结果失效；不能把缓存当恢复许可。PID 数字相同、FILETIME 不同就是不同控制端。未知进程/原生核验失败不批准执行，也不能凭未知身份误杀其他树。

投影完整批次必须含 snapshotId、complete=true、ledgerSeq、businessCursor、sessionWatermark、liveWatermark、所有 RuntimeScope 身份和有界完整 attempts。evaluateProjection 除结构还比较调用方所有最小水位。freshness 的 observedMonotonicMs 必须来自当前实例收到且通过共享状态机的新事实；重读磁盘、重新解析同一缓存、wall-clock generatedAt 或重复 envelope **不能**刷新它。`isFactFresh` 用严格小于 maxAgeMs 的年龄（最大 60s），拒绝未来观测、回退、未知事实、错 clockId/session/epoch/实例。shape-valid projection 本身不是执行批准，执行还需绑定许可、原生事实和有限租约。

**最终停树必须由独立的 Windows native watchdog 保证**，后续 node 工位负责证明在 JS 阻塞、gateway/node 退出、断网和租约逾期时仍能整树停下。context 中 nativeWatchdogArmed/controllerVerified/executionKnown 是可信本机适配器提供的核验状态，不是消息字段；合成夹具里的 true 只用于纯判据分支测试。本单不把 Node setTimeout、心跳循环、SSH 断连或签名字段的存在当停树证明。

NativeStartGatePort.prepare 先创建受控暂停门禁并返回真实 controller FILETIME，尚不 release；report.started 只报告该真实身份。cloud 必须在持久提交 started 后回 business_accepted，且返回不早于该回执 businessCursor 的已认证投影（同游标时 hash 必须相同），仍包含同一身份的 started、running、cancelRequested=false；其他票据后续落账不使本任务的启动回执失效。Windows 原生端还须接受绑定该身份、实例和投影 ledgerSeq 的有限 lease。evaluateNativeRelease 同时核对三证及 releaseConsumed=false，仅作纯判据；真正 release 由原生宿主原子消费 gateId，最多一次。任何缺证/旧 cursor/取消/未知/过期都不 release。native watchdog 的截止线程不能被 Node 阻塞或 C# ReadLine 等消息读取阻塞；即使输入线程卡住，也须按其自身 sentAt+TTL 停整树。后续工位须证明这个实现，不能把本纯函数或接口存在当已完成原生保证。

## 跨工位函数端口（仅接口，没有空实现）

原生启动的消费者使用 `gateway.execution.prepareObservation` / `sendPrepared` 两步。prepare 由唯一 gateway 分配序号和消息编号、封装并校验实际 envelope，返回 `preparationId` 及原文，尚不发送。句柄绑定操作系统核验的 peer、当前连接代际，不能把 frame/principal/session 当成 sendPrepared 的输入。网关串行保留该发送位置，准备阶段最长 5 秒，超时或断线释放位置并拒绝发送，不无限阻挡其他调用。started 经 sendPrepared 返回实际原文与关联的业务 ACK，交给 native gate 校验。lease.challenge 先 prepare，再由 native 记录原文挑战及自己当前的 Stopwatch 时刻，之后才 sendPrepared；返回关联的 lease.renewal 原文给 native。准备、排队和 IPC 时间都消耗现有 TTL，不从回复到达时重新计时。实时挑战不能持久离线重放；普通客户端不能调用这个受信端口。便捷 acceptObservation 保留给不需要原文的非租约事实。

产物首次发现使用现有 `handoff.observe-request` → `handoff.observe`：当 result.artifacts 含 manifest/zip 文件名时，回复必须带 artifactObjects。ready 分支给每个被命名文件的 ObjectRef（objectId/hash/size），zip 大小与原统计一致；随后 cloud 用相同 ticket/attempt 的 artifact.read 按块取字节、核整文件 hash，再发布自己的只读目录。node 只在原 jobs-v12 产物根内注册这些对象，不把文件名当任意路径。无法取得实物时返回 unavailable 及原因，不能编造哈希或把“文件未取回”变成已下载。resultObject 仍只指作业结果原件，不承担产物目录语义。

类型正本中的端口可经固定 SSH framed stdio 或其他已有承载实现，本单不增公网端口。函数签名见 contract.d.cts；共同错误类型 PortFailure 的 code 为 TIMEOUT、DISCONNECTED、FENCED、NOT_CONFIGURED、IO_FAILURE。CallOptions 必须显式提供正的有限 timeoutMs（上限 60000ms）；到期抛 TIMEOUT，不能无限 pending、不改写为业务成功。ProtocolValidationError 拒收输入；未收到回执的 immutable 调用结果是未知，允许按原 operationKey/hash 有界重试；live 调用丢弃，重新采样。端口实现必须核验返回 envelope 与请求的 authority/node/执行/对象/requestId 关联，不能只看 kind。

| 工位 | 冻结端口 | 行为 |
| --- | --- | --- |
| cloud | `CloudAuthorityPort.accept(principal,CloudInbound,options): Promise<CloudReply>` | SSH principal 是独立实参；只接收允许的入站消息，CloudReply 可以是已校验的主动请求 |
| cloud | `issue<K>(principal,Envelope<K>,options): Promise<TypedReply<K>>` | K 仅限 CloudRequestKind；提交区外发送固定操作，principal 是远端 Windows 的可信身份配置，发送身份固定为本地 cloud；回复必须通过 validateResponse |
| cloud | `snapshot(principal,Envelope<'state.read'>,options)` | 当前 epoch 的完整批次或明确 result；不读客户端给的任意路径 |
| cloud | `leaseReply(principal,Envelope<'lease.challenge'>,options)` | 核验账本当前执行与全部绑定后给 renewal/result；不重新解释 Windows sentAt |
| gateway | `GatewayPort.exchange(envelope,options)` / `send(envelope,options)` | 前者 CloudReply，后者 ProtocolResult；send resolve 不等于 CLI 成功，仍须 business accepted |
| gateway | `receive(options)` / `respond(NodeReply,options)` | 同一 framed stdio 上收 cloud 主动请求并发关联回复；respond 完成只代表发送，不伪造对端业务 ACK |
| gateway | `readFreshProjection(context)` | 同步仅读本机缓存并调用共享判据；拒绝 stale，不联网兜底 |
| Windows observation | `ExecutionObservationPort.request(input)` / `take(input)` | 两者异步；input 按 kind 严格区分 origin 的 SubmissionIdentity+OriginRequest 与 process-stop 的 StartedExecutionIdentity+ProcessStopRequest，外加 RuntimeScope；take 返回 pending/observed/unknown，错身份结果丢弃 |
| handoff | `HandoffPort.intent(input)` | 同步产生 intent；在 owner.commit 中持久化；无网络 |
| handoff | `publish(intent,options)` / `observe(intent,options)` / `quarantine(intent,reason,options)` | 提交区外异步调用 Windows jobs-v12 唯一 authority；任何未知不伪造 absent/done |
| handoff | `reconcile(intent,observation)` | 同步纯判据，输入是已收集观察，返回 retain/publish/quarantine/await-started-report/record-finished 草案 |
| local CLI | `LocalClientPort.call(request,options)` / `LocalGatewayPort.accept(peer,request,options)` | submit/command/read/read-object/wait/resident-renew 语义操作；peer 由 OS ACL/认证提供，禁止从 CLI JSON 取得 SID |
| gateway source | `captureSubmissionSource(peer,callId,submissionHash)` / `captureResidentIdentity(peer,request)` | 采真实提交者来源与实际续约进程出生身份，不伪造应用执行控制端 |
| local runtime | `RuntimeScopePort.current(options)` / `changes(afterGeneration,options)` | 获取与异步通知 generation/connection/scope；断线和替换通知使旧缓存/门禁失效 |
| native node | `TrustedExecutionNodePort.acceptObservation(peer,observation,options)` | 独立 ACL/凭据端点，仅受信执行 node 可给 typed 原生观察；gateway 包 envelope，不让 CLI 冒报 |
| native gate | `NativeStartGatePort.prepare/recordChallengeSend/acceptLease/release` | 真实出生、原生挑战钟、验租、消费一次释放；实际线程与整树保证由后续 node 实现 |
| persistence | `DurableAcceptancePort.commit(input,options)` | cloud 独占提供真实 durable/CAS/fencing；不是协议包提供的假数据库 |

调度拍次顺序：同步 commit 意图 → 离开 owner.commit → 异步 request/publish/take/observe → 下拍同步 fence 核验身份与新鲜度 → reconcile/领域落账。不得在 owner.commit 回调中 await、返回 Promise 或做网络调用；调度锁不跨网络。接口定义不替代实际账本迁移规则，后续实现不得为了满足类型而在锁内做网络或 mock 一条回复。

同一个 Windows 节点的常驻 gateway 独占上行 nodeSession、sequence、传输 messageId 和 SSH 连接；多个 CLI/执行器只经本机语义 IPC 复用它。CLI 不得每条命令 session.open 替换活连接，不传 envelope、nodeSession/sequence/messageId/principal/SID，不暴露 GatewayPort 为普通 CLI RPC。callId、submission.idempotencyKey、command.commandId 是稳定语义/业务身份，由 gateway 分配与持久关联 transport 身份，跨重试不能改业务内容。read 返回固定 manifest，read-object 返回有界 chunk，CLI 再校验整对象与原领域体；wait 返回该票据的新 manifest 或 pending，afterSeq 只过滤已授权 ticket.timeline。LocalSemanticReply 的 business 分支仍须 isBusinessSuccess，不把传输发送完成当成功。RuntimeScopePort 的初始/变化都带递增 generation；connected 才有有效 scope，断线/替换立即通知；消费者据此作废缓存、outstanding challenge 和旧实例许可。ACL、命名管道认证、超时与实际通知实现由网关负责，不能用 shared fixture 顶替生产 IPC。

## 公开 selfhost 配置与切换

部署者必须显式选择稳定 authorityId、当前持久 epoch、authorityHost、Windows ownerMachine、localRole、allowedNodes、每个固定 SSH 凭据对应 principal 的 role/nodeIds/machines/allowedKinds，以及对象根/菜单白名单/项目根。固定 SSH forced-command 不得接受来自客户端的 shell 或路径参数。principal 由该 forced-command 可信启动配置注入，不能从帧、环境透传的自报身份、submitter 或 ownerSid 认证。云和 Windows 两个方向都配置相应 principal，不默认信任云回帧。公开安装无默认信任主体、默认节点、默认 IP、私有账号、真实路径或开发者 token。下列只是合成配置结构示意，不能作为生产默认：

```json
{
  "authorityId": "example-authority",
  "authorityEpoch": 1,
  "authorityHost": "example-cloud",
  "ownerMachine": "example-windows",
  "localRole": "cloud",
  "allowedNodes": ["example-node"],
  "principal": {
    "id": "example-fixed-credential",
    "role": "windows",
    "nodeIds": ["example-node"],
    "machines": ["example-windows"],
    "allowedKinds": ["session.open", "submission", "lease.challenge", "projection.catalog", "projection.read"],
    "nativeObservation": true,
    "readAccess": { "role": "node", "machine": "example-windows", "projects": ["example-project"], "authorityKinds": ["dispatcher-heartbeat", "ci-policy"] }
  }
}
```

旧共享盘 formatVersion 与 remote protocolVersion 是不同协议域；不得把 v1 字样相同当兼容。必须 reader-before-writer：先部署并验证所有 cloud/gateway/client/node 严格读者、原生核验及 watchdog，再停止旧唯一调度写者及自动重启来源，校验备份/账本/墓碑/业务索引，启用新 writer。新帧使用独立固定 SSH 入口；旧 reader 必须明确拒绝，不往旧 JSON 文件里加一个可忽略 capability 假装切换。回退同样先 fence/停止新 writer，恢复单一经校验副本，不产生双写 ledger 或双写 jobs-v12。实际切换、部署、原生停树和用户验收均属于后续单。

## 共享夹具与验证交接

`fixtures/protocol/scenario.json` 是纯合成身份与预期序列；`messages.cjs` 为全部 kind 提供可 require 的合成样本和租约上下文；`phase-flow.cjs` 按真实 submission→来源证明→grant→快照/交接→started 顺序给出无预造 PID/token 的消息序列；`resident-flow.cjs` 则直接 grant→真实包装器续驻留占用，不出现 controller/started；`read-directory.cjs` 提供完整原票据七种状态与空队列心跳/目录原件。notStarted/null exit、拒绝/补跑结果与本机 IPC 场景亦使用合成身份。不是生产配置、持久层、IPC 或节点实现，不能被后续工位当生产端口导入。

`test/cloudSchedulerProtocol.test.cjs` 真实 require 正本，覆盖每种字段白名单、认证/epoch/session/sequence/hash/出生绑定、所有 command kind、业务去重与 durable 窗口身份预留、同 ID 异文、共享 direct/framed 序列判定一致、乱序心跳不刷新、墓碑压旧 upsert、租约延迟/重放/回退/重启/PID 复用/过期挑战、投影批次水位和有界读。它只验证协议，不伪造 fsync、真实 SSH、Windows OS 或 watchdog 证明。

本施工方按工单未执行该验收。主控/派单器须通过正式调度入口执行单文件测试，Node `--test-concurrency=1`；不得裸跑、改断言或把 fixture 序列通过当成真实多机执行证明。独立包的现有安装/构建测试不代替本协议验收，也不把旧集成基点的通过结论借给新文件。

未确定语义：本单无另行选择项。后续仍须实际实现并证明 durable commit、SSH 可信参数注入、对象访问授权、Windows 原生事实、独立 watchdog、单一生命周期 authority 和读者先行切换；这些不是本单完成的功能。
