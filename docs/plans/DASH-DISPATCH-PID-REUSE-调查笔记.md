# DASH-DISPATCH-PID-REUSE 调查笔记

## 症状与基线

卡面原文：「派单器 status/collect 仅凭旧 PID 存活判断任务在跑，PID 被无关进程复用后误报。暂停盘点时 aud-ui-unlanded 的历史 PID 8092 实际属于 Razer 设备服务；不得因此误杀进程。」

现有调用链：`codex-dispatch.ts` 的 `oneLineStatus` 和 `collect` 都调用 `codex-runner.ts` 的 `isAlive(pid)`；后者仅运行 `process.kill(pid, 0)`。`state.json` 已保存监工的 PID、派单时间 `startedAt` 和结束时间 `finishedAt`，但没有身份校验。`process.kill(pid, 0)` 对占用旧 PID 的无关进程也返回成功，于是状态会误报、收单会返回 3。

基线：`node --test test/codexPaths.test.cjs`，`tests 3 / pass 3 / fail 0`。源码搜索 `rg -n 'isAlive' scripts/codex test`，调用仅在 `oneLineStatus`、`collect`。Windows 只读探针 `Get-CimInstance Win32_Process -Filter "ProcessId = $PID"` 已确认可返回 PID、进程创建时刻、命令行和可执行文件路径。

## 假设与实验

- 假设 #1：只以 PID 判存活，进程编号复用后就会误判。预测：给一个活着但命令行不是本工单监工的进程快照，现有逻辑仍报运行。实验：新增只读单元测试，将同 PID、不同命令行和不同创建时刻分别喂给身份判断；实现前测试应失败。
- 结果：证实。新增 `test/codexProcessIdentity.test.cjs` 首跑退出码 1，原文包含 `跑着呢(pid 53412)`，而该 PID 是测试进程，并非本工单监工。加入进程身份探针后同一测试退出码 0，`tests 2 / pass 2 / fail 0`。探针查询为只读，不向目标 PID 发任何信号。

## 施工前复述与微型设计

现在的派单器先启动 Node 监工，再把 PID 与派单时间写进 `state.json`；`status/collect` 只探这个 PID 是否存在。修复将批量只读查询操作系统进程表，核对监工脚本路径、`_supervise` 参数、工单 slug 和创建时刻；新单再带一次性令牌，进一步区分同名重启。已完成状态不再探旧 PID。查不到进程视为退出；系统探针故障则显示“无法确认”，收单暂不误判。只改 `scripts/codex` 中启动与状态判断、对应单测和本笔记；不结束任何进程，不碰调度/验收逻辑。

边界：PID 为空、已结束、编号被异进程复用、同名新进程但启动时刻不同、进程表无法读取、老工单没有令牌、状态列表含多个工单。测试覆盖这些路径；回滚到本分支改动前的主干提交即可。

## 根因三问与验收

1. 以前为什么会错：`isAlive` 只用 `process.kill(pid, 0)` 探编号是否存在，旧监工退出后，复用该编号的无关进程使它返回 `true`；`status` 误报运行，`collect` 因此提前返回 3。
2. 为什么这次会对：`status/collect` 共用只读操作系统进程快照和同一身份判定，同时核监工脚本路径、工单号、进程创建时刻；新单还核一次性命令行令牌。已完成单直接按 `finishedAt` 判，不再看旧 PID。查询失败显式报“无法确认”并暂不收单，避免把不确定性伪装成结果。
3. 为什么不会伤到别处：新探针仅供这两个调用点使用；派单命令只多一个监工忽略的 `--identity` 参数，`supervise` 继续按原 slug 工作。状态文件新增可选字段，旧单按无令牌路径兼容。批量 `status` 只做一次进程表查询，验收/判决/调度代码未变。边界单测覆盖旧单、新单、无关可执行文件、错时刻、探针失败和已完成单。

验收：定向 `node --test test/codexProcessIdentity.test.cjs` 通过，`tests 2 / pass 2 / fail 0`；Codex 相关定向回归 `tests 145 / pass 145 / fail 0`。首次全量票据 `tk-c4e0f607da6667929235` 的 Node 汇总虽为 `tests 992 / pass 992 / fail 0`，外层退出码 1；调度台账本原文是 `"reason":"运行中内容漂移","result":"voided"`。原因是挂号后又补强了参数相邻匹配，修改了 `scripts/codex` 与测试文件，故这次全量结果作废、不计验收。固定文件后须重新挂号。类型检查、构建与 CI 结论待收官时补记。

第二次全量票据 `tk-2fb1ba336a224774577a` 的 Node 汇总是 `tests 992 / pass 991 / fail 1`；失败断言原文开头是 `不允许白名单以外的盘符路径`，定位 `test/codexProcessIdentity.test.cjs:48`。完整输出保存在本工位被忽略的 `.codex/logs/pid-reuse-full-test.log`。这是新增单测夹具的路径文本触发公开仓路径形状闸，非 PID 行为断言失败；已改用不含盘符的合成进程名，再跑定向与全量。尝试对该票据 `cancel` 时客户端回 `单子已不在排队中`，随后只读 `status` 确认状态 `failed`、原因为 `命令退出码:1`，无需另行强杀或撤单。

最终验收（固定代码后的提交 `0e63e7e`）：`npm test` 通过，原始结尾 `tests 992 / pass 992 / fail 0 / skipped 0`，调度单 `tk-754e75e60ec47f3bb99f` 状态 `passed`；`npm run typecheck` 退出码 0，调度单 `tk-b2c5f7adee9a0fbf9d17` 为 `passed`；`npm run build` 退出码 0，原始结尾 `built in 7.32s`，调度单 `tk-468496dae7454a260dc3` 为 `passed`。新增脚本另用本仓已安装的 TypeScript 直接执行 `tsc --noEmit`，退出码 0。构建、类型检查和最终全量日志中没有 warning/error/FAILED 行；前两次未通过票据的原因已分别记录，未计入最终验收。
