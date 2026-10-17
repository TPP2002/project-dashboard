# Cloud scheduler authority

本工位提供云端调度服务及三份服务级测试源码。验收未执行，不能据此声明 Linux、SSH、Windows 原生门禁或生产切换已通过。此前产物发现缺口已由共同协议提交 `6a56011b9355f9501cf7e74d3906e06e81985abf` 补齐，本实现消费 `artifactObjects`，没有修改协议。

## 运行接线

生产模块为独立包构建后的 `packages/scheduler/dist/cloud/service.cjs`，导出异步 `createCloudService`。现有构建器递归复制 CJS、编译同包 TS，无外部运行依赖。源码测试使用仓库已有 `tsx/cjs`；生产使用编译文件。公共 CLI、构建、Docker、hub、部署及退出信号接线由主控负责，本单未运行构建。

```js
const { createCloudService } = require('./packages/scheduler/dist/cloud/service.cjs');
// hub 由主控创建，通过 getAuthority 回调取得 cloud.authority。
const cloud = await createCloudService({
  dataRoot: configuration.dataRoot,
  catalog: configuration.catalog,
  authority: configuration.authority,
  sendToNode: hub.sendToNode,
});
// 传输问候使用这次启动的 health().authorityEpoch，不能用配置里的旧值。
await hub.listen(configuration.socketPath);
cloud.start();
```

配置全部显式提供：

- `dataRoot`：云端受保护、本机持久卷的绝对目录，含原 `sched/` 与新增 `cloud-authority/`。不得指向 Windows 共享目录。
- `catalog`：既有 deployment-config 的机器、项目、菜单、作业模板与 CI 配置；无真实机器名、私有项目或路径默认值。同一进程不能更换 catalog。
- `authority.id`：固定权威身份；`host` 为云主机身份；`ownerMachine` 为原业务接受预留、owner-hold 的 Windows 机器，必须在 catalog 中，不能与 host 混用。
- `authority.protocol/head`：实际部署的代理协议号及 40 位构建提交号，保留原 owner/心跳校验。`leaseTtlMs` 可省，默认 30000、最大 60000。
- `authority.principals`：受保护传输配置给出的固定 Principal 数组，含 `id/role/nodeIds/machines/allowedKinds/readAccess`；可信 Windows 主体另需 `nativeObservation:true`。每个 node 只能映射一个 principal，每台机器只能映射一个原生 node。网络 payload 不能提供可信 principal。
- `sendToNode(nodeId,envelope,{timeoutMs})`：唯一异步发送口，返回完整已认证 NodeReply，不创建第二个 writer。

返回 `authority.accept/issue/snapshot/leaseReply`、`start/tick/close/health`。snapshot 只收 state.read，leaseReply 只收 lease.challenge。start 幂等，tick 串行，close 立即 fence 并等待有界发送结束。主控退出时关闭 service 和 hub。

原 daemon 默认仍是 local；只有显式 remote 且提供远程端口才走云路径。未配置不能回退 CIM、kill 或共享目录。owner guard 检查的是云服务本身，不用旧 Windows PID 回收执行。

## 持久事务及恢复

继续复用原 daemon、intake、commands、reports、admission、schedulerInputs、project、ledger、handoff，没有第二套排队器。

启动领取原 owner fence、恢复原领域账本与本地 WAL，在保护区内持久递增 authorityEpoch。构造完成后主控才能发布 health 中的新 epoch。旧 epoch/session/generation 被拒绝；新会话重发同一不可变操作保留原结果、原业务游标。

不可变输入先持久保留有界 pending 索引、不可变 inbox、原始提交绑定，再给 durably_received；该状态不允许执行。提交阶段等待原生 origin.proof，核验原提交哈希、原始 ACL/IPC SID，持久保存 source 后才调用原 intake。只有原领域回执可恢复才写 business_accepted。unknown 不授予，mismatch 给业务拒绝，不以网关副本 owner 补证。

领域事件使用原 fsync 账本，云适配额外同步账本目录。协议索引采用同卷临时文件、文件 fsync、原子发布、Linux 目录 fsync；多索引更新以 WAL/revision CAS 恢复。领域写后、ACK 前崩溃由原业务自然键及回放校验补回执，不重做业务效果。completeAcceptance 只是提案，不当作落盘凭据。fsync/CAS/fence/恢复校验失败停写，不给成功 ACK。

安全历史按散列分片点读磁盘：消息指纹、authority 范围操作键、出站操作及原结果、退休 session、generation、waiting 墓碑、source、停止/交接意图。单条索引读上限 4 MiB，WAL 64 MiB、每事务最多 64 项，pending 不可变操作最多 256；超限明确失败，不清空旧键腾位置。

安全索引、inbox、结果和墓碑在 authority 生命周期内保留；当前不做在线删除。监控磁盘容量，只能在全部 writer 停止并确认 fence、完整备份可恢复后离线归档。恢复必须包含原账本、索引、WAL、epoch、source；不能单独清去重表、回拨 epoch、删除 owner guard 或把归档键当新操作。展示对象及下载分块同样保留，适用相同离线备份/归档规则。

Windows fixture 使用真实文件 fsync，Windows 不支持本实现的目录 fsync；目录持久性由 Linux 集成验收确认。异常退出沿用原 owner 接管、僵尸 guard 归档与 poisoned guard 人工核验规则，不降低闸门。

## 事实、交接及回收

