# 本地看板云同步设计

状态:设计稿,待负责人拍板(见第 11 节);日期 2026-10-19;看板卡 CLOUD-BOARD-REMOTE-1018。
上位契约:`docs/plans/cloud-collaboration/contract.md`(协作版服务端)。本文只管「本机看板 ↔ 云端看板」这一段,不改协作版已定的角色、判权和成员接口。

### S1 施工交接（2026-10-19，工作区实现，验收结果见派单回执）

本次仅实现本地操作队列与同步重放函数，不含网络、接口、同步进程、界面或部署。

文件职责：

- `core/resolveProject.cjs`：新增规范化的 `cloud` 和实际 registry 所在目录下的 `syncDir`，保留既有返回字段。
- `core/syncOutbox.cjs`：进程内操作上下文、板锁内序号分配/追加/fsync、读取队列、补丁与未跟踪记录；失败向调用方抛出。
- `cli/store.cjs`：仅云端项目在锁内保存改前快照，校验通过后先记队列再写板；未启用项目不复制看板、不加载队列模块、不建目录。
- `core/syncReplay.cjs`：命令分类、入口参数与文件快照、原文机器闸、`applyOp(op, {registryPath, projectId, author})`；返回 `{ok:true,result}`，`result` 使用 CLI 的 `slimJson` 摘要。
- `cli/index.cjs`：复用入口闸，限定命令执行上下文，并导出同一摘要函数。
- `cli/commands.cjs`：以不可从命令行传入的 Symbol 保存已捕获的文件/标准输入/分支/会话环境默认值；未捕获时沿用原来的推导。重放不绑定本机会话。
- `test/cloudSyncOutbox.test.cjs`：关闭兼容、逐条记录、批量、拒收、双进程并发、真实 Git 补丁、进程内写入、不可写目录等。
- `test/cloudSyncReplay.test.cjs`：除 set 外所有声明命令逐个对照，文件删除/标准输入/分支缺省、机器闸、错误状态、并集、输入隔离与禁二次入队。

记录协议：`OUTBOX_VERSION = 1`；文件为 `<syncDir>/outbox.jsonl` 与 `outbox.seq`。示例：

```json
{"v":1,"kind":"op","opId":"ea06ac89-4918-4f71-a616-b3feaf7da96f","seq":1,"project":"local","remoteProjectId":"remote","command":"note","flags":{"_":["T1"],"text":"已核对","author":"cli"},"files":{},"author":"cli","clientTs":"2026-10-19T12:00:00.000Z","device":"device-one"}
{"v":1,"kind":"untracked","seq":2,"project":"local","remoteProjectId":"remote","clientTs":"2026-10-19T12:01:00.000Z","device":"device-one","taskIds":["T1"],"source":"unknown"}
```

标准输入保存为 `files.stdin`，重放时映射为临时 `json-file`，因此队列 flags 不保留本地 `json` 开关。文件参数仅有建卡/待拍板的 `json-file` 与收单说明的 `file`；当前 edit 不支持 `desc-file`，request-info 与 undecide 无文件输入。批量回填的 `patch` 文件只在本地使用，其结果按三个元数据数组形成补丁，不重放原文件。

分支口径以现有代码为准：claim 不给 branch 就是空数组，不自动查询 Git；unclaim 缺省才取当前分支，并记录实际结果（包括空数组）。collect-brief 缺省不写卡片的可选 author 字段，记录顶层 author 为 activity 实际署名 cli，flags 保留缺省状态，避免重放凭空增加卡片字段。

重放只接受声明的命令或 patch-ai-meta。set 本单照记照重放，云端入口下一单另行拒绝。重放使用显式绝对 registry 路径及其中的绝对项目路径，原始输入路径不得代替内联内容；临时文件执行后删除，三道入口闸共用原文。400 表示参数/入口拒收，403 表示非白名单命令，404 表示项目/任务不存在，409 表示状态冲突。重放在独立禁记录作用域内执行，不建立、覆盖或继承可写操作上下文。

CLI 直接调用 store.mutate/mutateTask 的写入点清单：

| 路径 | 经 CLI 入口 | 进程内直接调用 |
|---|---|---|
| `cli/commands.cjs`（add/addBatch、claim、unclaim、progress、awaitCollect、collectBrief、pending、decide、markLanded、park、unpark、block、done、cancel、reopen、note、edit、set、cost） | 可重放 op；一次命令只记首次 mutate | 卡片变化记 untracked；仅活动流变化不满足卡片变化条件 |
| `cli/commands.cjs`（syncProgress） | 元数据新增补丁；进度等变化 untracked | 卡片变化记 untracked |
| `cli/gitSync.cjs`（syncFromGit、doctor 修复） | 三数组新增记 patch-ai-meta；其余卡片变更记 untracked | 卡片变化记 untracked |
| `cli/backfill.cjs` | 同上补丁规则 | 卡片变化记 untracked |
| `cli/requestInfo.cjs`、`cli/undecide.cjs` | 可重放 op | 卡片变化记 untracked |
| `cli/archiveActivity.cjs` | 排除，不记录 | 仅归档活动流，不改卡时不记录 |
| `cli/collaboration.cjs` | 不在 CLI 注册表 | 卡片变化记 untracked（云端 applyOp 自身禁记录） |
| `cli/store.cjs` | mutateTask 转调 mutate，使用所属入口上下文 | 直接 mutate 同样按卡片变化记 untracked |

2026-10-19 派单方第 1 次答复已纠正原施工单第 10 步：`server/auditionApi.cjs`、`server/readerApi.cjs` 的 mutate 是回调形参，写独立试听/审阅批注账本，不调用 cli/store，不属于看板同步；本单不修改、不为其生成记录。import/register 等独立写盘命令仍按排除表处理。

新模块无子进程调用；新增测试中的所有子进程调用均显式 `windowsHide: true`。原子写板在队列成功后失败的极端情况仍按 §4.1 的既定云端裁判语义处理，CLI 会报告写板错误。

自测记录（仅经派单方 mailbox；未直接运行 Node 或测试）：

- 第 1 次 `20261019T212701-0c49b700`：OUTBOX 通过；REPLAY 29/30，通过真实未提交分支发现夹具缺初始提交，保留失败回执。
- 第 2 次 `20261019T212827-048f1a04`：补齐临时 Git 仓的初始提交，原断言不变；OUTBOX、REPLAY、LEGACY-CMD 全部通过。
- 第 3 次 `20261019T212919-782418f5`：GATE-MODEL、GATE-TITLE 通过；GATE-COST 回执显示台账非终局 running，被标为未验，入口明确要求不重试、直接交活。按此停止自测，未将该项记绿。
- 其余指定回归、NOWINDOW 和 FAST 未自测，交派单方统一验收；FAST 按工单要求登记为 heavyRequests，不由施工方执行。

