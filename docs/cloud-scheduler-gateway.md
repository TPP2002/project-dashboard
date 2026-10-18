# 调度网关接口与部署要求

网关连接云端单一调度权威与 Windows 执行节点。部署前须完成正式验收及真实 SSH、本机身份与权限验证；账号、ACL 和 writer 切换由部署负责人批准。

## 固定入口与单一权威

- `gateway/cloud-hub.cjs` 导出 `createCloudHub({getAuthority, config})`。`listen(socketPath)` 只允许 `config.entries` 中的固定 Unix socket；每个 entry 包含 `{socketPath, principal}`。所有 entry 调用同一个 `getAuthority()` 返回的 `CloudAuthorityPort`。它不导入调度 writer，不创建 jobs-v12，不读旧共享盘。
- `gateway/cloud-stdio.cjs` 是 SSH forced-command 入口，参数只能是一个绝对配置文件路径。配置包含 `{socketPath, timeoutMs}`。身份由管理员配置的 socket entry 绑定，帧没有认证字段；`accept(principal, envelope, options)` 的 principal 独立于报文传入。
- `gateway/windows.cjs` 导出 `createWindowsGateway({config,onCloudRequest,onLocalExecution})`，提供 `start/close/port/semantic/execution/runtime/submissionSources/replyTo/health`。一个实例独占上行序号、会话代次和不可变 outbox；普通 CLI 不接触 SSH。
- `gateway/client.cjs` 导出 `createSemanticClient(config)`，提供 `call/readObject/runtime/close`。每个本机客户端保持一个原生 IPC 辅助进程，多个调用复用该进程身份；该进程不是上行网关，不创建 SSH 会话。调用者结束时必须 `close()`；父进程退出导致 stdin EOF，辅助进程停止。

`hub.sendToNode(nodeId, request, options)` 接收 cloud authority 已构造的 envelope，不分配云端序号。Windows 的 `onCloudRequest` 只交给 node adapter；adapter 使用 `gateway.replyTo(request, kind, payload, identity?)` 返回 NodeReply。`replyTo` 先校验关联，再通过唯一 sender 排入发送队列，避免返回回复与并发 CLI 争抢序号；`port.respond` 等待同一发送，不重发。

`execution.prepareObservation(peer, observation, options)` 返回 sealed 原文和 preparationId，绑定经过核验的 SID/PID/出生时间/登录会话及连接代次，发送位置最多保留五秒。`execution.sendPrepared` 只能使用该句柄，返回 `{envelope,reply}`。普通调用者无法使用受保护端口；未知、异主、超时或旧连接句柄均拒绝。native 必须在 prepare 之后、sendPrepared 之前记录挑战与自己的计时点。`acceptObservation` 按正本排除 lease.challenge，不编造 ACK。

`createSemanticClient().execution` 经同一持续原生客户端进程访问独立 execution 管道，保留 prepare/send 的同一 peer 身份并复核返回原文和关联回复。同账号的客户端 helper 不因 SID 相同自动获得该权限。同进程 node 用固定 `readProjection(stateReadPayload, options)` 取得已认证投影并更新 `readFreshProjection` 缓存；它只封装 `state.read`，不接受任意 kind、路径或传输身份。原生启动/续租消费者使用上述冻结的两步接口。

主控现有组合入口无需新增服务账号。`gateway.start()` 完成后，组合进程调用 `gateway.localExecutionPeer()` 获取原生 helper 从操作系统查询的本进程 PID、creationFileTime、Token SID 和 logon session；把该值交给现有 node `prepareExecution({peer,...})`。已读取实际消费者：node 保存这个 peer，并在 started 和 lease 两步调用中原样交回 `gateway.execution`。本方法只在进程内部暴露，不在本机 RPC 白名单上，也不改变共享协议签名。native gate 的独立子进程、Stopwatch 记录和 release 校验仍由 node 原有消费者负责，不能用这个调用者身份代替执行树 controller 身份。

