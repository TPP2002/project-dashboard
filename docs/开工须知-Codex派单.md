# 开工须知 · Codex 派单（把活派给 GPT 干，看板这边自己验收）

> 状态：正本 · 关联卡 AD-20260907-CODEX-DISPATCH-PORT · 2026-09-07 负责人拍板：**本仓库施工默认派 Codex（模型 gpt-6-astra，思考档 max，即本机 `~/.codex/config.toml` 的默认）**，本方只做设计、定契约、派单、亲自重跑验收、收官销卡。
> 方法论正本在 skill `project-build-workflow` 的 `references/跨模型派单-Codex.md`（§17），本文只写**本仓库的差异与命令**，不复制正文。

## 1. 三条命令

```bash
npx tsx scripts/codex/codex-dispatch.ts kinds                       # 看可用的验收作业名（点菜制）
npx tsx scripts/codex/codex-dispatch.ts template --slug my-task > .codex/jobs/my-task.json
npx tsx scripts/codex/codex-dispatch.ts dispatch --task .codex/jobs/my-task.json   # 派单，立刻返回
npx tsx scripts/codex/codex-dispatch.ts status                      # 看谁在跑、谁待收
npx tsx scripts/codex/codex-dispatch.ts collect my-task             # 收结论：派单器自己重跑验收后才出判决
npx tsx scripts/codex/codex-dispatch.ts say my-task "补一句" --sandbox workspace-write   # 续聊（默认只读；要它改代码加 --sandbox workspace-write；多行消息用 --message-file 文件；回话里带结论 JSON 就会刷新自述，见第 6 节第 9 条）
npx tsx scripts/codex/codex-dispatch.ts end my-task                 # 收工：摘依赖链接、删隔离工作区
```

也有短命令：`npm run codex:dispatch -- --task <工单>` / `codex:status` / `codex:collect -- <slug>`。
**派单器命令一律在主工位（仓库根）跑**，在 `.codex-worktrees/<slug>`（隔离工作区）里跑会找错工单目录。

## 2. 本仓库与 来源仓 那份的差别

| 差别 | 本仓库 |
|---|---|
| 单测 | `node --test`，文件在 `test/*.test.cjs`；作业名 `test:targeted`（定向）/ `test:all`（全量） |
| 前端 | 在 `web/` 子目录：`web:typecheck`（vue-tsc）/ `web:build`（vite）/ `web:no-emoji`（禁 emoji 扫描） |
| 依赖位置 | 前端依赖在 `web/node_modules`，根目录只有派单器自己的 `tsx`；派单器建 worktree 时**两处都链**（目录联接），`end` 时只摘链接 |
| 工作区位置 | 隔离工作区在 `<仓库根>/.codex-worktrees/<slug>`（**不在 `.codex` 底下**，理由见第 6 节第 13 条）；工单台账仍在 `.codex/jobs/<slug>` |
| 开工必读 | `AGENTS.md` + 本文第 3 节（本仓库没有开工须知/口径速查表） |
| 看板登记 | 由派单方（Claude）代做：claim / progress / done 都在主工位跑；Codex 不跑看板 CLI |

## 3. 派出去的每一单都要守的红线（会渲染进指令）

- 反阉割：不许为了跑通砍功能、简化设计；拿不准的停下写进 `openQuestions`，不自己拍板。
- 界面一律不用 emoji（`web/scripts/check-no-emoji.cjs` 会拦）；图标只用 `web/src/icons` 现有精灵，要新图标必须上报（新图标走 `docs/mockups/图标体系-mockup-v3-定稿.html` + `web/scripts/sync-icons.cjs`）。
- 颜色字面量只进 `web/src/styles/base.css` 的令牌与色站，组件里不出现颜色字面量。
- 本地设置走 localStorage，读回时逐字段校验，脏数据丢弃回默认；一切动效尊重 `prefers-reduced-motion`。
- 不做任何 git 写操作；不改 `.codex/jobs/**`；结论必须是结构化 JSON，`summary` 写给不懂代码的负责人看。

## 4. 工单怎么写