改动仅留工作区，没有 Git 写操作，没有修改禁区文件，没有安装依赖；看板/成本登记由派单器代办。

## 1. 要解决什么

### S2 施工交接：云端同步接口（2026-10-20）

本次实现仅在协作模式启用。四条路由均要求当前有效的 owner 设备会话；密码登录会话不够，设备撤销立即失效。POST 沿用 Origin、JSON、固定请求头、CSRF 与拒绝转发头的检查。凭据只从 Cookie / 子进程标准输入传递，不进入命令参数、回执或日志。

文件职责：

- `core/syncLedger.cjs`：每项目独立回执账、规范化内容摘要（仅排除顶层 seq）、独立锁和原子写、损坏拒收、已确认回执清理。
- `cli/collaboration.cjs`：内部 `sync-ops` 只读标准输入；认证锁 → 回执账锁 → 原有看板锁，逐条调用 S1 `applyOp`，逐条保存成功/拒收结果。既有 owner-command 白名单不变。
- `cli/store.cjs`：进程内活动附加字段作用域；补齐本次新增流水的 userId/via/clientTs/device/opId，finally 恢复上下文；未设置上下文时原行为不变。
- `server/collaborationApi.cjs`：四条路由、设备会话判权、批量请求上限、60 秒隐藏子进程、整本读取与条件响应、锁内首次上传及登记。
- `test/cloudSyncOps.test.cjs`：真实服务/设备登录、与本机命令执行对照、重发、闸门、权限矩阵、并发、锁超时、上传与事件流、清理及坏账拒收。
- `test/collaborationServer.test.cjs`：原 HTTP 越权矩阵和设备撤销检查补入四条同步路由。
- 本文与 `contract.md`：补充交付说明及请求响应契约。

`core/boardSchema.cjs` 的活动记录校验允许这些附加字段，无需放宽校验。`server/server.cjs` 的 `pollBoards()` 每轮调用 `readRegistrySafe()`，新登记项目自动进入 mtime 扫描；第一次观察建立基线，之后变更走既有 `board:changed` 广播，故无需修改轮询。新增项目会使已有 SSE 的项目集合改变，沿用现有关闭旧流、客户端重连的行为。

回执文件：`<DASHBOARD_HOME>/sync-ledger/<projectId>.json`，`v:1`，包含 receipts 与按设备记录的 acks。ackSeq 单调递增；seq ≤ ack 的回执在超过七天后清理；超额时仅淘汰最旧已确认回执。为新回执预留容量时也只淘汰已确认项；若两万项均未确认，新操作返回 retry，待客户端确认后重发，不静默丢回执。JSON 损坏或结构无效返回服务不可用并保留原文件。

四条请求/响应样例（省略 Cookie 和写请求保护头，不包含任何真实凭据）：

```text
POST /api/sync/projects/demo/ops
{"ackSeq":0,"ops":[{"v":1,"kind":"op","opId":"example-op-1","seq":1,"project":"local-demo","remoteProjectId":"demo","command":"note","flags":{"_":["T1"],"text":"已核对"},"files":{},"author":"owner","clientTs":"2026-10-20T00:00:00.000Z","device":"主机甲"}]}
→ {"ok":true,"results":[{"opId":"example-op-1","seq":1,"status":"applied","result":{"ok":true}}],"etag":"<文件内容的 sha256>"}

GET /api/sync/projects/demo/snapshot
→ {"ok":true,"etag":"<文件内容的 sha256>","board":{"schemaVersion":"1.0","project":{"id":"demo","name":"示例项目","createdAt":"2026-10-20T00:00:00.000Z","updatedAt":"2026-10-20T00:00:00.000Z"},"tasks":[],"activity":[]}}
相同 If-None-Match → 304，无正文；每次先认证，不复用其他角色的缓存。

GET /api/sync/projects
→ {"ok":true,"projects":[{"id":"demo","name":"示例项目","etag":"<文件内容的 sha256>"}]}

POST /api/sync/projects/new-project/upload
{"name":"新项目","board":{"schemaVersion":"1.0","project":{"id":"local-name","name":"新项目","createdAt":"2026-10-20T00:00:00.000Z","updatedAt":"2026-10-20T00:00:00.000Z"},"tasks":[],"activity":[]}}
→ {"ok":true,"etag":"<文件内容的 sha256>"}
```

`result` 原样采用 S1 的命令摘要，字段随命令变化。永久拒收条目包含 `status:"rejected"`、`httpStatus` 和原文 `error`；set 明确提示「云端项目不接受 set,请改用专门命令」。同 opId 同内容返回原回执（含原 seq），改内容返回 409；看板锁超时即使被 S1 映射为 409，仍返回 retry 且不记永久回执。一批某条失败不阻断后续。批量 1–20 条、正文至多 2 MiB；上传也使用 2 MiB 正文界限。上传会改写 project.id、先校验整本，然后在注册表锁和看板锁内落盘、登记；重复上传返回 409，坏看板返回 400。整本响应保留原始解析字段，不使用成员脱敏视图。

所有新增/修改的子进程调用显式 `windowsHide:true`。没有改本机同步程序、界面、部署或依赖；成果只留工作区，验收及看板/费用登记由派单器收单时执行。

S2 自测记录（仅经指定 mailbox，共 5 次，未直接启动 Node 或测试）：

- 第 1 次 `20261020T081354-c38ce619`：HTTP 20/20、TASK 8/8；SYNCOPS 失败原文为本机对照的 pending 被 `--json` 切换到标准输入，随后回执对照受前项中止影响。失败日志保留。
- 第 2 次 `20261020T081609-c9d04ef4`：删除对照命令误加的输出参数，原等价断言不变；SYNCOPS 13/13、MEMBEROPS 15/15、BOUND 8/8。
- 第 3 次 `20261020T081647-6cc353d9`：REVOKE 27/27、COLLABS 10/10、REPLAY 33/33。
- 第 4 次 `20261020T081742-ac27a9bf`：OUTBOX 15/15、SCHEMA 12/12、LEGACY-CMD 74/74。
- 第 5 次 `20261020T081812-4742a8ee`：NOWINDOW 通过。最新有效定向测试合计 235/235；完整日志由派单器保存在本工单 selftest/run-N 下。
- FAST 未执行，依施工单通过 heavyRequests 申请 `test:fast`，由派单器统一排队；旧代码反证也由派单器收单时执行，本轮未冒记通过。以上自测不替代收单统一复核。

