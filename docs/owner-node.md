# Owner node：入口对照、部分实现与恢复点

任务：CLOUD-OWNER-NODE-1018，工位：cloud-owner-node-1018-r2。
核对基点：`bb0db9397795a879a0b4952a66e2f1b80241c5ec`。
已落盘契约、独立承载、CLI、路由接入、采集缓存、生命周期和合成测试；本轮补齐主控授权的网页操作身份接线。
状态为 **施工交主控验收，未部署、未执行验收**。下述实现描述不是运行通过或线上生效证明。
指定验收没有运行；没有实际部署、连接真实服务器、调用模型或读取真实秘密。
启动参数与合成配置见 `packages/owner-node/README.md`，它们只用于后续受控集成。

## Operation → 原输入字段 → 既有处理器

表中 operation 名来自施工单；版本、方向、代际、序号、nonce、operationId、hash 已有严格运行时契约。
`project` / `projectId` / `pid` 是现有 HTTP 参数名，不能原样当成节点路径。
普通 POST 上限为 256 KiB；reader import 单独为 45 MiB。既有响应字段须保持。

| 固定语义 | 现有入口、字段和边界 | 既有处理器 / 数据来源 |
| --- | --- | --- |
| `dispatch.launch`，decision | POST `/api/dispatch`：`pid,tid,did`；三项非空，已注册项目、存在任务和已回答决策 | `server/server.cjs` `handleDispatch`；读 board、生成 prompt、启动 cmd/Claude |
| `dispatch.launch`，project | POST `/api/dispatch-project`：`pid,preview`；必须有待落地决策，`preview===true` 只返回 prompt/count | `handleDispatchProject` |
| `dispatch.launch`，task | POST `/api/dispatch-task`：`pid,tid,preview`；任务有待落地决策，预览返回 prompt/trigger/count | `handleDispatchTask`；`cli/dispatchPrompt.cjs` 生成指令 |
| `jobs.list/get/task` | GET `/api/codex/jobs,job,task`：`project`；后两者 `slug`，job 可传 `tail=0`；slug 正则 `^[a-z0-9][a-z0-9-]*$`（HTTP 层没有独立长度上限） | `server/codexApi.cjs` `handleJobs/handleJob/handleTask`；代码仓 `.codex/jobs`；`attachLiveness` 使用本机进程事实 |
| `jobs.dispatch` | POST `/api/codex/dispatch?project=`：`slug,taskText?`；taskText 必须解析为 JSON 对象；原工单、进行中集合及活性阻止复派 | `handleDispatch` → `spawnDispatchCli` → `scripts/codex/codex-dispatch.ts dispatch` |
| `jobs.say/collect` | POST `/api/codex/say,collect?project=`：`slug`；say 还需非空 `message`，至多 8000 字符；工单必须存在 | `handleSay/handleCollect` → 同一正式 CLI；输出为 text/plain；collect 有判决文件时可接受非零退出 |
| `sessions.list/get/resume/quota` | `/api/codex/sessions,session,say-session,quota` 均经过 project 上下文；list：limit 1–500、days 1–365；get：UUID `id`、tail 1–1000；resume：UUID `sessionId`、非空 message≤8000、sandboxMode 为 read-only/workspace-write | `server/codexSessionApi.cjs`；`codexSessions.cjs` 扫本机会话；resume 查已有会话再启动本机 Codex |
| 会话战报（不可遗漏） | GET `/api/codex/report?project=&days=`；days 仅 7 或默认 1 | `handleReport` → `getCodexReport`；属于原 owner 功能，需纳入固定会话语义 |
| `usage.changes` | 新增采集语义，没有原 HTTP 同名入口；原成本页 GET `/api/cost?project=&days=`，days 1–365；`project=all` 为组合汇总 | `handleCostUsage/handleCostPortfolio`；Claude、Codex、DeepSeek、GLM、quota；不能仅迁 Claude 后返回空的其他来源 |
| `usage.details` | GET `/api/cost/session-detail,job-detail`：`project,fromDate,toDate,model,card,engine`；session-detail 另有 days；日期正则 YYYY-MM-DD，文本过滤项只认 string | `handleCostSessionDetail/handleCostJobDetail`；保持 rows/totals/options/filters；工单明细来自本机 jobsRoot |
| `usage.balance` | 当前嵌在项目成本响应中的 `deepseekBalance`，没有独立 HTTP 路由 | `core/deepseekBalance.cjs`；env 优先、Windows 再查 HKCU；返回 available/reason/balance/sampledAt，凭据不可传云 |
| `project.doc.get` | GET `/api/doc`：`projectId,path` 非空字符串；路径按 docsRoot/realpath 校验；返回 text/plain | `handleDoc`；原 API 的相对路径须映射为绑定项目的对象，不能扩成任意路径 RPC |
| `project.facts` | 原 `/api/health` 中 `hooksInstalled`；不是一个可公开新增的节点信息路由 | `hooksInstalledMap` → `hookInstalledFor(proj.codeRepo,id)`；云板路径和节点仓库路径必须分开 |
| `ci.snapshot` | GET `/api/sched/ci-jobs` 无用户提供 repo 参数 | `ciJobs.snapshot()`；`core/schedCiJobs.cjs` 的 monitor/gh API；当前后台定时 refresh、从项目 board 位置查 git origin，迁移后只认配置 repo |
| `reader.sources.get` | GET `/api/reader/manifest,report,export-review`：`project,key`（manifest 无 key），key 正则 `[A-Za-z0-9_-]{1,40}`；IMP- 导入正文来自云账本 | `server/readerApi.cjs` `readManifest/loadReportBundle/loadNoteLayers`；固定 `docs/design/审计回流/reader.json`，按清单读 md/prevMd/noteLayers；report 保持 batch/report/md/prevMd/notes/annos/highlights/review |
| `reader.annotations.export` | POST `/api/reader/export`：`project,key` | `handleExport`；唯一目标 `docs/design/审计回流/批注/<key>.json`；响应 ok/path/count；未来由云提供账本版本与内容，节点只写固定导出 |
| `audition.sources.get` | GET `/api/audition/index,batch,file`：`project`，batch 带 key，file 带项目相对 path；音频单段 Range | `server/auditionApi.cjs` `readIndex/loadBatch/serveFile`；固定 `docs/design/audio/试听台/audition.json`；单文件≤30 MiB，mp3/ogg/wav/html/htm/png/jpg/jpeg/webp/svg 白名单；保留 HTML/SVG 各自 CSP、音频 206/416 和 MIME |
| `audition.annotations.export` | POST `/api/audition/export`：`project,key`，key 同上，批次必须存在 | `post('export')`；唯一目标 `docs/design/audio/试听台/批注/<key>.json`；响应 ok/path |

