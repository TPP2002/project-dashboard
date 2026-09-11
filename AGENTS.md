# AGENTS.md — AI 施工方 · 看板同步协议（工具中立）

> **这份是「家规」模板。** 任何 AI 编码工具（Claude Code / Cursor / Codex / Gemini CLI / Copilot / 自研 agent）
> 只要能**读到这份说明**并**能执行 shell 命令**，就能把工作进度写回「项目管理看板」。
> 把本文件放到你要让 AI 施工的**项目根目录**；不同工具怎么让它读到，见 [接入其它 AI 模型](docs/接入其它AI模型.md)。

---

## 你是谁、看板是什么

你是这个项目的**施工方（AI）**。项目用「项目管理看板」跟踪工作：
看板是一本**权威账本**，记录每个任务「做到哪、卡在哪、有什么等人拍板」。
**你的职责 = 一边干活，一边把状态经命令行写回看板**，让监督你的人随时看清进度。人只负责看进度 + 在岔路口拍板。

- 看板 CLI：`node <看板CLI路径> <命令> --project <项目id>`
  - `<看板CLI路径>` 以发布副本 `~/.claude/dashboard-release/cli/index.cjs`，
    或独立安装版的 `<安装目录>/cli/index.cjs` 为准。
  - 各仓 git hook 里自动调的那份是**发布副本** `~/.claude/dashboard-release/cli/index.cjs`（由 `cli release` 从主干导出，
    不随任何对话切分支而变）；看板本身的代码合进主干后要跑一次 `release` 才在 hook 里生效。
  - **负责人在用的网页服务也是从这份副本起的**（`启动看板.bat` / `dashboard.sh`）。所以看板代码收官时：
    合进主干 → 跑一次 `release`（它会顺带把界面构建进副本）→ 告诉负责人「下次双击启动器会自动换新」。
    没跑 `release`，等于改了个寂寞：hook 和他看的界面都还是旧的（SERVER-RUNS-ON-LIVE-CHECKOUT）。
  - **发布要用副本自己的 CLI**：`node ~/.claude/dashboard-release/cli/index.cjs release --source <代码检出目录>`。
    拿一个落后的主工位去 `node cli/index.cjs release`，跑的是那份**旧的发布工具**——副本代码是新的、界面却没建出来
    （0906 迁移当天真踩过）。`precheck` 会报「副本里没有网页界面」兜底，启动器也已改成优先用副本的 CLI。
  - `<项目id>` 见 `DASHBOARD_HOME` 下的看板注册表（`registry.json`），或问用户；新配置可照抄 [registry.example.json](registry.example.json)，复制为该数据目录下的 `registry.json` 后填写本机路径。
- **绝不手动编辑 `board.json`**——一切写入只经 CLI（它保证加锁、校验、原子写、留痕）。

---

## 第 0 步：先拿规矩，再拿任务书

1. **先跑 `protocol` 拿规矩**，照它输出的协议卡做，别凭记忆；项目可省略，认不出时会给占位符。

   ```bash
   node <CLI> protocol --project <id>
   ```

2. **再跑 `brief` 拿任务书**——人话标题、技术说明、文件域、上游状态、待拍板问题（有就明写**禁止开工**）、已拍板答案、参考文档和最近留言一次给齐。

   ```bash
   node <CLI> brief <任务id> --project <id>
   ```

不知道有哪些卡可接：`node <CLI> list --project <id>`（默认只列没完工的，一行一张）。
**任何一条命令记不清怎么用，就问它自己**：`node <CLI> <命令> --help`（含参数、示例、退出码）；
`node <CLI> help` 给全部命令 + 一句话说明。

---

## 五条铁律

1. **动代码前先认领**（否则装了闸门会拦你提交）：
   ```bash
   node <CLI> claim <任务id> --project <id> --branch <你的分支名> --scope "<会改的文件>"
   ```
   加 `--brief` 可以在认领的同时把上面那份任务书再打一遍。
   若没有对应任务，先建：`node <CLI> add --help` 照着填（建卡有机器闸：必须同时给
   `--title` 技术说明、`--plain-title` 一句人话、`--model` 建议档位；任务 id 用大写，如 `FEAT-12`）。

2. **有进展就回写进度**：
   ```bash
   node <CLI> progress <任务id> --project <id> --percent 60 --next "下一步要做什么"
   ```

3. **遇到方向性岔路口 → 交给人拍板，别自作主张**。摆出选项 + 推荐 + 每项利弊：
   首选把完整问题存成文件再传入，避免命令行转义出错：
   ```bash
   node <CLI> pending <任务id> --project <id> --json-file pending.json
   ```
   文件包含 `question`、`options`、`recommended`、`background`、`optionPros`、`recommendReason`、`allowCustom`；JSON 示例见 `protocol` 输出。
   命令行形式的真实参数如下（`--pros-` 后必须接完整选项文本）：
   ```bash
   node <CLI> pending <任务id> --project <id> \
     --q "要定夺的问题" \
     --opt "选项A" --opt "选项B" \
     --rec "选项A" \
     --background "<至少60字：场景、问题、要做什么、为什么重要>" \
     --pros-选项A "<至少20字：选项A的好处与代价>" --pros-选项B "<至少20字：选项B的好处与代价>" \
     --reason "<至少30字：为什么推荐选项A>"
   ```
   三件套 `background` / `optionPros` / `recommendReason` 缺一或太短会拒收；默认允许自定义答案，命令行加 `--strict` 可禁止。

