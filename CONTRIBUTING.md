# 参与贡献

本项目用于让 AI 汇报施工进度、让负责人查看进度和拍板。提交改动前，请先明确任务范围和已有决定；遇到需要改变方向的地方，先交由负责人确认。

## 开发环境

需要 Node.js 24、随附的 npm 和 Git。仓库根目录与 `web` 目录各有一份锁文件，分别安装依赖：

```bash
npm ci
cd web
npm ci
cd ..
```

构建界面后可启动源码实例，或使用隔离的示例数据体验：

```bash
npm --prefix web run build
npm start
```

`npm run demo` 使用临时目录中的虚构项目，适合复现通用问题。不要把真实项目数据复制进提交或问题报告。

## 分支与提交请求

1. 先找对应任务或提出问题，说明要解决的具体场景；不要把重构或新功能混进修复。
2. 从维护分支建立独立功能分支；在动代码前按项目协议认领任务，写清文件范围。
3. 保持改动集中，补充与行为对应的测试和文档，保护他人尚未提交的工作。
4. 提交信息写明卡号，例如 `fix(TASK-123): 修正项目切换后的显示`。
5. 发起提交请求，说明问题、改后的行为、验证结果和未验证部分，关联任务或问题编号。
6. 按审阅意见修改，由维护者验收并合并。发布副本的更新由维护者执行。

若你是按派单器工单施工，优先遵守工单：看板登记、提交和验收可能由派单方统一代办，不能擅自越过这些边界。

## 看板协议

先读 [AGENTS.md](AGENTS.md)。CLI 的 `protocol` 与各命令的 `--help` 是当前规则来源；不要手写 `board.json`。

```bash
node <看板CLI路径> protocol --project <项目id>
node <看板CLI路径> brief <任务id> --project <项目id>
node <看板CLI路径> claim <任务id> --project <项目id> --branch <分支名> --scope "本次会改的文件"
```

工作中用 `progress` 汇报；方向性问题用 `pending` 写明选项、背景、利弊与推荐理由，等负责人决定。完成后按协议登记成果。项目装有认领闸门时，先认领再提交。

## 检查

普通贡献在交付前运行以下检查，并记录真实结果：

```bash
npm test
npm --prefix web run typecheck
npm --prefix web run build
npm --prefix web run check:no-emoji
```

界面改动还应通过实际页面检查项目切换、交互与错误提示。测试必须使用隔离的数据目录；不要读取或改写贡献者的真实看板。工单明确指定由派单方运行验收时，施工方遵照工单，未运行就如实标记未运行。

## 界面红线

- 界面不用 emoji；图标只使用 `web/src/icons` 现有精灵。需要新图标时先上报，不自行绘制。
- 颜色字面量只进入 `web/src/styles/base.css` 的令牌与色站，组件用现有令牌。
- 本地界面偏好存入 localStorage，读回逐字段校验，脏数据回落默认值。服务级模块开关按现有设置接口存储。
- 动效尊重 `prefers-reduced-motion`，不要破坏已存在的降级行为。
- 不为通过检查而删除功能、弱化断言、隐藏错误或另造一套简化设计。

## English summary

Use Node.js 24 and install dependencies in both the repository root and `web`. Read [AGENTS.md](AGENTS.md), obtain the current CLI protocol, and claim a scoped task before editing. Include its ID in commits and describe behavior and validation in your pull request. Run the backend tests, frontend type check, build and no-emoji check unless a dispatch contract assigns validation to the dispatcher. Use existing icons and color tokens, validate stored preferences, respect reduced motion, and keep real project data out of fixtures and public reports. The project license is still to be decided.
