# 组员 AI 接入云端看板

云端看板：https://124.222.101.139

装好后，你的 AI（Claude Code、Codex、Cursor 等）可以替你查卡、建卡、领卡、报进度、留言、完工，权限和你在网页上一样。

## 1. 装 Node

需要 Node 18 或更新版本。终端里运行 `node -v` 能看到版本号就行，没有就去 https://nodejs.org 装 LTS 版。

## 2. 下载命令行

找个固定的目录放它，比如 `D:\tools`（下文都用这个目录举例）。

Windows：

```powershell
mkdir D:\tools -Force
curl.exe -o D:\tools\board-member.cjs https://124.222.101.139/board-member.cjs
```

Mac / Linux：

```bash
mkdir -p ~/tools && curl -o ~/tools/board-member.cjs https://124.222.101.139/board-member.cjs
```

以后看板升级了，重新下载一次覆盖旧文件就行，不用重新登录。

## 3. 登录（本人做一次，不要交给 AI）

```powershell
node D:\tools\board-member.cjs login --server https://124.222.101.139 --username 你的用户名
```

按提示输入网页登录用的密码。密码不会存到电脑上，存的是这台电脑专用的登录凭据，90 天有效。

登录后设默认项目（只有一个项目可以跳过）：

```powershell
node D:\tools\board-member.cjs projects
node D:\tools\board-member.cjs use 项目编号
```

## 4. 告诉你的 AI

把下面这段加进项目根目录的 `CLAUDE.md`（Claude Code）或 `AGENTS.md`（Codex），路径换成你自己的：

```markdown
## 云端看板

本项目的任务在云端看板上管理，命令行是 `node D:\tools\board-member.cjs`。
开工前先运行 `node D:\tools\board-member.cjs guide`，照里面的说明用。
接活先 claim，做到节点报 progress，做完 done。
不要替我登录，提示要重新登录时告诉我。
```

## 5. 遇到问题

| 情况 | 怎么办 |
|---|---|
| AI 说要重新登录（退出码 3） | 你本人重新跑第 3 步的 login |
| 换了电脑 | 新电脑上重做第 2、3 步 |
| 电脑丢了或不再用 | 在旧电脑上运行 `logout`；旧电脑用不了的话，请负责人在网页上撤销这台设备 |
| 连不上（退出码 4） | 先用浏览器打开看板网址，打不开就是网络或服务器问题，找负责人 |
