# 多人协作与自部署契约

状态：已确认产品目标；实现与部署验证进行中。日期：2026-10-18。

## 目标与授权

- 保留现有本机模式，新增显式启用的协作模式。
- 一个部署实例有负责人（owner）、成员（member）和只读访客（viewer）。负责人管理用户、邀请和项目授权；成员在授权项目建卡、留言并操作本人卡片；访客只读。没有项目管理员、删卡或回收站。
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
| GET `/api/auth/session` | `{ok:true,mode:'local'|'collaboration',user:null或User,csrfToken?:string}`；User 为 `{id,username,displayName,role:'owner'|'member'|'viewer',projectIds:string[],disabled:boolean}` |
| POST `/api/auth/login` | `{username,password}` → 同 session 响应并设置 Cookie |
| POST `/api/auth/register` | `{inviteToken,username,password,displayName?}` → 同 session 响应并设置 Cookie |
| POST `/api/auth/logout` | 撤销当前会话及本浏览器的受信任设备凭据，清除 Cookie，不能退出后自动重新登录 |
| POST `/api/auth/password` | 所有已登录角色，`{currentPassword,newPassword}`；当前密码错返回 400，按用户限流；成功保留当前会话，删除其他会话并撤销非当前绑定设备 |
| POST `/api/auth/users/:id/reset` | 仅负责人，`{}`；目标仅 member/viewer，返回 `{ok:true,reset:Reset,resetToken:string}`；明码仅本次出现，24 小时有效，新码作废同用户旧码 |
| POST `/api/auth/reset-password` | 公开写，`{resetToken,newPassword}`；码仅从请求体读取，成功单次消费，撤销该用户全部旧会话与设备，设置新会话 Cookie；禁用用户拒绝 |
| GET `/api/auth/admin` | 仅负责人，返回 `{ok:true,users:User[],invites:Invite[],devices:Device[],resets:Reset[]}`；列表不含明文令牌和重置码 |
| POST `/api/auth/invites` | 仅负责人，`{projectIds,expiresInHours,maxUses,role?:'member'|'viewer'}` → `{ok:true,invite:Invite,token:string}`，只在创建时返回令牌，缺省 member |
| POST `/api/auth/invites/:id/revoke` | 仅负责人，撤销邀请 |
| POST `/api/auth/users/:id/access` | 仅负责人，`{projectIds,disabled:boolean,role?:'member'|'viewer'}`；角色立即生效，不能设为 owner、不能改 owner 角色、不能取消最后负责人的权限 |
| POST `/api/auth/devices` | 仅负责人，`{label}` → `{ok:true,device:Device,token:string}` |
| POST `/api/auth/devices/:id/revoke` | 仅负责人，撤销设备及其衍生会话 |
| POST `/api/auth/device-login` | `{token}` → 同 session 响应并设置 Cookie；不得将令牌放 URL 或日志 |
| POST `/api/auth/remember-device` | 负责人已登录并通过 CSRF 后，`{label}` → `{ok:true,device:Device}`；用 HttpOnly Cookie 保存本浏览器的设备凭据，不向脚本返回令牌 |
| POST `/api/collaboration/projects/:projectId/tasks/:taskId/claim` | 登录且项目授权，原子领取空闲任务；已经被其他用户或 AI 认领时拒绝 |
| POST `/api/collaboration/projects/:projectId/tasks/:taskId/progress` | `{percent,note?}`，仅更新本人任务；到 100% 不会自动完工，完工须显式调用 done |
| POST `/api/collaboration/projects/:projectId/tasks` | 成员或负责人，`{title,plainTitle?,description?}`；标题必填且至多 200 字，可选人话标题至多 200 字、描述至多 4000 字；拒收其他字段。服务端锁内生成不重复的 `Myyyymmdd-XXXXXX`（六位大写字母数字），状态固定未开工，记 createdByUserId |
| POST `/api/collaboration/projects/:projectId/tasks/:taskId/note` | `{text}`，1–2000 字；授权项目任何卡均可留言，记录 type:note、kind:message、userId 和显示名 |
| POST `/api/collaboration/projects/:projectId/tasks/:taskId/unclaim` | `{reason}`，本人施工中卡退回待开工或可复工，释放成员归属 |
| POST `/api/collaboration/projects/:projectId/tasks/:taskId/park` | `{reason}`，本人非终态且非暂缓卡转暂缓 |
| POST `/api/collaboration/projects/:projectId/tasks/:taskId/unpark` | `{reason}`，本人暂缓卡转可复工 |
| POST `/api/collaboration/projects/:projectId/tasks/:taskId/done` | `{}`，本人非终态卡转已完工，100%，写完工日期；不需审批，存在未拍板决策返回 409 |
| POST `/api/collaboration/projects/:projectId/tasks/:taskId/cancel` | `{reason}`，自己建的或领的卡转已作废；已作废或存在未拍板决策返回 409；负责人可作废他人卡 |
| POST `/api/collaboration/projects/:projectId/tasks/:taskId/reopen` | `{reason}`，自己建的或领的已完工/已作废卡转待开工，清除完工日期并归零进度 |

