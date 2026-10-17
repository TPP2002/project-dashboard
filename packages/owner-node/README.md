# Owner node 工作区入口说明

**实现交主控统一验收，尚未运行验收或实际部署。**
操作身份已按主控授权接入现有网页请求；变更与验证索引见 [施工记录](../../docs/owner-node.md)。本目录不是线上生效或安全安装验收证明。

## 部署角色与依赖

- Linux：公开仓 Node 运行时与 `/usr/bin/flock`（util-linux）；独立 `gateway.cjs` 托管 Unix socket；看板进程托管 `server/ownerNodeBridge.cjs` 的数据写入。二者不能启动第二个写同一路径的实例。主控已只读确认目标容器有 util-linux 2.38.1，本工位未执行锁实验。
- Windows：公开仓 Node 运行时，新传输/缓存/桥只依赖内置模块。既有公开派单器使用仓库已有 tsx 依赖，安装时从该公开仓执行 `npm ci`；由主控走正式调度安装，不修改任何共享 node_modules。本工位没有安装依赖。
- 正式 scheduler CLI 由管理员显式配置，可指向本机客户端或 remote mode 的同一公开客户端；无配置、拒绝、许可未知时不启动工人。本文没有依赖私有游戏仓或某个开发者盘符。
- 已有模型可执行程序由节点管理员安装。主控集成后才允许真实调用。本目录测试只使用无害合成子进程。

## 合成配置

`examples/cloud.json`、`examples/node.json`、`examples/worker-scheduler.json` 是可填写模板，只含虚构路径、项目和主机名。替换 nodeId、项目 ID、OWNER 用户目录、公开仓位置、现有模型程序、scheduler 客户端与 SSH 主机/文件路径；三个项目 ID 列表须一致。节点 `projects` 对应本机路径；云 registry 保留云端路径，不能用节点绝对路径覆盖云板配置。

必要环境：看板显式设置 `DASHBOARD_OWNER_NODE_CONFIG` 指向受保护 cloud 配置，且必须启用既有 collaboration 认证；未设置时桥默认关闭。节点由命令行接收受保护配置文件；正式派单 CLI 使用 `DASHBOARD_WORKER_SCHED_CONFIG`。node 配置的 `schedulerConfig` 会为其子进程设置此环境。

`dashboardRemoteConfig` 指向本机已配置的公开看板 CLI 远程权威绑定，节点设置 `DASHBOARD_REMOTE_CONFIG`，启动项目派单前检查 binding。由主控沿现有远程 CLI 安装/登记流程生成该文件，不复制凭据到 owner-node 配置或云数据库。CLI、scheduler、owner-node 三者的子通道各自独立。缺少正式 scheduler 或项目权威绑定会明确失败，不裸跑，不回退本机旧板。

scheduler 配置中 `share` 与 `clientConfig` 恰好填写一个。remote 示例替换为 `clientConfig` 后由 helper 设置公开客户端的 `SCHED_CONFIG`，具体客户端部署归主控；不隐式回退共享盘。

模板使用 `balance: "windows-key"` 保留现有余额功能，由既有模块在 Windows 本机读取 key；配置、日志及云数据库不得存 key。合成测试可显式用 `disabled`，不可把此测试设置当作迁移完成。

## 最小入口（供主控后续集成，未执行）

```text
node packages/owner-node/gateway.cjs /etc/owner-node/cloud.json
node packages/owner-node/ssh-entry.cjs /etc/owner-node/cloud.json synthetic-node
node packages/owner-node/node.cjs C:/OwnerNode/config/node.json
node packages/owner-node/node.cjs C:/OwnerNode/config/node.json --stdio
```

第二行是管理员配置的 SSH forced command，固定 nodeId 及配置路径；不能取自 SSH_ORIGINAL_COMMAND、客户端载荷或成员输入。最后一行是本地 framed stdio 测试入口，stdout 只承载帧，日志走 stderr。不能把它直接接普通文本管道。

主控容器包装器直接使用 `await require('./packages/owner-node/gateway.cjs').serve(config)`，再调用看板 `main()`。不需要新增本工位入口。退出时先 `await dashboard.shutdown()`，再 `await gateway.close()`；包装器独占 SIGINT/SIGTERM 处理。看板导出的 `shutdown()` 可重复，收场 HTTP/SSE、轮询、调度读者与 owner Bridge；直接运行 server.cjs 才注册自身信号处理。

Windows 节点主动 SSH 连接配置 host，不开公网监听端口。SSH 使用 BatchMode、StrictHostKeyChecking、已验证 known_hosts、禁用 agent forwarding 及所有转发。管理员在服务端限制该密钥只能运行固定 entry，禁用 PTY/转发，隔离不同节点的 socket 与身份；安装、ACL、密钥绑定及 known_hosts 的实际验证由主控后续确认，本单没有执行安装。

## 环境和挂载

- gateway 的 socket 父目录必须预建并保护；按主控容器约定为 `/tmp/owner-node`，目录 0700、socket 0600。容器重建清除该私有临时目录，不共享生产 socket 目录，不开公网端口。
- 看板 Bridge 独占 `/var/lib/owner-node/dashboard` 持久卷，保存操作身份、成本副本和源素材缓存；不得多个实例同时写。
- 节点独占 stateRoot，持久保留 operations、launches、objects、usage 游标和缓存。重启不能清空它来消除未知状态。
- Windows codeRepo/docsRoot/sessionsRoot/claudeProjectsRoot 是节点本机挂载；仅节点读取会话正文。云不挂载 Windows 盘、不持有节点凭据。
- 批注/上传使用看板既有数据卷且唯一写；节点仅能向原固定项目批注导出目录写版本化内容。其他源目录只读。
- gateway 使用固定 nodeSocket/clientSocket；同一 cloud 配置供固定 entry 与看板读取，两类 socket 须按服务账户权限隔离。已有 socket 不自动 unlink；容器包装器负责临时目录的生命周期。
- Compose、根构建、系统服务安装、云端实际接线由主控完成；本单没有修改这些文件或真实配置。

