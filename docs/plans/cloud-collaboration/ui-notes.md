# CLOUD-COLLAB-UI-1018 前端交活说明

工位：`collab-ui-v2-1019`。本次仅留下工作区改动，没有提交、推送、写看板或登记成本。

## 范围与效果图

按派单方第 1 次答复，直接读取 v1 的 01–06 节与 v2 的 07–09 节 HTML/CSS；浅深主题使用现有 base.css 变量。截图要求已由派单方取消，未创建 screens 目录，真实页面截图由派单方云端隔离验收负责。

成员和访客共用固定一屏的泳道看板，各泳道独立滚动。卡片仅显示 actions 中的领取或更新进度；其余操作在抽屉。抽屉展示协作人员、说明和留言。访客 actions 为空时无卡片操作及留言输入。新建卡片仅由脚本中的 canCreate 控制。

新建、理由、进度、收官、退出协作、移出协作人均有独立输入或确认弹窗；加入协作直接请求并显示轻提示。弹窗用原生 dialog 实现焦点进入、焦点约束及 Esc 关闭，提交时禁用防连点。每次卡片写请求后重读授权和看板，拒绝时保留服务端错误，不修改本地任务模拟成功。

三种身份均有账号菜单和改密码入口。登录页可用重置码直接设新密码并登录。管理页支持邀请角色、保存用户角色、生成并关闭一次性重置码，以及有效未用重置码的到期提示。凭据仅在内存和请求体中使用。

## 改动文件及原因

| 文件 | 原因 |
| --- | --- |
| web/src/collaboration/board.ts | 集中泳道、按钮、路由、头像、关系文案、名额及输入校验纯逻辑。 |
| web/src/collaboration/types.ts | 增加访客身份、任务动作与公开协作字段、角色与重置记录类型。 |
| web/src/collaboration/member.ts | 扩充显式字段白名单并逐层挑选消息、日期、协作人字段；新增建卡及通用操作请求，保留旧领取和进度接口。 |
| web/src/collaboration/MemberBoard.vue | 替换网格为泳道，管理项目切换、抽屉、弹窗和写后刷新；项目授权切换时清除旧卡及旧弹窗。 |
| web/src/collaboration/MemberTaskCard.vue | 显示原始状态、进度流光、主负责人及协作人关系、单个主按钮和本人竖条。 |
| web/src/collaboration/MemberDrawer.vue | 展示卡片标题、创建人、可用日期、协作人、说明、留言及只读提示。 |
| web/src/collaboration/AvatarStack.vue | 两侧看板复用头像叠放、主位流光边、悬停展开及名字身份提示。 |
| web/src/collaboration/TeamSlots.vue | 复用 5 格协作名额显示，主负责人不占名额。 |
| web/src/collaboration/CollaboratorList.vue | 两侧抽屉复用主负责人皇冠、协作日期及可键盘访问的移出按钮。 |
| web/src/collaboration/CollabIcon.vue | 在本单目录提供描边 1.75 的线条图标，避免触碰另一单拥有的图标文件。 |
| web/src/collaboration/ModalShell.vue | 共用原生模态弹窗与关闭后焦点恢复。 |
| web/src/collaboration/ActionDialog.vue | 按动作提供建卡、理由、进度和确认输入，统一校验与提交中状态。 |
| web/src/collaboration/PasswordDialog.vue | 修改当前账号密码；400 保留会话，成功提示其他设备已退出。 |
| web/src/collaboration/AccountMenu.vue | 三种身份共用姓名胶囊、身份、修改密码与退出登录。 |
| web/src/collaboration/AuthForm.vue | 注册改为 6–128 字符，新增重置码表单和直接登录，切换或卸载时清空敏感输入。 |
| web/src/collaboration/CollaborationRoot.vue | 接受 viewer，成员和访客共用看板，负责人保留成员与邀请入口；本机路径不新增账号界面。 |
| web/src/collaboration/flow.ts | sessionView 增加 viewer，旧纯逻辑用例与导出保留。 |
| web/src/collaboration/http.ts | 将契约规定的公开重置密码端点加入匿名请求清单；提供只读负责人模式检查。 |
| web/src/collaboration/AdminPanel.vue | 邀请携带角色、授权携带角色、生成一次性重置码并重读管理信息。 |
| web/src/collaboration/UserAccess.vue | 用户角色选择和重置码操作；仅显示未使用且未过期的重置记录。 |
| web/src/collaboration/SecretDisplay.vue | 增加 reset 展示文案，关闭即清除父组件持有的明码。 |
| web/src/collaboration/collaboration.css | 补充限定在协作界面内的危险按钮与弹窗布局样式。 |
| web/src/collaboration/OwnerCollaborators.vue | 负责人完整抽屉的协作区适配，确认后携带 CSRF 移出协作人并调用原有刷新入口。 |
| web/src/components/TaskCard.vue | 仅在 collaborators 或 assigneeName 存在时增加共享头像。 |
| web/src/components/TaskDrawer.vue | 仅在 collaborators 存在时加入共享协作区；Esc 优先关闭已打开的模态弹窗。 |
| web/src/types.ts | 为完整看板增加可选协作字段，老数据不要求迁移。 |
| web/tests/collaborationBoard.check.mts | 覆盖 board.ts 全部函数、边界、动作白名单、编码路由、头像与关系文案、字段剔除和请求拒绝。 |
| web/tests/collaborationFlow.check.mts | 保留原用例，补充 viewer、公开协作字段、404、改密码 400 保持会话及匿名重置请求。 |
| docs/plans/cloud-collaboration/ui-notes.md | 保存交活范围、差异依据和真实验收状态。 |

