# READER-IMPORT-T1 施工记录 —— 审阅台导入 · server 端存取

任务号 READER-IMPORT-BUTTON(T1,server 侧)· 施工日期 2026-09-19 · 分支 codex/reader-import-server

## 做了什么

按工单五步,全部完成:

1. **新建 `server/readerImport.cjs`**(纯函数与存储层,不依赖 HTTP、零 npm 依赖):
   - `makeImportKey`:key = `IMP-<YYYYMMDD>-<md 内容 sha1 前 6 位>`,同内容同天 = 同 key;
     日期取本地日历日,`now` 参数可注入(同输入必同结果,方便测试)。
   - `validateImportBody`:按契约顺序校验并归一化 —— md 去空白为空 400 → md 超 3MB(UTF-8 字节)413 →
     原件 base64 解码超 30MB 413 → format 不在 md/txt/html/docx/pdf 名单 400;
     标题空则取 fileName 去扩展名并截 120 字;fileName/original.name 只取最后一段并清掉路径分隔符与「..」;
     落盘扩展名只认小写字母数字且 ≤5 位,否则 `bin`。
   - 存储:`saveImport`(原子写 report.md / meta.json / 可选 original.<ext>;同 key 已有完好导入则
     不覆盖不重复存回 `duplicate:true`;同一 key 的导入/删除用文件锁串行,复用 core/lock 与 core/atomicWrite)、
     `listImports` / `readImport` / `readImportOriginal` / `hasOriginal` / `deleteImport`;
     所有按 key 的盘上操作先过 `IMP-<8 位数字>-<6 位十六进制>` 形状闸,防路径注入。
   - `buildLocalImportBatch` / `buildImportReportMeta`:「本机导入」虚拟批次(id=local-import,
     名称「本机导入」,baseline=本机导入,未经回流对账,noteLayers=[]),报告元数据逐字段按契约
     (md:null、status 未对账、imported:true、why 文案等),按 importedAt 倒序。
2. **`server/readerApi.cjs` 接线**:route 新增 `import`(POST)、`import-original`(GET)、`import-delete`(POST);
   manifest 在 **shelfSummary 之前**并入本机导入批次(导入报告的批注数/荧光笔数/已审阅标记因此进货架汇总),
   **没有任何导入时不构造新对象,回包与改动前逐字节一致**;report 对 `IMP-` 开头的 key 读本机 md
   (notes:[]、prevMd:null,批注/荧光笔/已审阅沿用现有账本),`IMP-` 之外的 key 一行未动。
   import-original 回附件,pdf/docx 用正经 Content-Type,其余(含 html)一律 application/octet-stream 防脚本执行。
   import-delete 只放行 `IMP-` 开头(其余 400),删 imports/<key>/ 整目录 + 该 key 批注账本(及其 .lock),
   回 `removedAnnos` 条数,不存在 404。
3. **`server/server.cjs`**:只加了一个 `READER_IMPORT_BODY_MAX = 45MB` 并传给 readerApi
   (`importBodyMax`),仅 POST /api/reader/import 使用;server 层本就没有 reader 动作白名单,其余一律没动。
4. **`test/readerImport.test.cjs`** 并加入 package.json 的 `test:fast`(CI 的全量 `npm test` 自动包含,未动):
   第一段测纯函数与存储层(key 确定性、校验边界含 3MB/30MB 恰好压线、名字清洗、meta 形状、重复导入、删除);
   第二段 spawn 真实 server 按契约过一遍 HTTP(manifest 逐字节基线比对、批次追加、读本机 md、
   原件附件回包、校验状态码、删除连带账本)。夹具只用 test/fixtures/reader-import 的虚构样稿,未改动夹具。
5. 本施工记录。

## 没做什么(边界)

- 不碰任何前端(按钮/对话框/徽标归 T3);不做格式转换、不解析 pdf/docx(归 T2)。
- 不自动生成边注、不登记拍板项;不写仓库 reader.json;没有 commit(改动停在工作区)。
- 没给 server 加任何 npm 依赖(纯函数层只 require node 内置 + core/atomicWrite + core/lock)。
- 没改现有报告的任何行为:`IMP-` 之外的 key 的 manifest/report/annos/marks/review/export 路径逐行未动。

## 拿不准的地方(合同没写死、按最贴近契约原文的方式处理,已写进代码注释)

1. **title 与 fileName 都推不出标题** → 回 400「缺 title,且 fileName 推不出标题」
   (契约只说「title 空则取 fileName 去扩展名」;两者皆空时没名字可起,按无效请求处理)。
2. **meta.json 的 originalName/originalBytes 在没带原件时** → 存 `''` / `0`(契约 meta 形状是固定七/八字段,按恒有处理)。
3. **version 里的「导入日期」**取 importedAt(ISO)的前 10 位,即 UTC 日历日;而 key 里的 YYYYMMDD 取本地日历日。
   两者在深夜跨日时可能差一天,展示层面无实害;契约未指明时区,如需统一以哪个为准,请拍板。
4. **重复导入遇半截状态**(目录在但 meta.json 缺/坏,如写盘中途崩溃)→ 视同未导入补齐落盘;
   完好导入则严格不覆盖(含原件:同 md 换原件重导,原件保留第一次的)。
5. **original.base64 校验**用了字符集闸(只收 base64 字母表 + 空白),拒绝 data: 前缀等形态 ——
   契约只说 base64,按最朴素的裸 base64 收;T3 若想发 data URI 需在 T3 侧剥头。
6. **import-original 的 Content-Disposition** 固定 `filename="original.<ext>"`(ASCII 安全,避免中文文件名进响应头的编码问题;
   用户看的名字在清单里有 fileName)。
7. **删除已删掉的导入再删一次** → 404(契约「不存在→404」按字面执行,不做幂等 200)。

## 自查方式(本机沙箱跑不了测试,按工单指引未跑验收)

- `node --check`/模块加载 + 多组 `node -e` 验算:纯函数边界、存储层往返、
  以及一段进程内接线验算(假依赖把 import/manifest/report/annos/review/import-original/import-delete
  全流程走通,含「删完 manifest 与基线逐字节一致」与「IMP- 之外的 key 原样」)。
- 验收命令([A1] 全量单测)留给派单器统一重跑;本机为 junction/内存受限环境,未硬跑。