负责人原话:「不需要令牌吧?不能像我现在本地这样直接用吗?」「升级一下本地看板,支持云同步,这样我本地也能同时掌控云端版本的内容。」

- 本机的 AI 对话照旧敲 `~/.claude/dashboard-release/board.cmd <命令>`,命令、参数、输出、退出码一个字不变,不需要令牌,不等网络。
- 负责人在本地看板里把某几个项目打开「云同步」,这些项目就和云上那本保持一致:本机的改动送上云,协作成员在网页上的改动拉回本机。
- 云上那本是最终裁判。两边同时改同一张卡,以云上执行的结果为准;云上拒绝的本机改动自动退回,并在本机看板和下一次命令行输出里提示。
- 本地看板登录云端一次即可,之后同步程序自己续期,不再问密码。
- 不做的:AI 接入令牌;把所有项目都搬上云;调度台搬家(合同第 81 节,另议);两边互拷 `board.json`。

## 2. 总体做法:本机记操作,云上按同一套规则执行,结果回写本机

合同第 18 行明确禁止「把可写文件双向同步当作多主数据库」。所以同步的单位是**操作**,不是文件:

```
AI 对话 ──board.cmd──▶ 本机命令(照旧写本机 board.json)
                         │ 同一把板锁里顺手追加一条「待同步操作」
                         ▼
                    待发队列 outbox.jsonl
                         │ 同步程序(常驻,静默)按顺序发送
                         ▼
               云端 /api/sync/…/ops ──▶ 云上用同一份命令代码执行(cli/commands.cjs)
                         │ 回执:成功 / 被拒(原因)
                         ▼
     同步程序拉回云上整本 ──▶ 覆盖本机这一项目的 board.json(待发中的卡暂留本机版)
```

要点:

1. **本机命令照旧先写本机**。AI 敲完命令立刻看到结果,和现在一样快;网络断了也照常干活,改动在队列里排着。本机这份对云端项目而言是「草稿视图」:多数时候和云上一致,队列没发完时会领先云上几步。
2. **云上用同一套命令代码执行**。送上云的是「命令名 + 参数」,云端在自己的锁里用 `cli/commands.cjs` 同一批函数重放,状态机、闸门(建卡要档位与人话标题、`done` 要先登开销、pending 三件套字数)在云上再判一次。云上判过才算数。
3. **云上整本是真相**。同步程序拿到回执后拉回云上整本,替换本机这一项目的看板(第 6 节)。本机被拒的改动就这样自然消失,再补一条提示。

## 3. 哪些项目同步

- 每个项目单独开关,默认关。开关存在本机 `registry.json` 该项目条目里新增的 `cloud` 字段:

  ```json
  "cloud": { "enabled": true, "remoteProjectId": "dashboard", "attachedAt": "2026-10-20T10:00:00+08:00" }
  ```

  没有 `cloud` 字段或 `enabled:false` 的项目一切照旧,命令行和本地服务的行为与今天逐字节一致(回归验收)。
- 打开开关在本地看板「云端项目」页面里点(第 9 节),不需要敲命令;也提供命令 `board.cmd cloud attach <项目> [--upload | --adopt]` 给不方便开网页时用。
- 第一次打开分两种情况,页面上二选一:
  - **上传本机这本**(云上还没有这个项目):把本机整本作为云上初始版本上传,云端登记项目,之后进入同步。
  - **采用云上那本**(云上已有,比如另一台电脑先接上了):先把本机这本备份到 `<数据根>/sync/<项目>/backup-<时间>.json`,再用云上整本替换本机。
  - 两边都有且内容不同:不自动合并,页面列出差异的卡数,让负责人选以哪边为准(另一边留备份)。
- 关闭开关:停止发送和拉取,本机这本原样留着继续当本机项目用;队列里没发完的操作保留在文件里,页面提示「还有 N 条没送上云」,可以选「先发完再关」或「丢弃」。

## 4. 本机命令写入后怎么记成待同步的操作

### 4.1 记录点

改动只落在 `cli/index.cjs` 入口和 `cli/store.cjs` 的 `mutate` 两处,各命令文件不动:

- 入口在执行写命令前建立「本次操作上下文」:命令名、原始参数(已解析的 flags)、本机操作人(`--author`)、发起时刻、一个新生成的操作编号 `opId`(随机 128 位)。
- `mutate` 在锁内、写前校验通过之后,若该项目开了云同步且上下文存在,先把这条操作追加到该项目的待发队列(写入并 `fsync`),再原子写 `board.json`。两步都在同一把板锁里,所以队列顺序和本机实际写入顺序一致。
- 一条命令调用多次 `mutate`(批量建卡等)只记一条操作,以第一次为准,同一 `opId`。
- **依赖本机环境的默认值,记录时补成显式参数**:例如 `claim` 不写 `--branch` 时取本机当前 git 分支、`--author` 缺省值,记录里写成实际生效的值,云上重放不再去猜。判据是重放等价:同一条记录在另一份同样起点的看板上重放(不在任何 git 仓里、没有本机文件),结果必须和本机一致(时间戳除外)。
- 入口的三道机器闸(建卡要档位、要人话标题,收官要先登开销)抽成共用函数,本机入口和云上重放都调它,云上不会因为绕过入口而漏闸。
- **不经命令行入口的写入**(本地看板网页里的操作若是进程内直接写、自动巡检建卡等):对云端项目同样要进队列;做不到按命令记录的,记成一条「未同步写入」标记(哪几张卡变了),同步程序不发送它,只在页面上提醒负责人,下一次拉取会以云上为准覆盖。施工时要列出全部这类写入点。
- 命令在 `mutate` 前就报错(参数不对、闸门拒收)→ 什么都不记;本机都没写成的事不送上云。
- 极端情况:队列写成了、`board.json` 原子写失败(磁盘错)。这时云上会执行这条本机没生效的操作——云上是裁判,拉回后两边一致,可以接受;日志记一条。

### 4.2 一条操作长什么样

```json
{ "opId": "a3f…", "seq": 118, "project": "dashboard", "command": "claim",
  "flags": { "_": ["CLOUD-BOARD-REMOTE-1018"], "branch": "design/local-sync-1019", "builder": "派单器" },
  "author": "claude", "clientTs": "2026-10-19T21:30:05.120+08:00", "device": "主机A" }
```

