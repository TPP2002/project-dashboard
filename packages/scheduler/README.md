# Independent scheduler core

MIT; Node **24 or newer**. Source baseline:
`20cea25479bff56cc7d386be2c8d103fd0c446fb`.

本包抽取既有文件账本调度器，不代表云端迁移或生产切换已经完成。没有附带部署者的机器、项目、账户、服务器、运行代理或任务数据。`config.example.json` 是空目录，不能执行任何项目。

## 安装和构建

把本目录完整复制到独立目录，在部署方的算力许可内执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node dist/cli.cjs help
node dist/cli.cjs validate-config --config config.example.json
```

唯一构建依赖是 **TypeScript 6.0.3**；版本、下载地址和完整性值取自固定源版本的实际锁文件，包内锁文件只保留此依赖。`build.cjs` 强制从本包的 `node_modules/typescript` 加载编译器，并审计源码静态依赖：除构建生成器使用编译器外，只允许包内相对路径与 Node 内置模块。生产 `dist` 不需要编译器、第三方运行依赖、TypeScript 加载器、上级依赖目录或 `NODE_PATH`。

构建按现有生成器使用 `transpileModule`，不是完整类型检查。唯一的模块格式适配是把 `import.meta.url` 经编译器语法树转换为当前 CommonJS 文件的 URL；相对导入保留模块布局。原生脚本与生成源码在包内，客户端生成区和原生资产模块均在构建时生成到 `dist`，请勿手改构建产物。源码客户端是去掉旧生成区的模板，不能直接作为发行件执行。

## 部署配置

`validateConfig` 拒绝未知字段、未知机器引用、重复身份和缺少执行菜单的已启用项目。一个进程使用一份不可变目录：在加载 contract/store/client 等入口前调用 `configureDeployment(config)`，或在进程启动前明确设置 `SCHED_CONFIG` 指向部署方的配置文件。客户端进程和代理应使用同一份部署目录；请勿把未经核验的任务输入用作配置。

以下仅是合成示例，路径由部署方填写：

```json
{
  "schemaVersion": 1,
  "machines": [{ "name": "example-worker", "dedicated": false }],
  "projects": [{
    "id": "example-project",
    "aliases": ["example-alias"],
    "repo": "./example-repository",
    "accepted": true,
    "machines": ["example-worker"],
    "menu": [{
      "id": "test", "category": "vitest", "cores": 1,
      "args": { "kind": "paths" },
      "forms": [{ "cmd": ["node", "--test"], "tail": "args" }]
    }]
  }],
  "jobs": {
    "test": {
      "desc": "Example test command", "argv": ["node", "--test"],
      "acceptsTarget": true, "jobClass": "vitest"
    }
  }
}
```

菜单继续使用原有 `sched-menu.cjs` 的命令归一化、匹配优先级、受限参数文法、路径和 shell 元字符拒绝规则。菜单类别是 `vitest` / `shared` / `solo`；票据类别仍使用原协议中的 `unit-test` 等名称。`forms` 的 `cmd` 是分词后的固定前缀，`tail` 为 `none` / `args` / `npm`。未提供的项目属性按原注册表默认值补齐，菜单默认可搬、可重跑、无产物、无环境变量、不可借持续集成空闲核；`hardTimeoutMin` 仍为正整数分钟。

`jobs` 是管理员配置的固定模板，不是提交者可携带的任意命令。其字段保留 `JobTypeSpec` 的含义：`argv`、`acceptsTarget`、`workersFlag`、`workersEnv`、`quotaInject`、`fixedEnv`、`needsRound`、`injectShareEnv`、`targetPattern`、`outDirEnv`、`pinOneMachine`，另显式提供 `jobClass`。JSON 中的 `targetPattern` 为正则源码字符串。原有 payload 白名单、代码版本、来源哈希、目标路径、并发和分片检查仍保留。旧分片协议字段及相应环境变量名称保留兼容，不附带任何业务作业模板或业务执行源码。补跑仍保留原测试工具的语义；部署方应为这些作业配置与原补跑协议相符的模板。

## 入口和数据目录

- 主入口导出 `createSchedulerDaemon`、`validateConfig`、`configureDeployment`。
- `./contract` 导出原始票据、许可、账本事件、路径和验证契约。
- `./store` 导出显式初始化、提交、回报读取/受控接受、账本读取/投影和写者租约入口。写操作仍需在唯一写者保护区内调用；存储原语不另造并发权威。
- `./client` 是构建后的 `sched.cjs`；发布客户端时还会发布其包内配置与菜单侧车。
- `./config` 是配置验证与初始化端口。

在**新的临时目录**中显式初始化的库用法：

```js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const api = require('./dist/index.js')
const config = JSON.parse(fs.readFileSync('config.local.json', 'utf8'))
api.configureDeployment(config)
const store = require('./dist/store.js')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-example-'))
const sources = { now: () => new Date().toISOString(), nonce: () => require('node:crypto').randomUUID() }
store.initializeScheduler(data, sources)
store.createDispatcherConfig(data, 'example-worker', 'example-operator', sources)
// Retain the returned temporary path explicitly; no production path is inferred.
console.log(data)
```

初始化调度数据不会创建或迁移集群生命周期权威。真实生命周期控制数据及经过认证的机器事实仍须由部署方显式提供。默认读取现有本地生命周期快照；合成测试通过原 `readMachines` 端口注入完整机器事实。

常驻入口必须明确指定所有参数，并使用已初始化的数据目录：

```sh
node dist/cli.cjs daemon --data ./temporary-data --config config.local.json --machine example-worker --protocol 25 --head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