可信配置中与普通端口重叠的 SID，未指定 PID 时只绑定本次组合进程的真实出生身份；若指定 PID，则必须同时提供精确出生时间并在启动时通过真实 OS 复核。后续每次可信调用、准备发送前和回包交付前均重新查询真实存活进程；PID 被复用、出生时间或登录会话变化、进程退出均拒绝。helper/组合进程退出关闭管道并撤销内存绑定，重启重新绑定。普通管道仍只开放语义方法；相同 SID 的其他进程不能调用 execution。两管道各自拥有不继承的 DACL，同账号情形叠加上述精确进程门禁，不把 DACL 的 SID 匹配当成执行身份认证。

主控接线使用 `onCloudRequest` 回调模式。没有配置回调的端口消费者可以使用 `receive → replyTo → respond`；此时请求进入有界队列。两种模式互斥，避免同一动作被 callback 和 receive 两次执行；回调模式调用 receive 会明确返回 NOT_CONFIGURED。

## 本机运行转交与提交原件

组合入口把 `onLocalExecution(peer,request,options)` 接到 node 的 `handleLocalExecution`。只有共享本机语义的 `local-run/local-run-read/local-run-cancel` 进入此回调，peer 由真实命名管道探针提供，与 JSON 请求分开传入；回调有调用时限，回包必须通过共享 `validateLocalExecutionReply`，保留非零或 null 退出码。运行授权、子进程和取消动作仍由 node 处理；网关不执行 command/args，也不把这三个本机 kind 转成 SSH 消息。断开上行期间，读取结果和取消仍可到达 node，不能据此绕开 node 的许可与连接代次检查。

公开的 `createSemanticClient().call` 已接入 execution 分支：只有上述三个本机请求能接收这种回包，且这三个请求收到其他回包类型也明确失败。客户端调用共享 `validateLocalExecutionReply`，再验证 read/cancel 的 runId；read 另须匹配 stdoutOffset、stderrOffset，两流实际字节合计不得超过本次 maxBytes。字节数按验证后的偏移差计算，不能把多字节文本的字符数当字节数。输出保持原 base64 内容，非零退出码、null 和未启动结果原样保留；这些回包不授予普通调用者原生 observation 权限。

`submit` 必须携带 `localContext:{cwd}`。网关先用共享 validator 验证，再把原 request、来源证明、实际 OS peer 和规范化 cwd 放进同一份受保护状态，经 fsync/rename 原子提交之后才发送 submission。cwd 只做绝对路径的词法规范化，保留提交 worktree，不替换成 catalog 主仓，不读取或重建原件文件来冒充其 ACL。来源与原件记录条数受 `storage.maxOperations` 限制，总字节受 `storage.maxBytes` 限制；默认分别为 4096 和 16 MiB，满额拒绝。

`gateway.submissionSources.get(identity,expectedSource,options)` 是只读进程内端口，不在普通 RPC 白名单。它逐次重算原 request 的 hash，调用既有领域 `deriveTicketId`，核对 project、来源证明与已保存 OS 身份；指定 expectedSource 时须完整一致。成功返回深副本，缺失、损坏或不一致返回 unknown。`captureSubmissionSource` 保留原接口，但其 source-only 记录不能被 getter 当作原件，也不能自动补成原件。原件重试必须保持原 request、callId、OS 身份四元组和规范化 cwd；冲突拒绝，原记录保持不变。不可变上行重放使用原 payload，不因重连重造来源或更换工作目录。

## 管理员配置（没有真实部署默认值）

Windows 配置必须包含：

