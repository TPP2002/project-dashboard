# 接入其它 AI 模型（Cursor / Codex / Gemini / Copilot / 任意 agent）

看板最初为 Claude Code 调优，但**看板本体与模型完全无关**。这份告诉你怎么让别的 AI 工具也开箱接入。

---

## 一个核心事实

**看板是"账本"，谁都能写——只要它能跑一条命令。**

任何 AI 工具（或脚本、或你自己）执行
`node <看板CLI路径>/cli/index.cjs claim/progress/pending/done --project <id> …`
就能把状态写回看板。看板不关心是谁写的。

所以「让别的模型接入」= 满足两个条件：

1. **它能执行 shell 命令**（现在主流 AI 编码工具都能）。
2. **它读得到看板协议**（知道该在何时调哪个命令）——即把 [`AGENTS.md`](../AGENTS.md) 的内容喂给它。

---

## 各工具怎么"喂协议"

把 [`AGENTS.md`](../AGENTS.md) 的协议内容，放到各工具约定的规则文件里即可：

| 工具 | 放哪 | 说明 |
|---|---|---|
| **Claude Code** | 已内置 | `enroll` / `hooks-install` 会写 `CLAUDE.md` 协议锚 + 装 git/CC 钩子，开箱即用 |
| **OpenAI Codex / 多数遵循约定的工具** | 项目根 `AGENTS.md` | 直接用本仓的 `AGENTS.md` 模板，多数工具会自动读取 |
| **Cursor** | `.cursor/rules/dashboard.mdc`（或旧版 `.cursorrules`） | 把 `AGENTS.md` 协议粘进去 |
| **Gemini CLI** | 项目根 `GEMINI.md` | 把 `AGENTS.md` 协议粘进去 |
| **GitHub Copilot** | `.github/copilot-instructions.md` | 把 `AGENTS.md` 协议粘进去 |
| **任意 agent / 自研** | 它的系统提示 / 项目说明 | 贴入 `AGENTS.md` 协议即可 |

> 偷懒法：直接把 `AGENTS.md` 复制成对应工具要的文件名即可（内容一样，只是文件名不同）。

---

## 天然跨工具的部分（不用做任何事）

看板的 **git 钩子对所有工具都生效**（`hooks-install` 装一次即可）：

- `post-commit` / `post-merge`：**谁提交都触发** → 自动把 commit / PR / 分支同步进看板。
- `pre-commit` 认领闸门：**没先 `claim` 就提交会被拦**——不管提交的是哪个工具的 agent。

所以"提交自动同步进度"和"没认领就拦提交"这两条，对 Cursor / Codex / Gemini … 一视同仁。

---

## 一个诚实的提醒

- **富追踪（认领 / 进度 / 拍板）依赖模型"真的照协议去调 CLI"。**
  Claude Code 这边有 `CLAUDE.md` + `pre-commit` 闸门**强制**；别的工具主要靠它**遵守你给的规则文件**（可靠性略弱）。
- 但**`pre-commit` 闸门是 git 层、跨工具**——即使某个模型偷懒没 `claim`，提交那一刻照样会被拦下来，兜底仍在。
- 想要最省心：**装 `hooks-install`（git 层自动同步 + 闸门）+ 给模型一份 `AGENTS.md`（主动 claim/progress/pending/done）**，两者叠加就齐了。

---

## 最小接入清单

1. 注册项目：`node <CLI> register --id <id> --name <名> --root <项目路径>`
2. 装钩子（可选但推荐）：`node <CLI> hooks-install --project <id>`
3. 把 `AGENTS.md` 放进项目根（或复制成你工具要的规则文件名）。
4. 让 AI 在这个项目里干活——它会照协议把进度写回看板；方向性问题会 `pending` 交你拍板。
