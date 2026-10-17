# Evidence publication and provenance

公开目录中的证据是发布副本。主控已将全部未修改原始测量、旧失败/无许可日志以及第一轮 collect 逐文件留存在仓外独立证据目录；本报告用 `<controller-evidence-archive>/dashboard-resource-ab-1` 指代它，不发布本机用户名、工作区、共享根或主机名。正式验收原件由主控作业目录保存，公开副本位于 `acceptance/`。

## 规范化范围

仅替换身份或绝对路径，不删除失败，不改数字、断言、退出码、内容哈希或源码指纹：

| 发布副本 | 处理 |
|---|---|
| resource-comparison.json | fixtureRoot 改为 `<temporary-fixture>`；原始 runs/sourceHashes/输入清单与响应摘要不变，另加验收及发布说明 |
| original-behavior.log | 三条 esbuild 栈帧的本机仓库前缀改为 `<repo>`；2272:29、2478:19、2519:3 等行列号与 EPERM 原文保留 |
| original-permitted-dispatch.log | 本机 TEMP 前缀改为 `<temporary-fixture>`；日期、票号、退出码、失败断言和其余输出保留 |
| acceptance/typecheck.log | 本机 Node 安装路径改为 `<node-runtime>/node.exe`；调度提示、票号和其余原文保留 |
| original/updated/native/permitted 其他日志与四轮 stdout/stderr | 无身份路径者保持内容；全部记录均保留，不用绿色结果替换旧红日志 |

源码快照 `original-sched.ts` 与 `original-server.cjs` 不做规范化，严格保持原始字节。其已有通用示例路径仍属于原代码，并非本次公开本机身份：

- store SHA256：`120B520AABEF559325FBB180D1E86FA7C4C62BBFFCA1D9A783F681CF32ACC9AC`
- server SHA256：`2351C8E1F564301DDCE531DB2CDA7E6612A5CC92FBAFB16233E5B401AE98120E`

本次仅报告与证据副本编辑，已验生产源码、测试、实验脚本和快照没有修改。报告内 12 项源码/脚本指纹与实际文件匹配。全部四轮 raw 数值仍在 stdout 和 resource-comparison.runs；原件可由主控用外部档案核对。

本轮只读比对确认：公开汇总的 runs/sourceHashes 与外部原件一致；四份 stdout 和四份 stderr 逐文件 SHA256 与外部原件一致；12 项实际源码/脚本指纹没有差异。路径规范化后的汇总整体文件哈希会改变，不能将其冒称为未经修改的原件。

公开 Git 提交按仓库既有文本规则将 CRLF 规范化为 LF；仓外原件保留原始行尾。验收日志末尾空行也原样保留，`git diff --check` 对这些日志的空行提示不是代码空白错误。

## 验收归属和历史状态

controller-acceptance.json 摘录主控 verdict 的逐项验收与圈外授权，不伪造新的收单结果。该历史 verdict 的 finalStatus=blocked 来自第一轮旧 last-message 的范围问题，自动化验收实际全过；主控已确认范围授权落盘、没有待拍板。本次交付用 completed 表示施工面与报告完成，最终 collect 判定仍由主控更新。

最终 JSON 的 ran=false 表示施工方未执行相应验收，passed=true 引用主控正式通过结果。旧版真红的 exit 1 是预期合格结果；无许可 probe 和 esbuild EPERM 均不是正式验收通过证据。类型检查日志没有成功统计行，不添加虚构的统计。

noLocalIdentifiers 闸门与其白名单没有修改。本轮仅做文件内容检查和规范化，没有执行该测试、其他测试或任何测量脚本；最终发布检查由主控完成。
