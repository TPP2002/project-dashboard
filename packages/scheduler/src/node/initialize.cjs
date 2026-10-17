'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Explicit fresh installation only. Production migration retains its existing
// control, records and cutover evidence; this command cannot replace them.
function initializeFreshNode({ root, machine, head, actor = 'node-administrator' }) {
  const c = require('../bot/cluster-lifecycle-contract.js');
  const { lifecyclePaths } = require('../bot/cluster-lifecycle-control.js');
  const { COLD_CUTOVER_RECEIPT_SCHEMA, readLifecycleStatusSnapshot } = require('../bot/cluster-lifecycle-status.js');
  c.requireSafeSegment(machine, 'machine'); c.requireSha1(head, 'head'); c.requireText(actor, 'actor');
  if (!path.isAbsolute(root ?? '')) throw new Error('INITIALIZATION_ABSOLUTE_ROOT_REQUIRED');
  root = path.resolve(root);
  const parent = path.dirname(root), canonicalParent = fs.realpathSync(parent);
  if (path.resolve(canonicalParent).toLowerCase() !== parent.toLowerCase()) throw new Error('INITIALIZATION_CANONICAL_PARENT_REQUIRED');
  // Atomic mkdir refuses every existing directory, even an apparently empty one.
  fs.mkdirSync(root, { mode: 0o700 });
  const epoch = `fresh-${randomUUID()}`, at = new Date().toISOString(), paths = lifecyclePaths(root, epoch, machine);
  fs.mkdirSync(path.join(root, 'jobs'), { mode: 0o700 });
  for (const state of c.LIFECYCLE_STATES) fs.mkdirSync(paths[state], { recursive: true, mode: 0o700 });
  const receipts = path.join(paths.root, '_control', 'receipts');
  fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
  const receipt = { receiptSchema: COLD_CUTOVER_RECEIPT_SCHEMA, namespace: c.LIFECYCLE_NAMESPACE,
    lifecycleSchema: c.LIFECYCLE_SCHEMA, epoch, mergeSha: head, configuredMachines: [machine],
    controlState: 'ACTIVE', coldMode: true, freshInitialization: true, createdAt: at, createdBy: actor };
  fs.writeFileSync(path.join(receipts, `cutover-${epoch}.json`), JSON.stringify({ ...receipt,
    receiptSha256: c.lifecyclePayloadSha256(receipt) }), { flag: 'wx', mode: 0o600 });
  // Publish control last; partial setup remains visibly incomplete on failure.
  fs.writeFileSync(paths.control, JSON.stringify({ namespace: c.LIFECYCLE_NAMESPACE, lifecycleSchema: c.LIFECYCLE_SCHEMA,
    epoch, state: 'ACTIVE', codeVersion: head, configuredMachines: [machine], createdAt: at, createdBy: actor }), { flag: 'wx', mode: 0o600 });
  readLifecycleStatusSnapshot(root, undefined, { tolerateMachineFaults: true });
  return { root, epoch, machine, head };
}
module.exports = { initializeFreshNode };