不提供数据或配置即拒绝启动，不自动寻找生产共享目录，不切换生命周期权威。CLI 不创建后台代理、不开通网络入口，也不发布软件。`sched.cjs` 客户端仅保留原先从**自身明确部署位置**推导数据目录的兼容行为，没有私人路径默认值。

## 保留的不变量与平台边界

保留原 owner fencing、逐次提交保护、同卷暂存和原子发布、不可变提交幂等、流水校验和/顺序/重放、取消、started/finished 的机器/令牌/执行号/出生身份核对、超时回收、暂停及恢复逻辑。快照和心跳继续是缓存，不充当账本事实。未知来源、未知进程身份和非确定死亡不改判为可信或已退出。

`readMachines`、`originProbe`、`probeProcess`、时钟、nonce 和现有交接观察端口保留可注入。它们是部署适配边界，**不是网络认证实现**。非 Windows 的默认来源探测仍返回 `non-win32`，不会把 Linux 上同号进程当作 Windows 执行身份。Windows 原生许可归属核验、命名管道、进程树控制及挂起接口仍是 Windows 实现；运行本包不会使这些接口自动支持 Linux。

派单员的执行进程默认探测在非 Windows 平台也明确返回未知（抛出不支持，由原回收器保守保留占用），不会用本机 `process.kill(pid, 0)` 判断另一台执行机的死亡。Windows 默认探测和原 `probeProcess` 注入口保留；未来由主控接入经过认证的执行机观察端口。写者对**自身**租约保护进程的本机观察仍沿用原实现，不和执行机身份混用。

网络传输、Windows 身份事实认证、云端代际/投影新鲜度、远程交接、真实 Linux 派单与 Windows 执行、旧权威停用及真实迁移验收由下一单完成。不得把本包的合成测试、编译结果或库加载当作实际迁移通过。

## 私人默认值的兼容映射

| 原模块中的默认值 | 显式部署端口 | 无配置行为 |
| --- | --- | --- |
| `client/sched-projects.cjs` 的项目/别名/菜单/机器/仓库/运行环境/依赖配方 | `projects[]`，`hostMachine`，`spareMachine` | 项目与机器目录为空，无执行菜单 |
| `cpuLease` 的专职机器集合 | `machines[].dedicated` | 无专职机器；100%/85% 配额换算算法保留 |
| `cluster-job.JOB_TYPES`、缺省作业、并发分类 | `jobs`、`defaultJobKind`、每项 `jobClass` | 无模板、无缺省作业；未知类别仍保守独占 |
| 特定项目的旧超时回退、旧主干头/锚点及基础设施搬运闸 | `legacyProjectId` | 不启用此兼容分支；普通菜单超时语义保留 |
| 生命周期精确证明的旧 bundle 文件名 | `lifecycleBundleName` | 调用此证明接口时拒绝，不猜名称 |
| 持续集成车道历史留核表 | `ci.reserveCores` | 空表；未知工位仍按整机配额留核 |
| 标签管理仓库/车道/工位/机器策略/同机独占车道 | `ci.labels.{repo,managedLanes,untouchableLabels,runners,machinePolicy,exclusiveLane}` | 标签路由不启动，GitHub 改标签端口拒绝调用 |
| 接管仓库/标签/作业前置/执行机 | `ci.takeover.{repo,lanes,unmanagedLabels,prerequisites,executors}` | 不启用接管，网络读端口拒绝调用 |
| 本机一次性工位根目录 | `ci.jitSlotRoot` | 不探测固定磁盘位置，不认领该类进程 |
| GitHub 命令行工具位置 | `ci.ghPath` 或原有显式工具覆盖端口 | 使用 PATH 中的工具名；仅配置适配器后可启用 |
| 原产品名下的本机挂起账/原生缓存目录名 | 中性 `scheduler` 本机命名空间，原注入目录端口保留 | 不读取旧产品目录；迁移时由主控处理旧记录 |

