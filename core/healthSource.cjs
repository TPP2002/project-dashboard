'use strict';

function createHealthSource({ index, readStamp = null, readDetails = null, initialDetails = {}, refreshMs = 30000,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let latestReleaseCommit = null;
  let details = { ...initialDetails };
  let started = false;
  let timer = null;
  let inFlight = null;
  let dirty = false;
  let lastReadAt = null;

  async function readAll() {
    do {
      dirty = false;
      lastReadAt = now();
      await Promise.all([
        (async () => {
          if (!readStamp) return;
          try {
            const stamp = await readStamp();
            if (started) latestReleaseCommit = typeof stamp?.commit === 'string' && stamp.commit.trim() ? stamp.commit : null;
          } catch { /* Preserve the last successful value on read failure. */ }
        })(),
        (async () => {
          if (!readDetails) return;
          try {
            const next = await readDetails(details);
            if (started) details = { ...details, ...next };
          } catch { /* Independent fields retain their previous snapshot. */ }
        })(),
      ]);
    } while (started && dirty);
  }

  function refresh() {
    if (!started || (!readStamp && !readDetails)) return Promise.resolve();
    if (inFlight) { dirty = true; return inFlight; }
    if (timer !== null) clearTimer(timer);
    timer = null;
    inFlight = readAll().finally(() => {
      inFlight = null;
      if (!started) return;
      // A change can arrive after readAll returns but before this finalizer runs.
      if (dirty) return refresh();
      const delay = Math.max(0, refreshMs - (now() - lastReadAt));
      timer = setTimer(() => { timer = null; return refresh(); }, delay);
      timer.unref?.();
    });
    return inFlight;
  }

  return {
    current: () => ({ ...details, projects: index.ids(), latestReleaseCommit }),
    refresh,
    start() { if (!started) { started = true; return refresh(); } return inFlight; },
    stop() { started = false; dirty = false; if (timer !== null) clearTimer(timer); timer = null; },
  };
}

module.exports = { createHealthSource };
