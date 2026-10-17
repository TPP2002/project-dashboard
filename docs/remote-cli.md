# 远程唯一账本 CLI 原型

当前交付为工作区原型，正式集成验收由主控执行。主控已批准最小扩围 `cli/help.cjs`，remote-retry 已纳入正式帮助表和维护命令分组，原临时帮助分支已移除；没有隐藏注册命令或修改既有帮助测试。本文中的实现说明不代表测试通过或生产切换完成。

本实现保留本机正式 CLI 与 Git hooks，已绑定项目的业务读写经 `board-command.v1` 发往云端。首个生产传输为 SSH stdio，SSH / 操作系统认证的 owner 才能进入 gateway。它不是学校成员 HTTP 接口，不提供通用 shell、文件读取、整卡补丁或整板同步。没有连接实际服务器、迁移数据、切换发布副本或证明生产可用。

## 已实现与拒绝范围

| 类别 | 命令与行为 |
| --- | --- |
| 语义写 | add（单卡/批量）、claim、unclaim、progress、await-collect、collect-brief、pending、decide、undecide、park、unpark、block、done、cancel、reopen、note、request-info、edit、mark-landed、cost |
| 只读 | list、show、brief、inbox：每次读取云端当前状态，不缓存旧板结果 |
| Git 桥 | sync-from-git：本机采集不可变事实、云端按当前卡集合合并；claim-check：查询当前权威认领；sync-progress：本机分支与百分比、锁内重判状态及归属 |
| 本机工具 | help / --help、protocol、release、hooks-install、hooks-global、hooks-trunk-guard 保留原本机用途；release 仍须主控授权及正式排队，本单未执行 |
| 明确未适配 | set、backfill（包括 --patch）、import、archive-activity、cleanup、onboard、enroll 及 register 对已绑定远程项目不执行原本机函数 |
| 混合命令 | render-index：拒绝本机板派生；snapshot：拒绝本机旧板快照；precheck：拒绝混合板/仓检查；doctor（含 quick/fix）：拒绝旧板对账和修复；docs-audit：拒绝巡检建卡。各项均须后续分别适配，不能声称全量兼容 |

新生成的远程 post-commit hook 保留 Git 同步，省略未适配的 render-index。旧 hook 调 render-index 会得到明确拒绝。CC Stop 的 doctor 同样明确拒绝，尚未适配。没有静默回退。claim-check 连接/协议失败退出 1，不能落入旧 pre-commit 对 2/3 的兼容放行。

## 本机配置

默认读取 `DASHBOARD_HOME/remote.json`（未设数据根时为用户数据目录下的 remote.json），也可显式设置 `DASHBOARD_REMOTE_CONFIG`。独立测试必须显式使用临时 DASHBOARD_HOME；不能继承开发者配置。显式配置缺失或配置损坏均拒绝执行，不推定为 local 模式。未配置 remote.json 的项目继续使用原 local 模式。

配置示例均为占位机器、路径和标识；没有真实账户或凭据：

```json
{
  "version": 1,
  "projects": {
    "example-project": {
      "authorityId": "example-authority",
      "authorityEpoch": 1,
      "repoBindingId": "owner-device-repo",
      "transport": {
        "type": "ssh",
        "host": "owner@board.example.invalid",
        "entry": ["docker", "exec", "-i", "example-board", "node", "/app/cli/remoteGateway.cjs", "--authority", "/run/board/authority.json"]
      }
    }
  }
}
```

本机 registry 继续描述本机代码仓、worktree 归属和会话绑定文件位置；不把其 board 路径上传。云端 registry 是单独的受保护配置，指向云端账本，完全不需要本机 Git 仓。`resolveProject.remote` 区分远程权威绑定；store 对已绑定项目的本机 read/mutate 拒绝（含显式 registry 解析出的路径）。防线只覆盖新版程序，**不能阻止未升级的旧 CLI 直接写旧板**。

