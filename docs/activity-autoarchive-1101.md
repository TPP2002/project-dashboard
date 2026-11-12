# 看板服务自动按月归档旧活动（DASH-BOARD-FILE-ARCHIVE-1101）

## 这是什么
看板服务（server/server.cjs）启动后，会**自动按月归档**各项目的旧活动，避免
`board.json` 里的 activity 无限膨胀、每次 note/claim 整板读写一次带来的写放大。

归档动作复用既有的 `cli archive-activity` 命令（经子进程调用），不改变它的行为与
归档文件格式；网页读历史活动依旧完整（readMergedBoard 透明合并 `activity-YYYYMM.json`）。

## 口径（保留什么、归档什么）
- 只对**注册表里的全部项目**逐个处理，依次串行（不并发）。
- 每个项目起一个**静默子进程**跑：
  `node cli/index.cjs archive-activity --project <id> --before <YYYY-MM> --json`
- `<YYYY-MM>` 取「上个月」（本地时间）。例如现在是 2026-11，就传 `2026-10`：
  **10 月以前的活动被搬进归档文件，10 月与 11 月（本月与上月）留在 board.json 里。**
- 只归档 activity（活动），**不归档 tasks（卡）本身**。
- 子进程：`windowsHide: true`、超时 5 分钟、`maxBuffer: 1 MB`、stdout 只在 `moved > 0`
  时写一行日志 `[activity-archive] 项目 X 归档 N 条`；没东西搬或子进程失败都不刷屏
  （同一项目、同一错误文案连续出现只告警一次）。

## 触发节奏
- 服务起来 **60 秒后**跑第一次，之后**每 24 小时**跑一次。
- 上一次还没跑完时到点不叠加（跳过并计数）。
- 定时器 `unref`，不会卡住进程退出；**服务关闭时清掉定时器**。

## 怎么关
设置环境变量即可关闭整个功能（服务端不创建归档器，也不起任何子进程）：

```
DASHBOARD_AUTO_ARCHIVE=0
```

排查时若想临时关掉，给启动命令前置这个变量即可；不设置或设成别的值都按开启处理。

## 怎么手工跑
不想等定时，或不小心关了，可以手动对每个项目跑一次（效果和自动归档完全一致）：

```
node cli/index.cjs archive-activity --project <项目id> --before <YYYY-MM>
```

- 机读模式（适合脚本/本自动归档调用）：末尾加 `--json`，stdout 输出含 `moved` 与 `files`。
- `<YYYY-MM>` 同样是「上个月」，例如 `2026-10` 表示归档 10 月以前的活动。
- 重复执行安全：已经归档过的不会重复搬，没东西搬时不会改动任何文件。

## 改动面
- 新增 `core/activityAutoArchive.cjs`：纯逻辑（假时钟/假 spawn 可测），导出
  `createActivityAutoArchive`，含 `beforeMonth(date)`、`start()`、`stop()`、`runOnce()`。
- 改 `server/server.cjs`：在 `startIntervals` 里接线，受 `DASHBOARD_AUTO_ARCHIVE` 开关控制，
  `server` 关闭时 `stop()`。
- 新增 `test/activityAutoArchive.test.cjs`：六类用例（beforeMonth 跨年/退位、首跑延迟、
  每 interval 一次、串行、去重告警、不叠加、stop 后不再触发）。
- 未改动 `cli/**`、`archive-activity` 命令行为、归档文件名与格式、板的读接口与网页。