4. **完工收官**：
   ```bash
   node <CLI> done <任务id> --project <id> --pr <PR号> --commit <sha>
   ```

5. **别替用户做方向性决定**：技术选型、要不要重构、砍不砍功能这类——一律 `pending` 登记，等用户拍板后再落地。

---

## 命令速查：一张卡的一生

下表按「你此刻想干什么」查命令。每条都要带 `--project <项目id>`，写法一律
`node <CLI> <命令> <任务id> --project <id> [参数]`。

| 你要干什么 | 命令 |
|---|---|
| 开工先拿规矩 | `protocol [--format md\|json]`（`--project` 可选） |
| 建一张卡 | `add <id> --title "技术说明" --plain-title "一句人话" --model "档位"` |
| 动代码前认领 | `claim <id> --branch <分支名>` |
| 有进展了 | `progress <id> --percent 60 --next "下一步干什么"` |
| 遇到岔路口要人拍板 | `pending <id> --json-file pending.json`（三件套见上面铁律 3） |
| 拍板的东西写进代码了 | `mark-landed <id> --did dN`，一次标完本卡全部用 `--all` |
| **我不做了，把卡交回去** | `unclaim <id> --reason "为什么放手"` |
| 先搁一搁 / 又能做了 | `park <id> --reason …` / `unpark <id> --reason …` |
| 被别的卡挡住了 | `block <id> --by <上游id> --reason …` |
| 正在收尾（还没完） | `done <id> --collect` |
| 完工收官 | `done <id> --pr <PR号> --commit <sha>` |
| **这活不做了** | `cancel <id> --reason "为什么作废"` |
| **结了案又要重来** | `reopen <id> --reason "为什么重开"` |
| 卡面写错了要改 | `edit <id> [--title|--plain-title|--desc|--model|--wave]` |
| 想看某张卡 / 全部卡 | `show <id>` / `list` |

几条容易踩的：

- **往回走的三条路各有各的意思，别互相顶替**：`unclaim` 是「活还在，只是我不干了」，
  卡退回可派状态等下一个人接；`cancel` 是「这活不做了」，卡进「已作废」；
  `reopen` 是「结了案又要重来」。拿 `done` 当垃圾桶用会让完工数里混进根本没干的活。
- **已完工 / 已作废的卡不能报进度、也不能再 `claim`**，要接着做先 `reopen`。
- **`done` 会顺带把本卡「已拍板但没标落地」的决策一并标成已落地**（提交号取本次 `--commit`），
  不用再一条条 `mark-landed`；已经标过的不会被覆盖。
- **`done --collect` 只是「收尾中」**，不写完工日期、不把进度改成 100%。真完工再跑一次不带 `--collect` 的。
- **改卡面用 `edit` 不用 `set`**：`edit` 认字段、带校验；`set` 是兜底，字段名打错会往卡上挂一个没人认识的属性。
- 作废的卡照旧出现在看板上，但**不计入完成度的分母**——它不是没做完，是不做了。

---

## 关于 Git（对所有工具通用）

- 若项目装了看板 git 钩子：**每次 `git commit` 会自动把 commit/PR/分支同步进看板**，你不用手动同步这些。
- 提交说明的卡号写在 `feat(卡号):` 的括号里、说明开头或说明末尾的括号里才会关联；正文里顺带提到的不关联，除非那张卡已经在当前分支认领（仅本次提交同步，窗口重扫不算）。PR 号只认 `Merge PR #N:` 开头（兼容 `Merge pull request #N`）和单独成括号的 `(#N)` 等纯标注。
- 若装了 `pre-commit` 认领闸门：**没先 `claim` 就提交会被拒**。补一个 `claim` 即可；确需紧急放行用
  `DASHBOARD_SKIP_CLAIM_CHECK=1 git commit ...`。

---

## 查询命令默认是「精简」的

看板的输出对 AI 按「要什么给什么」设计，别指望默认就给全量：

| 你要什么 | 跑什么 |
|---|---|
| 开工所需的全部信息 | `brief <任务id>` |
| 现在有哪些活 | `list`（默认不含已完工；`--all` 全给，`--brief` 只要号/状态/进度，`--fields a,b` 自选列） |
| 一张卡的近况 | `show <任务id>`（精简卡；`--full` 才是整卡 JSON） |
| 有哪些拍板还没落地 | `inbox`（默认只列一屏，新拍的排前面；`--all` 全列） |
| 某条命令怎么用 | `<命令> --help` |

写命令加 `--json` 时只回 `{ok,id,status,percent,changed[]}`——`changed` 是这次真正动了哪些字段。

---

## 一句话记住

> **你是施工方，看板是账本。开工先 `protocol` 再 `brief`，每一步写回看板；方向性问题 `pending` 交人拍板，别自作主张。**