- **参数里引用本机文件的,记录时就把内容读进来**:`pending --json-file`、`collect-brief --file`、`add --json-file`、`edit --desc-file` 一类。云上没有本机的文件,只能带内容过去。标准输入读入的同理。
- **不送上云的参数**:`--registry`、`--json`、`--help` 这类只影响本机进程的;`--project` 换成云端项目编号。
- **和本机状态有关的命令**:`sync-from-git`、`doctor --fix`、`backfill` 这类是扫本机 git 再改卡,云上没有那份 git。它们不按命令重放,改记成「字段补丁」操作:`{ "command": "patch-ai-meta", "taskId": …, "add": { "commitShas": […], "prNumbers": […], "gitBranch": […] } }`——只许往这几个只增不减的数组里加,云上做并集。
- **不同步的命令**:`register`、`enroll`、`release`、`hooks-*`、`claim-check`、`render-index`、`snapshot`、`archive-activity`、所有只读命令。它们要么不改看板,要么只管本机。

### 4.3 云端白名单

云上的执行入口沿用 `cli/collaboration.cjs` 的 `ownerOperation` 思路,另开一份「同步白名单」,比网页负责人通道宽,但仍是显式列举:

`add`(含批量)、`claim`、`unclaim`、`progress`、`await-collect`、`collect-brief`、`pending`、`decide`、`undecide`、`park`、`unpark`、`block`、`done`、`cancel`、`reopen`、`note`、`request-info`、`edit`、`mark-landed`、`cost`、`patch-ai-meta`。

`set`(任意字段直改)不进白名单:它能绕开状态机,在多人场景下太危险;本机用了 `set` 的云端项目,那条操作云上一律拒,本机提示改用专门命令。

只有负责人设备能走这条通道(第 8 节);成员账号永远走合同里已定的成员接口。

## 5. 同步程序怎么送上云和拉回

### 5.1 发送

- 同步程序盯着各项目的待发队列(文件变化通知 + 每 10 秒兜底扫一次),有新操作就**按序号逐条**发:`POST /api/sync/projects/<项目>/ops`,一次最多打包 20 条,按顺序在云上执行,遇到第一条被拒不影响后面的(每条独立判)。
- **幂等**:云端为每个项目记一本「已执行操作编号」账,同一个 `opId` 再来,直接回上次的结果,不再执行;同一 `opId` 内容不同则拒。所以断线重发、程序重启重发都安全。这本账**按设备的已确认序号清理**:设备每次发送附带「我已确认到第几号」,云端删掉该设备这个序号以前且超过 7 天的回执;另设每项目 2 万条硬上限,超了先删最旧的已确认回执(前任分支的回执账只增不减,是盘点报告点名的坑)。
- **云上流水的署名**:云上执行时,活动流水记负责人的 `userId`、`via: "ai"`(本机操作人是 AI 时;`--author` 为负责人本人时记 `via: "owner-device"`)、`clientTs` 与设备名,供协作版的贡献统计(工单 collab-contrib-core-1019)区分「负责人亲手」和「AI 代办」。
- 回执三种:`applied`(成功,附云上执行后的卡片摘要)、`rejected`(云上拒,附原因,如「这张卡已被成员小王认领」「done 前没登开销」)、`retry`(云端暂时忙或锁超时,稍后重发)。
- 发送进度记在 `<数据根>/sync/<项目>/state.json`:最后一条已确认的序号、最后一次拉取时刻、云上版本号。队列文件只追加;已确认的条目每天归档一次。

### 5.2 断网排队与补发

- 连不上云(隧道断、云端停、网络抖):操作照旧在本机队列里攒着,本机命令完全不受影响。同步程序按 2 秒起、每次翻倍、最长 5 分钟的间隔重试,恢复后按序补发。
- **本机命令永不等网络**:命令行进程里没有任何网络调用,`board.cmd` 的耗时和今天一样。290 毫秒一趟的延迟只落在后台同步程序身上。
- 队列积压超过 24 小时或 500 条:本地看板顶部亮黄条,命令行写命令在标准错误多打一行提醒(不改退出码、不改标准输出,AI 读结果的口径不变)。

### 5.3 拉回

- 订阅云端事件流 `/api/stream`,收到该项目有变就拉;事件流断了改每 30 秒拉一次。另外每发完一批操作拉一次。
- 拉的是负责人身份看到的云上整本(负责人读接口不脱敏,和本机格式相同),带云上版本号,没变就不下载正文。
- 写回本机:进本机板锁,用云上整本替换,但**还在队列里没确认的操作所涉及的卡保留本机版本**(否则 AI 刚 claim 的卡会在回执到达前被拉回的旧版本闪回去)。这些卡在回执到达后的下一次拉取里换成云上版本。
- 活动流水以云上为准整本替换;本机记的流水在操作被云上执行时已经由云上补进去了(带 `clientTs` 和设备名),不会丢。

## 6. 冲突与被拒

- **同一张卡两边同时改**:没有「合并」这一步。本机的操作送到云上,云上按当时最新状态判:能做就做(比如两边各留一条言,都成),不能做就拒(比如成员已经认领,本机 AI 再 claim 被拒)。拉回后两边一致。
  - 施工记录（CLOUD-BOARD-REMOTE-1018 / cloud-claim-guard-1020）：云端认领判权由本单补上；同步重放携带负责人 actorUserId，锁内发现 assigneeUserId 存在且不同于负责人时，以 409 rejected 退回，卡片与活动流水不变；原文为「这张卡已被成员 ${t.assigneeName || t.assigneeUserId} 认领(主负责人),云端退回本次认领;要一起干请在网页上改用「加入协作」,或请对方先放弃认领」。没有主负责人或主负责人就是负责人时照旧执行；不带 actorUserId 的本机命令与重放不受影响。
- **被拒的改动怎么退回**:拉回时自然被云上版本覆盖;同时:
  1. 本机看板该卡亮红色角标「云端退回」,点开看原因和原命令;顶部通知条计数。
  2. 本机该卡流水追加一条 `sync:rejected` 记录(命令、原因、时刻),这条只在本机,不上云。
  3. 下一次任何 AI 对该项目敲写命令时,标准错误打一行:`⚠ 云端退回了你 1 条改动:claim CLOUD-…(已被成员认领)。看 board.cmd cloud status`。读命令 `show` / `brief` 也在卡片头部带这一行,让接手的 AI 一眼看到。
  4. 不自动重试被拒的操作(重试只会再被拒);要不要换个做法由 AI 或负责人决定。
- **本机先改、云上后来又被成员改**:正常情况,拉回即可,不算冲突。
- **云端那张卡已不存在 / 项目被关了授权**:按被拒处理,原因写清。

## 7. AI 的施工记录怎么上云

这些都是现有命令的参数或字段,随操作上云,云上照常写进卡:

