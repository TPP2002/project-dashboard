# 多人协作与自部署契约

状态：已确认产品目标；实现与部署验证进行中。日期：2026-10-18。

## 目标与授权

- 保留现有本机模式，新增显式启用的协作模式。
- 一个部署实例有负责人账号。负责人管理用户、邀请和项目授权；成员只能访问获授权的项目，领取空闲任务并更新本人任务。
- 邀请链接或邀请码注册，不开放任意注册。邀请可限定项目、到期时间和使用次数，并可撤销。撤销成员权限立即影响已有会话与事件订阅。
- 负责人设备可持有可撤销的凭据，减少重复登录；不得按来源 IP、伪造请求头或访问本机地址直接授予云端管理员身份。
- MIT 开源，使用者自行准备服务器。仓库只存通用配置，不存用户服务器信息、项目账本、密码、私钥或运行时令牌。
- 部署优先考虑 Docker Engine + Compose，适配四核、四 GB 内存的小型服务器；不新增收费依赖。

## 模式与持久化

默认模式仍只监听回环地址，保留原有 CLI 与本机使用方式。协作模式要求显式配置 `DASHBOARD_MODE=collaboration`、`DASHBOARD_PUBLIC_ORIGIN`，部署数据置于 `DASHBOARD_HOME`，与代码和静态文件分离。

第一版沿用单进程服务及文件账本模型，认证状态使用独立文件和跨进程锁，写入前在锁内重读。文件损坏必须拒绝请求，不得当作空库创建新负责人。不得把可写文件双向同步当作多主数据库。

凭据采用随机令牌、持久化仅保存令牌哈希；密码用 Node 内置异步 scrypt（N=131072、r=8、p=1），限制并发及等待数量。HTTPS 会话使用 HttpOnly、Secure、SameSite Cookie，写操作验证来源和 CSRF。回环 HTTP 仅供明确的本机验证场景。

## HTTP 契约

所有响应不得包含密码哈希、令牌哈希、认证数据库路径。普通失败使用 `{ok:false,error:string}`。

| 方法与路径 | 请求与响应摘要 |
| --- | --- |
| GET `/api/auth/session` | `{ok:true,mode:'local'|'collaboration',user:null或User,csrfToken?:string}`；User 为 `{id,username,displayName,role:'owner'|'member',projectIds:string[]}` |
| POST `/api/auth/login` | `{username,password}` → 同 session 响应并设置 Cookie |
| POST `/api/auth/register` | `{inviteToken,username,password,displayName?}` → 同 session 响应并设置 Cookie |
| POST `/api/auth/logout` | 撤销当前会话，清除 Cookie |
| GET `/api/auth/admin` | 仅负责人，返回 `{ok:true,users:User[],invites:Invite[],devices:Device[]}`；邀请和设备列表不含明文令牌 |
| POST `/api/auth/invites` | 仅负责人，`{projectIds,expiresInHours,maxUses}` → `{ok:true,invite:Invite,token:string}`，只在创建时返回令牌 |
| POST `/api/auth/invites/:id/revoke` | 仅负责人，撤销邀请 |
| POST `/api/auth/users/:id/access` | 仅负责人，`{projectIds,disabled:boolean}`；不能取消最后负责人的权限 |
| POST `/api/auth/devices` | 仅负责人，`{label}` → `{ok:true,device:Device,token:string}` |
| POST `/api/auth/devices/:id/revoke` | 仅负责人，撤销设备及其衍生会话 |
| POST `/api/auth/device-login` | `{token}` → 同 session 响应并设置 Cookie；不得将令牌放 URL 或日志 |
| POST `/api/collaboration/projects/:projectId/tasks/:taskId/claim` | 登录且项目授权，原子领取空闲任务；已经被其他用户或 AI 认领时拒绝 |
| POST `/api/collaboration/projects/:projectId/tasks/:taskId/progress` | `{percent,note?}`，仅更新本人任务；到 100% 也不能代负责人验收销卡 |

Invite 公共字段为 `{id,projectIds,expiresAt,maxUses,uses,revoked}`；Device 为 `{id,label,createdAt,revoked}`。前端所有认证写请求带 `Content-Type: application/json` 和 `X-Dashboard-Request: 1`；登录、注册、设备登录以外的协作写请求还带 `/api/auth/session` 返回的 `X-Dashboard-CSRF`。

普通成员只可读 `/api/projects`、`/api/board/:id` 和按授权过滤的 `/api/stream`。其余既有 API 默认拒绝，包括文件读取、审批、派单、设置、成本、审阅、试听。成员项目和任务响应使用字段白名单，去掉本机绝对路径、收单指令、成本明细及负责人留言。事件订阅在每次推送时复核会话和项目授权。

成员视图独立于现有负责人界面，只显示项目切换、任务列表、领取及本人进度输入。负责人沿用原界面并增加“成员与邀请”入口。本机模式不改变现有操作。

## 任务写入

成员操作通过 CLI 所属的协作命令模块，复用 `cli/store.cjs` 的锁、schema 校验、原子写入和活动流水；服务端不得另写 `board.json`。使用独立 `assigneeUserId` 与 `assigneeName` 标识成员，不能伪造 AI 施工方式。抢单、更新和归属检查必须在同一锁内完成。

## 调度迁移判别点

现有调度依赖共享文件协议、同卷原子写、单写者租约和 Windows 身份／进程控制。云端展示调度页面不能算派单器已迁移。必须验证真实提交、许可、执行、回执、死亡回收、断网恢复和旧写者隔离后才切换；迁移期间现有调度保持权威。

候选迁移方案与最小测试另记，不因 Ubuntu 可以启动 Node 就宣布跨平台兼容。

## 验收与发布

1. 未登录、跨项目、篡改任务 ID、过期／撤销邀请码、重复使用邀请、并发抢卡、越权改卡都必须真实拒绝。
2. 撤销权限后已建立的 SSE、设备及会话不得继续访问。
3. 服务重启后用户、授权、任务认领和进度保留；损坏状态拒绝服务并有可恢复备份。
4. 负责人、受邀成员与未授权账号的实际浏览器流程验证；原本机模式回归。
5. 精确提交 CI、自审、GitHub PR、部署运行与实际访问分别留证。
6. 对外开放端口前说明防火墙和 TLS 改动并获得确认；先私有验证，再按已批准范围开放。

## 参考依据与当前边界

- [OWASP 密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)：scrypt 参数及限制计算资源。
- [OWASP 授权](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)：默认拒绝、每次请求检查资源权限。
- [腾讯云是否需要备案](https://cloud.tencent.com/document/product/243/19630/) 允许纯 IP 直接测试暂不备案，并有不使用域名解析的说明；[备案场景](https://cloud.tencent.com/document/product/243/18910) 对中国内地的 IP 网站提供信息服务有更严格说明。当前按封闭成员测试推进，不将邀请制视作长期服务必然豁免。

尚未完成：协作功能实现、迁移判别测试、容器部署、浏览器验收和生产切换。文档本身不代表这些步骤已完成。