## 契约与实现口径

- v1 旧图的 12 位密码按 v2 和当前服务端统一采用 6–128 字符。
- v2 图中协作满员的灰按钮不额外推算显示；本单明确要求只显示 actions 中的操作，服务端不返回 join 就不渲染加入按钮。
- 头像最多三个包含主负责人，四位协作人时显示主负责人、前两位协作人和 +2，符合第 07 节实例。
- 成员视图不保留 builder、gitBranch、prNumbers 等负责人字段。完整负责人看板使用既有完整任务数据，AI 主位的适配只在负责人组件内根据既有元数据判断，不给成员传入这些字段。
- 完整负责人 GET /api/board 保持现有完整看板路径，其任务没有成员视图派生的 actions；按本单第 9 步，新增移出按钮由已认证协作负责人模式控制，提交仍由服务端判权。本机没有新增协作字段时卡片和抽屉不渲染新增内容。
- 服务端公开创建人字段为 createdByUserId，没有单独的创建人姓名或 createdAt。优先用当前用户、领取人、协作人或留言中的同一用户显示名，无法对应则如实显示 ID；日期只显示服务端实际提供的 design/start/done，不把开工日冒充创建日。

## 验收事实

自测仅提交一次：`20261019T213406-4fcbe990`，选择 BOARD、FLOW、TYPE。

| 项目 | 结果 |
| --- | --- |
| FLOW | 自测第 1 次通过，含原有用例。 |
| TYPE | 自测第 1 次通过。 |
| BOARD | 自测第 1 次没有验成：调度台账仍为 running，没有最终结果，不能记通过。 |
| BUILD / FAST | 未运行；按派单方第 2 次答复，交活后在工位外统一执行，无需另提重活申请。 |
| SERVER / NOEMOJI / ACTIONS-ONLY / NOSECRET | 未运行；邮箱要求未验成后停止重试直接交活，交活后由派单方统一复核。 |

邮箱响应 exitCode 为 3，并明确要求“不反复重试，直接交活，交活后统一重跑”。没有重新提交、绕过调度或自行启动 node、测试、构建。

收到结果后，静态自审补了 MemberBoard 的两处处理：自动转到另一个授权项目时关闭旧卡弹窗；写失败后若重读也失败，保留最初服务端错误并追加刷新错误。这两处收尾改动没有重新运行类型检查，最终工作区仍需派单方统一验收。

## 第 2 次答复后的交活复核

派单方明确要求施工以 `done` 交活，全部九项验收由工位外统一重跑。本轮没有新增自测申请，也没有改动生产代码。

- 项目切换处理位于 snapshot 非空、组件未卸载且刷新序号仍有效的检查之后。两边 projectId 均为 string；selectedId 赋空串、dialog 赋 null，符合各自 ref 类型。清空发生在新项目任务赋值前，避免旧弹窗被带到同号任务上。
- refresh 的 preserveWriteError 参数由默认值 false 推导为可选 boolean；调用点只传 true 或不传参数。挂载、计时器、授权变化和点击入口均通过包装函数调用，不会把事件对象当成 boolean 参数。
- catch 中 cause 经 instanceof Error 收窄，readError 的两个分支均为 string；错误保留表达式的两个结果也均为 string，与 error ref 匹配。写失败先保存原始消息，随后 refresh(true) 若再失败则追加刷新错误；原异常继续向提交弹窗传播。
- 静态复核未发现这两处引入类型不匹配；这不等于最终工作区已重跑 TYPE。`git diff --check` 通过，改动路径仍全部在本单允许范围内。

真实浏览器交互、浅深视觉、构建及全量回归尚未取得通过证据，不以代码审查替代。未修改服务端、调度规则、依赖、CI、成员贡献或其他禁区。成本由派单器代办，本段无可核实的会话 token 基点，不能记为零。