| 记录 | 来自哪条命令 | 云上怎么存 | 成员能不能看见 |
|---|---|---|---|
| 施工方 | `claim --builder` | `builder` 字段 | 不显示原值,只显示「AI 施工中」(合同第 65 行) |
| 分支 | `claim --branch`、`patch-ai-meta` | `gitBranch` | 不显示 |
| PR 号、提交号 | `done --pr --commit`、`patch-ai-meta` | `prNumbers`、`commitShas` | 不显示 |
| 开销 | `cost` | `cost.entries` | 不显示 |
| 拍板问题 | `pending` 三件套 | `decisions` | 合同未开放给成员,沿用 |
| 进度与下一步 | `progress` | `percent`、`nextMilestone` | 显示 |

成员可见性完全沿用合同里成员视图的脱敏规则,同步不额外放开。开销的入账口径不变:本对话的开销照旧由 `conversation-cost.cjs` 调本机 `cost` 命令登记,自动随操作上云。

## 8. 本地凭据怎么存

- **不存密码**。本地看板「云端项目」页面里输入一次云端负责人账号密码,本地服务拿去云端登录,随即调合同里的 `POST /api/auth/devices` 为这台电脑建一个设备凭据(名字形如「本机同步·主机A」),然后把密码从内存里丢掉。
- 设备凭据存在 `<数据根>/sync/device.cred`,用 Windows 当前用户加密(DPAPI)后再写盘,文件权限只给当前用户;别的用户、拷走文件到别的电脑都解不开。加解密通过隐藏窗口的 PowerShell 一次调用完成。
- 同步程序启动时用设备凭据走 `POST /api/auth/device-login` 换一个会话(会话 7 天、设备 90 天,见 `core/collaborationAuth.cjs`),再 `GET /api/auth/session` 取 CSRF;写请求按合同带 `Origin`(云端配置的公开地址)、`Content-Type: application/json`、`X-Dashboard-Request: 1`、`X-Dashboard-CSRF`,不带任何转发头。会话过期自动重换;设备到期前 7 天页面提醒重新登录一次;设备到期或被负责人在云端撤销,页面提示「请重新登录云端」,队列照旧攒着等。
- 凭据不进命令行参数、不进环境变量、不进日志、不进 URL,和合同第 43 行一致。
- 每台电脑一个独立设备凭据,在云端设备列表里能看到、能单独撤销。负责人的几台电脑都接同一个云端项目时,各自发各自的操作,云上排队执行,互不干扰。

## 9. 本地看板界面:「云端项目」板块

- 左侧导航加一项「云端」,页面三块:
  1. **连接状态**:已连接 / 正在重连(下次重试倒计时) / 未登录;云端地址;本机设备名;上次同步时刻。
  2. **项目开关表**:每行一个本机项目——开关、同步状态(一致 / 待发 N 条 / 有 N 条被退回)、云端项目编号、首次接入方式。
  3. **退回与提示**:被拒的改动列表(卡号、命令、原因、时刻),可逐条「知道了」。
- 看板主页面:云端项目的项目卡片上带一个小云标记;被退回的卡亮角标。
- 外观先出样图给负责人看(负责人的界面偏好:先出样图、不用 emoji、图标自绘),施工单里不写正式文案,用占位符。

## 10. 同步程序作为常驻服务

- 程序入口 `cli/cloudSync.cjs`(Node,无新增依赖),单实例:启动时抢 `<数据根>/sync/agent.lock`,抢不到就退出。
- **调度台长期占用**:通过 `sched.cjs hold --project dashboard --cores 0 --title "看板云同步常驻" -- node cli/cloudSync.cjs run` 启动,调度台登记为长期占用单;它几乎不吃 CPU,核数登 0(若调度台不收 0 核,登 1)。
- **开机自启、静默**:Windows 计划任务「用户登录时」挂 `wscript.exe` 跑一个 `.vbs` 启动器,`Run 命令, 0` 隐藏窗口;程序内每个子进程(PowerShell 加解密、ssh 隧道)都写 `windowsHide: true`;`detached` 的同时必写 `windowsHide`。验收用 `console-flash-watch.ps1` 跑满一个周期不出现它的窗口。
- 本地看板服务不负责拉起同步程序(避免牵连看板服务重启),只读它写的状态文件 `<数据根>/sync/status.json` 显示在页面上;页面上的「重新连接」按钮写一个请求文件,由同步程序自己读到后处理。
- 日志 `<数据根>/sync/logs/`,按天滚动,保留 14 天,不含凭据和卡片正文。

## 10.5 和前任分支的关系

`codex/cloud-board-remote-1018` 做的是「每条命令当场经 SSH 写云端」:命令行直接等云端回执,断网时命令失败、要手工 `remote-retry`;每条命令一次完整 SSH 往返(建连约 3.9 秒),且和调度搬家捆在一个 PR 里,测试从未实跑。本设计不沿用它的「命令直写云端」,只借鉴两样:写请求先落盘再发送、请求编号回执去重(`cli/remoteOutbox.cjs`、`core/boardCommand.cjs`),补上它没有的自动补发和回执清理。

## 11. 要负责人拍板的岔路

2026-10-19 负责人已拍板(看板卡 CLOUD-BOARD-REMOTE-1018 的 d1、d2):

1. **本地连云端:继续走 SSH 隧道**,不开公网。
   - 同步程序自己拉起一条 `ssh -N -L 127.0.0.1:<本机端口>:127.0.0.1:<云端看板端口> <主机别名>`,参数固定 `BatchMode=yes`、`ExitOnForwardFailure=yes`、`ServerAliveInterval=15`、`ServerAliveCountMax=3`,子进程 `windowsHide: true`。
   - 隧道断了按第 5.2 节的退避重连;建连一次约 4 秒,只在重连时付。
   - 主机别名、云端看板端口、云端公开地址(写请求的 `Origin`)存在 `<数据根>/sync/config.json`,用这台电脑现有的 `~/.ssh/config` 与钥匙,不要求负责人贴密码或私钥。
   - 不碰线上 16060、16061、staging 与旧代理进程;云端看板端口填协作版实例自己的端口。
2. **成员不装本地版**。负责人原话:「我不希望必须要有本地版。」成员直接在浏览器里用云端网页改云上那本,第一版本地同步只给负责人的电脑。
   - 成员网页要从公网打开,是协作版上线时单独的决定(合同验收第 6 条),不在本卡。

## 12. 施工分解(拍板后细化成契约)

