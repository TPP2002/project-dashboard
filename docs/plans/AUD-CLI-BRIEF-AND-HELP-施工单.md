# AUD-CLI-BRIEF-AND-HELP · 施工单(复述 + 微型设计)

> 卡:`AUD-CLI-BRIEF-AND-HELP`(项目 `dashboard`)· 分支 `feat/aud-cli-brief-and-help`
> 工位:`<worktree>/aud-cli-brief-and-help`(主工位停在主干,施工在 worktree)
> 正本:`docs/审计报告-20260907-看板全景审计.md` §4-A1/A3/A4、§5
> 状态:施工中 · 建单日 2026-09-07

---

## 0. 一句话

AI 每次跟看板打交道都被塞几千字废话,这张卡把 CLI 的**输出**改成"要什么给什么",
并补上**一条命令拿全开工信息**(`brief`)和**逐命令帮助**(`--help`)。

## 1. 复述关卡(skill code-quality-discipline §2.2)

### 1.1 这块系统现在怎么运作

- `cli/index.cjs` 是唯一入口:`parseFlags` 解析 argv → `REGISTRY` 表惰性 require 命令模块 →
  跑 `fn(flags)` → 按 `--json` / `res.text` / 默认三种方式打印。
- `cli/commands.cjs` 是语义命令集合,所有写命令走 `store.mutate`(抢锁 → 锁内重读 → 改 → 追活动流 →
  校验 → 原子写),返回 `okTask(board,id)` = `{ok, task}`。
- 读命令 `list` / `show` 也在 `commands.cjs`:`list` 拼字符串、`show` 直接 `JSON.stringify(task,null,2)`。
- `cli/inboxCmd.cjs` 是"新对话读看板接单"入口;`--tid` 时调 `cli/dispatchPrompt.cjs` 的
  `buildTaskDispatchPrompt` 生成任务书。`server/server.cjs` 的 `/api/dispatch` 用同一个生成器。

### 1.2 问题落在哪个环节

四处,全在"输出体量"和"入口缺失":

1. **没有逐命令帮助**(A1)。`index.cjs` 只有一行全局 help(命令名罗列);`pending --help` 会被
   `need()` 当成缺参数报错——AGENTS.md 却让 AI 去看 `pending --help`,照做必失败、白跑一轮。
2. **没有"一条命令拿全开工信息"的入口**(A3)。今天 AI 开工要读 CLAUDE.md 锚段 + skill + `precheck`
   + `show`(整卡 JSON)+ `inbox --tid`(还只在有待落地决策时可用)。
3. **查询命令整卡回吐**(A4)。`list` 默认含已完工且把 `title`(给模型看的技术说明,可达 2000+ 字)
   整段吐回;`inbox --project` 列表态同理;写命令 `--json` 回整个 task 对象。
4. `show` 无论要不要都给整卡 JSON。

### 1.3 打算怎么改

**新增四个文件承载新逻辑,对两个热点文件只做最小接线**(见 §3 撞车预案):

| 文件 | 职责 |
|---|---|
| `core/taskTitle.cjs`(新) | 人话标题的唯一口径(`humanTitle`/`specText`),与 `web/src/utils/taskTitle.ts` 同 60 字截断 |
| `cli/help.cjs`(新) | 帮助表(每命令:一句话 / 用法 / 参数 / 示例 / 退出码)+ 全局 help 渲染 |
| `cli/brief.cjs`(新) | `brief <id>` 命令 + `buildBrief()` 生成器(markdown 一屏) |
| `cli/renderTask.cjs`(新) | `list` 的行渲染(默认 / `--brief` / `--fields`)与 `show` 的精简卡渲染 |
| `cli/store.cjs`(改) | 加 `mutateTask()`:锁内比对目标卡前后快照,产出 `changed[]` |
| `cli/commands.cjs`(改) | 写命令换用 `mutateTask`;`list`/`show` 改调渲染器;`claim --brief` |
| `cli/index.cjs`(改) | 注册 `brief`;`--help` 拦截;写命令 `--json` 走精简信封 |
| `cli/inboxCmd.cjs`(改) | 列表态只打 id + 人话标题 + 决策数 |
| `cli/dispatchPrompt.cjs`(改) | 任务书 = `buildBrief()` + 施工职责段(与 `brief` 共用同一生成器) |
| `server/server.cjs`(改·1 行) | `/api/dispatch` 把 board 传进生成器,派单任务书与 `inbox --tid` 完全同源 |