`ci.labels.runners` 每项包含正整数 `id`、安全 `name`、已知 `machine` 与受管 `labels[]`；受管与不可触碰标签不能重叠，`exclusiveLane` 必须在受管目录内。机器策略只接受 `dynamic` / `pinned`。`ci.takeover.lanes` 明确提供 `fast`、`main`、`e2e` 三个原契约角色，每项保留 `lane`、`label`、`workType`、`category`、`jobClass`；私有标签和 runner 身份均无内置值。原地板、限速、退避、单轮上限及独立不变量复核保留。

主控整合前须补全真实部署目录、核对历史项目及别名、显式映射旧 bundle 名称与超时兼容项目、核对 runner 布局和同机独占标签、处理旧挂起记录，并在单一权威下导入已校验的历史数据。配置须覆盖重放中的项目和机器，不能靠删历史记录来通过新配置校验。先升级客户端及代理读者，再执行后续真实迁移契约；本单不执行这些生产步骤。

## 临时验证与来源

仓库的 `test/cloudSchedulerPackage.test.cjs` 是单个串行 `node:test` 文件，应由统一调度入口授予许可后，以 `--test-concurrency=1` 运行。该测试把**整个包**复制到新临时目录，清除外部配置和 `NODE_PATH`，使用包内锁文件独立安装并构建；随后删除临时包的 `node_modules`，限制模块解析边界，以生产 JavaScript 实际运行。它不连接真实共享目录、GitHub 或运行代理；失败保留临时目录和安装/构建/运行原始输出并标记 `NOT_PROVEN`，成功才清理自己创建的临时目录。

独立安装、构建、状态机与原生生成链的实际结果，以派单器重跑为准。本次施工未执行该验收命令，也未自行执行安装或构建，不能提前声称独立运行已证实。

| 新验证断言 | 固定源测试对应 |
| --- | --- |
| 提交→授予、重复节拍不重授予、内存投影与账本重放一致 | `tests/unit/sched/schedDaemon.test.ts` |
| 错误令牌拒收、started/finished、出生身份固定、重放补回执及同身份异内容停写 | `tests/unit/sched/schedReports.test.ts` |
| 幂等原件、回执后重传及不同内容冲突 | `tests/unit/sched/schedIntake.test.ts` |
| 双实例拒绝、租约 token 换代后禁止旧写者提交 | `tests/unit/sched/schedOwner.test.ts` |
| 取消已授予未开跑单、十分钟回收的边界 | `tests/unit/sched/schedDaemon.test.ts`、`sched-reclaim` 原规则 |
| 非法已提交账本不能假装空表 | `tests/unit/sched/schedLedger.test.ts` |
| 非 Windows 来源保持失败，权限不足不算死亡 | `sched-origin-probe`、`sched-reclaim` 原端口行为 |

合成机器结构和可注入时钟来自 `daemon-fixtures.ts` 的有效断言形状；只改示例身份、目录和受测入口，未把运行行为替换成文件存在检查。

`SOURCES.json` 逐项列出固定版本的来源模块与目标。主要是 `scripts/sched/*`、必要的生命周期/owner/job 模块、机器配额与最小代理事实类型；生命周期 facade 仅转出 contract/control/state，不复制切换或金丝雀实现。旧客户端生成区由包内生成器重建，旧原生资产生成件由原生正本重建。删去的私人内容包括整份项目注册表与业务作业模板、真实机器白名单、runner 基线/仓库/标签、固定磁盘位置、产品缓存前缀及注释中的历史真实票据。没有复制业务仿真、游戏数据、训练或校准执行脚本。固定源算法继续以原模块名保留，新增部署适配和包构建文件不属于旧来源清单。
