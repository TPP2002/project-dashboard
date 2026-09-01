'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseSessionIdFromFilename } = require('./codexSessionData.cjs');

function safeDirEntries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function cutoffDate(days, nowMs) {
  if (!Number.isFinite(days)) return null;
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (Math.max(1, days) - 1));
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function listSessionFiles(sessionsRoot, options = {}) {
  const minimumDate = cutoffDate(options.days, options.nowMs ?? Date.now());
  const files = [];
  for (const year of safeDirEntries(sessionsRoot)) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
    const yearPath = path.join(sessionsRoot, year.name);
    for (const month of safeDirEntries(yearPath)) {
      if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
      const monthPath = path.join(yearPath, month.name);
      for (const day of safeDirEntries(monthPath)) {
        if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue;
        const date = `${year.name}-${month.name}-${day.name}`;
        if (minimumDate && date < minimumDate) continue;
        const dayPath = path.join(monthPath, day.name);
        for (const entry of safeDirEntries(dayPath)) {
          if (entry.isFile() && parseSessionIdFromFilename(entry.name)) files.push(path.join(dayPath, entry.name));
        }
      }
    }
  }
  return files.sort((a, b) => b.localeCompare(a));
}

function readRange(file, position, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.max(0, length));
    const bytesRead = length ? fs.readSync(fd, buffer, 0, length, position) : 0;
    return buffer.subarray(0, bytesRead);
  } finally { fs.closeSync(fd); }
}

module.exports = { listSessionFiles, readRange };
