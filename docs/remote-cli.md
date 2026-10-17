# 远程唯一账本 CLI：生产容量与本机维护

本轮交付为工作区源码、临时目录测试及本说明；**真实切换尚未完成**。原型基点 `29a87dfa7c644f62450c82acbfa64570af02b336` 已由主控收单（COMMAND 5/5、TRANSPORT 7/7、GIT 3/3、ASSIGNMENT 2/2），不代表本轮通过。本施工方没有执行四份验收文件，没有连接真实服务器、迁移实际账本、权限或配置，也没有 release、commit、push。正式收单、SSH、PR、迁移、部署、切换、费用登记均归原主控。

## 运输与权威

业务协议升级为 `board-command.v2`。SSH stdio 是固定 owner OS 认证入口，不是学生 HTTP 接口，不接受通用 shell 或远端用户路径。仍固定使用 `-T`、BatchMode=yes、StrictHostKeyChecking=yes、ForwardAgent=no；host 不接受选项，entry 每个 token 独立 POSIX 引用，用户文字只走 JSON stdin。首次可信主机确认由主控执行，不自动接受密钥。

请求仍最多 **512 KiB**，单文本最多 128 Ki 字符、数组最多 2000 项、嵌套最多 16 层。未知字段、原型链及文件能力继续拒绝。响应 stdout 与 stderr 合计最多 **64 MiB**，子进程 maxBuffer 有界，客户端 **180 秒硬超时**。网关先序列化检查成功响应再发送。非法 JSON、截断、超限、超时、版本/权威/代际/编号错误均失败，不能回退本机旧板。

配置取 `DASHBOARD_REMOTE_CONFIG` 或 `DASHBOARD_HOME/remote.json`。显式配置丢失、损坏或绑定无效时拒绝；无远程配置的项目保留原 local 模式。配置例子仅含占位值：

```json
{
  "version": 1,
  "projects": {
    "example": {
      "authorityId": "example-authority",
      "authorityEpoch": 1,
      "repoBindingId": "owner-repo",
      "transport": {
        "type": "ssh",
        "host": "owner@board.example.invalid",
        "entry": ["docker", "exec", "-i", "example-board", "node", "/app/cli/remoteGateway.cjs", "--authority", "/run/board/authority.json"]
      }
    }
  }
}
```

本机 registry 只管本机代码仓、共仓/worktree、冻结旧板路径、会话绑定。云端 registry 独立定位云端账本，不需要本机仓库或 Git。`store.guardLocal` 仍阻止已绑定项目读取或修改本机旧板，没有猴补或临时缓存权威。

数据根、待送文件应为 owner 私有。POSIX 新建配置 0600、待送目录 0700。禁止把密码、密钥、令牌写入 entry、参数、日志或任务文字。

## 回执、水位和原型升级

requestId 为 `创建毫秒戳-32位随机十六进制数`；创建时间直接从不可变编号解析。写请求首次发送前持久化到 `remote-outbox`，重试只读原编号、原内容、原权威代际。确认只改确认状态；过期或失联不能自动换号。

默认保留 7 天，每板最多 10000 条，回执对象序列化总量最多 8 MiB；单条结果仍最多 128 KiB。受保护 authority 可设 `receiptPolicy: {retainMs,maxCount,maxBytes}` 缩小这些边界，不能超过默认硬上限。回执只存输入哈希、创建时间、revision 和结果摘要，不存整板、完整请求或秘密。键绑定已认证主体、项目、编号；同键异内容拒绝。

业务变更、revision、回执及 `_commandRetention` 在同一 board 锁、同一次原子写中提交。`rejectBefore` 单调递增，时钟高水位持久化，服务器时钟后退不会重新接纳旧请求。新 ID 不得早于水位，也不得超过当前服务器时间 5 分钟。GC 先推进拒绝水位，再删除所有已不可能接受的回执。容量提前驱逐时，把水位提升到最早逐出毫秒之后，同毫秒全部逐出；不能只删 LRU。当前请求的回执也保不住时，整个业务事务拒绝。

过老丢 ACK 请求永久返回 `expired` 和结果待核对，即使收据已 GC 也不会再次执行。应读当前权威和审计人工核对；`remote-retry <requestId>` 不自动重新编号。自动进度继续使用禁止重放的短期日志，云端锁内重判当前状态和分支，只增不减、封顶 95。

