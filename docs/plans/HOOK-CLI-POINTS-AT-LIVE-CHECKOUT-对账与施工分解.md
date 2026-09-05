# HOOK-CLI-POINTS-AT-LIVE-CHECKOUT · 对账与施工分解

> 卡号:HOOK-CLI-POINTS-AT-LIVE-CHECKOUT · 项目:dashboard · 分支:`fix/hook-cli-points-at-live-checkout`
> 阶段:①对账 ②建议 ③分解 已完成,**等负责人拍板后再进阶段④(动代码)**。
> 写于 2026-09-06。本文是阶段①②③的产出正本,拍板结论回写在文末「拍板记录」。

---

## 一句话说清

全机器几十个仓库的「提交前检查」和「提交后同步」,都是去 `~/.claude/dashboard/cli/index.cjs` 这个**正在被人编辑的工作副本**里拿代码来跑。谁在那个目录切分支、谁在那儿改了没提交的东西,全机器的闸门就跟着一起变。治法是把「大家跑的那份」和「正在改的那份」分开:hook 只认一个只读的**发布副本**,合进 master 后一条命令把发布副本刷新。

---

## ① 对账(设计 ↔ 代码现状,逐条核过)

### 1. 病根链(症状 → 直接病因 → 更深病因 → 最深根)

| 层 | 事实 | 出处 |
|---|---|---|
| 症状 | 合进 master 的新命令不生效;主工位切到功能分支时全机器 hook 跑的是那条分支的代码 | 卡面原话(HOOK-CLAIM-GATE-MULTI-PROJECT 当时无法部署) |
| 直接病因 | hook 文件里焊死的是 `node "C:/Users/Administrator/.claude/dashboard/cli/index.cjs" …` 这个**绝对路径** | 实测 4 个仓的 `.git/hooks/{pre-commit,post-commit,post-merge}`、3 个仓的 `.claude/settings.json`、全局 `~/.claude/settings.json` 的 TodoWrite 钩子 |
| 更深病因 | `cli/hooksInstall.cjs` 顶部 `const CLI = path.join(DASHBOARD_HOME,'cli','index.cjs')`,拿**数据根**当**代码根**用 | `cli/hooksInstall.cjs` 第 26 行附近 |
| 最深根 | `core/resolveProject.cjs` 明文规定「DASHBOARD_HOME 只决定数据往哪读写,代码定位一律走 `__dirname`」,hooksInstall 违反了这条自家约定;而且**根本没有「发布/部署」这一层概念**,「代码在哪」= 「谁在改的那个目录」 | `core/resolveProject.cjs` 头注 + 产品手册 §4.4 |

### 2. 「活的工作检出」不是理论风险,是当下正在发生

- `git reflog` 显示主工位 09-05 两次被切到 `feat/reader-into-board`、`feat/reader-usability-round2`,期间全机器 hook 跑的就是那两条分支。
- **此刻**主工位 master 上躺着 `cli/cleanup.cjs`、`test/opsScripts.test.cjs` 两个**未提交改动**(属于另一张卡 BOARD-CLEANUP-DELETES-MAIN 的对话,它没走 worktree,直接在主工位改)。这就是「某对话把 CLI 改坏,全机器立刻遭殃」的现场样本——只是恰好 cleanup 不在 hook 调用链上,没炸而已。
- `registry.json` 也以未提交改动形态躺在主工位(另一张卡 REGISTRY-LIVE-DIVERGED-FROM-REPO 已登记,本卡不碰)。

### 3. 波及面盘点(实测,不是卡面估计的 9 个)

| 位置 | 状况 |
|---|---|
| `F:\game` `F:\Questline` `F:\stock-rogue` `F:\百卉园艺` | 三个 git hook 全装了,路径全指主工位 |
| `F:\game` `F:\Questline` `F:\百卉园艺` 的 `.claude/settings.json` | Stop / PostToolUse 钩子各 3 处引用主工位路径 |
| `~/.claude/settings.json` | 全局 TodoWrite 进度钩子引用主工位路径(**所有对话**都会触发) |
| `F:\stock-rogue` 的 30+ 个 worktree | 共享同一份 `.git/hooks`,等于全部受影响 |
| `F:\lhjy` `F:\mama-method` `F:\cluster-ops` 自动化求职 看板仓自身 | 没装 hook,不受影响(看板仓自己没装 claim 闸门,本卡顺带不改) |

另外 **看板网页服务**(`server/server.cjs`,由 `启动看板.bat` 起)同样跑在主工位上,同一族病;不在本卡 fileScope,已另立卡登记(见文末)。

### 4. 现有代码里可复用的零件