| 批 | 内容 | 主要文件 | 验收要点 |
|---|---|---|---|
| S1 本机记操作与重放 | 入口操作上下文、`mutate` 锁内追加队列、文件参数与依赖本机环境的默认值内联、`patch-ai-meta` 记录、不同步命令表;**重放函数 `applyOp`**(含入口三道闸的共用版)| `cli/index.cjs`、`cli/store.cjs`、`core/resolveProject.cjs`、新 `core/syncOutbox.cjs`、新 `core/syncReplay.cjs` | 未开同步的项目行为逐字节不变;开了的每条写命令恰好一条操作、序号连续、并发两进程写不乱序不丢;**按记录在另一份看板上重放,结果与本机一致** |
| S2 云端执行入口 | `/api/sync/projects/:id/ops` 批量执行(调 S1 的 `applyOp`)、`opId` 幂等账与清理、同步白名单、上传与采用接口、版本号、流水署名 | `server/collaborationApi.cjs`、`cli/collaboration.cjs`、新 `core/syncLedger.cjs` | 重发同一 `opId` 不重复执行;非负责人设备拒;`set` 拒;闸门在云上同样生效 |
| S3 同步程序 | 发送、指数退避、拉取与写回(待发卡保留本机版)、事件流订阅、凭据加解密、单实例、状态文件 | 新 `cli/cloudSync.cjs`、`core/syncCredential.cjs` | 断网 10 分钟内的 50 条操作恢复后按序全上云;被拒操作本机退回并提示;不弹窗 |
| S4 本地界面 | 「云端」页面、项目开关、登录一次、退回列表、卡片角标 | `web/src/…`、`server/server.cjs` 新本地接口 | 样图先过负责人;浏览器实测开关与登录流程 |
| S5 常驻与开机自启 | `hold` 登记、计划任务 + `.vbs` 启动器、安装与卸载命令 | `packaging/` 或 `scripts/` | 登录后自启、调度台可见长期占用单、闪窗监测为零 |

S2 复用 S1 的重放函数,S1 落地后再派;S3 依赖两者;S4 依赖 S3 的状态文件格式;S5 最后。

## S3 甲施工交接

本单新增本机后台同步程序，不改既有 CLI 写入路径、服务端、界面、部署和启动任务。

- `core/syncCredential.cjs`：连接配置校验、当前 Windows 用户 DPAPI 加解密、设备登记及密码会话注销。设备凭据只通过隐藏 PowerShell 的标准输入输出传递，提供 protector 注入供跨平台测试使用。
- `core/syncClient.cjs`：内存中的设备会话、一次认证重试、写请求保护头、读写超时、四个同步接口及 SSE 事件解析。
- `core/syncAgent.cjs`：与 mutate 相同的板锁、连续确认、分批发送、退回记录、整本拉回、待发卡保留、每日归档、单实例、SSH 隧道及后台循环。
- `cli/cloudSync.cjs`：`run`、`once`、`status`；不接受凭据类参数。第二个常驻实例退出码为 3，单轮失败为 1。
- 两份新增测试：真实协作服务端与真 CLI 的断网/恢复、冲突/重发、事件流/撤销、归档与隔离；真实 Windows DPAPI、隐藏子进程和真实登记流程。

所有目录均以显式 registryPath、DASHBOARD_REGISTRY 或 REGISTRY_PATH 的所在目录为准，根目录为其下 `sync/`：

| 文件 | 字段与职责 |
|---|---|
| `config.json` | `v:1, mode, origin`；ssh 模式另有 `sshHost, remotePort, localPort`，direct 模式有 `baseUrl` |
| `device.cred` | `v:1, scheme:'dpapi-user', origin, label, deviceId, expiresAt, blob`；blob 为密文，原文不落盘 |
| `agent.lock` | 排他锁及持有进程号；正常退出释放，已死亡进程遗留锁可回收，不按运行时长抢活进程的锁 |
| `reconnect.request` | 后续界面写入，程序读到后删除并立即重连同步 |
| `logs/agent-YYYYMMDD.log` | 仅时间、级别、事件名、项目 id、条数、HTTP 状态，按天滚动保留十四天 |
| `<localId>/state.json` | `v:1, ackedSeq, etag, lastPullAt, lastPushAt, lastArchiveDay, untracked, lastError`；untracked 最近五十条 `{seq,taskIds,source,clientTs}` |
| `<localId>/base.json` | 上次写回所用的云端整本，project.id 已换成本机 id |
| `<localId>/outbox-archive-YYYYMM.jsonl` | 每天第一次成功同步归档已确认行，原 outbox.seq 不变 |

后续命令行提示与界面**只读以下两份公共状态**，不自行推断队列进度：

```text
status.json = {
  v:1, updatedAt,
  agent:{pid,startedAt,state,nextRetryAt,lastError,origin,deviceLabel,deviceExpiresAt},
  projects:{<localId>:{remoteProjectId,pending,oldestPendingAt,ackedSeq,
    rejectedUnseen,untracked,lastPushAt,lastPullAt,lastError}}
}
<localId>/rejected.json = {
  v:1, items:[{seq,opId,command,taskIds,httpStatus,error,at,seen:false}]
}
```

agent.state 为 `connected | reconnecting | login-required | stopped`。pending 只数未确认 op，不计 untracked；untracked 为保留提醒条数。退回项按 opId 去重，最多二百条，优先删除最旧已读项。错误只存固定人话原因与 HTTP 状态，不复制可能含卡片正文或凭据的任意服务器错误字符串。所有状态 JSON 以仓库原子写函数落盘。

与设计正文的区别：退回记录只保存在 rejected.json，不往卡片流水写 `sync:rejected`，因为下次拉回会整本替换流水，写入也会冲掉。每批确认后清除条件读取版本，确保云上没有发生变化的拒收也能撤回本机草稿；普通无变化拉取仍保持 board.json 内容和 mtime 不变。拉回直接原子写板，不经 mutate，不追加 outbox。SSH 登记临时隧道及常驻隧道都使用固定参数和隐藏窗口，不连接任何真实云端进行本单测试。

自测记录（仅经指定 mailbox，未直接运行 Node、安装依赖或执行全量测试）：