SSH 固定使用 `-T`、BatchMode=yes、StrictHostKeyChecking=yes、ForwardAgent=no，host 不接受 SSH 选项。entry 各 token 独立进行 POSIX 引用，再组成固定远端命令。用户文本、任务号、分支和请求内容只走 JSON stdin。不要把密钥、密码、令牌放在配置 entry、argv、环境或日志中；使用操作系统的 SSH 身份和预先验证的 known_hosts。首次主机信任由主控操作，工具不自动接受主机密钥。

## 云端 authority 初始化

先在云端创建私有数据目录与 registry，由主控在停写窗口校验导入账本。authority 配置须为私有普通文件（POSIX 权限 0600），并由部署层保护父目录、文件所有者、程序文件及 forced-command 入口。仅给受信 owner OS 账户调用权；不可给学生账户或学生 HTTP 服务访问这个入口。

```json
{
  "version": 1,
  "authorityId": "example-authority",
  "authorityEpoch": 1,
  "ownerId": "owner-device",
  "home": "/srv/example-board",
  "registryPath": "/srv/example-board/registry.json",
  "projects": {
    "example-project": {
      "repoBindings": {
        "owner-device-repo": {"ownerIds": ["owner-device"]}
      }
    }
  }
}
```

受信设备使用各自经 OS 认证保护的入口/authority 配置，其 ownerId 必须在项目 repoBindings 的 ownerIds 中。请求 body 不能声明 owner、主体或文件位置。单纯知道 repoBindingId 不授予访问权。

初始化入口：`node /app/cli/remoteGateway.cjs --init /run/board/authority.json < authority-input.json`。它使用独占创建，既有文件绝不覆盖；初始化后仍须主控审核配置并配置 OS 权限。`remoteConfig.initialize(file, value)` 同样用于本机配置的独占初始化；没有覆盖式初始化命令。正常固定入口为 `node /app/cli/remoteGateway.cjs --authority /run/board/authority.json`。Docker 可按上方 entry 数组执行，无需 Web 认证或 server 改动。

## 协议、回执与断网

请求字段仅有 version、authorityId、authorityEpoch、requestId、projectId、command、typed args。未知版本、权威、代际、命令及多余参数拒绝；参数按命令白名单检查，拒绝原型点路径及客户端提供的 registry/root/board/lock 等路径能力。请求不超过 512 KiB，单文本不超过 128 Ki 字符，数组不超过 2000 项，嵌套不超过 16 层。业务参数还保留原命令校验（包括建卡三件套、claim builder、待拍板三件套、成本与收官闸）。

本机先解析 --json-file（剥 UTF-8 BOM）、pending JSON、批量 add JSON、collect-brief --file，再发送结构化内容。远端不读取客户提供的文件。保留重复分支/范围等 flags；单卡 add --json 仍是结果格式，未给卡号的 add --json 才从 stdin 读取批量输入；pending --json 仍从 stdin 读输入。unclaim 缺省分支在本机 Git 解析，云端不猜。本机 claim/done 成功确认后继续记录原有会话绑定，云端不从其环境推断本机会话。

成员归属边界：正式 claim 在同一 board 锁内发现有效 assigneeUserId 时拒绝，不能自动夺取成员任务。正式 unclaim 在原有状态闸通过后，同锁清除 assigneeUserId/assigneeName、按原规则摘指定分支，并保留进度、builder 和其它 Git 元数据。同一条 unclaim activity 的 releasedAssignee 保存原成员 userId/name，releasedBy 保存操作方来源、author 标签及已认证传输 subjectId；本机 local-cli 没有远程认证主体，subjectId 明确为 null，不把 author 标签冒充认证身份。失败不写入，成功后同编号重放只返回回执，不重复释放审计。成员 HTTP progress 的状态约束由后端作者另行负责，本单未改该接口。

写请求发送前持久化到本机数据根 `remote-outbox/<requestId>.json`，包含不可变请求与 unconfirmed/confirmed 状态。传输超时、断网、响应截断或协议错误，退出 1 并打印“结果待确认”和 requestId。不能把断网解释为未认领或未写入。请使用显示的 `node <本机正式CLI> remote-retry <requestId>` 重试：原 ID、原内容、原权威代际不变；不自动换 ID，不无限后台重试。待送记录可能包含用户任务文本，数据目录应为 owner 私有且不要输入秘密。云端已执行但本机没收到回执时，重试只返回已存结果。

