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
  - `<看板CLI路径>` 通常是看板安装目录下的 `cli/index.cjs`（如 `~/.claude/dashboard/cli/index.cjs`，
    或独立安装版的 `<安装目录>/cli/index.cjs`）。
  - `<项目id>` 见看板注册表（`registry.json`），或问用户。
- **绝不手动编辑 `board.json`**——一切写入只经 CLI（它保证加锁、校验、原子写、留痕）。

---

## 五条铁律

1. **动代码前先认领**（否则装了闸门会拦你提交）：
   ```bash
   node <CLI> claim <任务id> --project <id> --branch <你的分支名>
   ```
   若没有对应任务，先建：`node <CLI> add <任务id> --project <id> --title "一句话标题"`（任务 id 用大写，如 `FEAT-12`）。

2. **有进展就回写进度**：
   ```bash
   node <CLI> progress <任务id> --project <id> --percent 60 --next "下一步要做什么"
   ```

3. **遇到方向性岔路口 → 交给人拍板，别自作主张**。摆出选项 + 推荐 + 每项利弊：
   ```bash
   node <CLI> pending <任务id> --project <id> \
     --q "要定夺的问题" \
     --opt "选项A" --opt "选项B" \
     --rec "选项A" \
     --background "前因后果（越具体越好）" \
     --pros-A "选项A利弊" --pros-B "选项B利弊" \
     --reason "为什么推荐 A"
   ```
   （字段名以 `node <CLI> pending --help` / 项目 skill 为准；给全「背景 / 每项利弊 / 推荐理由」三件套，看板界面才能完整展示、便于用户一键拍板。）

4. **完工收官**：
   ```bash
   node <CLI> done <任务id> --project <id> --pr <PR号> --commit <sha>
   ```

5. **别替用户做方向性决定**：技术选型、要不要重构、砍不砍功能这类——一律 `pending` 登记，等用户拍板后再落地。

---

## 关于 Git（对所有工具通用）

- 若项目装了看板 git 钩子：**每次 `git commit` 会自动把 commit/PR/分支同步进看板**，你不用手动同步这些。
- 若装了 `pre-commit` 认领闸门：**没先 `claim` 就提交会被拒**。补一个 `claim` 即可；确需紧急放行用
  `DASHBOARD_SKIP_CLAIM_CHECK=1 git commit ...`。

---

## 一句话记住

> **你是施工方，看板是账本。每一步写回看板；方向性问题 `pending` 交人拍板，别自作主张。**