仍由云唯一写入的入口（不能把它们整条透传给节点）：

- Reader：GET/POST annos，POST marks/review；批注≤4000 字，选区必须 start≥0 且 end>start；荧光笔颜色固定 yellow/green/blue/pink，审阅状态固定已审阅/未审阅。GET export-review 是给浏览器生成意见单，不是节点固定目录导出。
- Reader：POST import/import-delete、GET import-original。导入正文≤3 MiB、原件≤30 MiB、标题≤120 字；删除限 IMP-；原件只有 pdf/docx 使用专用 MIME，其余 attachment/octet-stream。
- Audition：GET state；POST note/note/update/note/delete/mark/verdict/review。批注≤4000 字；mark 为 up/down/null；verdict 为 like/meh/dislike/null，原因≤2000 字；审阅状态固定两种。group/scene 必须属于清单。批注及卡片留言镜像都在云处理。

## 第一阶段阻碍及主控解除（保留历史证据）

影响验收：保留 owner 派单/续聊/收单、节点可公开独立部署、正式派单自行挂号。
定位方式：只读核对调用链，无执行付费工具或测试；证据已经能定位到正式派单入口，不需要试跑模型。

1. `server/codexProcess.cjs:8-18` 的固定入口是项目代码仓内 `scripts/codex/codex-dispatch.ts`，经 `npx tsx` 调用。
2. 本仓 `scripts/codex/codex-runner.ts:216-282` 的 dispatch 直接创建工位、写 meta、spawn 监工；监工启动参数硬编码 `--import tsx`（264 行）。`supervise`（311 行起）直接 spawn 模型；`codex-say.ts:281` 直接 spawnSync 续聊。`runAcceptance` 直接 spawnSync 各验收命令。对本仓 `scripts/codex` 搜索 sched/permit 没有调度接入。
3. 因此，“复用项目正式入口，由入口挂号”在当前基点不成立。桥外包 sched exec 被工单明确禁止；引用游戏仓入口又违背公开仓独立运行边界。即使把桥本身做成仅内置模块，现有监工仍依赖 tsx，不能宣称整条执行链满足该要求。
4. `scripts/codex/**` 不在 allowedPaths；`package.json` 在 forbiddenPaths；`packages/scheduler/**` 既禁止修改，也禁止依赖未完成协议。未擅自迁移、复制、替换正式派单器，未关闭任何 owner 功能。

上述是扩大施工面之前的证据，并非当前阻碍。主控随后明确授权修改 `scripts/codex/**`，既有 tsx 依赖由公开仓安装提供，新桥只使用 Node 内置模块。按此授权增加 scheduler helper；dispatch/supervise/say 走 worker 注册、许可确认与 finish/cancel，验收走 exec。后台派单没有外包整个 exec。没有修改共享依赖或 scheduler 包。

