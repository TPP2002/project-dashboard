'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');
const { DASHBOARD_HOME } = require('../core/resolveProject.cjs');
function fileOf(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) || id.includes(':')) throw new Error('非法待送 requestId');
  return path.join(DASHBOARD_HOME, 'remote-outbox', id + '.json');
}
function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}
function writePrivate(file, value) {
  privateDirectory(path.dirname(file));
  atomicWriteJsonSync(file, value);
  try { fs.chmodSync(file, 0o600); } catch (e) { if (process.platform !== 'win32') throw e; }
}
function save(request) {
  const file = fileOf(request.requestId);
  if (fs.existsSync(file)) {
    const old = read(request.requestId);
    if (require('../core/boardCommand.cjs').inputHash(old.request) !== require('../core/boardCommand.cjs').inputHash(request)) throw new Error('待送 requestId 内容不可变');
    return;
  }
  // Persist before transport starts, including Git facts captured against this exact commit.
  writePrivate(file, { state: 'unconfirmed', request });
}
function read(id) { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); }
function acknowledge(id) {
  const old = read(id);
  writePrivate(fileOf(id), { ...old, state: 'confirmed' });
}
function progressJournal(request) {
  const file = path.join(DASHBOARD_HOME, 'remote-progress', path.basename(fileOf(request.requestId)));
  writePrivate(file, { replayable: false, request });
  return () => fs.unlinkSync(file);
}
module.exports = { save, read, acknowledge, fileOf, progressJournal };
