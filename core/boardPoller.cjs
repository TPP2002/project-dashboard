'use strict';

function createBoardPoller({ index, stat = require('node:fs').promises.stat,
  intervalMs, maxIntervalMs = 30000, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
  onFirstSeen, onChanged, log = console.warn }) {
  const mtimes = new Map();
  let running = false;
  let started = false;
  let timer = null;
  let skipped = 0;
  let delay = intervalMs;
  let durationMs = 0;

  function schedule() {
    if (!started || running || timer !== null) return;
    timer = setTimer(async () => {
      timer = null;
      await tick();
    }, delay);
    timer.unref?.();
  }

  async function tick() {
    if (running) { skipped++; return; }
    running = true;
    const began = now();
    try {
      await index.refresh();
      const projects = index.ids().map(id => [id, index.get(id)]).filter(([, project]) => project);
      const results = await Promise.all(projects.map(async ([id, project]) => {
        let mtime = null;
        try { mtime = (await stat(project.board)).mtimeMs; } catch { /* Missing or unreadable board. */ }
        return [id, mtime];
      }));
      for (const [id, mtime] of results) {
        if (!mtimes.has(id)) {
          mtimes.set(id, mtime);
          onFirstSeen(id, mtime);
        } else if (mtimes.get(id) !== mtime) {
          mtimes.set(id, mtime);
          onChanged(id, mtime);
        }
      }
    } catch (error) {
      log(`[board-poller] ${error.message}`);
    } finally {
      durationMs = now() - began;
      if (durationMs > delay) {
        const wasBackingOff = delay > intervalMs;
        delay = Math.min(delay * 2, maxIntervalMs);
        if (!wasBackingOff && delay > intervalMs) log(`板轮询退避到 ${delay} 毫秒`);
      } else if (durationMs < intervalMs / 2 && delay !== intervalMs) {
        delay = intervalMs;
        log(`板轮询恢复到 ${delay} 毫秒`);
      }
      running = false;
      schedule();
    }
  }

  return {
    start() { if (!started) { started = true; schedule(); } },
    stop() { started = false; if (timer !== null) clearTimer(timer); timer = null; },
    tick,
    stats: () => ({ running, skipped, intervalMs: delay, durationMs }),
  };
}

module.exports = { createBoardPoller };
