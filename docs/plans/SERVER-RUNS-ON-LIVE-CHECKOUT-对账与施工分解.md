# SERVER-RUNS-ON-LIVE-CHECKOUT · 对账与施工分解

> 卡号:SERVER-RUNS-ON-LIVE-CHECKOUT · 项目:dashboard · 分支:`fix/server-runs-on-live-checkout`
> 阶段:①对账 ②建议 ③分解 已完成,**等负责人拍板后再进阶段④(动代码)**。
> 写于 2026-09-06。本文是阶段①②③的产出正本,拍板结论回写在文末「拍板记录」。
> 前置卡 HOOK-CLI-POINTS-AT-LIVE-CHECKOUT 已完工(PR#9,走治法①发布副本),本卡的依赖已解除。

---

## 一句话说清

看板网页服务(浏览器里那个 6060 的界面)是从 `~/.claude/dashboard` ——**正在被各个对话编辑的那份代码**——直接起的,和提交闸门原来是同一个毛病。

但它比闸门更糟一层:闸门是"每次提交现起一个进程,所以永远跑最新的那份(哪怕那份是改坏的)";**服务是长驻进程,启动那一刻的代码会一直跑到有人重启为止**。所以它同时得了两种病——**跟着别人改的代码漂**,和**合了 master 也一直不生效**。

现场就是活样本:此刻在跑的服务启动于今天 00:10,那之后运行期代码合进 master 的提交有 **20 个**(其中 5 个直接改 `server/`);而它端给浏览器的网页界面,是今天 **18:00** 才重新构建的新产物。**负责人现在看到的看板 = 新前端 + 19 小时前的旧后端**,页面上没有任何地方告诉他这件事。

---

## ① 对账(设计 ↔ 代码现状,逐条核过)

### 1. 病根链(症状 → 直接病因 → 更深病因 → 最深根)

| 层 | 事实 | 出处 |
|---|---|---|
| 症状 | 合进 master 的服务端修复,在看板界面上不生效;主工位切分支 / 留未提交改动,会被"下一次重启"整个吃进去 | 本卡卡面 + 下面第 2 节实测 |
| 直接病因 | 启动器先 `cd /d "%~dp0"`(= 看板仓主工位),再在主工位 `npm run build` 写 `web/dist`,最后 `node server\server.cjs` 起**主工位那份**服务 | `启动看板.bat` 第 7 / 47 / 76 行;`dashboard.sh` 同构;`package.json` 的 `serve`/`start` 也是 `node server/server.cjs` |
| 更深病因 | `server/server.cjs` 的 `DASH_ROOT = path.resolve(__dirname, '..')`,即"代码根 = server.cjs 此刻躺在哪";**没有任何机制保证它躺在一份不会被人改的目录里**,`DIST_DIR` / `CLI_INDEX`(写板通道)全都跟着它走 | `server/server.cjs:46-48` |
| 最深根 | HOOK 卡只把 **hook 那一条消费链**切到了发布副本。`RUNTIME_PATHS` 白名单虽然已经含 `server`,但**没有任何入口从副本起服务**;"网页服务 + 前端产物"这条链还留在旧世界,而且 `web/dist` 被 `.gitignore` 挡在发布副本之外 | `core/runtimeRoot.cjs:24` 的注释自己写着"web/dist 被 .gitignore,归 SERVER-RUNS-ON-LIVE-CHECKOUT 卡另议" |

### 2. 现场证据(实测,不是推演)

- 在跑的服务:**PID 51772**,命令行 `node server\server.cjs`,监听 `127.0.0.1:6060`,启动于 **2026-09-06 00:10:24**(`/api/health` 报 `uptimeMs≈7.08e7`,19.7 小时)。
- 自它启动以来,master 上**动过运行期代码(`server/ core/ cli/ package.json`)的提交共 20 个**,其中直接改 `server/` 的 5 个:
  `5a4b85b`(18:04 费用按登记目录清单算账)、`8afad87`(17:47 Codex 面板改认 codeRepo)、`66458f2`(03:26 派单落脚点)、`ff66c86`(05:06 额度分档文案)、`b8fd301`(00:29 审阅台可用性七条)。**这五笔修复此刻一笔都没在跑。**
- 与此同时,主工位 `web/dist` 于今天 **17:56 / 18:00** 被重新构建过(`index.html` 17:56,`assets/` 18:00)。服务是**文件级**托管 dist、且 HTML 是 `no-store`,新产物**立刻**对浏览器生效,不需要重启 → **前端 18:00 版 + 后端 00:10 版**,同一个看板里两个版本在对话。
- 发布副本 `~/.claude/dashboard-release` 里**根本没有 `web/`**(`RELEASE.json` 的 `paths` = `core cli server package.json`),所以今天就算有人想从副本起服务,也起不出界面——只会看到"前端还没构建"的占位页。
- `web/dist` 命中 `.gitignore` 的 `dist/`。`cli release` 是**从 origin/master 的树导出**的(`git ls-tree` + `checkout-index`),天然导不到构建产物。**这是本卡唯一的真障碍,也是唯一需要负责人拍板的地方。**

### 3. 波及面盘点(所有起服务的入口)

| 入口 | 现状 | 本卡是否要改 |
|---|---|---|
| `启动看板.bat`(负责人日常双击的那个) | cd 主工位 → 主工位 `npm run build` → 起主工位服务 | ✔ 要改 |
| `dashboard.sh`(mac/linux) | 同上 | ✔ 要改 |
| `package.json` 的 `serve` / `start` | `node server/server.cjs` | ✔ 要改口径(改成"开发实例",见分解 T4) |
| `kanban-launcher.exe`(仓库根)/ `packaging/tray/Dashboard.cs` | 托盘启动器起的是 `<自己所在目录>/node-runtime/node.exe <自己所在目录>/server/server.cjs`。仓库根**没有** `node-runtime/`,所以这个 exe 在主工位双击是跑不起来的(不是"跑了旧代码",是直接失败);装机版目录里才成立 | ✔ 只需核一眼 + 文档说明(T4) |
| 分发安装版(`packaging/build-installer.cjs`) | 布局**已经**是"无 `.git` 的运行目录 + 自带 dist" | ✘ 不改。本卡要做的正是让本机版长成它那样 |

### 4. 先划清:数据根不受影响

`DASHBOARD_HOME`(数据根:`registry.json` / `snapshots/`)与代码根**互不推导**,这是 `core/resolveProject.cjs` 头注写死的约定。服务搬去发布副本之后,**看板数据仍然从 `~/.claude/dashboard` 读、仍然由 CLI 写**,负责人看到的内容一条都不会变。本卡搬的只有"程序本体 + 网页产物"。

唯一要盯的连带:`server.cjs` 的写板通道 `CLI_INDEX = DASH_ROOT/cli/index.cjs`。服务搬到副本后,它会自动变成**副本的 CLI**——这正是我们要的(界面上点"拍板"走的也不再是别人改到一半的代码),但要在验收里显式核一遍。

### 5. 已知硬约束(动手前必须知道,已实测)

1. **Windows 上,目录只要是某个进程的当前工作目录(cwd),就换不了名。** 实测:进程 cwd 在 `dir/` 时 `fs.renameSync(dir, dir2)` 抛 `EBUSY`。而 `cli release` 的收尾动作恰恰是"把 dest 换名成 `.old`、再把 `.new` 换成 dest"。**结论:从副本起服务时,服务进程的 cwd 绝不能落在副本目录里**(启动器要显式指定 cwd,别用 `cd /d` 那一套),否则下一次 `cli release` 必然失败并被迫回滚。
2. **服务的 `require` 全在文件顶部**(只有 `child_process` 是懒加载,且是内置模块)。好处:发布换名不会让在跑的老服务半路读到半新半旧的文件;代价:**不重启就永远是老代码**——这正是今天 20 个提交没生效的机制原因。
3. **前端 dist 是文件级托管,不需要重启就生效**,和后端"必须重启才生效"两套节奏对不齐——这是"前端新后端旧"的机制原因,治理时必须把两者绑成同一份、同一次发布。

### 6. 现有可复用的零件

- `cli/release.cjs` 的 `release()` / `releaseStatus()` / `detectTrunk()`:导出机制、印章、`.new`→换名、落后几个提交的算法全都现成,本卡是**往里加一类内容**,不是另起炉灶。
- `core/runtimeRoot.cjs`:`RUNTIME_PATHS` 白名单、`isGitCheckout()`、`readStamp()`。
- `packaging/build-installer.cjs`:已经证明"代码目录 = 运行目录 = 自带 dist、无 `.git`"这种布局跑得通。
- `server.cjs` 的单实例探活 `probeHealth()` / `findExistingInstance()`:改"旧实例版本不对就重启"时直接在这上面接。

### 7. 冲突分类

- **A 类(架构选择,要拍板)**:
  - **d1**:前端产物(`web/dist`)用什么方式进发布副本(它被 `.gitignore` 挡着)。
  - **d2**:双击启动器时,发现已经在跑一个**旧版本**服务,该怎么处置。
- **B 类(能力缺失,不用拍,随本卡做掉)**:`/api/health` 不报"我这份代码从哪来、是哪个 commit" → 负责人、体检、启动器三方都无从判断在跑的是不是最新;`doctor` / `precheck` 目前只体检 hook 那条链,不体检服务。
- **C 类(数值口径)**:无。

---

## ② 建议(只建议,拍板权在负责人)

### d1 · 前端界面怎么进发布副本

| 选项 | 好处 | 代价 |
|---|---|---|
| **A(推荐)发布时现场构建**:`cli release` 把 `web/` 源码也从 `origin/master` 导出到临时目录,在那儿 `npm run build`(复用主工位已装好的 `web/node_modules`),把产物放进副本 | 副本的前端和后端**严格来自同一个 commit**,与"主工位工作区此刻是什么样"彻底无关——真正治本;仓库里不多一坨构建产物 | 发布从"秒完成"变成"几十秒";发布机器上必须有 `web/node_modules`(本机已有),没有就得先 `npm ci`;发布命令要处理构建失败(必须整单失败,绝不能发一半) |
| **B 直接拷主工位现成的 `web/dist`** | 改动最小,发布仍是秒完成 | **前端这一半根本没治**:拷过去的是"谁最后在主工位 build 的那份",可能来自任意分支或未提交改动。等于把病灶搬了个位置,还更隐蔽(印章会声称这份副本 = 某个 commit,其实前端不是) |
| **C 把 `web/dist` 取消 gitignore、提交进仓** | 副本严格等于 commit,发布仍是秒完成;离线机器也能发 | 每次前端改动,diff 里都带一坨压缩过的构建产物;两条分支同时改前端必然产生**无法人工解决的合并冲突**;仓库体积持续膨胀。业界普遍不这么干 |

**倾向 A,理由**:本卡的全部意义就是"跑的那份不许跟着人正在改的东西漂"。B 把后端治好了却把前端原样留在病里,而负责人**每天真正看的就是前端**;C 的代价会天天扎人(前端一改就冲突),而 A 的代价只在"发布"这一个动作上多等几十秒——发布是收官序列里的一步,一天跑不了几次。

### d2 · 双击启动器时,已在跑的旧版本服务怎么办

| 选项 | 好处 | 代价 |
|---|---|---|
| **A(推荐)自动重启**:探到在跑的实例、比对它的代码版本,不是最新就关掉旧的、用新副本重起,再开浏览器 | "双击启动器"本来就是"我要用看板"的意思,自动给最新的最符合直觉;负责人**永远不需要知道"服务要重启才生效"这件事** | 正在看页面的人会断一两秒(SSE 自动重连);要给一个"别重启,复用就行"的开关兜底 |
| **B 只提示不动手**:界面顶部横幅 + 控制台明示"在跑的是 X 版、发布副本已是 Y 版,请重启",由人决定 | 绝不打断任何人;实现最简单 | 又多一条"要靠人记得"的纪律——本 skill 反复记录的教训是这类纪律必失守;而且横幅只有打开界面的人看得到 |
| **C 维持现状**:探到就复用旧实例,不比版本、不提示 | 零改动 | 就是今天的病:合了 master 一直不生效,谁也不知道 |

**倾向 A,理由**:这张卡的病根一半在"服务不重启就不生效",光把代码搬进副本只治了"跟着别人漂",没治"合了不生效"。B 把最后一公里丢回给人。A 配一个 `--no-restart` 开关(以及"有人正在用就先问一句"的可能),代价可控。

### 不用拍板、随卡做掉的配套

- **开发实例**:改 `server` 代码的人当然要能看自己的效果。`npm run serve` 保留成"起本检出的开发实例",但**换个端口起(6070 起)**、`/api/health` 里标 `mode:"dev"`、控制台横幅写明"这是开发实例,不是负责人在用的那份"。
- **/api/health 报家门**:加 `codeRoot`(代码从哪来)、`releaseCommit` + `releasedAt`(印章)、`mode`(release/dev/installed)。这是后面所有体检、启动器比对、界面横幅的共同地基。
- **体检接上**:`doctor` / `precheck` 除了体检 hook 那条链,顺带报"在跑的服务是哪份代码、落后几个提交"。

---

## ③ 施工分解(拍板后才动手;每项都可独立验收)

> 以下按 **d1=A、d2=A** 写。若拍板结论不同,T1/T2 的内容随之调整,T3/T4 不变。

### T1 · 发布副本纳入前端产物
- **范围**:`cli/release.cjs`、`core/runtimeRoot.cjs`(白名单/印章字段)。
- **做什么**:导出 `origin/<主干>` 的运行期文件之后,再把该 commit 的 `web/` 源码导到临时目录、以主工位的 `web/node_modules` 为依赖跑一次生产构建,产物落进 `<副本>.new/web/dist`;印章里记 `webBuiltFrom`(同一个 sha)与构建耗时。构建失败 = **整单失败**,副本保持原样(绝不能发出一份"后端新、前端旧"的副本)。加 `--skip-web` 只在明确要跳过时用(例如纯 CLI 修复的紧急发布),用了就在印章里记下来。
- **禁区**:不碰主工位工作区(既不 `npm install`,也不往主工位 `web/dist` 写东西);不碰 hook 那条链的现有行为。
- **验收断言**:①`cli release` 后,副本里有 `web/dist/index.html`,且其引用的 assets 文件都在;②印章 `commit` 与 `webBuiltFrom` 一致;③故意把 `web/` 源码改坏(在临时导出的那份里)→ 发布整单失败且旧副本原封不动;④主工位切到别的分支 / 留未提交改动时发布,产物与那些改动无关(比对两次发布的 dist 指纹一致)。

### T2 · 启动器改从发布副本起服务
- **范围**:`启动看板.bat`、`dashboard.sh`。
- **做什么**:①不再在主工位 `npm run build`;②先确保发布副本是最新(副本不存在或落后 → 跑一次 `cli release`,失败就停下报错,不许"凑合用旧的");③`node <副本>/server/server.cjs` 起服务,**cwd 显式设在副本之外**(第 5 节硬约束 1);④首次使用要装 `web/node_modules` 的逻辑跟着挪到"发布前"这一步。
- **禁区**:不改 `server.cjs` 的端口/单实例/托管逻辑(那是 T3)。
- **验收断言**:①双击启动器后,`/api/health` 报的 `codeRoot` 是副本路径;②启动后立刻在主工位改 `server/server.cjs` 并不重启 → 服务行为不变(证明已解耦);③`cli release` 在服务运行期间可以成功执行(证明 cwd 没锁住副本,硬约束 1 已避开);④副本发布失败时启动器停下并说人话,不会退回主工位起服务。

### T3 · 服务报家门 + 旧版本自动重启
- **范围**:`server/server.cjs`。
- **做什么**:①`/api/health` 增 `codeRoot` / `releaseCommit` / `releasedAt` / `mode`;②单实例探活时比对"在跑的实例的 `releaseCommit`"与"副本印章的 commit",不一致就按 d2 结论处置(A:优雅关旧起新,`--no-restart` 可关);③控制台横幅打印代码根与版本。
- **禁区**:不动写板通道(仍只经 CLI)、不动 SSE / 端口区间 / 路径安全那几条铁律。
- **验收断言**:①`/api/health` 四个新字段齐全且与印章一致;②在跑旧版本时再次启动 → 旧进程退出、新进程接管、端口不变、浏览器能开;③`DASHBOARD_NO_OPEN=1` 等既有环境变量行为不变;④单测覆盖"版本比对"的三种结果(一致 / 不一致 / 印章缺失)。

### T4 · 开发实例、体检与文档
- **范围**:`package.json`(scripts)、`cli/gitSync.cjs`(doctor)、`cli/precheck.cjs`、`docs/看板使用手册.md`、`docs/产品手册-PRODUCT-MANUAL.md`、`AGENTS.md` 收官序列一行、`packaging/tray/Dashboard.cs`(核一眼起的是哪条命令)。
- **做什么**:开发实例换端口 + 标 `mode:dev`;`doctor`/`precheck` 报"在跑的服务是哪份代码、落后几个提交";手册把"启动 = 发布 + 起副本"讲成人话;收官序列里"合完跑 `cli release`"补一句"服务会在下次启动时自动换新"。
- **验收断言**:①`npm run serve` 起在 6070 且 health 报 `mode:dev`;②`precheck --project dashboard` 输出里有一行服务状态;③手册里没有残留"先去 web 目录 npm run build"这类旧口径。

### 施工方与顺序
- 顺序:T1 → T2 → T3 → T4(T1 是地基;T2 与 T3 都依赖 T1 的印章字段)。
- 施工方按 §17.0 在开工时判定并留痕。本项目 `AGENTS.md` 没写"施工默认派 Codex",契约(本文③)已够细,可派可自干,派单时以本文各任务的"验收断言"为契约。
- **全程禁区**:`.dashboard/board.json`(只经 CLI 写)、`registry.json`、hook 那条链的既有行为、`web/` 的业务源码(本卡不碰界面功能)。

---

## 拍板记录(2026-09-06 负责人当场拍板,看板卡 decisions 已同步)

- **d1(前端产物怎么进副本)= A 发布时现场构建**:`cli release` 把同一个 commit 的前端源码导到临时目录建一次,产物进副本。
- **d2(旧版本服务怎么处置)= A 自动重启**:比对版本,不是最新就关掉旧的、用新的接管同一端口(`DASHBOARD_NO_RESTART=1` 可关)。
- 同时放行进阶段④,一口气做到收官。

---

## 施工记录与验收证据(阶段④,同日完成)

**施工方**:本方自干(本项目 `AGENTS.md` / 开工须知没有"施工默认派 Codex"的硬默认,§17.0 判定不适用)。

| 任务 | 提交 | 落地要点 |
|---|---|---|
| T1 副本带界面 | `1e23b89` | `buildWebDist()`:导出树带 `core/`(vite.config 要 `require('../core/boardSchema.cjs')`)、依赖软链借主工位那份、收尾只摘链;两道机器闸(build 脚本漂了 / 依赖没装)当场失败指路;`--skip-web` / `--print-dest`;印章记 `web.builtFrom` |
| T3 服务报家门 + 自动换新 | `be03d55` | health 增 `mode/codeRoot/releaseCommit/releasedAt`;启动比对身份,不同就关旧接管同端口;端口段 release `6060~6068` / dev `6070~6078` **不重叠**(重叠会误杀开发实例) |
| T2 启动器 + T4 体检与文档 | `fb07363` | 两个启动器改成"备依赖 → 发布 → 从副本起服务",落脚点不进副本;`serviceStatus()` 接进 `precheck`;手册/产品手册/AGENTS.md/package.json 跟着改口径 |

**测试**:新增 `releaseWeb`(6 条)、`serverRuntimeIdentity`(6 条)、`launchers`(5 条),都先在改前跑红再转绿
(releaseWeb 6 红→绿、serverRuntimeIdentity 5 红 1 绿→全绿、launchers 4 红→绿)。合并 `origin/master` 后全量 `node --test`:
**276 pass / 0 fail,退出码 0**。

**真机端到端**(不只是单测):
1. 真跑 `cli release`(真 vite 构建)→ 副本里 43 个运行期文件 + 50 个界面文件,耗时 6.3s,印章 `web.builtFrom` = 同一个 commit;
2. 从副本起服务 → `/api/health` 报 `mode:release`、`codeRoot` 指副本、`releaseCommit` 对得上;浏览器拿到的 `index.html` 就是副本里那份;
   `registry` 仍指 `~/.claude/dashboard`(数据根没被搬走,符合第 ④ 节);
3. **服务运行期间再发布一次 → 成功**(证明落脚点纪律避开了 Windows 的 `EBUSY`);
4. 换个 commit 再发布后启动 → 控制台明写"在跑的是 ac4cc6…、这一份是 fb0736…",关掉旧 pid、**新实例接管同一个端口 6155**。

**收官迁移时踩到并已治的一个坑(0906 当天)**:合进 master 后在**落后的主工位**跑 `node cli/index.cjs release`,
跑的是那份**旧的发布工具** —— 副本里的代码是新的、界面却没建出来(旧工具不认识这一步)。
治法两条已落地:①`precheck` / `releaseStatus` 会报「副本里没有网页界面」;②启动器改成**优先用副本自己的 CLI**
(`node <副本>/cli/index.cjs release --source <本检出>`),副本不存在时才用本检出的引导一次。
手工发布时同理:用副本的 CLI,别用落后主工位的。

**已知边界(如实记)**:
- 发布多花几十秒(本机实测 6s 左右),且要求发布机装了前端依赖——启动器第一次会替用户装;
- 已在跑的服务不会自己换新,要等下次启动(这正是 d2=A 处理的那一步);
- 分发安装版的托盘启动器(`packaging/tray/Dashboard.cs`)按安装目录布局起服务,本卡不动它;
  仓库根那个 `kanban-launcher.exe` 缺 `node-runtime/` 本来就跑不起来,不是"跑了旧代码"。

---

## 顺带登记的圈外发现(§11.6,已另立卡,不在本卡范围)

`packaging/build-installer.cjs:123` 只拷 `server/server.cjs` 一个文件,而 `server/` 现在有 13 个模块(`codexApi.cjs` / `readerApi.cjs` / `parallelPlan.cjs` 等),且 `server.cjs` 顶部就 `require` 它们。实测 `packaging/staging/root/server/` 里确实只有 `server.cjs` → **现在打出来的社区安装版,一启动就会因找不到模块而崩**。已另立卡登记,不在本卡 fileScope 内。