- 第 1 次申请 `20261020T084023-e4e71358`：凭据测试原始日志为 4/4 通过、0 跳过，Windows DPAPI 往返实跑通过；但运行期间追加修复导致受测内容漂移，最终回执将 AGENT、CRED 自动项作废，**不能作为本次交付的通过证据**。NOWINDOW 最终为绿，输出「本单涉及文件的子进程调用都带 windowsHide: true」。
- AGENT 首项在服务重启就绪等待处失败，后续联网项连带失败。已定位：服务端只在随机端口模式发送 IPC 就绪消息，固定端口重启需读取实际监听地址；退出清理也必须识别 signalCode，不能再等待已退出的进程。辅助逻辑已修正，原断网、五十条写入和数据一致性断言不变。最终回执另报「调度撤单未确认:等待超时」，AGENT 票据 `tk-2e968a967637e204b58a` 仍显示 running；请派单器核实回收状态，本施工方未手工强杀。
- 同步引擎自审另外修正了多项目中后续成功掩盖先前失败的状态，并补充坏快照拒写、运行中重载凭据、队列变化和重连请求测试；这些最终改动尚待重新实跑，不能以首轮旧代码结果冒记通过。
- 正式入口结论为「这次没验成」「直接交活」，依工单停止自测，不另行重试。最终 AGENT、CRED 及其余回归仍待派单器统一验收，FAST 通过 heavyRequests 申请。看板与成本登记由派单器代办。本单为部分完成，未冒记验收通过。

### 自动复核第 1 轮后的恢复记录（2026-10-20）

派单方明确恢复施工后，已补齐退回场景真 CLI 的必填 `--builder 派单器`，不修改生产闸门。第 2 次自测 `20261020T085723-a574e1e9` 中 CRED、NOWINDOW 取得有效通过结果，AGENT 的退回文件仍未生成。随后只增加对真实云端回执的直接断言，保留原退回与脱敏断言，不通过制造拒收记录让测试变绿。

第 3 次自测 `20261020T085821-caa44060` 确认：成员已认领 T1 后，本机 claim 的云端回执实际为 `applied`，契约要求 `rejected`；AGENT 为 19 项中 16 通过、3 失败（含父用例），无取消、无跳过。隐私检查的 rejected.json 缺失是该场景未被拒收的连带结果，不是凭据泄漏证据。

源码链路：`cli/collaboration.cjs` 的 syncOperations 直接调用 `core/syncReplay.cjs` 的 applyOp，再调用 `cli/commands.cjs` 的 claim；后者允许「施工中」状态，没有成员 assigneeUserId 冲突检查。这三个文件均在本单禁区。本机同步程序不能把云端 applied 擅自改成 rejected，也不能用本机检查代替云端板锁内判权。

当前状态为 blocked，暂停继续测试与修改，等待派单方决定：推荐另派上游单补齐云端冲突规则后恢复本单；另一选项为明确扩大本单施工面，在同一工位修复禁区文件（代价是扩大职责与旧命令回归风险）。不建议修改原验收要求。无需重复运行已定位的失败；看板和成本仍由派单器代办。

### 上游修复接入后的验收（2026-10-20）

派单方选择另派上游修复，PR #128 已合入；本工位基线核对为 `d8b8acd`。原成员归属冲突阻碍已解除，本单没有修改任何禁区文件或放宽断言。以下三批测试运行期间未修改受测文件：

- 第 4 次 `20261020T222421-2eea4cb9`：AGENT、CRED、NOWINDOW 全绿；成员认领回执拒收、退回文件与敏感信息检查全部通过，Windows DPAPI 实跑且未跳过。
- 第 5 次 `20261020T222504-5678a2f9`：SYNCOPS、OUTBOX、REPLAY 全绿。
- 第 6 次 `20261020T222542-382bfb53`：HTTP、LEGACY-CMD 全绿；同批已申请 FAST，但正式回执明确为「本次没跑:FAST(这类检查不能自测,交活后派单器统一重跑)」。该批退出码 0 不代表 FAST 通过。

当前剩余阻碍仅为 FAST 执行入口：已获授权要求全部跑完，但施工方 mailbox 不开放这一项，且禁止绕过入口直接起测试。通过 heavyRequests 申请派单方正式排队执行 `test:fast`；或由派单方开放本工单 FAST 自测资格后恢复。八项通过证据保留，FAST 仍为 ran=false，未冒记整单完成；不重复申请已明确排除的自测项。

## S3 乙施工交接

本单为本机 CLI 增加 `cloud` 管理入口，不修改服务端、界面、常驻启动方式和依赖。所有管理子命令支持 `--registry`、`--json`，不进入同步重放上下文，不调用 `store.mutate`，不生成 op 或 untracked 记录。

| 子命令 | 用法与效果 |
|---|---|
| config | 无参数查看；`--ssh-host --remote-port --local-port --origin` 配置隧道，或 `--direct --base-url --origin` 配置直连，沿用甲单校验 |
| login | `--username [--label]`；密码只读标准输入第一行，终端静音，登记设备后请求重连 |
| logout | 删除本机设备凭据、请求重连，保留队列 |
| reconnect | 只写 reconnect.request |
| status | `[--project]`；只读 status.json 和 rejected.json，不推算队列，读不到也返回 0 |
| ack | `--project (--all 或重复 --seq)`；板锁内全量校验序号后标已读，不存在时不写文件 |
| attach | `<本机id> --remote <云端id> (--upload 或 --adopt)`；设备登录，上传或备份后采用云端，初始化 base/state 并锁内登记 |
| detach | `<本机id> [--drop-pending]`；待发未处理时拒绝，明确丢弃则留存原始行并推进确认序号，保留本机整本 |

`core/syncCredential.cjs` 的 `withCloudClient` 共用临时隧道、认证就绪重试和清理。密码登记流程仍为密码登录、建设备、加密保存、注销密码会话。设备凭据与密码不进入进程参数、环境变量、URL、输出或日志。

退回提示位置：REPLAY_COMMANDS 与 PATCH_COMMANDS 的写命令在原成功/失败输出之后向 stderr 追加一行；show/brief 仅当本卡有退回时在文本头部提示，JSON 只新增 `cloudRejected`。未开云同步时不加载提示模块、不读同步文件。格式为：

```text
⚠ 云端退回了你 N 条改动:command 卡号(原因)等。看 board.cmd cloud status
```

只有 N 大于 1 才带「等」。`rejected.json` 保留原 `error` 固定人话原因；新增可选 `reason`：仅 claim/409 且严格匹配已知成员认领错误前缀时提取至多 64 字符的成员名，提示「已被成员 <名> 认领,要一起干请在网页上改用「加入协作」」；set/403 提示「云端项目不接受 set,请改用专门命令」。其他错误不写 reason；日志不写 reason。展示优先 reason，回落 error。不自动重试退回，不自动加入协作。

与正文的差别沿用甲单：退回只存公共状态，不向卡片流水追加易被整本拉回覆盖的记录。status 缺少项目报告时 pending/untracked 返回 null，文本显示未知和「同步程序还没报到」，不将未知冒记为零。上传期间不持板锁等待网络，完成后在锁内核对本机原始字节；若本机期间发生写入则拒绝登记，保留本机与已上传副本并明确提示核对。采用模式备份板锁内读取的原始字节。接入确认序号来自既有 outbox.seq，不重发接入前旧记录。