Invite 公共字段为 `{id,role,projectIds,expiresAt,maxUses,uses,revoked}`；Device 为 `{id,label,createdAt,expiresAt,revoked}`；Reset 为 `{id,userId,expiresAt,used}`。前端所有认证写请求带正确 Origin、`Content-Type: application/json` 和 `X-Dashboard-Request: 1`；登录、注册、设备登录、重置密码以外的协作写请求还带 `/api/auth/session` 返回的 `X-Dashboard-CSRF`。访客已登录时仅可写改自己密码和退出；要使用公开重置入口须先退出。

认证账本新增 resets（id、userId、tokenHash、expiresAt、used）；令牌仍只保存哈希。旧账本无 resets、旧邀请无 role 时正常读取，读时不改写，首次写入才补齐，损坏仍拒绝服务。无效重置码使用独立有界限流桶，有效码按重置记录限流。恢复认证备份或撤销全部凭据时也作废重置码。

User 增加明确的 `disabled:boolean`，供负责人管理列表显示真实状态。负责人可主动信任本浏览器 90 天；设备凭据只放 HttpOnly、SameSite=Strict Cookie，HTTPS 时必须 Secure。普通会话过期时，session 接口可凭有效设备 Cookie 恢复负责人会话，但不得延长设备原到期日。撤销设备、重置负责人密码及主动退出都阻止该凭据再次恢复。默认不自动信任设备，不以 IP 或本机地址识别负责人。恢复历史备份后提供显式 CLI 撤销全部会话、设备和邀请的能力，保留用户与账本。

成员与访客只可读授权 `/api/projects`、`/api/board/:id` 和 `/api/stream`，以及公开健康/会话查询。其余既有 API 默认拒绝，包括文件读取、审批、派单、设置、成本、审阅、试听。任务视图增加 actions（同一 memberActions 规则计算）、messages（kind:message 的最近 50 条，ts/author/text/userId）、blockReason、cancelReason、createdByUserId 和 aiWork。所有文本照旧脱敏，不暴露 builder 原值、分支、PR、提交号、路径、成本。事件订阅在每次推送时复核会话、角色和项目授权。

本单只提供服务端能力；改密码、重置入口、访客界面和成员操作按钮由后续界面单实现。本机模式不改变现有操作。

## 任务写入

成员操作通过 CLI 所属的协作命令模块，复用 `cli/store.cjs` 的锁、schema 校验、原子写入和活动流水；服务端不得另写 `board.json`。使用独立 `assigneeUserId` 与 `assigneeName` 标识成员，不能伪造 AI 施工方式。抢单、更新和归属检查必须在同一锁内完成。

认证锁先于看板锁；CLI 子进程在锁内重验会话与角色，mutate 内使用共享 memberActions 判权后调用 cli/commands.cjs 导出的纯状态迁移函数。旧命令保持输出和活动记录，成员操作的同类活动额外带 userId 和显示名。reason 必须为 1–500 字。自动施工卡（builder 有值或 gitBranch/prNumbers/commitShas 非空）对成员仅允许留言，负责人可操作；访客在 HTTP 和 CLI 均拒绝卡片写入。成员不写任何 AI 元数据，不开放拍板、撤销拍板、挂待拍板、edit/set、mark-landed、request-info、block、await-collect 或派单。全部后台子进程显式 windowsHide:true。

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
