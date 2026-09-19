# READER-IMPORT-T3 施工记录 —— 审阅台导入的界面:按钮、对话框、徽标与删除 / 下载原件

> 任务:READER-IMPORT-BUTTON(T3)· 2026-09-19 完工
> 范围:界面 + 纯函数辅助;不改 server(T1 已合并)、不改转换器(T2 已合并)。

## 干了什么

负责人在审阅台页头点「导入报告」,把 md / markdown / txt / html / htm / docx / pdf 拖进
(或点选)对话框,逐份在浏览器端转成 markdown,再逐份交给 T1 的接口落本机数据目录;
转完导入的报告立刻出现在报告架「本机导入」分组里,可直接读、写批注、标已审阅。

| 文件 | 职责 |
| --- | --- |
| web/src/utils/reportImport/importFlow.ts | 纯函数三件:`bytesToBase64`(分块转,几 MB 原件不爆栈,与 Node Buffer 结果逐字符一致)、`ORIGINAL_MAX_BYTES`/`shouldKeepOriginal`(原件 30MB 口径)、`summarizeImport`(导入结果汇总成一行中文) |
| web/tests/readerImportFlow.check.mts | 上述纯函数的字符级断言 6 条;与 readerImportConverters.check.mts 同理由放 web/tests/ 且以 .check.mts 结尾 |
| web/src/api/reader.ts | `ReaderReportMeta` 补本机导入专有的可选字段(imported/importedAt/format/fileName/warnings/hasOriginal);新增 `importReport` / `deleteImport` / `importOriginalUrl` 三个封装 |
| web/src/stores/reader.ts | 新增 `refreshManifest`(导入后重新拉清单)与 `removeImport`(删除后刷新;删的是当前打开的报告就退回报告架)两个动作 |
| web/src/components/reader/ImportDialog.vue | 拖拽 / 点选对话框:串行转换、逐行状态、可编辑标题、转换提示展开、逐份导入、失败单行标注 |
| web/src/views/Reader.vue | 页头「导入报告」按钮与对话框接线;导入报告的页头徽标、「转换提示 N 条」展开、「下载原件」、「删除此导入」(二次确认) |
| web/src/components/reader/ReportShelf.vue | 报告架条目(待审阅 / 已审阅两组)对 imported 报告显示「本机导入 · 未回流对账」徽标 |
| package.json | `test:reader-import-flow` 脚本接线,并追加到 `test:fast` 末尾 |

## 交互口径(按工单逐条落地)

1. **对话框**:虚线拖拽区同时可点击选文件、可多选,accept 为七种扩展名;写明支持格式与
   「扫描件 pdf、.doc、图片不支持」。拖拽区 role=button + tabindex=0,回车 / 空格打开
   文件选择。转换逐个串行(pdf 要加载解析库,串行防界面卡死),状态依次 等待 / 转换中 /
   可导入 / 失败;成功的行给可编辑标题(默认转换给出的 title,上限 120 字与 server 一致)
   与「转换提示 N 条」展开;失败的行显示 `ImportError.hint`(没有 hint 才退回 message),
   该行不参与导入。底部「导入 N 份」(N=可导入数,0 时禁用)与「关闭」。
2. **导入动作**:逐份 POST,`original` 用 `bytesToBase64` 分块转(不带 data: 前缀,字节
   在转换阶段读一次、导入时复用,不重读大文件);原件超过 30MB 就不带 original 并在该行
   提示「原件太大没有保存,只导入了文字」;回包 duplicate:true 的行标「已导入过,未重复
   保存」。全部做完:刷新清单 → 自动选中第一份成功导入的报告 → 关闭对话框 → 页面一行
   提示(「已导入 N 份,其中 M 份此前已导入」;M=0 省略后半句;一份都没成功时对话框不关,
   在框内显示「没有导入成功的文件」并把各行失败原因留给负责人看)。单份失败只标那一行并
   显示 server 的 error,不影响其它份。
3. **徽标与操作**:imported 报告在报告架条目与报告页头显示「本机导入 · 未回流对账」徽标
   (悬停说明:没有边注,也没有登记拍板项;需要对账请找回流对话);页头对导入报告另有
   「转换提示 N 条」(有 warnings 才显示,点开面板列全文)、「下载原件」(hasOriginal 为真
   才显示,直接链到 import-original 接口,server 以附件回)、「删除此导入」(window.confirm
   二次确认——与全仓既有破坏性确认同款;确认后删除接口连这份报告的本机批注一起清,成功后
   刷新清单;删的是当前打开的报告就退回报告架)。

## 关键选择(口径之内、实现层面的取舍)