自测记录（仅通过指定 mailbox，共 4 次，未直接启动 Node、测试或全量检查）：

- 第 1 次 `20261020T224801-86e06a4f`：CLI、AGENT、CRED 全绿。覆盖真实协作服务与命令行的登录、上传、采用、成员冲突退回以及凭据流程。
- 第 2 次 `20261020T224844-3486a74d`：HELP、OUTBOX、SYNCOPS 全绿。
- 第 3 次 `20261020T224937-8ae40e7a`：LEGACY-CMD 绿；NOWINDOW 红，指出新测试第 54 行。该调用已有 `windowsHide: true`，但参数数组里的箭头函数使既定扫描器提前截断。保留原检查，将参数数组计算移到调用前。
- 第 4 次 `20261020T225051-9751041d`：CLI、NOWINDOW 全绿。同步补充损坏退回记录不会改变写命令退出码的回归；status 与命令提示共用只读过滤。原十二类断言全部保留，未放宽验收。

最终八项可自测检查均有有效通过回执，FAST 依工单禁止自行运行，通过 heavyRequests 申请派单器执行；旧代码必红复核同样由派单器执行，本轮不冒记已跑。测试还包括旧入口输出逐字节对照、关闭同步时的文件读取监视、重复上传不改本机、备份原始字节一致和丢弃待发原行留存。每批测试期间不修改受测文件，最后只追加本交接记录。成果只留工作区，Git 操作仅只读，看板及开销由派单器代办。

### S3 乙自动复核第 1 轮恢复

派单方 CLI 原始复核为 14 项中 12 通过、2 失败（包括父用例），唯一独立失败是登录参数拒绝测试的监听器收到 1 次请求，要求为 0。原断言、原失败日志保留，没有修改生产登录实现或放宽零请求要求。

- 第 5 次 `20261020T225416-3d3ec1bc`：给监听器增加不含请求正文、凭据或任意 URL 的诊断，CLI 通过；额外请求没有复现，不能把这一绿认作修复证明。
- 已确认的干扰机制：`server/server.cjs` 的 `findExistingInstance` 会在 `127.0.0.1` 上扫描一段相邻端口并发送 `/api/health`；同批 FAST 的 `test/readerImport.test.cjs` 用动态空闲端口启动这种服务。原始日志未记请求路径，因此历史那一条请求是否来自该扫描仍未证实。
- 修复限于测试隔离与观测：被测云端计数监听器改绑 `127.0.0.2`，所有收到的请求仍逐个计数，仍断言严格为 0，不按路由过滤、不重置计数。另在同端口的 `127.0.0.1` 建探测对照，实发健康检查验证地址隔离。对子进程的真实 fetch 加纯计数观察，禁止参数的每次调用都断言 fetch 为 0，且标准输入错密码的真实请求必须大于 0，以证明观察器有效；观察器不替换网络响应。
- 第 6 次 `20261020T225747-745c482e`：CLI、NOWINDOW 全绿，包含上述地址隔离与发送端检查。其余生产文件与上次交付相同。本轮不重复执行已通过的无关回归，不自行执行 FAST；交派单方继续正式复核。

## S5 施工交接

### 命令与任务形态

```text
board.cmd cloud service install [--sched-cli <sched.cjs绝对路径> --sched-share <共享盘根>] [--task-name <名称>] [--registry <注册表文件>]
board.cmd cloud service uninstall [--task-name <名称>] [--registry <注册表文件>]
board.cmd cloud service status [--task-name <名称>] [--registry <注册表文件>] [--json]
```

默认任务名 `DashboardCloudSync`，安装后立即运行一次。仅 Windows 支持安装和卸载，其他平台明确报「目前只支持 Windows」并退出 1，不写文件。三个子命令均支持 `--json`。

使用 PowerShell `Register-ScheduledTask` 注册当前用户的登录触发任务，登录触发含十分钟无限重复，交互用户令牌、普通权限、`IgnoreNew`、不限运行时长，并允许电池供电。任务动作只有 `wscript.exe "<数据根>/sync/launcher.vbs"`；PowerShell 仅用于隐藏注册和查询，不是任务动作。

启动器为带字节序标记的 Unicode VBS，调用 `Run 命令, 0, True` 并传递退出码。Node 使用安装时的 `process.execPath`，同步入口使用执行安装的这份代码根目录；启动器设置 `DASHBOARD_REGISTRY`，确保计划任务继承正确数据根，不依赖启动目录。调度参数必须成对提供，指定后使用 `hold --share <共享盘根> --project dashboard --cores 1 --title "看板云同步常驻" --category other --work-type cloud-sync -- <node> <同步入口> run`，未指定则直接运行。第二个同步实例仍由锁拒绝并退出 3。

### 停止与数据保留

常驻循环在重连请求检查处检查 `<数据根>/sync/stop.request`。已开始的一轮完成后停止，释放锁、删除请求，正常退出 0。卸载先删除计划任务，再写停止请求，最多等十五秒释放锁；超时读取锁中的进程号，以隐藏的 `taskkill` 结束进程并确认退出，最后删除启动器。强制停止遗留的已死亡进程锁会清理。队列、状态、连接配置、凭据和历史日志全部保留；无人运行时的停止请求在下次安装启动前清理。

状态查询返回任务安装情况、下次触发时间、锁中的进程存活情况以及原始状态报告；旧状态报告不能单独证明进程仍活着。查询异常向上报错，不把查询失败伪报为未安装。

### 验收边界

定向测试使用假执行器检查注册、立即运行、卸载、超时停止与查询，不实际注册任务。真实子进程仅在临时数据根内连接不可达地址，验证重连期间第二实例退出 3，以及停止请求十五秒内正常退出、释放锁、删除请求；测试完成即退出。

派单工位不安装任务、不启动长期常驻。负责人机器上须另行安装并验证重新登录后自启、十分钟触发兜底、调度台可见一核长期占用单，并运行 `console-flash-watch.ps1` 满一个周期，确认闪窗为零；随后验证卸载后停止、队列及状态文件保留。全量回归与旧代码必红复核由派单器统一执行。

S5 本轮自测：第 1 次 SERVICE、AGENT、CLI 全绿；第 2 次 HELP、IDENT 全绿，合计使用两次申请。FAST 未在工位执行，交派单器统一排队；旧代码必红和负责人机器的实际自启、调度占用、闪窗监测尚待正式复核。未注册任何真实计划任务，未执行 Git 写操作，看板与成本由派单器代办。