**明确升级规则：** v1 请求拒绝。板内含没有可信创建时间的原型收据时，完整保留并拒绝新 v2 写入；不猜旧 UUID 日期、不删除后重执行。只读仍可用。原型回执、旧待送、旧写者及新代际须由主控在专门停写迁移中核对，本工单不迁移真实数据。正常 v2 重启从板内水位和收据恢复。

CLI owner 投影剔除 `_commandReceipts`、`_commandRetention`；**成员 HTTP 过滤由后端集成方另行落实**，本单未改 server 或认证权限。

## 维护命令

`readProjectBoard` 显式取得每次的当前 owner 投影，随后才扫描本机或写派生文件。默认输出为 `DASHBOARD_HOME/remote-artifacts/<projectId>/`；显式输出仍禁止冻结旧板目录及其实际路径别名。派生文件永不回写权威。

| 命令 | 远程模式行为 |
| --- | --- |
| snapshot | 当前云端投影导出到本机 snapshots；`--out` 指定本机目录 |
| render-index | 默认生成独立 INDEX；`--index` 指定已有文件时保留人工段及原锚校验；dry-run 不写 |
| precheck | 云端占用、决策和留言；本机 Git/hook/正本检查。本机 docs 扫描地图写入 artifacts；明确不执行输出位置未声明的仓库 docs:index 脚本。local 仍保留原脚本刷新 |
| doctor --quick | 当前云端决策质量及本机 hook；quick 与 fix/branches 同传仍不扫描提交图、不修复 |
| doctor --fix | 本机采集不可变提交事实，云锁内复用现有 Git 合并。确认后修复前投影备份落在本机 artifacts/doctor |
| doctor --branches [--fix --tier …] | 本机提交图，当前及归档 claim 从各项目权威读取；仅上传受约束清理条目、档位和 expected hash。云锁内重判当前板、依赖、分支持有人及显式 claim；并发变化拒绝 |
| docs-audit | 本机文档与当前云端卡比较；报告、monthly 成功戳只写本机 artifacts 或显式报告路径 |
| cleanup | 原本机 Git 检查、默认干跑、显式 --yes 执行、主干保护；不写 board、不接受云端 shell |

docs-audit 月度卡具备原建卡三件套，云端按月度卡号锁内幂等。丢 ACK 保留不可变待送请求，两次同号重试只有一次建卡审计。需要的云端操作确认后才写远程模式报告及 monthly 成功戳。doctor 不上传整板或任意 JSON 补丁；Git 事实仍核验受信 repoBindingId。

新远程 post-commit 恢复 render-index；旧 doctor/precheck/render-index hooks 同样适配。共仓认领检查逐个确认权威，远程失联不能当作无认领。claim/done 确认后仍只在本机记录真实会话绑定，云端不猜本机会话。

本机 `syncFromGit` 保留原兼容入口：显式传入 branch 时，即便没有 commit，也给窗口内结构化引用的卡记录该分支；不传 branch 仍不猜分支，正文引用仍要求明确提交与已有认领。远程 `git-facts` 是不同入口，window 仍禁止传播分支，只有 exact 模式允许指定分支。主控提供的 PR118 首次 CI `39066019795`（HEAD `f56cabc`）为 1276 通过、2 失败、1 跳过；其中 `gitE2e.test.cjs:75` 暴露了本机错误增加 commit 条件的兼容回归。本轮移除该额外条件，原测试只读，尚待主控整文件重验；不把这次修复记为已通过。

## Owner 管理命令

- set、backfill --patch 限现有 task 业务域，禁止 id、project/registry、revision、内部回执、水位、原型链和文件能力。补丁在本机有界解析，云锁内复用 schema；非法批次不写。backfill 只读直接查云端。
- import 在本机最多读取 32 MiB Markdown，复用原解析器；每语义批次最多 50 张、请求仍最多 512 KiB。只新增，相同已有卡幂等跳过，冲突拒绝覆盖；不清空旧任务或历史。artifacts/imports 保存不可变请求计划和逐批确认数。失败明确报告部分完成；相同输入续接原 ID/原内容，或使用显示的 remote-retry。已确认批次不重发，未确认过期批次不能换号重执行。
- archive-activity --before YYYY-MM 仍先持久归档再删板内记录；目录只从受保护云端 registry 派生，不接受客户路径。保持原去重规则。回复只有月份对象身份、摘要和条数；同号重试返回原回执。