保护区内提交意图，离开同步 commit 后发送，下一拍消费经 epoch/session/sequence/关联校验的事实。事实缓存使用本进程单调时钟，最多 30 秒并绑定当前会话；重启不恢复“新鲜”。cold start 按 unknown 输入原 schedulerInputs。CPU/内存/CI/slots/managed load/protocol/head 来自认证机器观察。

handoff 保留原 full/legacy 身份及 claim/transition/absent/终态/补跑分支。unknown 不作 absent。running 目录不能合成 started；cluster 同样必须上报真实 controller PID/FILETIME 并获得持久业务接受。cluster 的简略 report.finished 不取代原交接结果对账；完整 notStarted/refused/exitCode:null/rerunPlan 留给原分支，防止吞掉补跑。

lease 核对当前 attempt/token/controller、连接、当前账本游标、challengeSequence 和实例身份。首次 challenge 绑定已认证 gateway/node instance；即使 started ACK 后游标已推进而拒绝这次 lease，仍可 state.read 取得同实例的新投影，再以新挑战申请。未取得实例事实返回 business_pending，不虚构实例。完整执行投影包含范围内全部当前授予/执行；终态历史在 GUI 目录，显式 ticketId 仍可查询终态。原生门仍须同时校验 started ACK、完整投影与有效 lease；单独 lease 不释放子命令。Windows native 保存发出挑战的 Stopwatch 时刻及截止时间，cloud 不重置 sentAt。

取消、硬超时、失联只记停止意图，同时拒绝新 lease；只有当前同 attempt/token/controller 出生身份的原生 tree-exited 证据才能释放运行占用。unknown/alive 保留占用。启动前失败走原 notStarted/refused 分支。waiting 墓碑及原序号判定保留；断连不把旧观察当退出证据，已授予的等待超时只写取消意图。

pause/resume、CI 让路、owner-hold、预留及暂停计账复用原逻辑，意图与原生确认分开。hold 直接授予驻留占用，ResidentIdentity 绑定真实 renewer 与原 source，不要求 started/JobObject，不签执行 lease；换 renewer 必须换已认证会话，旧会话不能续约。resident 失联保留占用。registerOnly 保留原零核、无执行许可的登记/finish 流程。云端不因登记接管或终止已有应用。

## 不可变读取及产物

GUI 目录与执行 state.snapshot 分开。目录提供完整原 TicketSnapshot（全部 attempt、timeline、许可）、format/config/heartbeat、command receipts、策略、usage/overuse、项目 head、snapshot metadata、job result、log descriptor/segment、artifact manifest/zip。控制文件只从云 dataRoot 固定位置读取；空队列有空目录和原控制信息。缺实物不伪造 hash。

固定 ReadAccess 限制项目/机器；ledger 仅 owner。版本固定业务 cutoff，60 秒过期，最多 8 个同时有效版本；每版本最多 16384 entries、4096 continuation tokens。响应最多 64 entries，分块最多 131072 bytes，完整对象最多 64 MiB。cursor 绑定 principal/版本/selector；越权、旧版本、伪造 entry、坏 hash、越界均拒绝。shape-valid 投影不是许可。

账本索引只存原文件 offset/length/hash，不复制账本。首次导入或崩溃后未索引尾部每 128 条一批恢复，批间释放 guard 并续租；日常按新事件增量索引。owner 可通过目录 continuation，或直接请求 ledger-segment 的 fromSeq/throughSeq（最多 128 条），避免每次 wait 从历史开头扫描。每条核验原 checksum，不越该版本 cutoff。只跨网传请求的对象，不随每拍全量同步账本。

认证 handoff.observe.artifactObjects 是首次发现依据。cloud 按引用取块，核完整 hash 后才发布自己的目录，文件名不是任意路径授权。resultObject 仍为原结果，保留 suspension；日志 descriptor 引用已完整核验的字节。snapshot bundle 同样下载并核验后才允许原快照门进入 ready。下载队列最多 128 项、每拍总预算 1 MiB；队列和分块进度持久化，重启续接，断线不发布半个对象。

## 验收交接

三份测试均使用真实 service 与合成临时目录，本工位未运行：

- `test/cloudSchedulerAuthority.test.cjs`：生命周期、started/lease、unknown 占用、cold start、驻留、暂停意图/确认、owner-hold、原补跑及 local 模式。
- `test/cloudSchedulerAuthorityRecovery.test.cjs`：真实子进程在领域/回执/WAL 边界退出，重启只生效一次；丢 ACK、同 ID 异文、换 session、旧 epoch、waiting 墓碑、fsync/CAS 失败及离线 lease。
- `test/cloudSchedulerAuthorityRead.test.cjs`：空队列、完整对象、固定 cutoff、跨项目拒绝、owner-only 账本、分页/旧 cursor/超限、产物 hash 与日志。

由派单器按单文件、concurrency 1 挂号执行；没有裸跑验收或构建。静态自查只有源码核对和 git diff 检查，不能替代运行验收。

真实 SSH/hub/node 联调、Linux 文件系统、Windows JobObject/watchdog、公开包构建、生产菜单与 CI、资源/带宽收益、旧 writer/托管器停机切换、PR/部署均未亲验，由主控负责。切换先升级读者，再停旧 writer 和自动重启源、确认无并行 writer 后启新 authority。成本按工单由主控归集本会话独立 token，不重复登记。
