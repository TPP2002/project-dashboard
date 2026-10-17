# Controller execution record — scope completed

当前状态为 `completed`：主控已执行完本单自动化验收和受控资源对照，本施工方已读取结果、完成报告和公开副本路径规范化。本轮没有运行 node/tsx/python、测试、测量、Git 写操作或生产操作。

| 正式作业 | 已取得结果 | 公开证据 |
|---|---|---|
| collect `tk-c14e9c992338a009f876` | 五个定向测试与 typecheck 全部 exit 0；resource-regression@base exit 1，旧 store 真红合格 | `acceptance/` 与 `controller-acceptance.json` |
| 旧版 probe `tk-78db9fe28eb2b3393a44` | 六条实际行为断言失败 | `original-permitted-dispatch.log` / `original-behavior-permitted.log` |
| 资源 `tk-de4de4ed23d58dbd330d` | ABBA 四进程均 exit 0，完整响应摘要一致、源码指纹不变 | `resource-comparison.json` / `resource-1..4-*.stdout.json` / 对应 stderr |

五个测试依次为资源生命周期、读取缓存边界、server、sched-api、read-integrity，原断言和超时保留。施工方最终 acceptanceResults 的 ran=false，passed=true 引用主控正式运行结果；不冒记为施工方执行。类型检查没有额外成功统计行，不添加伪造成功输出，exit 0 以主控 verdict 为准。

资源实验实际使用 Node v24.14.0、win32/x64，固定 seed=1017，单份 fixture 276 个文件 / 44,254,036 字节。driver 以 `--expose-gc` 启动四个顺序独立 worker；显式 GC 只在实验中。生产源码没有显式 GC，也未触碰生产数据。

结果与证据边界：

- 已读全部四轮原始数值，具体计数、容量、wall/CPU、峰值和回收后 heap/external/RSS 见 implementation 与汇总中的完整 runs。
- 100 次突发：旧版 101 fetch / 100 abort，新版 2 fetch / 0 abort；最终结果均正确。组合压力下关闭回收后 heap 两轮均值约 108.82 MiB → 34.04 MiB，不能归因当前生产 RSS。
- 原始 driver 状态 `measured-controller-review-required` 保留；汇总另标 deliveryStatus=completed 与主控通过结果，避免改写原测量状态的含义。
- 主控外部保存所有未修改原件和第一轮 collect；公开副本仅规范化本机身份/路径，数字、断言、失败、哈希保留，源码快照原字节不变。规则见 `evidence-provenance.md`。
- 早期无许可记录仍保留，不能当正式验收。路径规范化不等于运行 noLocalIdentifiers 测试；该闸门未修改，最终检查仍属主控。

没有新的范围问题或待负责人决定。第一轮 blocked 只是旧 last-message 的已解除问题，历史状态不改写；本次 completed JSON 提供当前施工结论。尚待主控完成最终提交 CI、正式发布、实景验收和看板收官，这些不冒记为本次施工方已经完成。

圈外适配只有 `web/src/components/sched/QueueTable.vue` 的类型 import/props，已获主控落盘授权；冻结工单保持原样。主控负责 collect、统一验收、CI、发布、实景检查和精确会话成本登记。