## 前轮操作身份阻碍（本轮授权解除）

前轮约束：原 owner 续聊功能保持、丢回执不重复启动、网页仍用原入口，当时 `web/**` 不可修改。

- 原 `web/src/components/codex/CodexSessionsTab.vue` 的 `sendMessage` 只提交 sessionId、message、sandboxMode；`CodexJobsTab.vue` 的续聊只提交 slug、message。当时 authFetch 没有生成 operationId。
- `server/ownerNodeBridge.cjs` 支持显式 `x-owner-operation-id`。未提供时，草稿实现用 node + operation + args 的 hash 持久复用同一 ID。
- 因而同一会话先发送“继续”，正常完成后再次明确发送“继续”，第二次会被当作第一次的回放。这不满足保留既有功能；不能将此草稿当成正确实现或已通过验收。
- 改为每个 HTTP 请求生成新 ID 则无法识别收到业务结果之前断线的重试，违反断网不重复启动。仅靠服务端时间窗、PID、消息内容或完成状态，都不能证明用户意图，不应自行选一个启发式规则。

主控已经批准最小网页请求接线。本轮在明确白名单内完成：owner 写请求持久保存请求摘要与操作 ID；fetch 收到 headers 不结束操作，只有 text/json 业务回执完整消费并确认成功后才结束。断线、读取失败、未知结果保留原 ID；成功后的相同文字是新动作、新 ID。Bridge 缺 ID 返回 400，不再按 args hash 猜身份。权限、布局和认证凭据储存未改变；额外 sessionStorage 仅保存摘要/ID，既不存请求正文也不存凭据。local 模式不插入该协议。

## 当前实现结构（不是验收结论）

- `owner-node.v1`：512 KiB 长度前缀帧、128 KiB 对象块、连接代际/序号/nonce 绑定；固定 node socket 的配置决定 principal，帧不能自报角色或归属。新连接关闭旧节点连接，旧回复不能完成新请求。
- 云 gateway 可独立托管，也可由主控容器包装器 await `serve(config)`；强制 SSH entry 只连接固定 node socket。看板 Bridge 与节点各自单写。Linux 使用固定 inode 的内核 flock，父 FD 持有、关闭释放，不依赖宿主进程挂载；Windows 按不可变代际推进，核实旧 OS 出生身份不再存在后才接管。旧 Linux 代际链须证明已释放或旧身份已结束再封口迁移，未知拒绝；不删除竞争者的锁或旧证据。
- 节点 Journal 在业务动作前 fsync intent；完成后保存回执；重启遇到未完成 launch 不再次启动。素材块与固定目录导出允许相同内容重放。正式派单保留 job slug/state，Windows 进程出生身份由本机查询，Linux 不探测 Windows PID。
- 原 owner 路由在既有认证和模块检查之后接入。没有桥配置时保留 local 路径；读写批注和上传仍使用云端原处理器。素材缓存位于桥专用目录，不覆盖云板注册表中的仓库地址。
- 成本节点每 60 秒检查元数据，Claude 父子组版本包含子文件集合/大小/mtime；只对变化组复用原组解析器。Codex 变化会话按最多 64 个一批在新解析线程中复用原解析器，避免等长替换命中旧 size 缓存。GLM/DeepSeek 使用 jobs 总组指纹，任一输入变化时重解析该组，不宣称逐 job 增量。
- 成本事实按 node/source/sourceVersion 替换，保留游标及有界日志；失去增量时分页对账、临时批次完成后发布。云网页读持久事实，不触发节点全量扫描；详情按需读取。余额仅 Windows 节点读取既有本机 key，示例不含 key。
- 节点材料限制配置 docsRoot 内相对路径，链接/越界被拒绝。试听复用原 Range 解析、MIME、HTML/SVG 策略与 30 MiB 限制；云先拿对象描述，再按请求范围以 ≤128 KiB 分块转发并等待 HTTP backpressure，不先下载完整对象。固定导出绑定内容 hash。

## 本轮补齐与可追溯验证

以下是对应前轮缺口的代码和断言位置，均待主控执行，不以 fixture 代替真实部署：

