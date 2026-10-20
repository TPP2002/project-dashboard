'use strict';

const { memberContributions } = require('./collaborationContrib.cjs');
const { text } = require('./collaborationPublic.cjs');

const ACTIONS = {
  claim: 'claim', progress: 'progress',
  'collaboration:claim': 'claim', 'collaboration:progress': 'progress',
  'collaboration:join': 'join', 'collaboration:leave': 'leave',
  'collaboration:remove-collaborator': 'removeCollaborator',
  unclaim: 'unclaim', park: 'park', unpark: 'unpark', done: 'done', cancel: 'cancel', reopen: 'reopen',
};
function action(activity) {
  if (activity.kind === 'message') return 'message';
  if (activity.type === 'note' && activity.kind === undefined && typeof activity.text === 'string' && activity.text.startsWith('新建任务')) return 'create';
  return Object.hasOwn(ACTIONS, activity.type) ? ACTIONS[activity.type] : 'other';
}
// Same explicit timestamp formats as the contribution core. Invalid times sort
// last and are represented as null, never echoed as arbitrary activity text.
function activityTime(ts) {
  if (typeof ts === 'number') return new Date(ts).getTime();
  if (typeof ts !== 'string' || !ts.trim()) return NaN;
  let value = ts.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T00:00:00Z`);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) value = value.replace(' ', 'T');
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  return match ? Date.parse(match[1] ? value : `${value}Z`) : NaN;
}

function contributionView(board, { users = [], now, weeks = 8, role } = {}) {
  if (!['owner', 'member', 'viewer'].includes(role)) throw new TypeError('Invalid contribution role');
  const tasks = board.tasks || [];
  const activities = board.activity || [];
  // Cloud replay uses CLI activity types. Normalize only signed events in a
  // separate view; the merged board may be shared with other cached readers.
  const normalized = activities.map(a => a.userId && ['claim', 'progress'].includes(a.type)
    ? { ...a, type: `collaboration:${a.type}` } : a);
  const raw = memberContributions({ ...board, activity: normalized }, { users, now, weeks });
  const totals = {
    completed: tasks.filter(t => t.status === '已完工').length,
    completedWithCollaborators: tasks.filter(t => t.status === '已完工' && t.collaborators?.length > 0).length,
    inProgress: tasks.filter(t => t.status === '施工中').length,
    activeMembers: raw.members.filter(m => m.inProgressAsOwner + m.inProgressAsCollaborator > 0).length,
    createdByMembers: tasks.filter(t => t.createdByUserId).length,
    createdOther: tasks.filter(t => !t.createdByUserId).length,
    messages: activities.filter(a => a.kind === 'message').length,
    aiOps: activities.filter(a => a.via === 'ai').length,
    attributedOps: activities.filter(a => a.userId).length,
  };
  const buckets = new Map(raw.unattributed.weekly.map(w => [w.weekStart, { ...w }]));
  for (const member of raw.members) for (const w of member.weekly) {
    const bucket = buckets.get(w.weekStart);
    for (const key of ['completed', 'messages', 'ops']) bucket[key] += w[key];
  }
  const weekly = [...buckets.values()];
  // Explicit allowlist: summary never acquires any person-shaped fields.
  if (role === 'viewer') return { scope: 'summary', range: raw.range, totals, weekly };

  // Keep raw IDs as lookup keys: distinct identities may scrub to the same text.
  const names = new Map(raw.members.map(m => [m.userId, m.name]));
  const members = raw.members.map(m => ({ ...m, userId: text(m.userId) ?? '', name: text(m.name) ?? '' }));
  const tasksById = new Map(tasks.map(t => [t.id, t]));
  const recent = activities.map((a, index) => ({ a, index, time: activityTime(a.ts) }))
    .filter(({ a }) => a.userId)
    .sort((a, b) => (Number.isFinite(b.time) ? b.time : -Infinity) - (Number.isFinite(a.time) ? a.time : -Infinity) || b.index - a.index)
    .slice(0, 20).map(({ a, time }) => {
      const task = tasksById.get(a.taskId);
      return {
        ts: Number.isFinite(time) ? a.ts : null,
        userId: text(a.userId) ?? '', name: text(names.get(a.userId) || a.author || a.userId) ?? '',
        action: action(a), taskId: text(a.taskId) ?? null,
        taskTitle: text(task?.plainTitle || task?.title) ?? '',
        ...(a.via === 'ai' ? { viaAi: true } : {}),
      };
    });
  return { scope: 'full', range: raw.range, totals, members, unattributed: raw.unattributed,
    weekly, membersWeekly: members.map(m => ({ userId: m.userId, weekly: m.weekly })), recent, skipped: raw.skipped };
}

module.exports = { contributionView };