- `cli/cleanup.cjs` 的 `detectTrunk()`:探测远程主干名(main/master),发布命令直接复用,不再写死。
- `core/atomicWrite.cjs`:原子写,RELEASE 印章文件用它。
- hook 侧已有 rc=2/3 兜底(CLI 缺命令时放行并吵一声),本卡保留不动。
- `packaging/build-installer.cjs` 已经证明「代码目录 = 安装目录、无 .git」这种布局能跑——发布副本就是同一布局的本机版。

### 5. 冲突分类

- **A 类(架构选择,要拍板)**:「hook 到底该指向哪份代码」——三条治法互斥,见②。
- **B 类(能力缺失)**:没有「发布」命令;没有「发布副本是否落后 master」的体检;测试用 `DASHBOARD_HOME` 强行把 hook 指向本检出(`test/hooksInstall.test.cjs`、`test/claimCheck.test.cjs`、`test/claimCheckRollout.test.cjs` 三处),换了口径要跟着改。
- **C 类(数值口径)**:无。

---

## ② 建议(只建议,拍板权在负责人)

### 三条治法大白话对照

| | 治法① 发布副本(**推荐**) | 治法② 主工位永远停 master | 治法③ hook 里加版本探测 |
|---|---|---|---|
| 一句话 | 「改的」和「跑的」分成两个目录;hook 只认「跑的」那份;合进 master 后一条命令刷新 | 规定主工位不许切分支,施工一律去 worktree | hook 每次跑之前先探一下 CLI 有没有它要的命令/版本 |
| 治的是什么 | **病根**:hook 不再依赖任何「正在被编辑」的目录 | 病根的一半:切分支这条路堵住了,但**未提交改动**照样漏(今天就在漏) | 症状:只兜「命令不存在」这一种坏法,逻辑改坏了照样跑坏的 |
| 「合了 master ≠ 生效」解决了吗 | 解决:发布动作有明确的一步,`doctor`/`precheck` 能报「发布副本落后 master」 | 半解决:还得有人记得回主工位 `git pull` | 没解决 |
| 「某对话改坏 CLI 全机器遭殃」解决了吗 | 解决:改坏的在工位里,发布副本没动 | 没解决:主工位改了没提交照样影响 | 没解决 |
| 靠什么保证 | 机器(路径物理分开) | 人的纪律(可加一个 post-checkout 拦截 hook 变半机器) | 机器,但只兜一种情况 |
| 工程量 | 中:新命令 + 改 hooksInstall 取路径规则 + 测试 + 一次性迁移(约 300 行含测试,4~5 个文件) | 小:一个 post-checkout 拦截 hook + 文档(约 30 行) | 极小:已有 rc=2/3 兜底,再加也是补丁 |
| 副作用/代价 | 多一个目录、多一个「发布」步骤要记(放进收官序列 + doctor 提醒) | 主工位从此只能看不能改,和现有「多对话直接在主工位改」的习惯冲突,靠人守 | 无,但也没治 |

### 推荐:治法①,并顺手带上治法②的「拦截 hook」当保险

理由:
1. **只有①把「跑的代码」从「人改的目录」里拿出来了**。②③都还让全机器的闸门依赖一个随时会被人改的目录,区别只是改的方式被限制了多少。
2. **今天的现场就是②的反例**:主工位停在 master,但 `cli/cleanup.cjs` 已被另一对话直接改了没提交。纪律型方案在多对话并行下必失守,这是 skill 反复写进去的教训(v4.1「纪律靠自觉必失守,机器闸兜底」)。
3. **①和现有设计一脉相承**:`resolveProject.cjs` 早就写明「代码定位与 DASHBOARD_HOME 无关」,分发版安装包也是「代码目录不带 .git」的布局。①只是把分发版那套布局在本机也落一份。
4. ②的拦截 hook 便宜且不冲突,作为①的保险一起做:主工位切离 master 时吵一声(不硬拦,免得堵死别人),提醒「去 worktree」。

### 治法①的具体设计(拍板后照此施工)

**新概念:发布副本** `~/.claude/dashboard-release/`——只有运行期文件(`core/ cli/ server/server.cjs package.json`)+ 一个印章 `RELEASE.json`(记来源 commit、导出时间、来源仓),**没有 .git**,不许人手改。

**hook 路径取值规则(hooksInstall.cjs 唯一要改的核心)**——「hook 永远不许指进一个 git 检出」:
1. 环境变量 `DASHBOARD_HOOK_CLI_ROOT` 有值 → 用它(测试隔离专用,替代现在测试里滥用的 DASHBOARD_HOME)。
2. 否则,当前运行的这份代码(`__dirname/..`)**自己就是发布副本或安装版**(目录里没有 .git)→ 指向自己。分发版安装包天然走这条,行为不变。
3. 否则(当前代码是 git 检出)→ 指向 `~/.claude/dashboard-release`;该目录不存在就**拒装并提示先跑 `cli release`**,绝不回退到检出路径。

