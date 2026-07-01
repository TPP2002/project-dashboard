#!/usr/bin/env bash
# 项目管理看板 - 一键启动（macOS / Linux）
# 做三件事：①首次装界面依赖 ②生成最新界面 ③启动服务（自动开浏览器 + 单实例复用）
set -uo pipefail

# 切到脚本所在目录（看板根目录）
cd "$(dirname "$0")"

echo
echo "================================================"
echo "  项目管理看板 - 一键启动"
echo "================================================"
echo

# ---- 检查 Node.js ----
if ! command -v node >/dev/null 2>&1; then
  echo "[X] 没找到 Node.js，看板运行需要它。"
  echo "    请到 https://nodejs.org/ 下载安装 LTS 版本后，再运行本脚本。"
  exit 1
fi

# ---- 第一次使用：安装界面依赖（只装一次）----
if [ ! -d web/node_modules ]; then
  echo "[1/3] 第一次使用，正在安装界面依赖（只需一次，可能要一两分钟）..."
  if ! ( cd web && npm install ); then
    echo
    echo "[X] 依赖安装失败（多半是网络问题）。"
    echo "    请连上网后，在 web 文件夹里手动运行： npm install"
    exit 1
  fi
else
  echo "[1/3] 界面依赖已就绪。"
fi

# ---- 生成最新界面 ----
echo "[2/3] 正在生成最新界面（npm run build）..."
( cd web && npm run build ) || true

# ---- 构建后仍无界面产物 → 友好提示 ----
if [ ! -f web/dist/index.html ]; then
  echo
  echo "[X] 还没有可用的界面（web/dist 不存在）。"
  echo "    请先在 web 文件夹里运行： npm run build"
  echo "    若提示缺少依赖，请先运行： npm install"
  exit 1
fi

# ---- 启动服务（server 会自动开浏览器 + 单实例复用）----
echo "[3/3] 正在启动看板服务，浏览器稍后自动打开..."
echo "    关闭看板：在本窗口按 Ctrl+C。"
echo
exec node server/server.cjs
