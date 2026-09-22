'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** 文档地图是本地生成物；缺依赖是常态，脚本失败不能阻止开工。 */
function refreshDocsIndex(repo, { run = execFileSync } = {}) {
  const file = path.join(repo, 'package.json');
  if (!fs.existsSync(file)) return { status: 'skipped' };
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof pkg.scripts?.['docs:index'] !== 'string' || !pkg.scripts['docs:index'].trim()
      || !fs.existsSync(path.join(repo, 'node_modules'))) return { status: 'skipped' };
    const options = { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: 'pipe' };
    if (process.platform === 'win32') {
      // 命令串完全固定，工位路径只通过 cwd 传入，不拼进 shell。
      run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run docs:index'], options);
    } else run('npm', ['run', 'docs:index'], options);
    return { status: 'refreshed', text: '  ✔ docs:index 已刷新本工位的文档地图' };
  } catch (error) {
    const detail = String(error.stderr || error.message).trim().split(/\r?\n/).find(Boolean) || '未知错误';
    return { status: 'warning', text: `  ⚠ docs:index 刷新失败（不阻断开工）：${detail}` };
  }
}
module.exports = { refreshDocsIndex };