onboard 仍明确拒绝远程调用，不拿本机整板重建充当迁移。其余未适配命令同样明确失败，不静默跳过或读旧板。现有数据迁移由主控专门脚本执行。

## 初始化和本机绑定

`remoteGateway --init <authority-file>` 仍独占创建私有 authority。普通业务入口 `--authority <authority-file>` 不能初始化项目。固定管理员入口为 `--init-project <authority-file>`，受保护配置还需 `admin: true`，只给 owner OS 使用。authority 的其他字段保持 version、authorityId、authorityEpoch、ownerId、home、registryPath、projects/repoBindings，部署层保护父目录、所有者和 forced-command。

1. 准备单个绑定对象的本机管理员 JSON，transport.entry 固定指向 `--init-project`。
2. `remote-project-init --id example --name 示例 --binding-file ./admin-binding.json`。请求只提供 ID/name，目录由管理员 home 派生为 projects/ID。独占创建 board、锁内追加云端 registry；初始化清单支持创建 board 后中断的恢复。既有板绝不清空或覆盖，名字/目录冲突拒绝。丢 ACK 用原编号 `--request-id` 重送。
3. 独立认证流程授予所需 owner/repoBindings；初始化不增加设备或成员权限。
4. 准备指向普通 `--authority` 的绑定 JSON，运行 `remote-bind --id example --root ./repo --binding-file ./binding.json`。先确认云端投影，才登记本机代码仓、旧板路径和 remote 配置；不创建本机 board。已有项目/绑定必须显式 `--update`。
5. register/enroll 显式 `--remote-binding <文件>` 可调用上述绑定流程；enroll 保留装 hooks 和远程语义导入，不把已有账本改成空板。已存在远程配置时，其他新本机项目必须显式 `--local`，防止误建本机权威；没有远程配置的原 local 流程不变。

远程配置与本机 registry 为两个独立文件，双锁防并发更新。两文件写入之间断电时，原绑定加显式 --update 完成本机登记；恢复不创建或覆盖旧板。绑定不是数据迁移。

## 验证与历史证据

新增文件已编写，**施工方未执行验收，结果待派单器重跑**：

- remoteBoardRetention：GC 丢 ACK 与重启、永久拒旧、同毫秒容量、字节边界、时钟后退、未来 ID、多主体/项目、异内容及原型安全拒写。
- remoteBoardMaintenance：临时真实 Git/hook，云端无仓库，旧板不可读写，断线无派生文件，并发认领保护，巡检重试单次审计，语义管理、归档、部分导入恢复、管理员初始化和显式绑定。
- remoteBoardLargeRead：至少 20 MiB 合成板，真实客户端→stdio→网关，逐卡/逐活动完整性；真实超限、解析失败和 180 秒硬超时。超时用例约三分钟，主控排队执行。
- remoteBoardTransport：正式授权的旧维护拒绝断言改为合法成功、权威读写、旧板不变；非法 patch、缺少月份仍按真实原因拒绝。原 SSH argv/字面文本/断网/同 ID/身份/512 KiB 边界保留。新版编号仅最小适配夹具。cliHelp 原测试不改。

正式执行均须统一调度、逐文件重跑；静态自审和原型绿色不代替本轮验收。实际 SSH、Ubuntu 权限、发布 hooks、成员 HTTP 元数据过滤、旧写者冻结及唯一权威切换仍未证明。

历史失败保留：原型语法单 `tk-79831f0925780e76ce35`、帮助单 `tk-4a44b912c80c2627b363` 曾等待超时、未开跑、票据不存在，不是通过证据。原收单 `tk-358496695d8f76fc9c34` 初次 TRANSPORT 6/7，原 `acceptance/TRANSPORT.log` 不可覆盖；重复 title 辅助参数修复后主控正式收为 7/7。原成员单 `tk-e7335960ab21c5bccd0b` 曾调度状态目录 EPERM 未启动；早期实际 progress/成本板锁亦曾 EPERM。以上不是本轮新执行结果。

本轮静态语法申请 `tk-ed84d5b91fe59ce451df` 获准后，在命令启动前因写入本机 `sched-suspend` 状态文件 EPERM 失败，未运行语法检查、没有通过证据。未裸跑或重复 submit。工作区 `git diff --check` 已执行无差异格式错误；此结果不代替语法或验收。

费用按主控指示用本施工会话独立 token 取数，不用共享账户窗口差，施工方不声称已落账。