1. **base64 分块的块长取 3 的倍数**(49152 = 3×16384):块边界正好落在 base64 字符整边界,
   各块结果可以首尾相接,不需要每块之间做余数拼接;内层逐字符拼二进制串再 btoa,避开
   `String.fromCharCode(...大数组)` 的调用栈上限。空文件返回空串,与 Buffer 行为一致。
2. **原始字节不进响应式**:每个文件读进的 ArrayBuffer 按行号放在组件里一张普通 Map,不进
   Vue 的深响应式,避免给几 MB 的二进制套代理;转换读一次、导入转 base64 时复用。
3. **对话框不碰 store**:对话框只认 `project` 这一个 prop,导入做完了把 `{ message,
   firstKey }` 交给页头——刷新清单、选中第一份、页面提示都是 Reader.vue 的动作,与
   ReviewExportDialog「对话框管自己、页面管编排」的既有分工一致。
4. **部分失败也关对话框**:只要有一份成功就按工单的完成序列走(刷新 → 选中 → 关闭 →
   提示 N 份);一份都没成功时留在对话框里显示汇总话术与各行失败原因,否则失败原因会随
   关闭一起消失,负责人没处看。
5. **删除的二次确认用 window.confirm**:全仓既有的破坏性确认(TaskDrawer / ApprovalCenter /
   ToLand 等)都是这一款,不为审阅台单独发明新样式。
6. **导入报告的状态徽标**:导入中的行显示「导入中」、成功「已导入」、失败「导入失败」,
   叠在转换四态之上——工单只规定了转换四态与重复 / 失败标注,导入过程照四态体系的同款
   徽标语言补齐,不另造词。
7. **原件下载用 `<a class="btn btn-sm" href>`**:server 已回 `Content-Disposition:
   attachment`,直接链接即可下载,不需要 fetch 中转;base.css 的 .btn 同样作用于链接。

## 没做什么(边界)

- 没动 server/**、cli/**、core/**、scripts/**、转换器五模块与 index/types;
- 没动「导出批注」「导出给外脑」的行为,没动批注 / 荧光笔 / 已审阅的任何逻辑;
- 不做 OCR、不自动对账、不登记拍板项、不写仓库文件;没新增 npm 依赖;
- 没动 web/package.json、web/package-lock.json、根 package-lock.json、样式令牌与夹具。

## 验证

- 定向自查:`node -e` 动态导入 importFlow.ts 与 Node Buffer 对拍(空串 / ASCII / 中文 /
  块边界前后 / 5MB 大缓冲),加 shouldKeepOriginal 边界与 summarizeImport 全分支——全部
  一致通过。正式跑法 `npm run test:reader-import-flow` 留给派单器重跑。
- 验收命令(全量单测、打包、typecheck)按工单留给派单器重跑,施工方未在沙箱硬跑
  (worktree 的 web/node_modules 联接缺失,跑不动,也不该跑)。
- 全部施工文件扫过一遍:无本机盘符路径、无 emoji;颜色只用 base.css 令牌;图标只用
  现有精灵(file / x / download / alertTri / check);无新增动效,prefers-reduced-motion
  无需降级。

## 返工记录(2026-09-19,验收人实机拖文件核出两缺陷,一轮改完)

只动了 `web/src/components/reader/ImportDialog.vue`、`web/src/views/Reader.vue` 与本记录:

1. **PDF 导入必失败(Cannot perform Construct on a detached ArrayBuffer)**:原实现把转换
   阶段读进的 ArrayBuffer 存进一张缓存,提交阶段取出来转 base64——而 pdfjs 转换时会把传入
   的缓冲「转移」(detach)给 worker,缓存里只剩一块被掏空的内存,只有 pdf 中招
   (md/docx/html 不转移)。改法:缓存连同 set/get 整体删掉;转换阶段现读现交、用完即弃;
   提交阶段总是重新 `file.arrayBuffer()` 读一份新的再转 base64。已按代码路径走查:全文
   只剩两处 `arrayBuffer()`(转换、提交各一),互不复用。
2. **部分失败时失败信息被吞(一轮有成功有失败,对话框照样自动关)**:原实现只要有一份
   成功就交「全部完成」并关框,失败行随框一起消失。改法:新增 `imported` 事件只负责让
   父页面刷新清单(成功的马上进报告架);存在任何导入失败时不自动关框,框底显示
   「已导入 N 份[,…];K 份导入失败,原因见上」,失败行与原因保持可见,负责人点「关闭」
   才走;全部成功才走原样的自动关框 + 选中第一份。

纯函数、测试文件、api 封装、store 动作与 package.json 本轮未动;定向自查(装载真实测试
文件)依旧全绿,验收命令仍留给派单器重跑。文件头注释补写了两种收尾路径与「内存纪律」;
失败重试开始时先清掉上一轮的框底汇总话术,不残留旧提示。
