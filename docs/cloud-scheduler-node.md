# Windows 执行节点施工记录

公开执行节点已接入实际调用路径。2026-10-18 正式收单 `tk-c7819e75a23735efd856` 通过：客户端 13、运行端 15、原生控制 9，共 37 项，无失败或跳过；提交为 `434008ceaed20ddc7c7173ea01c1673e78b4ed32`。这是 Windows 组件验收，真实 Ubuntu＋SSH＋主副机联调及正式切换仍待完成。

## 共同版本与来源

当前工位基于 bc77e06，已合入主控 45672bbe39cc5bb5934fb6ecdc9f44f5dbb84a5b，包含 Gateway/Authority 最新代码。Cloud 26/26 正式 collect 是主控提供的上游证据，不是本节点验收结果。已读磁盘 AGENTS、主控 runtime-contract、local-ipc/messages/contract、跨工位端口段及 scheduler-acceptance。新增协议测试是否通过以主控正式证据为准。

私有源仅只读对照固定 20cea25479bff56cc7d386be2c8d103fd0c446fb，并核对公开 SOURCES 与 imports。复用原 jobs-v12/owner、cluster-job、sched-snapshot.fetchSnapshot、暂停控制器、许可、产物打包及 sched-rerun 判定。工作树、依赖配方、菜单的对照来源是该版本 cluster-agent-projects/deps-cache/menu-exec/job-execution；公开路径按管理员 catalog 参数化，不包含私人项目分支、硬编码安装路径或机器名。原 AGENT_PROTOCOL=96，本节点=97，读者先升级及 writer 切换归主控。

## 已接入的实际路径

- 原 sched/client/sched.cjs 的 submit/status/wait/run/exec/hold/cancel/finish 及 pause/resume/reserve/owner-hold/owner-release 进入固定 LocalClientPort。默认 local 保留；显式 remote 不启动本地 writer、不读取旧权威。同步 validatePermit 用有界子客户端读取完整当前票据，继续原许可与出生核验。
- runtime.handleLocalExecution 接主控 onLocalExecution。SID+callId+请求 hash 先落 durable claim，再执行；相同调用重试不重建树，重启 pending 保留 unknown。原 IPC 提交者只用于授权，所有原生事实使用 gateway.localExecutionPeer。非菜单 argv 在原提交 worktree.cwd 执行，caller env 留本机且监督字段由节点重建。
- handoff.publish 经原唯一生命周期写者发布 inbox；handoff runner 按 queueRank 领取，持久本单 claim 后转 running，核当前许可、撤单、代际，创建专有镜像与工作树。claim/transition/已有运行记录不能触发再次发布或重启。准备期持续核验，失败保留原拒跑语义；原生状态未知不会归档为已退出。
- snapshot-bundle 通过 semantic.accept 的 read/read-object 获取。每块至多 131072 字节，核 manifest 版本、权限、长度、分块及完整 hash；返回 Buffer。bundle 的 hash/size 对齐 handoff.snapshot，允许 Cloud 分配不同 objectId。导入使用现有 fetchSnapshot 的 bundle verify/fetch/exact commit 校验，再创建执行工作树。源 snapshot 沿原 cwd/targetPaths，持久操作回执避免重复生成。
- 安装依赖与菜单命令在同一原生 JobObject 内执行；只使用 catalog 中的 npm/pip 配方，在本单工作树与缓存目录安装，不连接开发者共享 node_modules。菜单 argv 从配置 forms 还原并经过原 classifier 回环，保留 require/emit/worker 限额。项目正式入口及部署 catalog 的实际接线仍由主控集成验证。
- 执行持续续租，原 SuspensionController 消费 CI/manual/owner-hold，保留原因、累计时间及超时扣除。原 sched-rerun 提炼暂停超时补跑计划，并在下一次发布时传入 selection；Windows 只把结果写入原 jobs-v12，不写云 ledger。
- 双路原生日志有配额；本机读取总量每次不超过 64 KiB、等待不超过 1 秒。远程日志按已校验版本汇成追加流，跨 attempt 保持输出偏移；产物沿原声明打包，并通过实际 ObjectRef 发现、完整校验和原安全解包器取回。resultObject 承载严格 JobResult 与 suspension；jobs-v12 身份外层保留在原始生命周期记录中，不误送给结果读取器，也不借结果对象传产物。无文件明确 unavailable，不伪造 hash；解包在 Worker 内，避免阻塞续租。
- 所有 Cloud 回包经 gateway.replyTo。Node 不分配上行 envelope/session/sequence。代际改变停止旧树、旧任务不重派，新 scope 可接后续不同任务；owner lease 丢失则停止接单。

## 本轮三个消费者修复