- `authorityId/authorityEpoch/nodeId/machine/cloudPrincipal`：来自批准的部署配置，cloud principal 的角色是 `cloud`。
- `stateRoot`：已建立、受保护的本机目录。保存代次、待确认握手、不可变操作、来源证明及提交原件、waiting 序号和墓碑。两个实例会在创建命名管道第一实例时冲突，不能共同使用上行状态。
- `ssh`：绝对 `executable/knownHostsFile/identityFile`，明确 `host/user/port`，固定 `entryArgv`，`connectTimeoutMs/rpcTimeoutMs`。连接默认不读取用户 SSH config；显式开启 BatchMode、严格主机密钥核验，禁用代理转发和连接复用。固定远端 argv 逐词做 POSIX 单引号转义；业务只走 stdin 帧。
- `timeoutMs/startupTimeoutMs/projectionTtlMs/maxReconnectAttempts/reconnectBaseMs/reconnectMaxMs`：均须有界；单次 RPC 最多 60 秒，自动重连最多 32 次。重连先关闭旧连接，完成业务接受握手后才能发送原操作。握手 ACK 丢失时重试已持久化的同一 open；已确认的连接断开后推进新代次。
- `ipc`：Windows 自带 Windows PowerShell 5.1 的绝对 `powershell` 路径，`serviceSid/serviceLogonSessionId/protectedWriterSids/protectedPaths/timeoutMs/startupTimeoutMs`，以及 `cli/execution` 两个 `{name,peers}`。每个 peer 指定 `{sid,logonSessionId}`；固定外部宿主时同时指定 `{pid,creationFileTime}`。同账号策略按上文限制为精确进程，不能用普通客户端传来的值填配置。
- `cache`：已建立的受保护 `root`、`ttlMs/maxObjectBytes/maxCacheBytes`。`readPrincipals` 按普通调用者 SID 绑定共享协议的 `ReadAccess`，不是从 CLI JSON 接收权限。

本机 `createSemanticClient` 配置包含同一 `ipc` 连接字段；需要 `readObject` 时还提供 `authorityId/readPrincipal/cacheTtlMs/maxObjectBytes/validationRoot`。`validationRoot` 是部署者准备的该客户端专用验证暂存目录，不能指向服务端缓存或旧共享盘。CLI 在核对整对象 hash 后再次调用原领域检查，完整 ticket 验证只在该暂存目录内进行。

现有用户组合模式可在两个 peers 列表中配置相同的实际用户 SID/登录会话，由启动时原生探针绑定组合进程；不需要改用户或迁移执行权限。另一个可配置例子是部署者已批准的 SYSTEM 专用执行账号；具体 SID、登录会话和目录 ACL 仍由部署者提供，没有开发者账户、固定机器或私有路径默认值。若未来改成不同服务账号，文件可见性和来源读取权限影响须另由主控批准。本单不会创建真实账号、改生产 ACL 或安装服务。

受信配置生成器可在实际组合宿主中调用 `transport/local-ipc.cjs` 的 `readParentIdentity({powershell}, {timeoutMs})`，取得 `{sid,pid,creationFileTime,logonSessionId}`。固定 helper 的一次性 `parent-identity` 模式经私有匿名管道查询该 Node 进程的 OS token、`TokenStatistics.AuthenticationId` 和进程出生时间；调用者不能指定被查询的 PID 或身份。读取有界且结束后关闭 helper，不建立命名管道、不写配置或 ACL。应由主控受信入口把结果用于本次登录的 `serviceSid/serviceLogonSessionId` 和批准的 peer 策略，不可让普通调用者填配置，也不能把其他登录进程的结果套用到宿主。`whoami /logonid` 返回的登录 SID 不能代替 token 的 AuthenticationId。此探针只提供身份信息，不授予 execution 权限；普通 RPC 没有对应方法，同账号其他进程仍须通过原来的精确 PID/出生时间门禁。