字段口径与 来源仓 完全一致（`taskId` 填看板卡号、`slug` 小写连字符、`goal` 大白话、`allowedPaths` 施工面、`forbiddenPaths` 禁区、`nonGoals` 反阉割边界、`acceptance` 只能点第 2 节的作业名、`expectArtifacts` 完工必在的文件、`sandbox` 只许 read-only / workspace-write、改代码的单一律 `worktree: true`）。

**契约要写它"应该知道"但不知道的事**（§17.5）：性能约束、可测性要求、已知坑、还有本仓库的这几条——
看板界面所有可配置项的样式写法（`data-*` 属性映射 + 内联 CSS 变量覆盖）、`applySpectrum` 那套"删掉内联变量即回落默认"的机制、`Icon` 组件用法、`StatusTile` 的动效降级三规则（`utils/iconMotion.ts`）。

## 5. 判决与落地

`accepted / blocked / rejected / crashed` 四种，含义同 来源仓 第 2 节。收单后固定走 §17.11：自审 diff（有没有悄悄降级设计）→ 精确 add → commit（说明写卡号 + 工单 slug + 验收结果）→ 合最新主干 → 在合并结果上重跑验收 → push / PR / 四闸门 → 看板 `done` + `note`（写明「施工方=Codex(工单 slug)」）→ `end` 删工作区。

## 6. 已知坑（本仓库专属，其余见 来源仓 那份第 5 节）

1. 根目录原本没有 `node_modules`，第一次用前要在仓库根 `npm install --no-audit --no-fund` 把 `tsx` 装上；否则 `npx tsx` 会临时下载、慢且不稳。
2. 隔离工作区里 `web/node_modules` 是联接，Codex 的沙箱写不进去 → `vue-tsc` / `vite` 它自己跑不动，指令里已明写"不要自己跑验收"。
3. `CLAUDE.md` 在本仓库是 gitignore 的（含本机绝对路径），worktree 里没有；所以指令只指路 `AGENTS.md`。
4. 派单器自己的单测（来源仓 有 40 条 vitest）**没有随同移植**——本仓库用 `node --test`，移植测试是另一张卡；这次的验收是一单只读探活单真派真收。
5. **续聊（say）的两个坑**：①消息里不能带换行——Windows 下 `npx` 的 cmd 垫片会把参数在第一个换行处截断，多行消息一律写进文件用 `--message-file`；②续聊在**这单自己的工作区**里跑（`meta.json` 的 cwd），`--worktree` 派出去的单才能在续聊里改文件，在主工位里 resume 会被 Codex 沙箱以「项目外目录」拒写（2026-09-08 已修）。