**新命令 `cli release`**(`cli/release.cjs`,新文件):
- 来源固定取 **`origin/<主干>`**(先 `git fetch`,主干名用 `detectTrunk()` 探测),用 `git archive` 导出运行期文件——**和主工位此刻检出什么分支、有没有未提交改动完全无关**,这正是治本点。
- 导出到 `dashboard-release.new` → 写 `RELEASE.json` → 目录级原子换名(旧的先挪到 `.old` 再删;Windows 上换名被占时重试几次)。hook 进程加载完就不占文件,换名窗口极小。
- 可选 `--commit <sha>` 指定发布某个 commit(回滚用)。
- 发布副本路径固定,所以 hook 里焊的路径**一次装好永不变**,以后只刷新目录内容。

**体检接线**:`doctor` 与 `precheck` 增加一项「发布副本 vs origin/主干」——落后就报「⚠ 发布副本落后 N 个提交,跑 `cli release`」;不存在就报「未发布」。

**触发时机(拍板项之二,见下)**:默认写进看板项目的收官序列(合并入 master 的那个对话跑 `cli release`),体检兜底。

**一次性迁移(本机)**:跑一次 `cli release` → 对 game / questline / rogue / baihui 各重跑一次 `hooks-install`(幂等,只换锚块里的路径)→ 重跑 `hooks-global` → grep 核对所有 hook 与 settings 里不再出现 `dashboard/cli/index.cjs` → 真提交一次验闸门。

**保险(治法②那一小块)**:看板主工位装一个 `post-checkout` 钩子,切离主干时打印一行提醒「主工位应停在 master,施工去 dashboard-wt」;不拦。

### 附带拍板项:发布怎么触发

| 选项 | 含义 | 好处 | 代价 |
|---|---|---|---|
| A 收官序列手动跑(**推荐**) | 合并入 master 的对话在收官清单里跑 `cli release`;`doctor`/`precheck` 落后就提醒 | 简单、可控、坏 master 不会自动铺满全机器 | 靠对话记得跑;有体检提醒兜底 |
| B 计划任务自动跑 | Windows 计划任务每 10 分钟 fetch + release | 真正「合了就生效」 | 多一个常驻任务;master 合坏了 10 分钟内全机器跟着坏,没有人工缓冲 |

推荐 A:看板仓刚接了 CI(CI-BOOTSTRAP-CLOUD-RUNNER),但 master 合坏的可能仍在;人工一步是有价值的缓冲。B 可以以后单独立卡。

---

## ③ 施工分解(拍板①+A 后按此派单)

**施工方判定(§17.0)**:本卡契约能定死(下面每条都有机器可跑的验收),按默认应派 Codex;本项目没有开工须知/派单简报脚本,派单方式由负责人在拍板时一并说。

| 序 | 子任务 | 范围(文件) | 禁区 | 验收断言 |
|---|---|---|---|---|
| T1 | 新命令 `release`:fetch → `git archive origin/<trunk>` 运行期文件 → `RELEASE.json` → 原子换名;`--commit` 可选;`index.cjs` 注册 | 新建 `cli/release.cjs`;`cli/index.cjs` 加一行注册 | 不碰 `server/`、`web/` | V1 `test/release.test.cjs`:在临时 git 仓 + 临时 HOME 下发布,产物含 `cli/index.cjs`、`RELEASE.json.commit` = origin/trunk 的 sha;来源检出切到别的分支、留未提交改动后再发布,产物仍等于 origin/trunk(**这条是治本的直接证据**);连发两次目录内容一致且无 `.new/.old` 残留 |
| T2 | hooksInstall 取路径规则改为「永不指进 git 检出」:环境变量 → 自身非检出 → 发布副本 → 否则拒装 | `cli/hooksInstall.cjs`(`CLI`/`MARK` 的取值改成函数);`test/hooksInstall.test.cjs`、`test/claimCheck.test.cjs`、`test/claimCheckRollout.test.cjs` 把 `DASHBOARD_HOME` 那行改成 `DASHBOARD_HOOK_CLI_ROOT` | 不改 hook 锚块内的判定逻辑(rc=2/3 兜底、放行口原样) | V2 新增用例:代码根有 `.git` 且无发布副本 → 抛错且提示 `release`;有发布副本 → hook 文本含发布副本路径且不含检出路径;代码根无 `.git` → 指向自身。V3 既有 hooksInstall/claimCheck 全部用例仍绿 |
| T3 | `doctor` / `precheck` 加「发布副本新鲜度」一项 | `cli/gitSync.cjs`(doctor)、`cli/precheck.cjs` | 不动其它检查项 | V4 单测:印章 commit ≠ origin/trunk → 文案含「落后」;无副本 → 含「未发布」 |
| T4 | 主工位 post-checkout 提醒钩子(不拦) | `hooksInstall.cjs` 新增 `hooks-self` 子命令,或直接文档化一段脚本 | 不给其它项目装 | V5 手动:主工位 `git checkout -b x` 打印提醒,退出码 0 |
| T5 | 文档:产品手册 §4.4 加「发布副本」概念与路径规则;AGENTS.md/README 的 CLI 路径示例改指发布副本;收官序列加 `cli release` | `docs/产品手册-PRODUCT-MANUAL.md`、`AGENTS.md`、`README.md` | — | V6 grep:三份文档出现 `dashboard-release` 与 `cli release` |
| T6 | 安装包同步:`packaging/build-installer.cjs` 把 `cli/release.cjs` 一并打进去(它拷整个 cli 目录,应已覆盖,核一遍即可);分发版跑 `release` 时友好提示「安装版无需发布」 | `packaging/build-installer.cjs`、`cli/release.cjs` | 不动 NSIS 脚本 | V7 单测:代码根无 `.git` 时 `release` 返回提示、退出码 0 |
| T7 | 本机一次性迁移(**负责人本机操作或授权对话做**):`cli release` → 4 仓 `hooks-install` → `hooks-global` → grep 核对 → 在任一仓真提交一次验闸门 | 机器状态,不入库 | 不改各仓 hook 锚块以外内容 | V8 `grep -rl "dashboard/cli/index.cjs"` 在 4 仓 hooks + 3 仓 settings + 全局 settings 为零;真提交被闸门正确处理 |