### 1.4 会波及哪些文件/模块

见上表。**不动**:`core/boardSchema.cjs`(状态枚举归 AUD-CLI-LIFECYCLE-CMDS)、前端 `web/`
(人话标题前端侧已由 AUD-UI-PLAINTITLE-EVERYWHERE 收口)。

---

## 2. 微型设计(skill code-quality-discipline §4)

**目标**:`list` / `inbox` 输出体量各降 ≥80%;`brief` 一条命令覆盖开工所需全部信息;逐命令 `--help`。

**方案**(逐条对应卡上的 ①~⑥):

1. `brief <id> --project <p>`:markdown 一屏 = 人话标题 / 状态档位波次分支 / 技术说明 / 文件域 /
   依赖及**依赖卡的当前状态** / 待拍板(有则置顶 ⛔ 禁止开工) / 已拍板待落地的答案 / 参考文档 /
   最近留言 / 下一步命令。`claim --brief` 认领后直接打印同一份;`inbox --tid` 复用同一生成器。
2. `--help`:数据表驱动,`index.cjs` 在分发前拦 `--help`/`-h`,也支持 `help <cmd>`。
   全局 help 列"命令 + 一句话"。退出码统一写进每条帮助。
3. `list`:默认隐藏已完工(给 `--all`;显式 `--status` 时不隐藏);默认行 = `id status pct branch 人话标题(截60)`;
   `--brief` 只给 id/status/pct;`--fields a,b` 自选列(支持 `branch`/`pct`/`plain` 别名与一级点路径)。
4. `show`:默认精简卡(id/人话标题/status/percent/branch/待拍板问题/nextMilestone),`--full` 才整卡 JSON。
5. 写命令 `--json` → `{ok,id,status,percent,changed[]}`。`changed[]` 由 `mutateTask` **在锁内**
   比对同一张卡的前后快照得出(不是各命令自报,免得与真实行为漂移)。
6. `inbox --project` 列表态:每行 `id + 人话标题(截60) + N 条待落地`。

**边界情况**:老卡没有 `plainTitle`(截 `title` 60 字应急);卡没有 `deps`/`docs`/`fileScope`
(给出"没登记"并指路补齐,不静默留白);`brief` 的卡不存在(沿用 `findTask` 报错);
`--fields` 写了不存在的字段(该列打 `-`,不报错);夹具卡缺 `status`/`percent`
(`repoHygiene` 的 `DEMO-1` 就是这种,生成器必须容错);`brief` 对已完工卡照常可看(用于复盘)。

**测试点**:每条命令都有 `--help` 且含用法行(表驱动 + 注册表比对,防新增命令漏帮助);
`brief` 含七段必备信息;有未答决策时含"禁止开工";`list` 默认不含已完工 / `--all` 含 /
`--brief` / `--fields`;`show` 默认精简 / `--full` 整卡;写命令 `--json` 只有五个键且
`changed` 反映真实变更;`inbox` 列表态不含技术说明;`claim --brief` 打任务书;
两处人话标题截断口径一致(防 CLI 与前端漂移);体量对比(必败先行:改前的渲染必须超阈值)。

**回滚**:安全点 = 本卡第一个提交的父提交 `54a926e`。全部改动限于 `cli/` `core/taskTitle.cjs`
`server/server.cjs` 一行与 `test/`,`git revert` 即可。

---

## 3. 撞车预案(skill §11.4)

**开工当时看板上有三张 CLI 卡同时挂"施工中"**:本卡、`AUD-CLI-LIFECYCLE-CMDS`、
`AUD-CLI-BATCH-AND-AUTOPROJECT`,三张都改 `cli/commands.cjs` 与 `cli/index.cjs`——
审计报告 §5 明写这三张**应串行**。已在看板 `note` 里留痕并当面报告负责人。

本卡的减震措施:**新逻辑一律落新文件**,`commands.cjs` / `index.cjs` 只留最小接线
(`list`/`show` 各缩成三五行、`index.cjs` 加一个命令注册 + 两处拦截),
让后合并的那张卡冲突面尽量小。