1. started 业务 ACK 后，先用其 businessCursor 发送 bootstrap lease.challenge，native 在发送前记录自己的 Stopwatch。bootstrap 可以被拒租，只用于绑定 runtime；它不交 native.acceptLease、不放行。随后读取 fresh 完整投影，再发送正式挑战、接受租约并释放一次。读取未成功时下次仍重新绑定，不能永久停在 pending。
2. execution.heartbeat 的 childPid 来自 native.prepare.root 或完整 suspension.root，绝不使用 controller PID。测试使用不同的根进程与控制器编号。
3. remote-host.ps1 与 Windows原生接口.ps1 明确保存 UTF-8 BOM（字节 239,187,191），由真实 Windows PowerShell 5 宿主测试验证中文 dot-source。hostEnv 继续隔离 PSModulePath 和 gateway 环境。

原生宿主持有真实 JobObject，以自身 Stopwatch 和独立 Timer 管理 30 秒默认、60 秒上限。等待 ACK 的时间消耗 TTL，迟到/重复 ACK 不从收包时续命；JS 卡死、stdin 仍开也停止本单树。根进程完成时也结束其遗留后代，只操作本 controller 的 JobObject。PID/FILETIME/token/attempt/scope 全绑定；tree-exited 只来自实际空树确认，正常完成的证明在本实例内保留，未确认则 unknown。

## 组合与配置

本轮读取恢复在 remote client 的整次 read 外层统一处理，Node reader 复用同一预算。只有 error.code 精确等于 READ_VERSION_UNAVAILABLE 才重启一次，selectors 固定、新 callId、snapshotId/pageToken 从 null 开始；先前 manifest、分页结果与下载缓冲不复用。初始目录、后续分页及 read-object 的版本失效均走此边界；第二次失败保留原错误。权限、epoch、cursor、hash、请求身份等错误不触发重试，也不回退共享盘。Node 新下载仍核完整 hash/size/权限/版本；workspace 再核 handoff 原始 bundle hash/size，不因换目录版本接受不同来源包。未提交票据的空查找仍返回 null。

测试 source loader 显式使用本仓 web 已声明的 TypeScript 依赖，并按公开 build 的 AST 转换把 import.meta.url 映射为当前模块文件 URL。含空格及中文路径、CLI guard 的断言验证这一语义；未改变生产 build 或其锁定的 6.0.3，未安装依赖。

生产控制者身份继续来自 gateway.localExecutionPeer。真实原生 fixture 使用 transport/local-ipc.cjs 的 readParentIdentity 取得本进程 SID/PID/FILETIME/TokenStatistics.AuthenticationId；不使用 whoami 的 logon SID 推导 LUID。Gateway/transport 已由主控合入，首次正式 collect 的该身份用例通过；普通 IPC 替身的合成身份仍明确是替身。没有复制 gateway 代码或使用私有路径回退，没有修改任何 ACL 或扩大生产可信 owner 策略。

主控先 configureDeployment(config.catalog)，再启动 gateway，最后 node.start；onCloudRequest/onLocalExecution 接节点对应方法。节点返回 start/close/health/handleCloudRequest/handleLocalExecution。start/close 并发调用复用同一 Promise。

必填 mode=remote、machine、head、绝对 stateRoot/lifecycleRoot/artifactRoot/snapshotRoot；可配 clientConfigPath、timeoutMs、maxLogBytes、maxObjectBytes、maxJobs。clientConfigPath 传给子作业的 SCHED_REMOTE_CONFIG，里面是正式本机 IPC 配置。catalog 项目 repo 必须已有所需 Git 基础提交；没有基础对象明确拒跑，不擅自联网取代码。专有执行 worktree 保留在 stateRoot/workspaces；不清理或重用不确定的历史目录。

## 正式验收入口与证据边界

由主控 collect 经统一调度逐文件运行，concurrency=1。施工方未自行运行以下文件：

- test/cloudSchedulerNodeClient.test.cjs：完整读与原 CLI 远程分支、resident 无 started、同步许可当前读取与拒绝旧令牌、空退出码保真；目录/分页/对象版本失效整次重读一次、旧结果丢弃、第二次失败保留原错误、其他错误不重试、请求身份与未提交空查找。
- test/cloudSchedulerNodeRuntime.test.cjs：真实临时 jobs-v12、原暂停计时、原 CLI 非菜单 argv 双路输出并退出 7、丢回包与 started ACK 一树重试、原始 IPC 来源、断线旧树与新代际新任务、普通伪造 started 拒绝。新增首次绑定拒租的严格替身、真实临时 Git 快照/专有工作树/无外部依赖 npm ci/菜单子进程/产物日志、snapshot-bundle 原语分块与权限/hash 检查、公开依赖静态遍历。本机 CLI 用例的 native 端口为严格替身；发布菜单闭环用例使用真实 Windows JobObject，Git/npm 和工作负载均为真实无害临时命令。Gateway 仍是严格替身。
- test/cloudSchedulerNodeNative.test.cjs：真实 Windows JobObject、child+grandchild、stdin 持续开启时阻塞 JS、短 TTL 停树、错误 birth/token/scope 无旁杀、丢 ACK 无 marker、一棵树及一次 release、迟到/重复 ACK、真实 stdout/stderr 和退出 7，以及实际 transport helper 的本进程完整身份。不能以替身或 skip 冒充通过。