6. **禁区 glob 不能盖住施工面**（0908 wf-bottom 实踩）：`forbiddenPaths` 写了 `web/src/components/Appearance*.vue`，而 `allowedPaths` 里显式列了 `AppearanceWorkfloor.vue`——判决按「碰禁区」直接 rejected，哪怕机器验收全绿。禁区用具体文件名列，别用能盖住施工面的通配。
7. **契约漏写一个文件 = 整单停工**（0908 aud-ui-unlanded 实踩）：虚拟模块的类型声明在 `web/env.d.ts`，契约只允许 `web/src/**/*.d.ts`，Codex 按零决策停工重派。写契约前把「要改的每个文件」用 grep 核一遍真实位置。
8. **新测试文件三条硬约束**（0908 三单各踩一次）：① 夹具里不能出现字面量本机盘符路径（`test/noLocalIdentifiers.test.cjs` 扫全部被跟踪文件，夹具里的绝对路径只许用白名单占位形态 `C:/path/to/x`，或把盘符与其余部分拼接（如 `'C' + ':/x'`））；② 读全局设置的测试要用 `DASHBOARD_GLOBAL_SETTINGS` 指到临时文件（本机 `~/.claude/settings.json` 装着全局钩子，会改变 hooksInstall 的行为）；③ 派单器 collect 时新文件还是未跟踪状态、卫生扫描不看它，落地 commit 后才会红——收单后先本地跑一次 `npm test` 再合主干。
9. **续聊后要让它把结论重发一遍**（0908 wf-zoom / aud-hooks-dedup 实踩，AD-20260908-CODEX-SAY-REPORT 已治本）：`collect` 判卷读的是 `last-message.json`，而 `resume` 不接 `--output-schema`，新结论只落在 stdout。现在 `say` 会在回话里认一份**符合结论格式的 JSON**：认到就覆盖 `last-message.json` 并在 `state.json` 记下 `resumedAt` / `selfReportUpdatedAt`，`collect` 自然按最新的判、并印一行「自述来源：续聊后刷新过」；认不到就一个字都不改（宁可用旧自述，也不拿散文把结论文件糊掉），`say` 当场打一行 ⚠，`collect` 也会警告「这份自述是续聊之前的」。所以**让它补做完之后，记得再 say 一句「把最终结论按 output schema 原样输出成一个 JSON 对象，不要别的话」**，再 `collect`。
10. **派单器命令必须在仓库根跑**这一条会被对话的 cwd 悄悄破坏：一次 `cd` 进 worktree 后，后续所有命令的 cwd 都留在那里，`say` 会报「找不到会话号」、`dispatch` 会报「工单文件不存在」。每条派单器命令前显式 `cd /f/project-dashboard`。
11. **一张卡多单并行的落地顺序**：同一批派出去的单先落地改动小、改文件少的；两单都碰同一文件（如 `server/server.cjs`）时，后落地的那单在自己的工作区 `git merge origin/master` 后必须重跑全部验收再 push——派单器只在 collect 时跑过一次，不知道主干又动了。
12. **被裸 tsx 子进程导入的模块，契约里别让它引 Vite 虚拟模块或 `@/api/schema`**：test/ageLevel.test.cjs 这类单测用 `node --import tsx` 直接导入 web/src/utils 下的纯模块，没有路径别名也没有虚拟模块加载器；schema.ts 牵着 `virtual:board-schema`，一引就 ERR_UNSUPPORTED_ESM_URL_SCHEME（aud-kanban-flow-build 开工 4 分钟即因此停工）。写契约时先 `grep -l "web/src/utils" test/*.cjs` 看哪些模块被裸导入，这些模块只许做形状校验，状态名之类的枚举校验放到组件里。
13. **隔离工作区不许建在 `.codex` 底下**（0908 aud-notify-fresh 实踩，治本卡 AD-20260908-CODEX-WORKTREE-ROOT）：Codex 沙箱把「工作目录里的 `.codex`」当自己的配置目录，启动时给沙箱用户在这个目录上加一条**拒写的显式 ACE，而且向下继承**。工作区原本建在 `.codex/worktrees/<slug>`，并行派出去的第二单一起来，第一单就在**自己的工作区里**写不进文件——现象是「说好的三个测试文件一个都没落盘」，看着像 Codex 偷懒，其实是被自己锁住。现在工作区根是 `<仓库根>/.codex-worktrees/`（不进 git）；工单台账 `.codex/jobs/` 没动，那是派单器（管理员身份）在写，不受沙箱 ACE 影响。改根之前留下的老工作区，`end` 还认得出来，照常收。要临时止血旧环境：用 PowerShell 去掉 `.codex` 上的显式 Deny 规则。
14. **契约里限定「只动某一段」时，先核那一段之前有没有写路径**（0911 branch-cleanup-tiers 实踩）：工单让新参数 `--tier` 只在 doctor 的 `--branches` 段里解析，同时要求「档位瞎写时板一个字节不变」；而 doctor 在那一段之前就会因为「缺提交 + --fix」先备份、写板——两条要求同时满足不了，Codex 开工即停下提问，白跑一轮。写契约时把「校验必须在第一次写之前」的那个位置一起圈进施工面。
15. **续聊（say）是同步的，要当后台进程拉起**（0911 实测）：`say` 内部用 spawnSync 等 Codex 这一轮干完才返回，补做一整轮施工常要十几分钟以上，放在对话工具前台会撞超时，工具一杀就连带杀掉续聊。用 PowerShell `Start-Process`（或其它脱离父进程的方式）直接起 `node --import tsx scripts/codex/codex-dispatch.ts say <slug> --message-file <文件> --sandbox workspace-write`，stdout / stderr 重定向到文件、记下 pid，轮询 pid 退出后再读输出。另外 `collect` 只认派单时那个监工进程的 pid，看不见续聊进程——续聊没结束就 `collect`，会变成它一边改文件、派单器一边跑验收，判卷作废。