sync-progress 发送前同样持久化 requestId，但使用单独的 remote-progress 短期日志，正常返回或失败后立即清除，不落待送队列；进程崩溃可能留下 replayable=false 的取证记录，工具不会重放它。失败后只可重新采集当前分支/状态。它不允许通过 remote-retry 延迟重放。云端每次锁内重新查施工中且仍归属此分支的卡，写入 max(current, min(95, incoming))，不降进度，不写 done/unclaim 后的卡。未来如增加自动进度重放，必须先加明确 task 与 claim 代际。

业务变更、revision 和 `_commandReceipts` 在现有 board 锁中一次 atomicWriteJsonSync 持久化。回执键绑定传输主体、项目、requestId；相同 ID 不同内容拒绝。同一事务的嵌套 read/mutate 使用同一个对象，不接收 Promise，finally 清理上下文。只保存输入哈希、revision 和有界结果摘要，不保存完整输入、秘密或整本板。对外 CLI 读结果剔除内部回执。**HTTP 投影必须由后端集成方另行过滤此元数据，本单未修改 server。**

### 原型容量边界

回执暂不 GC，每块板最多 10000 个回执；到达上限后只准旧 ID 重放，新写请求拒绝，不能删回执后把旧请求当新请求执行。每条结果上限 128 KiB（批量卡结果也压成摘要），这是保守的原型硬上限，远非生产容量承诺；所有回执与账本都要随一次写重新序列化，达到数量上限之前也可能因体积而不适用。生产需容量评估及可验证的过老请求拒绝/保留期限协议，再设计归档或 GC；不能直接删除字段或清待送记录来绕过。

## Git 事实规则

本机按登记代码仓的 Git common-dir 校验当前 worktree，再采集 repoBindingId、exact/window、明确 commit/branch 与 commits 的 sha/subject。云端校验项目的受信设备绑定，仅以当前卡集合和既有 subjectRefs / unionShas / unionBy 合并 commitShas、prNumbers、gitBranch 与必要流水。status、decisions、deps 不改。

结构化卡号可补字段；正文提及仅对本次明确提交且该卡已认领本分支生效；window 只扫描结构化引用、不传播当前分支；post-merge 不发送当前分支。post-commit 断线仍允许已经发生的 Git 提交保留，并保存不可变事实、明显报“未确认”及幂等重试命令。pre-commit 连接失败则拦截提交。共仓多项目 claim-check 保留“施工中/待收单”口径，任一所需远程权威不可达时拒绝放行。

## 验证与生产切换前置项

本轮源码自审修正：无效或空项目绑定必须拒绝，缺少文件路径和超限输入在本机拒绝；list 字段选择也禁止原型点路径；待送文件编号必须等于请求编号，不能篡改编号后重送。待送目录/文件在 POSIX 上收紧为私有权限，自动进度日志清理失败不会覆盖原来的请求结果。共享建卡闸保留原模型提示表与检查顺序；传输主体必须匹配受保护 owner 配置。Git 引用只按锁内当前任务集合解析，并复用每个提交的解析结果。事务与重放代码已逐段检查，但这些源码观察仍需以下测试和真实集成验收证明。

已编写以下真实子进程/临时目录测试，**施工方依工单要求未执行验收文件**，通过与否待派单器重跑：

静态自查记录：`git diff --check` 已执行且无差异错误（存在工作区换行提示）。此前统一调度静态语法申请 `tk-79831f0925780e76ce35` 返回“等待超时 / 命令没开跑，没有日志 / 票据不存在”，没有语法检查通过证据。扩围后单独申请既有帮助兼容检查，单号 `tk-4a44b912c80c2627b363`，同样返回“等待超时 / 命令没开跑，没有日志 / 票据不存在”；未重复提交、未裸跑或越权恢复调度台。两次调度单号均保留供主控核对。

