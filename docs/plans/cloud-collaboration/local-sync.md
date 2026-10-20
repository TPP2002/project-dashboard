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
