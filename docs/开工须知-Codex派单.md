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
npx tsx scripts/codex/codex-dispatch.ts say my-task "补一句"        # 续聊（默认只读；要它改代码加 --sandbox workspace-write）
npx tsx scripts/codex/codex-dispatch.ts end my-task                 # 收工：摘依赖链接、删隔离工作区
```

也有短命令：`npm run codex:dispatch -- --task <工单>` / `codex:status` / `codex:collect -- <slug>`。
**派单器命令一律在主工位（仓库根）跑**，在 `.codex/worktrees/<slug>` 里跑会找错工单目录。

## 2. 本仓库与 来源仓 那份的差别

| 差别 | 本仓库 |
|---|---|
| 单测 | `node --test`，文件在 `test/*.test.cjs`；作业名 `test:targeted`（定向）/ `test:all`（全量） |
| 前端 | 在 `web/` 子目录：`web:typecheck`（vue-tsc）/ `web:build`（vite）/ `web:no-emoji`（禁 emoji 扫描） |
| 依赖位置 | 前端依赖在 `web/node_modules`，根目录只有派单器自己的 `tsx`；派单器建 worktree 时**两处都链**（目录联接），`end` 时只摘链接 |
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
