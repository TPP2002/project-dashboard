'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** 只认本项目的锚或转发参数；旧版无 id 锚仍可由参数识别，空值与非字符串返回 false。 */
function hookForwardsProject(text, projectId) {
  if (typeof text !== 'string' || !text || typeof projectId !== 'string' || !projectId.trim()) return false;
  const id = projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = '(?![A-Za-z0-9_.-])';
  return new RegExp(`#dashboard-hook:begin:${id}${boundary}`).test(text)
    || new RegExp(`(?:^|\\s)--project\\s+(?:"${id}"|'${id}'|${id})${boundary}`).test(text);
}

/** 只读 post-commit；.git 目录/指针与安装侧同口径，路径或读取异常一律视为未装。 */
function hookInstalledFor(codeRepo, projectId) {
  try {
    if (typeof codeRepo !== 'string' || !codeRepo) return false;
    const gitPath = path.join(codeRepo, '.git');
    let gitDir = gitPath;
    if (!fs.statSync(gitPath).isDirectory()) {
      const match = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)/);
      if (!match || !match[1].trim()) return false;
      const raw = match[1].trim();
      gitDir = path.isAbsolute(raw) ? raw : path.resolve(codeRepo, raw);
    }
    return hookForwardsProject(fs.readFileSync(path.join(gitDir, 'hooks', 'post-commit'), 'utf8'), projectId);
  } catch {
    return false;
  }
}

module.exports = { hookForwardsProject, hookInstalledFor };