**顺序**:T1 → T2 → T3 → T6 → T5 → T4 → T7(T7 必须最后,且在 PR 合并、`release` 从 master 导出之后)。
**可立即施工子集**:T1~T6 全在本分支内完成,不依赖任何未完工卡。
**依赖**:无上游依赖。相关卡:REGISTRY-LIVE-DIVERGED-FROM-REPO(registry 与本卡无耦合,发布副本不含 registry.json——它是数据,继续留在 DASHBOARD_HOME)。
**回滚方式**:hook 路径规则是纯函数,回滚即 revert 本 PR;本机迁移回滚 = 对 4 仓重跑旧版 `hooks-install`。

---

## 拍板记录

- 2026-09-06 已登记待拍板 d1(走哪条治法)、d2(发布怎么触发)到看板,等负责人拍板。
- 2026-09-06 负责人拍板:**d1 走①发布副本,顺带把②的"切分支提醒钩子"当保险装上(只提醒不拦);d2 走 A**。放行开工。
- 施工方:本机没有 Codex CLI(`which codex` 找不到),派单器只存在于 stock-rogue 项目的 TS 脚本里,对本仓不可用 → §17.0 例外①,本对话自干。

## 施工落地记录(阶段④)

| 子任务 | 落地 | 验收 |
|---|---|---|
| T1 | `core/runtimeRoot.cjs`(hook 代码根裁判)+ `cli/release.cjs`(临时索引导出 + 目录换名 + RELEASE.json)+ `index.cjs` 注册 | `test/release.test.cjs` 8 条,含"来源切到功能分支 + 未提交改动,副本仍 = origin/master 且来源仓索引不动"的治本证据 |
| T2 | `hooksInstall.cjs`:路径由 `resolveHookCliRoot` 裁决,写任何文件前先裁,裁不出就拒装;settings 幂等识别兼容旧路径条目(迁移不并存两套) | `test/hooksInstall.test.cjs` 新增 2 条;claimCheck / claimCheckRollout / gitE2e 三处测试改用 `DASHBOARD_HOOK_CLI_ROOT` |
| T3 | `doctor`:本仓 hook 指着副本且副本落后 → 报;`precheck` 第①查加副本状态行 | `test/releaseWiring.test.cjs` 2 条 |
| T4 | `hooks-trunk-guard`:主工位 post-checkout,切离主干只提醒不拦,worktree 内不提醒 | `test/hooksInstall.test.cjs` 1 条(真跑 git checkout / worktree 验 stderr 与退出码) |
| T5 | 产品手册 §4.4 / CLI 表 / §8,AGENTS.md,README | grep `dashboard-release` |
| T6 | `packaging/build-installer.cjs` 无需改:它整拷 `cli/` `core/`,装出来的目录没有 `.git` → hook 指向自身;`release` 在其中友好跳过(有测试) | `release.test.cjs`「代码根不是 git 检出 → 跳过」 |
| T7 | 本机迁移,PR 合并后做(见收官记录) | — |

已知留尾(另立卡):`installClaudeMd` 写进各项目 CLAUDE.md 的示例路径仍是 `~/.claude/dashboard/cli/index.cjs`(对话手动跑的命令),本卡刻意不改——改了会让 4 个项目仓的已提交 CLAUDE.md 出现 diff,撞并行会话;见卡 CLAUDE-MD-ANCHOR-CLI-PATH。