原生 helper 在创建管道前检查配置路径/状态根/缓存根/密钥与 known-hosts 的所有者、写 ACL 和祖先 reparse point。管道 DACL 不继承，第一实例使用 `FILE_FLAG_FIRST_PIPE_INSTANCE`，并拒绝远程管道客户端。服务进程当前 SID 必须匹配配置。客户端核验服务器 PID、出生时间、Token SID 与登录会话；服务器用管道 API 获取客户端 PID，再查出生时间与 Token，并将 impersonation token 与进程 token 的 SID/登录会话核对，前后身份不一致即拒绝。

普通调用者的原始 SID 从 OS 管道 peer 取得，持久来源证明绑定 submissionHash，不读取网关重写文件的 owner。IPC 辅助进程继承调用者令牌，其 PID/出生时间是实际管道 peer；它在客户端整个使用期内保持不变。已有 `original-object-acl` proof 在 cloud/node 往返时保持原对象引用，不改成缓存对象。

Linux socket 与配置目录必须由部署入口账号拥有且权限不超过 0700，配置/Unix socket 不超过 0600。forced-command 必须固定到部署文件和固定配置参数；禁止把 `SSH_ORIGINAL_COMMAND` 作为参数解析。请主控为每个受控 principal 固定对应 socket entry，并在真实部署验证账户隔离和撤销方式。

cloud hub 的 authorityId/authorityEpoch 必须由主控在 cloud 构造后取 `health()` 的持久提交值，不能复用文件中的旧 epoch。hub 经固定 stdio 连接发送 `scheduler-gateway-hello.v1` 前言，仅含 transport、authorityId、authorityEpoch 三字段，含换行最多 4096 字节，读取与写出都有超时，且仅允许连接第一帧。Windows 仅接受预配置 authorityId 且不低于受保护状态内最高 epoch 的值；中途重复前言按非法业务帧关闭。问候不是业务消息，不授予许可；之后仍须 session.open 的真实 business ACK 才发布 connected RuntimeScope。断流立即清除旧 scope、准备句柄和实时事实；较新 epoch 从已验证主机密钥的固定 SSH 通道获知，旧 outbox 的业务原文保留，不改变账号或防火墙策略。

## 缓存、时效与启动许可

`read` 只申请所选目录页，按需读取页内所需对象，不自动展开 ledger-index 拉取全部 ledger。每块最多 128 KiB；核对 requestId、kind、执行身份、snapshotId、cursor、offset/length、chunk hash，再验证完整对象 hash/size 与原领域规则，最后原子发布到固定 hash 缓存路径。没有任意文件读取接口。

完整 ticket 通过原 `readTicketSnapshot` 在受保护临时验证目录读取；permit 通过原事件 validator 的 granted 分支验证。format、dispatcher heartbeat、receipt、ledger checksum、policy 等调用原领域检查。单纯通过协议的对象字节验证不会成为许可。缓存不读取旧共享盘；损坏旧缓存明确失败，不拿文件名或 mtime 充当新鲜度。

`snapshot-bundle`、`artifact-zip` 和 `log-segment` 的正文保留原始二进制字节，不作 JSON/UTF-8 解码。它们仍须通过共享协议的 manifest 成员、执行身份、访问权限、完整 hash/size 及分块关联检查；快照包不是执行许可。

缓存最多保留 64 份可读 manifest，以最近使用顺序替换，普通高频状态轮询不会因为第 65 份 manifest 而停止。每份记录只保留对象条目，正文从已校验的磁盘对象读取，不长期重复保留解码值。磁盘对象总量受 `maxCacheBytes` 和 4096 个文件上限约束，下载中的整页对象固定保留；本机读取为同步操作，回收不会穿插删除正在读取的对象。文件回收先撤销依赖它的 manifest，避免发布只有目录、没有完整读取路径的结果。

被替换的 manifest 只作为已交付凭据保留，最多 4096 份；可读和淘汰凭据的序列化元数据预算合计 8 MiB，超过预算删除最早的淘汰凭据。凭据绑定普通调用者 SID、已认证 principal、连接、snapshot、cursor、完整 entry 和分页选择条件。仍在凭据范围内、身份与请求精确匹配的合法旧版本被淘汰时，返回本机 `error.code = READ_VERSION_UNAVAILABLE`；未曾交付、凭据已删除、伪造条目/页码/游标或权限变化不返回该重试信号。断线清除这些凭据。

