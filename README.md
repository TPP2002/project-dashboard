# 项目管理可视化看板（claude-dashboard）

多项目通用的项目管理看板：一份机读 `board.json`（数据） + 零依赖 CLI（唯一写者） + 零依赖 server（API/SSE） + Vite/Vue 前端（界面）。
全局装一份 `~/.claude/dashboard/`，多项目共用；各项目数据落**主仓** `<root>/.dashboard/board.json`（**不进 git**，文件锁串行写）。

> 完整设计与风险治本登记册见 `~/.claude/plans/gui-refactored-pebble.md`。

## 快速开始

```bash
CLI="node ~/.claude/dashboard/cli/index.cjs"

# 注册项目（写 registry + 建空 board）
$CLI register --id game --name A股模拟器 --root F:\game

# 从现有 INDEX.md 回填任务骨架（先 dry-run 预览，再落盘）
$CLI import --project game --dry-run
$CLI import --project game

# 查询
$CLI list --project game
$CLI show P17 --project game
$CLI show --pending --project game     # 待拍板中心

# 起网页服务（server 就绪后）
npm --prefix ~/.claude/dashboard run serve
```

## 命令速查（`node cli/index.cjs <命令> --project <id>`）

| 命令 | 用途 |
|---|---|
| `register --id --name --root [--board]` | 注册项目到 registry + 建空 board |
| `import [--from <INDEX.md>] [--dry-run]` | 从 INDEX §一总表回填任务骨架（剥删除线、抽可靠字段） |
| `backfill [--patch <json>]` | 查缺语义字段 / 批量补丁 |
| `add <id> --title [--status --wave --desc]` | 新建任务 |
| `claim <id> --branch [--scope]` | 认领 → 施工中（防倒退状态机） |
| `progress <id> --percent [--next --tests --typecheck]` | 里程碑回写 |
| `pending <id> --q --opt… --rec` | 登记待拍板问题 |
| `decide <id> --did --answer [--promote]` | 拍板（填答案） |
| `park <id> --reason` / `block <id> --by --reason` | 暂缓 / 阻塞 |
| `done <id> [--pr --commit --collect]` | 收官 / 完工 |
| `note --text [--task]` / `set <id> --field --value` | 活动流 / 通用兜底赋值 |
| `list [--status --wave]` / `show <id>｜--pending` | 查询 / 待拍板中心 |
| `sync-from-git [--branch --n]` | 从 git 自动派生 commit/pr/branch（hook 调用） |
| `doctor [--fix]` | 对账 git↔board + 自检 hook + 有边界修复 |
| `render-index [--index <INDEX.md>] [--dry-run]` | 从 board 生成 INDEX 状态段（锚间、幂等） |
| `snapshot [--out --stamp]` | 导出 board 快照（git 外备份） |

全局 flag：`--author <身份>`、`--json`（机器可读）、`--registry <path>`（测试用）。

## 文件结构

```
core/     零依赖底座（CLI 与 server 共用）
  atomicWrite.cjs   唯一写盘（fsync+退避重试，治本 R1）
  lock.cjs          跨进程锁（O_EXCL+退避+陈旧锁抢占，R9c/e）
  safePath.cjs      normalizeReal / resolveInsideRoot（防 junction 逃逸，R4）
  resolveProject.cjs  --project → {mainRepo,board,lock,docsRoot}
  boardSchema.cjs   STATUS/STATUS_EMOJI/emojiFor/emptyBoard/validate/assertValid
cli/      零依赖 CLI（board 唯一写者）
  index.cjs         惰性分发（命令→[模块,导出]，各命令独立文件、互不撞车）
  store.cjs         mutate/readBoard/findTask/unionBy（锁内 read-modify-write）
  commands.cjs      register/add/claim/.../list/show
  gitSync.cjs       syncFromGit/doctor/scanCommits
  importCmd.cjs backfill.cjs renderIndex.cjs snapshot.cjs
server/   零依赖 HTTP+SSE（托管 dist + /api，另见启动指令）
web/      Vite+Vue3 前端（另见启动指令）
test/     node:test 单测（39 用例，npm test）
registry.json   项目注册表
```

## 给开发者：写 board 的铁律

一切写 board **只能**经：`CLI → store.mutate(proj, mutator, activityEntry)`，它内部保证
`withLock → 锁内重读最新 → 就地改 → 刷 updatedAt → 追 activity → assertValid 校验 → atomicWrite`。
- **禁裸 `fs.writeFileSync` 写 board/registry**；一律 `core/atomicWrite`。
- **累加字段**（commitShas/prNumbers/gitBranch/activity）用 `unionBy` 去重合并，**绝不整对象覆盖**（防并发丢更新）。
- **按用户输入拼的路径**（如 /api/doc）一律 `core/safePath.resolveInsideRoot`，逃逸返回 null/403；**禁 `startsWith`**。
- **统计**（进度/状态计数/矩阵）读时派生、**不落盘**。

## 三重同步保险（数据新鲜度不靠对话记性，治本 R2）

① skill 指令让施工对话主动调 CLI（弱） ② git `post-commit` hook 自动 `sync-from-git` 派生字段（强） ③ `doctor` 对账 git↔board 抓漂移（兜底）。git 派生字段（commit/pr/branch）与语义字段（decisions/deps/wave/禁区）**字段集不相交**，各有唯一权威、互不抢写。

## 测试

```bash
npm --prefix ~/.claude/dashboard test    # node:test，零依赖，39 用例
```