既有 `test/cliHelp.test.cjs` 必须在主控正式验收中原样运行：COMMANDS 与 REGISTRY 双向一致，remote-retry 在全局帮助中出现，每条帮助保持一句话、用法、参数、示例、退出码和最多40行；`help remote-retry`、`remote-retry --help`、`remote-retry -h` 走同一帮助生成器，已有命令帮助继续兼容。该文件未修改，本施工方没有该检查通过的执行证据。

此前真实看板 progress、unknown 成本登记及调度故障留言因沙箱外 board lock 的 EPERM 失败；当前成本按主控指示，由主控使用本施工会话独立 token 证据登记，不读取共享账户窗口，不宣称已落账。

- remoteBoardCommand：typed 参数、语义/机器闸、同锁事务、截断响应后重启重放 note/cost/pending、同 ID 异内容拒绝、Promise 拒绝与上下文清理、本机入口机器闸、并发追加及本机普通写保留回执。
- remoteBoardTransport：固定 SSH argv、真实 stdio gateway、中文/BOM/引号/换行、批量输入、断网/错协议不碰旧板、未适配命令拒绝、独占初始化、无效项目绑定、缺路径/超限输入、篡改待送编号拒绝、本机会话绑定与云端环境隔离。
- remoteBoardGit：真实 Git 与生成 hooks、云端无仓库、两个 worktree、共仓多项目、正文/历史/window/postmerge、断网 precommit 拦截与 postcommit 待送、并发自动进度不倒退。
- remoteBoardAssignment：仅构造临时含成员归属的账本，验证本机与真实 stdio gateway 的 AI 冲突、原子释放、释放审计身份、重复回执不清除后来成员的归属、校验失败/终态拒绝时数据完整，以及既有 builder/Git 元数据保留；不引入多人后端模块依赖。

后续正式收单基线（修复前，主控提供，单号 `tk-358496695d8f76fc9c34`）：COMMAND 5/5、GIT 3/3，TRANSPORT 6/7。原 `acceptance/TRANSPORT.log` 保留；失败的首项实际重复传入了 --title（辅助函数已有一次，测试又追加一次），按既有重复 flags 规则得到数组，故在发送前被严格字符串校验拒绝。本次只替换辅助参数中已有标题的值，完整保留中文、引号、换行和特殊字符字面量及所有原断言，没有修改生产解析器或放宽协议类型校验；修复后的首项尚待主控用原验收重跑。既有帮助检查由主控续跑原单后 10/10 通过，本轮未改帮助且未重复运行；这些修复前证据不代替当前工作区正式验收。

本轮成员定向检查单 `tk-e7335960ab21c5bccd0b` 获准后在启动阶段因写入本机调度状态目录失败（EPERM）退出，命令没有启动，无测试通过证据；没有重挂或裸跑。主控须正式执行新增成员隔离检查，并重跑原收单验收。真实成员 HTTP 联动、实际 SSH 服务器、发布 hooks 和生产唯一权威切换仍未验收，临时 fixture 不替代这些集成证据。

正式执行使用统一调度与 `node --test --test-concurrency=1 <单个文件>`，三条验收由派单器统一跑。测试只使用临时 authority/registry/home 和显式 stdio 测试运输（`DASHBOARD_REMOTE_TEST_TRANSPORT=1`），不接实际服务器或生产账本。

生产切换必须由同一主控集成验收：

1. 先升级发布 CLI 与全部本机 hooks，识别所有旧写者和混合命令消费者；分别适配必需的 doctor/precheck/render-index 等或明确停用其业务用途。
2. 停写，核对项目绑定和账本数据完整性，在云端导入并验证；学校 HTTP 接口保持独立权限边界，过滤内部回执。
3. 配置受保护 owner 入口、可信主机和 repo/device 绑定，启用云端 authority，验证权威代际、断网、丢回执和真实提交链。
4. 冻结旧写者：撤销旧板写权限/旧写服务、停旧进程与自动任务并核验不能再写，再放开云端写入。只设环境变量或 schemaVersion 不会阻止旧 CLI。
5. 证明发布副本、进程、实际页面/接口、各机器 hooks 与云端账本一致，并评估回执容量。上述生产动作、账户配置、release/commit/push 均不在本工单施工中执行。