云端 `projection.catalog` 或 `projection.read` 的已验证 `result` 只有在 `status = business_rejected` 且 reason 以精确字符串 `READ_VERSION_UNAVAILABLE: ` 开头时，才映射为同名本机错误。消费者收到该错误后须丢弃这一轮已收集的全部 pages/chunks，从 `snapshotId = null, pageToken = null` 完整重读，最多重试一次；再次失败应返回失败。网关不自行循环重试。权限拒绝、连接/epoch 变化、未知或伪造请求、内容 hash 错误及其他业务拒绝不得归入该状态。

后续页只能使用此前交付给同一调用者、同一 selectors 的 snapshot/pageToken；返回页必须仍有相同 snapshot 和 ledger cursor，不能拼接新旧版本。未知 ticket 的首次空目录是合法结果。LRU 触碰只改变回收顺序，不修改真实接收时间、manifest 到期时间或本机 TTL；过期仍明确失败。

manifest TTL 从当前连接真实接收时刻开始，下载耗时计入期限，重复读缓存不续期。断线清除内存 manifest 与投影的可用性；磁盘字节可以留作下次收到新 manifest 后的 hash 复用。`readObject` 还要求调用者在当前 runtime generation 取得该 manifest，且所有本机分块完成时仍在同一代次。

`readFreshProjection` 同步比较当前 scope、真实接收时刻和水位，拒绝过期/旧代次。网关既不创建 JobObject，也不以 Node timer 代替原生 watchdog。启动仍须 node/native 独立核对完整 started business ACK、当前投影和原生租约；`durably_received/business_pending` 原样返回，均不能放行子进程。

不可变 outbox 只保留共享协议 `IMMUTABLE_KINDS`，以自然操作键及原 payload hash 拒绝异文。跨重连只重绑传输封装，原 payload 不变。live heartbeat、waiting 和 lease 不落离线待发送队列。waiting 的序号及删除墓碑跨进程重启保留。容量到顶明确拒绝，不无限堆积。

## 验证与运维要求

正式验证通过统一调度运行 Transport、IPC、Cache 三个定向文件，每次单文件且 concurrency 为 1。缓存验证覆盖二进制快照、完整对象校验、连续超过 64 次状态读取、旧版本完整重读信号、跨页版本一致、拒绝状态分类、下载保护和 TTL 不续期。真实本机管道及 SSH 部署须另行验证；合成数据测试不能作为已部署证明。

Windows 配置必须使用实际宿主 token 的 AuthenticationId，并核对状态目录、缓存及新建文件的 owner/写 ACL。管理员 token 的默认文件 owner 可能与用户 SID 不同；部署者应明确批准完整的受信写者集合，或在批准范围内设置准确 owner。不得自动信任任意观测 SID，也不得为启动而跳过 owner、SID/LUID/PID/birth 检查。原生 helper 使用自身 PSHOME 的模块目录；诊断输出仅走有界 stderr，不能混入协议帧。

配置工具可通过 `readParentIdentity({powershell}, {timeoutMs})` 读取当前进程的真实身份；不要用 `whoami /logonid` 的登录 SID 推算 AuthenticationId。命名管道在内核层设置 [PIPE_REJECT_REMOTE_CLIENTS](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createnamedpipew)，随后只接受计算机名查询的 [ERROR_PIPE_LOCAL（229）](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-)结果；成功的远程查询（包括 SMB 回环）及其他未知错误都拒绝。之后仍须完成进程出生时间、令牌及管道模拟身份的交叉核验。宿主内部的 `diagnostics()` 仅返回最近最多 4 KiB 的原生 stderr，不是普通本机 RPC 方法。