## 恢复与测试界线

### 服务写锁恢复

Linux 使用固定 `stateRoot/writer.flock` 的内核独占锁。父 Node 以 `O_NOFOLLOW` 打开文件，检查正常文件、单硬链接、服务用户所有权、保护权限和路径/FD 的设备及 inode 一致；状态目录也必须是真实、受保护且归服务用户所有。然后同步调用 `/usr/bin/flock -n -E 75 3`，通过 stdio FD3 传递同一 open file description。辅助进程退出后父 FD 继续持锁，退出码 75 表示已有活写者，其他工具错误或超时均拒绝启动。release 只关闭父 FD；该固定文件永不 unlink/rename，不要在维护时删除或替换它。

锁语义依据 [flock(1) 的 FD 调用形式](https://man7.org/linux/man-pages/man1/flock.1.html) 与 [flock(2) 的 open file description 生命周期](https://man7.org/linux/man-pages/man2/flock.2.html)。同一持久卷 inode 的互斥不依赖 PID namespace；所有对应 FD 关闭后内核释放锁。部署使用本地 ext4，不需要宿主 `/proc` 挂载或 `pid:host`，没有扫描宿主进程的环境入口。网络文件系统必须实际支持所需 flock 语义，不能直接套用本地磁盘假设；本单不验证网络文件系统。

旧 Linux `writer.lock` / `writer-generations` 不忽略、不删除。取得内核锁后逐代检查旧释放回执，或使用本机 `/proc` 的 boot ID、观察 namespace 与 starttime 保守证明旧身份结束。不同 namespace、缺失出生身份、权限不足等不能证明的状态明确要求核对；不以新 namespace 中 PID 缺失判死。证明可迁移后，通过旧协议的 hard-link CAS 在链尾发布永久迁移标记，旧版执行器不能越过该标记重新写入；旧程序若抢先进入则迁移失败。本次服务尚未部署，无真实旧 Linux 数据强迁。新目录也发布迁移标记以阻止旧版执行器进入。

Windows 继续记录本机 CIM CreationDate，使用不可变代际与 hard-link CAS；只有正常释放或可靠确认旧出生身份结束才允许下一代，活写者或未知状态拒绝接管。Windows 状态目录须支持原子硬链接。上述单写状态目录不得跨机器共用。

正常 shutdown 先停止新工作，再关闭连接并等待所有在途持久写完成，最后 Linux 关闭持锁 FD、Windows 发布自身释放标记；5 秒收场失败保留所有权并报错。Linux SIGKILL/崩溃后由内核释放锁，Windows 下次仍核验 OS 出生身份。服务恢复不会改变 operations 中的 intent。

Transport 已加入仅 Linux 执行的真实子进程断言：辅助 flock 退出后父 FD 仍锁住固定 inode、第二写者冲突、异常退出后可重新取得且 inode 不变；跨平台真实子进程测试另验证两个恢复者仅一个成功，以及丢回执/未知 intent 不重派。保留 Windows 出生身份和异步 drain 断言。新增旧格式拒绝/释放迁移、链接与非普通文件边界断言。本轮只作静态自审，全部断言未运行；容器跨 namespace 的真实服务器验证由主控完成，不以 mock 或本机测试冒充。

### 业务动作恢复

intent/unknown 表示无法证明动作是否执行，不能盲目重试或删除记录。owner HTTP 写入口必须携带 UUID `X-Owner-Operation-Id`：相同 ID/相同内容回放，内容变化冲突，新 ID 表示明确新动作。网页只在完整成功消费回执后结束 ID，未知重试跨页面刷新仍保留同一 ID；sessionStorage 仅保存摘要与 ID，不改变任何认证凭据存储。错误沿用原页面展示。

应核对 node operations、launches、项目原 job state 和 scheduler 票据，以及 Windows PID 出生身份、整树退出证据。worker spawn 前先落 intent；spawn 后尚未记 PID 时重启保持未知。正常主进程退出也不自动声明整树退出，未知不会放开同 slug 复派。服务恢复不等于批准重新启动未决模型；不得通过 Linux 同号 PID、清空账本或手改 treeExited 来解除。

SSH 断开后节点每 5 秒重连，启用新代际，不自动重发业务操作；旧回复不能匹配新请求。云成本游标、完整对账 stage 与节点事实均持久保留。来源离线报不可用，采样超过 180 秒报陈旧，保留旧事实供后续核对。

成本采集为节点每 60 秒元数据巡检和变化组解析，云使用可替换事实及游标；没有实测 CPU、磁盘、延迟或带宽改善。正文只在 owner 请求时传输。音频范围调用链为 `Bridge.route → audition.sources.get（仅描述）→ streamObject → object.read(offset,length)`，每块至多 128 KiB，HTTP 写缓冲背压时等待 drain。整段响应也分块，云不会为一个 Range 先下载整段。原单文件 30 MiB/MIME/HTML-SVG CSP 边界保留。

`test-worker.cjs` 和 `test-scheduler.cjs` 是合成验收夹具，不能配置成生产入口。三份 `test/ownerNode*.test.cjs` 由派单器收集后逐文件、并发 1 执行；本施工方没有运行。一次排队的语法检查已取消，故没有语法检查通过记录。