1. `web/tests/ownerOperations.check.mts`：headers 后正文读取失败保持 ID、无效 JSON 保持 ID、成功后相同文字的新动作生成新 ID、重载恢复与 local 基线。Transport 断言真实合成进程同 ID 一次、新 ID 第二次；Routes 断言云批注同 ID 回放、新 ID 新增、缺 ID 拒绝。
2. 派单 prompt 将 cloud CLI 显示命令映射为固定占位，再由节点替换为公开仓 CLI。节点配置 `dashboardRemoteConfig` 绑定现有公开远程 CLI；启动前必须存在对应项目权威绑定，不能退回本机旧板。
3. resume 从原本机会话读取 cwd；say 公共同步 API 内由独立固定 supervisor 运行，保存 PID 出生身份并每 10 秒复核调度许可。登记拒绝、许可未知或取消不裸跑；结束记录 finish/cancel 回执。
4. `shutdown()` 可重复调用，先停止 HTTP/SSE/轮询和新桥请求，关闭 sched 读者并等待在途写入；5 秒收场超时会拒绝释放 writer 所有权。恢复服务只恢复单写所有权，不清除 Journal 的未知 launch intent。Transport 包含真实进程被杀/再起、未知任务不重派、活写者不被抢占、异步落盘晚于 close 请求的断言；Routes 用包装夹具调用两次 shutdown 后重启同一状态目录。
5. 云会话成本详情使用云 cards/bindings；组合汇总去除同名 Codex 重复归属；分页对账保留 stage 游标，过期批次重新开始；超过 180 秒的采样明确返回陈旧错误，持久事实不删。未测性能。
6. 可选 prev/note 来源删除会移除对应云缓存，保留原处理器缺文件展示；试听范围断言检查真实桥上传输的 offset/length 为请求范围，整段响应也只保留一个分块。未创建长音频带宽基准，3 Mbps 实机体验待主控部署验证。

正常模型主进程退出仍不等于整树退出：`treeExited` 未有证据时继续明确等待核对，不自动复派。正式 supervisor 锁绑定一次性 launch identity，只有已有整树退出证据的新派单才能生成下一代。此保守状态是原工单安全约束，不应通过删锁、改状态或 Linux 同号 PID 来解除。

三份合成测试包含真实 stdio 子进程、本机 socket、正式公开派单入口及合成 scheduler/worker，未调用真实模型。它们尚未执行；其中路由清单的拒绝/无数据路径覆盖不能代替全部成功交互证明。

## 恢复与登记

- 本轮 Linux 崩溃恢复修正：`core/ownerNodeLock.cjs` 同步 `exclusive(root)` 使用 `/usr/bin/flock -n -E 75 3`，父 FD 与子 FD3 共享 open file description；工具退出后父 FD 持锁，release 只关闭 FD，固定 `writer.flock` 不删除/替换。冲突明确 active，工具错误 fail closed。文件/目录保护与 inode 核验、旧代际 CAS 封口均在获取锁期间完成。Windows 方案与异步 drain 保留。
- 已删除宿主 `/proc` 挂载前提及可配置宿主进程扫描；本机 `/proc` 仅用于旧格式的保守迁移核验。部署前提为本地 ext4 与已存在的 util-linux flock，网络文件系统需另有语义支持。原理与实际操作说明见 [README 恢复章节](../packages/owner-node/README.md#服务写锁恢复) 及其官方手册链接。
- 新增 Linux 真子进程锁持续持有/冲突/异常退出/固定 inode 断言及旧格式和链接边界断言；已有跨平台恢复竞争测试证明目标是两竞争者只能一个成功，已有 Journal 崩溃测试继续断言未知意图不重派。这些是待执行断言，不是通过证据；本轮没有运行脚本、锁实验、验收或服务器命令，跨 namespace 实机验证留给主控。

- `protocol`、`brief` 已读；brief 已显示 r2 分支由派单器认领，任务施工中 0%。
- 本轮追加 claim 失败：`EPERM: operation not permitted, open 'F:\board-repo\.dashboard\board.json.lock'`。沙箱只允许本工位，不能绕过锁、直接写板或扩大权限。阻碍/待拍板记录需主控代登记。
- 按施工单“费用主控从独立 session token 记账”，本轮成本交原主控归因登记；施工方没有冒记共享账户差值，也没有声称已落账。
- 必需代码/测试文件均已落盘。三项指定验收 `ran=false`，新增网页检查也未执行，不声称通过。
- 曾通过正式调度申请单文件语法检查，票据 `tk-80909554a1a5f575c6a9` 未获执行；随后 cancel，回读状态为 cancelled，未裸跑。此票据不是语法通过证据。
- 主控已明确费用统一登记、锁权限失败由主控写回；施工方不重试 ACL/板锁，不冒记账户窗口差。未进行 git 写操作、真实配置改动、真实秘密读取或远端连接。
- 本轮第二次单文件语法检查票据 `tk-94c8331df79554edb7d6` 同样未获执行，正式 cancel 后回读 cancelled；没有语法通过证据。`git diff --check` 无输出，只证明已跟踪差异未报空白错误。
- 主控后续 collect/self-review/land，并统一执行三份指定验收及新增网页检查；容器、服务安装、SSH/ACL/known_hosts、真实数据迁移与最终验收仍由主控处理。
