'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');
const defaultFs = require('node:fs');
const { githubRepository, runnerMachines } = require('./schedCiJobs.cjs');
const schedContract = require('./schedContract.cjs');

function readCiRepository(boardPath, runFile = execFile) {
  return new Promise((resolve, reject) => {
    runFile('git', ['-C', path.dirname(path.dirname(boardPath)), 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 }, (error, stdout) => {
        if (error) return reject(error);
        resolve(githubRepository(stdout));
      });
  });
}

function createCiBoardsReader({ registryPath, readRegistry, resolveProject, runFile = execFile,
  fs = defaultFs, now = Date.now, originTtlMs = 600000, log = console.warn }) {
  const origins = new Map(), boards = new Map(), boardErrors = new Map();
  async function readBoards() {
    const projects = Object.keys(readRegistry(registryPath).projects || {}).map(resolveProject).filter(Boolean);
    const paths = new Set(projects.map(project => project.board));
    for (const cache of [origins, boards, boardErrors]) for (const key of cache.keys()) if (!paths.has(key)) cache.delete(key);
    return Promise.all(projects.map(async project => {
      const key = project.board;
      let origin = origins.get(key);
      if (!origin || now() - origin.at >= originTtlMs) {
        let repository = origin?.repository ?? null, error = null;
        try { repository = await readCiRepository(key, runFile); } catch (failure) { error = failure.message; }
        if (!origin || origin.repository !== repository || origin.error !== error) {
          if (error) log(`[sched-ci] 项目 ${project.id} 的远端暂不可读：${error}`);
          else log(`[sched-ci] 项目 ${project.id} 的远端：${repository ?? '无 GitHub 远端'}`);
        }
        origin = { repository, at: now(), error }; origins.set(key, origin);
      }
      try {
        const stat = await fs.promises.stat(key);
        let cached = boards.get(key);
        if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
          cached = { mtimeMs: stat.mtimeMs, size: stat.size, parsed: JSON.parse(await fs.promises.readFile(key, 'utf8')) };
          boards.set(key, cached);
        }
        boardErrors.delete(key);
        return { ...cached.parsed, repository: origin.repository };
      } catch (error) {
        if (boardErrors.get(key) !== error.message) log(`[sched-ci] 项目 ${project.id} 的标题暂不可读：${error.message}`);
        boardErrors.set(key, error.message);
        return { repository: origin.repository, tasks: [] };
      }
    }));
  }
  async function readRunnerMachines(share) {
    try {
      const file = schedContract.schedPaths(share).heartbeat;
      const heartbeat = schedContract.validateHeartbeat(JSON.parse(await fs.promises.readFile(file, 'utf8')));
      return runnerMachines(heartbeat.machines);
    } catch { return new Map(); }
  }
  return { readBoards, readRunnerMachines };
}
module.exports = { createCiBoardsReader, readCiRepository };
