'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const STATUS_CHANGES = new Set(['unclaim', 'park', 'unpark', 'done', 'cancel', 'reopen']);

function mondayAtUtc(timestamp) {
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime() - ((day + 6) % 7) * DAY_MS;
}

function activityTime(ts) {
  if (typeof ts === 'number') return new Date(ts).getTime();
  if (typeof ts !== 'string' || !ts.trim()) return NaN;
  // Interpret zone-less ISO date-times as UTC, independently of the host timezone.
  const value = ts.trim();
  const isoWithoutZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
  return Date.parse(isoWithoutZone.test(value) ? `${value}Z` : value);
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Snapshot card counts and all valid activity totals, with a UTC weekly trend.
 * `now` is required (epoch milliseconds). Range endpoints and weekStart are ISO
 * UTC strings; the trend covers [from, now], including the partial current week.
 * lastActiveAt preserves the source ts. Invalid activity timestamps count only
 * toward skipped. Unknown members have role null; task-only identities fall back
 * to their stored name / ID until a valid activity supplies an author.
 */
function memberContributions(board, { users = [], now, weeks = 8 } = {}) {
  if (typeof now !== 'number' || !Number.isFinite(new Date(now).getTime())) {
    throw new TypeError('now must be a valid millisecond timestamp');
  }
  if (!Number.isSafeInteger(weeks) || weeks < 1) {
    throw new RangeError('weeks must be a positive integer');
  }
  const from = mondayAtUtc(now) - (weeks - 1) * WEEK_MS;
  const weekStarts = Array.from({ length: weeks }, (_, i) => new Date(from + i * WEEK_MS).toISOString());
  const weekly = () => weekStarts.map(weekStart => ({ weekStart, completed: 0, messages: 0, ops: 0 }));
  const membersById = new Map();
  const latestTimes = new Map();

  function member(userId, name = userId) {
    if (!membersById.has(userId)) {
      membersById.set(userId, {
        userId, name, role: null, unknownUser: true,
        created: 0, claimed: 0,
        completedAsOwner: 0, completedAsCollaborator: 0,
        inProgressAsOwner: 0, inProgressAsCollaborator: 0,
        messages: 0, progressUpdates: 0, statusChanges: 0, aiOps: 0,
        ops: 0, lastActiveAt: null, weekly: weekly(),
      });
    }
    return membersById.get(userId);
  }

  for (const user of users) {
    Object.assign(member(user.id), { name: user.displayName, role: user.role, unknownUser: false });
  }
  const unattributed = {
    messages: 0, statusChanges: 0, ops: 0, weekly: weekly(), completedWithoutMember: 0,
  };

  for (const task of board.tasks || []) {
    if (task.createdByUserId) member(task.createdByUserId).created++;
    const completed = task.status === '已完工';
    const inProgress = task.status === '施工中';
    if (!completed && !inProgress) continue;
    if (task.assigneeUserId) {
      const owner = member(task.assigneeUserId, task.assigneeName || task.assigneeUserId);
      owner[completed ? 'completedAsOwner' : 'inProgressAsOwner']++;
    } else if (completed) {
      unattributed.completedWithoutMember++;
    }
    const seen = new Set([task.assigneeUserId]);
    for (const collaborator of task.collaborators || []) {
      if (!collaborator.userId || seen.has(collaborator.userId)) continue;
      seen.add(collaborator.userId);
      member(collaborator.userId, collaborator.name || collaborator.userId)[
        completed ? 'completedAsCollaborator' : 'inProgressAsCollaborator'
      ]++;
    }
  }

  let skipped = 0;
  for (const activity of board.activity || []) {
    const time = activityTime(activity.ts);
    if (!Number.isFinite(time)) {
      skipped++;
      continue;
    }
    const target = activity.userId ? member(activity.userId) : unattributed;
    target.ops++;
    if (activity.kind === 'message') target.messages++;
    if (STATUS_CHANGES.has(activity.type)) target.statusChanges++;
    if (activity.userId) {
      if (activity.type === 'collaboration:claim') target.claimed++;
      if (activity.type === 'collaboration:progress') target.progressUpdates++;
      if (activity.via === 'ai') target.aiOps++;
      const latest = latestTimes.get(activity.userId);
      if (latest === undefined || time >= latest) {
        latestTimes.set(activity.userId, time);
        target.lastActiveAt = activity.ts;
        if (target.unknownUser) target.name = activity.author || activity.userId;
      }
    }
    if (time >= from && time <= now) {
      const bucket = target.weekly[Math.floor((time - from) / WEEK_MS)];
      bucket.ops++;
      if (activity.type === 'done') bucket.completed++;
      if (activity.kind === 'message') bucket.messages++;
    }
  }

  const members = [...membersById.values()].sort((a, b) =>
    (b.completedAsOwner + b.completedAsCollaborator) - (a.completedAsOwner + a.completedAsCollaborator)
    || b.ops - a.ops || compareText(a.name, b.name) || compareText(a.userId, b.userId));
  return { members, unattributed, range: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), weeks }, skipped };
}

module.exports = { memberContributions };