Runtime 另有下载中途版本失效后从 offset=0 重取新内容、两次失效仅两个目录请求、权限/hash 错误不重试的断言；首次 collect 的 snapshot reader 用例通过。通过范围不覆盖完整执行闭环，修后仍需统一重跑。

施工方修后三项 acceptanceResults 一律 ran=false。当前仅做文件阅读、修改和只读 git diff --check，未执行语法/测试/构建命令；此前主控正式结果另列如下，不作修后证据。公开构建及 native assets 的正式检查、Linux/SSH/服务器/真实配置、实际项目正式入口与 writer 切换仍归主控集成。

## tk-033cc96aefb4b9f75f55 拒收后的单轮修复

用户标准：迁云后真实执行并正确回报，失联不重复运行或误杀。本轮每项只作一次有依据的修复；未自行验证，正式 collect 留主控，若同一问题仍失败则依据新原始日志报告剩余差距，不继续滚动补测。

原始日志保留在施工方工单的 `acceptance/` 目录，具体本机位置存于部署者的私有记录。日志记录的实际定向子命令和完整汇总如下（这是主控既有正式运行，不是本轮执行）：

| 日志 | 原始子命令 | 结果 |
| --- | --- | --- |
| CLIENT.log | `node --import tsx --test test/cloudSchedulerNodeClient.test.cjs` | 13 项，12 过、1 失败，cancelled/skipped/todo 均 0 |
| RUNTIME.log | `node --import tsx --test test/cloudSchedulerNodeRuntime.test.cjs` | 15 项，5 过、10 失败，cancelled/skipped/todo 均 0 |
| NATIVE.log | `node --import tsx --test test/cloudSchedulerNodeNative.test.cjs` | 8 项，3 过、5 失败，cancelled/skipped/todo 均 0 |

1. **hashbang**：CLIENT 的 VM 和 RUNTIME source loader 把 CLI 的首行放进 Module.wrap 函数体，日志直接指向 `#!`。仅在两处测试装载前移除 BOM/hashbang，保留换行及生产 CLI 原文。原同步许可和真实 CLI 用例继续覆盖，无依赖安装。
2. **生命周期结果封套**：原 jobs-v12 将 IDENTITY_FIELDS 与结果放在同层；裸深比较及运行时 validateJobResult 都不应接收这个封套。新增 extractNodeJobResult，先以原 identityFrom/assertSameIdentity 核记录和结果身份，再移除明确的身份字段及独立 suspension，严格校验剩余 JobResult。observeHandoff 实际调用它，完整 resultObject 仍保留原件。测试逐一覆盖 notStarted/null、refused、rerunPlan，实际调用 runtime 观察回包、核完整对象，并拒绝错身份及未知结果字段。
3. **8.3 路径**：此前逐级 realpath 与输入拼写直接比较，将 ADMINI~1 展开误判为重解析。现在逐级从规范化父目录走，保留 lstat 链接/junction 拒绝、父目录不得改变、Windows 别名必须 dev/ino 相同及最初词法边界检查；返回规范路径。临时根不在夹具中偷偷替换，断言实际 canonical 路径；保留并补充越界、根 junction、内部 junction 拒绝。
4. **原生返回原文**：PowerShell 把原生 JSON 解析进管道再序列化，破坏空/单元素数组，嵌套 consumedLeaseIds 同样影响整份租约相等比较；double 表示也可能被二次编码改变。日志的 LEASE_REQUIRED 尚不足以单独证明浮点因素。宿主现只核请求 id，将 gate.Call 返回的原始 JSON 直接嵌入外层响应，不加 JS 数组补丁。另针对 C# Canon 对 Double/Decimal 文本表示的差异，将两个原生时钟字段以精确 double 数值比较后统一类型，其余字段仍完整 Canon 核对；不接受字符串、不加容差、不从 JS 时钟或接收时刻重算期限，native 原始 accepted 不变。UTF-8 BOM 已只读核验仍为 239,187,191。新增空/单成员、嵌套租约数组、篡改 deadline 及最小可表示 clock 改动拒绝断言；能否完整消除 LEASE_REQUIRED 待正式原生测试。
5. **旧 scope**：原用例只改 payload，先被共享协议 LEASE_SCOPE 拒绝。现保留该断言，另构造封套/payload/hash 自洽的旧 session，要求 nativeRequestKind=lease 且 ENVELOPE_SCOPE；旧 gatewayInstance 则实际到达原生 SCOPE_MISMATCH。仍核本树存活及旁树未被杀。
6. **安全门和期限**：同 nonce/lease 重放、较新序号复用 leaseId、取消投影、JS 阻塞且 stdin 开启的短 TTL 整树退出、stdout/stderr/exit7、无业务 ACK 无 marker 及一次 release 断言均保留；未改生产 30 秒默认/60 秒上限、用例 TTL 或 timeout。修后尚无实测结果；更不代表真实 SSH 或两台机器切换通过。

此前语法检查票 tk-3384228d429fe4405177 的撤单未确认，本轮没有重复申请或绕调度执行，请主控沿原票处理。看板失败与本对话增量费用由主控代记；本记录不销卡、不提交、不发布。
