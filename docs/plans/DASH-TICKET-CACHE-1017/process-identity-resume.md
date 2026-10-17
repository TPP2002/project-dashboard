# 进程身份探针续接交接

基于 `11dad5d9c9e60c79ba02b300b5ada92712fb768b`，仅修改正式圈外授权的 `codex-process.ts`、`codex-dispatch.ts`、`codexProcessIdentity.test.cjs`，另新增本说明。既有缓存、服务器、生命周期 fixture、原 land 记录和比较证据未修改；没有 Git 写操作。

## 本次实现

- inspectProcesses 接收预期启动时刻提示数组。status 保留每张未完成且未判读工单的提示，collect 传入已读取的 state；同一 PID 多单不以 Map 覆盖。
- Windows 仍只有一次原参数的 PowerShell 子进程（5000ms）。内部仅对有提示且全部能解析成有效时刻的 PID，通过 CLR Process.StartTime 读取真实创建时刻；每个 Process 均在 finally Dispose。
- 只有所有提示与真实创建时刻的差值都严格大于原 10000ms 容差，才返回真实时间及 null commandLine/executablePath，跳过 CIM。缺失、坏提示、任一可能匹配、CLR 失败均进入完整 CIM；无提示调用保留完整探测。批量 CIM 只查询剩余 PID。
- supervisorLiveness 在有效 PID、有效创建时刻校验后，先按原十秒差异否定旧身份，再检查命令行。相符时间不能单独证明 running：原 executablePath、脚本路径、`_supervise + slug`、identityToken 规则仍须通过。缺时刻、缺命令行等仍 unknown。
- 结果保持原形状校验。CIM 查询、子进程或 JSON 解析/形状失败仍使整次探针返回 null，调用方判 unknown，不能冒记 exited 或放行 running；无失败缓存。非 Windows 原 ps 路径未改。

## 验证交接

两个既有测试的代码、原断言和 30000ms 子进程期限完整保留，仅追加测试。新增断言覆盖：真实活 PID + 陈旧时刻在明确禁止 CIM 时可判 reused；匹配、正负 10000ms 边界、正负 10001ms、缺失/坏/混合提示、同 PID 两种提示顺序、混合批量、真实 StartTime 读取失败的回退；混合批量只查询剩余 PID；脚本/slug/token 错误仍拒绝；查询、超时、解析和结果形状失败仍 unknown，随后正常探测可恢复。真实 PowerShell 测试仅在 Windows 执行，每个探针仍限五秒。

**本轮未执行任何工作脚本、PowerShell 探针、测试、类型检查、构建或 CI。** 仅阅读源码、编辑授权文件并做只读 Git 差异检查。新增断言不是通过证据；原主控继续正式排队、最终 SHA CI、收单、发布及成本登记。

已执行的静态核对：`git diff --check` 无错误；与 HEAD 的文本前缀比较确认原测试文件全部保留，新增内容仅追加；工作区差异仅为上述三个授权文件和本说明。

主控提供的两次 CI 耗时 5239/5279ms、stdout unknown 与内部 5000ms 探针超时相符；底层具体错误未暴露，不能宣称唯一根因。主控已有实测的 CLR 198/201/238ms、完整 CIM 390/368/360ms 及毫秒精度一致，属于同一真实 PID 的本机取证，**不是云 runner 冷启动复现**。本轮不新增性能结论，不采用已证实无收益的 CIM -Property 缩字段路线。

成本由原主控按本次 resume 的 token 增量补记；不重复原施工累计，不访问真实台账，不冒称本工位已落账。

## 主控运行验收补记

正式票 tk-4de10b226784e014c002 发现 Windows PowerShell 5.1 的 ConvertFrom-Json 数组又经 @() 包装时，混合 PID 批次会退化为整个批次走 CIM。原失败日志保留。主控移除该多余包装，保留全部测试断言；tk-b46a7f16cf3a70dfb74a 的六项进程身份测试全部通过，包含真实 PowerShell 混合批次和禁止 CIM 的边界验证。生命周期 46 项此前通过，产品生命周期代码未改变。四项原缓存/接口/服务契约经正式 collect 再次通过。

这些结果不替代最终提交完整 CI 或真实服务发布验收。原有两次 CI 红、首次探针回归红均留存；没有改变原 5000ms / 30000ms 限期。施工对话累计 4125189 token 已经主控独立归因登记并回读，续接只补新增 2213217。
