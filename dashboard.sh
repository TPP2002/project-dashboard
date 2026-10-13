#!/usr/bin/env bash
# 项目管理看板 - 一键启动（macOS / Linux）· 薄入口
# 全部编排都在 cli/launcher.cjs（DASH-LAUNCHER-NO-SCHED-HOLD-1012）：
# ①备好界面依赖 ②把主干最新代码 + 现场构建的界面【发布】出去 ③起常驻服务。
#
# 【两种模式】默认【严格模式】：整条启动链（首次依赖安装、现场构建、常驻服务）一律经调度台登记
# （常驻服务只申请 1 核的真实长期占用单）；调度台不可用就明确拒绝新启动，不降级、不裸跑。
# 无调度台的用户显式加参数走独立模式： ./dashboard.sh --standalone （整条链路不经调度台）。
# 细节与实据见 docs/launcher-hold-1014.md。
#
# 【为什么不直接从这个目录起服务】(SERVER-RUNS-ON-LIVE-CHECKOUT，负责人 0906 拍板)
# 这里是看板仓库的【活的工作检出】——随时有对话在切分支、留未提交改动。从这里起服务，等于
# 负责人天天看的看板跟着别人改到一半的代码漂；而且服务是常驻进程，合进主干也一直不生效。
# 所以代码一律从只读的【发布副本】起（由 cli release 从 origin/主干 导出 + 现场构建界面）。
#
# 【落脚点纪律】进程的当前目录留在本检出，绝不进发布副本 —— 那样会让下次发布的目录换名被占住
# （Windows 上必失败，类 Unix 上也会让"换名后旧目录还被引用"变得难查）。
set -uo pipefail

cd "$(dirname "$0")"

# ---- 检查 Node.js ----
if ! command -v node >/dev/null 2>&1; then
  echo "[X] 没找到 Node.js，看板运行需要它。"
  echo "    请到 https://nodejs.org/ 下载安装 LTS 版本后，再运行本脚本。"
  exit 1
fi

# ---- 全部逻辑交给启动器；参数原样转发（--standalone 走显式独立模式）----
node cli/launcher.cjs "$@"
