# Windows 工作区节点与云端管理操作

云端看板通过 owner node 调用负责人电脑上的模型工具、会话资料、文档素材和成本采集。项目文件与模型凭据继续留在已配置的执行节点；看板成员不能使用这些管理操作。

部署入口和配置示例见 [节点说明](../packages/owner-node/README.md)，整体部署与备份见 [自部署文档](self-hosting.md)。示例必须替换为自己的项目、工具路径和受保护 SSH 配置。只配置已需要的功能，不把整台电脑的目录映射给服务器。
## Operation → 原输入字段 → 既有处理器

版本、方向、代际、序号、nonce、operationId、hash 已有严格运行时契约。
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

## 传输与权限

`owner-node.v1` 使用有长度上限的帧、连接代次、序号及固定 socket。SSH 连接对应的受保护配置确定节点身份，消息不能自行声明身份或项目路径。SSH 管理入口不对浏览器公开，不开放数据库或节点管理 TCP 端口。

每个节点的项目目录、会话目录、工具程序和调度入口来自部署配置。文件读取拒绝目录逃逸和符号链接；缓存有大小上限，不能把旧缓存当成新的运行状态。模型启动、续聊、验收继续使用正式派单与调度入口，后台工人不会外包在会清理子进程的外层 exec 中。

## 动作重试与恢复

网页对一次写操作保存请求摘要和操作 ID，只有完整收到业务成功结果才结束。网络断开或响应读取失败时保留原 ID，重试不会重复启动任务；成功后再次发送同样文字会产生新的操作 ID。浏览器 sessionStorage 只保存摘要和 ID，不保存请求正文或凭据。本机原有模式不使用这套远程操作协议。

服务器与节点各自持久保存操作日志。进程重启后，已知结果可以读取；无法确认是否执行的动作保持未知，先核对节点进程和操作记录，再由负责人决定是否发起新动作，不能自动重复启动。

服务写锁在 Windows 核验进程出生时间，在 Linux 使用固定 inode 的 flock。Linux 容器退出后由内核释放锁；不要删除锁文件或操作日志来强制启动。恢复方法及旧格式处理见 [写锁说明](../packages/owner-node/README.md#服务写锁恢复)。

## 验证范围

自动测试分别覆盖传输与派单、云端路由权限、数据来源和缓存。Linux 写锁另有真实子进程与崩溃恢复测试；Windows、Linux 和实际 SSH 连接需要在各自目标环境验证。合成工具只用于测试，不能将其结果当作真实模型调用或正式服务器切换成功。