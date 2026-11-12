'use strict';
// Single-instance authentication ledger. Never recover implicitly: a missing,
// truncated or invalid ledger fails closed. Local recovery is an explicit CLI act.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withLock } = require('./lock.cjs');
const { sleepMs } = require('./atomicWrite.cjs');
const { DASHBOARD_HOME, REGISTRY_PATH, readRegistry } = require('./resolveProject.cjs');
const WEEK = 7 * 86400000;
const DEVICE_LIFETIME = 90 * 86400000;
const MAX_USER_SESSIONS = 32;
const MAX_DEVICE_SESSIONS = 4;
const token = () => crypto.randomBytes(32).toString('base64url');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const csrf = value => digest('dashboard-csrf:' + value);
const HEX = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function username(value) {
  if (typeof value !== 'string') fail(400, 'Invalid username');
  const name = value.normalize('NFKC').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(name)) fail(400, 'Username must be 3-64 ASCII letters, digits, dots, underscores or hyphens');
  return name;
}
function password(value) {
  if (typeof value !== 'string' || [...value].length < 6 || [...value].length > 128) fail(400, 'Password must be 6-128 characters');
  return value;
}
// One expensive hash in flight, at most eight waiting; never block the event loop.
const HASH_QUEUE_LIMIT = 8;
let hashing = false;
const hashQueue = [];
function drain() {
  if (hashing || !hashQueue.length) return;
  hashing = true;
  const { value, salt, resolve, reject } = hashQueue.shift();
  crypto.scrypt(value, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (err, key) => {
    hashing = false;
    if (err) reject(err); else resolve(key.toString('hex'));
    drain();
  });
}
function hashPassword(value, salt) {
  if (hashQueue.length >= HASH_QUEUE_LIMIT) fail(429, 'Authentication busy; retry later');
  return new Promise((resolve, reject) => { hashQueue.push({ value, salt, resolve, reject }); drain(); });
}
function createAttemptLimiter(now = Date.now) {
  const entries = new Map();
  function check(key) {
    const time = now();
    for (const [k, v] of entries) if (v.until <= time) entries.delete(k);
    if ((entries.get(key)?.count || 0) >= 10) fail(429, 'Retry later');
  }
  return {
    check,
    take(key) {
      check(key);
      if (!entries.has(key)) {
        if (entries.size >= 2048) fail(429, 'Authentication capacity reached; retry later');
        entries.set(key, { count: 0, until: now() + 15 * 60000 });
      }
      entries.get(key).count++;
    },
    clear: key => entries.delete(key),
    get size() { return entries.size; },
  };
}
// Allocate buckets only for existing accounts / validated invitations / devices.
// Arbitrary anonymous names cannot fill the map. Never key on the proxy address:
// a shared reverse proxy is not a user identity. Expensive anonymous work is
// admitted by the process-wide one-active/eight-waiting scrypt capacity above.
const attempts = createAttemptLimiter();
// Unknown device guesses have a separate bounded budget, so neither a proxy
// address nor guessed bearer strings can exhaust legitimate account buckets.
const invalidDevices = createAttemptLimiter();
const invalidResets = createAttemptLimiter();
function grantRole(role = 'member') {
  if (!['member', 'viewer'].includes(role)) fail(400, 'Invalid role');
  return role;
}
function publicUser(u) { return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, projectIds: [...u.projectIds], disabled: u.disabled }; }
function publicInvite(i) { return { id: i.id, role: i.role || 'member', projectIds: [...i.projectIds], expiresAt: i.expiresAt, maxUses: i.maxUses, uses: i.uses, revoked: i.revoked }; }
function publicReset(r) { return { id: r.id, userId: r.userId, expiresAt: r.expiresAt, used: r.used }; }
// Pre-remember-device ledgers had no expiresAt. Their fixed deadline is derived
// from creation, never from their next use; no implicit migration or renewal.
function deviceExpiry(d) { return d.expiresAt || new Date(Date.parse(d.createdAt) + DEVICE_LIFETIME).toISOString(); }
function publicDevice(d) { return { id: d.id, label: d.label, createdAt: d.createdAt, expiresAt: deviceExpiry(d), revoked: d.revoked }; }
function validLedger(db) {
  const obj = v => v && typeof v === 'object' && !Array.isArray(v);
  const str = v => typeof v === 'string' && v.length > 0;
  const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  const ids = v => Array.isArray(v) && v.every(str) && new Set(v).size === v.length;
  if (!obj(db) || db.version !== 1 || !['users', 'sessions', 'invites', 'devices'].every(k => Array.isArray(db[k]))) return false;
  for (const k of ['users', 'sessions', 'invites', 'devices']) if (!db[k].every(obj) || !ids(db[k].map(v => v.id))) return false;
  if (!db.users.length || !db.users.some(u => u.role === 'owner' && u.disabled === false)) return false;
  if (!db.users.every(u => str(u.id) && str(u.username) && str(u.displayName) && ['owner', 'member', 'viewer'].includes(u.role) && typeof u.disabled === 'boolean' && ids(u.projectIds) && /^[a-f0-9]{32}$/.test(u.salt) && /^[a-f0-9]{128}$/.test(u.passwordHash))) return false;
  if (new Set(db.users.map(u => u.username)).size !== db.users.length) return false;
  const userExists = id => db.users.some(u => u.id === id);
  if (db.resets !== undefined && (!Array.isArray(db.resets) || !db.resets.every(obj) || !ids(db.resets.map(r => r.id)) ||
      !db.resets.every(r => userExists(r.userId) && typeof r.tokenHash === 'string' && HEX.test(r.tokenHash) && date(r.expiresAt) && typeof r.used === 'boolean'))) return false;
  if (!db.invites.every(i => i.role === undefined || ['member', 'viewer'].includes(i.role))) return false;
  if (!db.devices.every(d => str(d.label) && userExists(d.userId) && HEX.test(d.tokenHash) && date(d.createdAt) && (d.expiresAt === undefined || date(d.expiresAt)) && typeof d.revoked === 'boolean')) return false;
  if (!db.sessions.every(s => userExists(s.userId) && HEX.test(s.tokenHash) && date(s.expiresAt) && (s.deviceId === null || db.devices.some(d => d.id === s.deviceId && d.userId === s.userId)))) return false;
  if (!db.invites.every(i => HEX.test(i.tokenHash) && ids(i.projectIds) && date(i.expiresAt) && Number.isSafeInteger(i.maxUses) && i.maxUses > 0 && Number.isSafeInteger(i.uses) && i.uses >= 0 && i.uses <= i.maxUses && typeof i.revoked === 'boolean')) return false;
  return true;
}
// The generic writer creates 0666 temporary files. Authentication instead opens
// same-directory exclusive 0600 staging files before any secret bytes are written.
// Reuse its bounded retry primitive; do not unlink a valid destination on failure.
function secureWrite(dest, content) {
  const temp = path.join(path.dirname(dest), '.' + path.basename(dest) + '.' + token() + '.tmp');
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    for (let n = 0; ; n++) {
      try { fs.renameSync(temp, dest); break; }
      catch (e) { if (n >= 4 || !['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(e.code)) throw e; sleepMs(15 * 2 ** n); }
    }
    fs.chmodSync(dest, 0o600);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function createAuth({ home = DASHBOARD_HOME, registryPath = process.env.DASHBOARD_REGISTRY || REGISTRY_PATH } = {}) {
  const dir = path.join(home, 'private');
  const file = path.join(dir, 'collaboration-auth.json');
  const backup = file + '.bak';
  const lock = file + '.lock';
  function prepare() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(dir).isSymbolicLink()) fail(503, 'Authentication unavailable');
    fs.chmodSync(dir, 0o700);
  }
  function read(from = file) {
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Invalid private directory');
      const st = fs.lstatSync(from);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('Invalid ledger');
      const db = JSON.parse(fs.readFileSync(from, 'utf8'));
      if (!validLedger(db)) throw new Error('Invalid ledger');
      return db;
    } catch { fail(503, 'Authentication unavailable'); }
  }
  function save(db) {
    if (!validLedger(db)) fail(503, 'Authentication unavailable');
    db.resets ??= [];
    db.invites.forEach(i => { i.role ??= 'member'; });
    // Keep the previous validated state for explicit, offline operator recovery.
    if (fs.existsSync(file)) secureWrite(backup, JSON.stringify(read()));
    secureWrite(file, JSON.stringify(db));
  }
  function transaction(fn) {
    return withLock(lock, () => { const db = read(); const result = fn(db); save(db); return result; });
  }
  function projectIds(value) {
    if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string')) fail(400, 'Invalid projectIds');
    const reg = readRegistry(registryPath);
    if (value.some(id => !Object.hasOwn(reg.projects || {}, id))) fail(400, 'Invalid projectIds');
    return [...new Set(value)];
  }
  function sessionIn(db, raw) {
    if (typeof raw !== 'string' || !TOKEN.test(raw)) return null;
    const s = db.sessions.find(s => s.tokenHash === digest(raw) && Date.parse(s.expiresAt) > Date.now());
    if (!s) return null;
    const u = db.users.find(u => u.id === s.userId && !u.disabled);
    if (!u || (s.deviceId && !db.devices.some(d => d.id === s.deviceId && d.userId === u.id && deviceActive(db, d)))) return null;
    return { user: publicUser(u), sessionId: s.id, deviceId: s.deviceId, csrfToken: csrf(raw) };
  }
  function deviceActive(db, d) {
    return !d.revoked && Date.parse(deviceExpiry(d)) > Date.now() && db.users.some(u => u.id === d.userId && !u.disabled);
  }
  function deviceIn(db, raw) {
    if (typeof raw !== 'string' || !TOKEN.test(raw)) return null;
    return db.devices.find(d => d.tokenHash === digest(raw) && deviceActive(db, d)) || null;
  }
  function requireSession(db, raw, owner = false) {
    const s = sessionIn(db, raw);
    if (!s) fail(401, 'Login required');
    if (owner && s.user.role !== 'owner') fail(403, 'Forbidden');
    return s;
  }
  function issue(db, userId, deviceId = null) {
    db.sessions = db.sessions.filter(s => Date.parse(s.expiresAt) > Date.now() &&
      (!s.deviceId || db.devices.some(d => d.id === s.deviceId && deviceActive(db, d))));
    // Keep a small recent window for parallel tabs. Even cookie-less GET retries
    // cannot accumulate unlimited live sessions; all persisted tokens stay hashed.
    const trim = (matches, limit) => {
      const excess = db.sessions.filter(matches).slice(0, Math.max(0, db.sessions.filter(matches).length - limit + 1));
      const ids = new Set(excess.map(s => s.id));
      db.sessions = db.sessions.filter(s => !ids.has(s.id));
    };
    trim(s => s.userId === userId, MAX_USER_SESSIONS);
    if (deviceId) trim(s => s.deviceId === deviceId, MAX_DEVICE_SESSIONS);
    const raw = token();
    const device = deviceId ? db.devices.find(d => d.id === deviceId) : null;
    const deadline = Math.min(Date.now() + WEEK, device ? Date.parse(deviceExpiry(device)) : Infinity);
    db.sessions.push({ id: crypto.randomUUID(), tokenHash: digest(raw), userId, deviceId, expiresAt: new Date(deadline).toISOString() });
    return { token: raw, ...sessionIn(db, raw) };
  }
  async function bootstrap(name, secret) {
    name = username(name); password(secret); prepare();
    const pristine = () => { if (fs.existsSync(file) || fs.existsSync(backup)) fail(409, 'Already initialized; use explicit local recovery'); };
    withLock(lock, pristine);
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(secret, salt);
    return withLock(lock, () => {
      pristine();
      const u = { id: crypto.randomUUID(), username: name, displayName: name, role: 'owner', projectIds: [], disabled: false, salt, passwordHash };
      save({ version: 1, users: [u], invites: [], devices: [], sessions: [] });
      return publicUser(u);
    });
  }
  async function login(name, secret, client = 'local', deviceCookie = '') {
    name = username(name);
    const u = read().users.find(u => u.username === name);
    const key = u && 'user:' + u.id;
    if (key) attempts.check(key);
    try {
      password(secret);
      const computed = await hashPassword(secret, u ? u.salt : '00000000000000000000000000000000');
      if (!u || u.disabled || !crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(u.passwordHash, 'hex'))) fail(401, 'Invalid credentials');
      const result = transaction(db => {
        const current = db.users.find(c => c.id === u.id && !c.disabled && c.passwordHash === u.passwordHash);
        if (!current) fail(401, 'Invalid credentials');
        const device = deviceIn(db, deviceCookie);
        // An already trusted cookie may accompany password login; never create
        // trust by default, and never attach another account's device.
        return issue(db, u.id, device && device.userId === u.id ? device.id : null);
      });
      if (key) attempts.clear(key);
      return result;
    } catch (e) {
      // Count actual failed credentials, not queued work or capacity rejection.
      // A burst already admitted is bounded by the global nine-job hash limit.
      if (key && [400, 401].includes(e.status)) attempts.take(key);
      throw e;
    }
  }
  function validInvite(db, raw) {
    const i = typeof raw === 'string' && TOKEN.test(raw) && db.invites.find(i => i.tokenHash === digest(raw));
    if (!i || i.revoked || i.uses >= i.maxUses || Date.parse(i.expiresAt) <= Date.now()) fail(400, 'Invalid invitation');
    projectIds(i.projectIds);
    return i;
  }
  async function register(body, client = 'local') {
    const pre = read(); const invitation = validInvite(pre, body.inviteToken);
    const key = 'invite:' + invitation.id;
    attempts.check(key);
    try {
      const name = username(body.username); password(body.password);
      const displayName = body.displayName === undefined ? name : body.displayName;
      if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 128) fail(400, 'Invalid displayName');
      if (pre.users.some(u => u.username === name)) fail(409, 'Username unavailable');
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = await hashPassword(body.password, salt);
      const result = transaction(db => {
        const i = validInvite(db, body.inviteToken);
        if (db.users.some(u => u.username === name)) fail(409, 'Username unavailable');
        const u = { id: crypto.randomUUID(), username: name, displayName: displayName.trim(), role: i.role || 'member', projectIds: [...i.projectIds], disabled: false, salt, passwordHash };
        db.users.push(u); i.uses++;
        return issue(db, u.id);
      });
      attempts.clear(key);
      return result;
    } catch (e) {
      if ([400, 409].includes(e.status)) attempts.take(key);
      throw e;
    }
  }
  function ownerMutation(raw, fn) { return transaction(db => { const s = requireSession(db, raw, true); return fn(db, s.user); }); }
  function createInvite(raw, body) {
    return ownerMutation(raw, db => {
      const ids = projectIds(body.projectIds);
      if (!ids.length) fail(400, 'Invalid projectIds');
      if (!Number.isFinite(body.expiresInHours) || body.expiresInHours <= 0 || body.expiresInHours > 8760 || !Number.isSafeInteger(body.maxUses) || body.maxUses < 1 || body.maxUses > 100000) fail(400, 'Invalid invitation limits');
      const rawToken = token();
      const i = { id: crypto.randomUUID(), role: grantRole(body.role), tokenHash: digest(rawToken), projectIds: ids, expiresAt: new Date(Date.now() + body.expiresInHours * 3600000).toISOString(), maxUses: body.maxUses, uses: 0, revoked: false };
      db.invites.push(i); return { invite: publicInvite(i), token: rawToken };
    });
  }
  function addDevice(db, u, label) {
    if (typeof label !== 'string' || !label.trim() || label.length > 128) fail(400, 'Invalid label');
    const raw = token();
    const created = Date.now();
    const d = { id: crypto.randomUUID(), userId: u.id, label: label.trim(), tokenHash: digest(raw), createdAt: new Date(created).toISOString(), expiresAt: new Date(created + DEVICE_LIFETIME).toISOString(), revoked: false };
    db.devices.push(d); return { device: publicDevice(d), token: raw };
  }
  function revokeDeviceIn(db, id) {
    const d = db.devices.find(d => d.id === id);
    if (d) d.revoked = true;
    db.sessions = db.sessions.filter(s => s.deviceId !== id);
  }
  function myDevices(raw) {
    const db = read(); const { user } = requireSession(db, raw);
    return db.devices.filter(d => d.userId === user.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(publicDevice);
  }
  function createMyDevice(raw, label) {
    return transaction(db => {
      const s = requireSession(db, raw);
      if (s.deviceId !== null) fail(403, 'Password session required');
      if (typeof label !== 'string' || !label.trim() || label.length > 128) fail(400, 'Invalid label');
      if (db.devices.filter(d => d.userId === s.user.id && deviceActive(db, d)).length >= 10) fail(409, 'Too many devices');
      return addDevice(db, s.user, label);
    });
  }
  function revokeMyDevice(raw, id) {
    return transaction(db => {
      const { user } = requireSession(db, raw);
      if (!db.devices.some(d => d.id === id && d.userId === user.id)) fail(404, 'Not found');
      revokeDeviceIn(db, id);
      return {};
    });
  }
  function rememberDevice(raw, label) {
    return transaction(db => {
      const current = requireSession(db, raw, true);
      const session = db.sessions.find(s => s.id === current.sessionId);
      const result = addDevice(db, current.user, label);
      if (session.deviceId) {
        // Replace this browser's former trust only, preserving other devices.
        const previous = session.deviceId;
        session.deviceId = result.device.id;
        revokeDeviceIn(db, previous);
      } else session.deviceId = result.device.id;
      return result;
    });
  }
  function restoreSession(deviceCookie) {
    // Invalid cookies do not write or create an auth store. Revalidate inside
    // the lock before issuing so concurrent revocation always wins at commit.
    if (!deviceIn(read(), deviceCookie)) return null;
    return transaction(db => {
      const d = deviceIn(db, deviceCookie);
      return d ? issue(db, d.userId, d.id) : null;
    });
  }
  function logout(raw, deviceCookie = '') {
    return transaction(db => {
      const current = requireSession(db, raw);
      const device = deviceIn(db, deviceCookie);
      // A stolen/mismatched device cookie must not become a cross-account or
      // cross-device revocation primitive. The session must bind this device.
      if (device && device.userId === current.user.id && device.id === current.deviceId) revokeDeviceIn(db, device.id);
      db.sessions = db.sessions.filter(s => s.id !== current.sessionId);
    });
  }
  function access(raw, id, body) {
    return ownerMutation(raw, db => {
      const u = db.users.find(u => u.id === id);
      if (!u) fail(404, 'Not found');
      const ids = projectIds(body.projectIds);
      if (typeof body.disabled !== 'boolean') fail(400, 'Invalid disabled');
      if (body.role !== undefined) {
        grantRole(body.role);
        if (u.role === 'owner') fail(403, 'Cannot change owner role');
        u.role = body.role;
      }
      if (u.role === 'owner' && body.disabled && db.users.filter(x => x.role === 'owner' && !x.disabled).length <= 1) fail(409, 'Cannot disable last owner');
      u.projectIds = ids; u.disabled = body.disabled;
      if (u.disabled) db.sessions = db.sessions.filter(s => s.userId !== id);
      return { user: publicUser(u) };
    });
  }
  function revoke(raw, kind, id) {
    return ownerMutation(raw, db => {
      const item = db[kind].find(i => i.id === id);
      if (!item) fail(404, 'Not found');
      item.revoked = true;
      if (kind === 'devices') db.sessions = db.sessions.filter(s => s.deviceId !== id);
      return {};
    });
  }
  function deviceLogin(raw, client = 'local') {
    const device = deviceIn(read(), raw);
    if (!device) {
      invalidDevices.take(digest(typeof raw === 'string' ? raw : ''));
      fail(401, 'Invalid credentials');
    }
    const key = 'device:' + device.id;
    attempts.take(key);
    const result = transaction(db => {
      const d = deviceIn(db, raw);
      if (!d) fail(401, 'Invalid credentials');
      return issue(db, d.userId, d.id);
    });
    attempts.clear(key);
    return result;
  }
  async function changePassword(raw, body) {
    const pre = read();
    const current = requireSession(pre, raw);
    const previous = pre.users.find(u => u.id === current.user.id);
    const key = 'password:' + previous.id;
    attempts.take(key);
    password(body.newPassword);
    if (typeof body.currentPassword !== 'string' || body.currentPassword.length > 256) fail(400, 'Invalid current password');
    const computed = await hashPassword(body.currentPassword, previous.salt);
    if (!crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(previous.passwordHash, 'hex'))) fail(400, 'Invalid current password');
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(body.newPassword, salt);
    transaction(db => {
      const session = requireSession(db, raw);
      const u = db.users.find(u => u.id === session.user.id);
      if (u.passwordHash !== previous.passwordHash) fail(400, 'Current password changed');
      Object.assign(u, { salt, passwordHash });
      db.sessions = db.sessions.filter(s => s.userId !== u.id || s.id === session.sessionId);
      db.devices.filter(d => d.userId === u.id && d.id !== session.deviceId).forEach(d => { d.revoked = true; });
    });
    return {};
  }
  function createReset(raw, id) {
    return ownerMutation(raw, db => {
      const u = db.users.find(u => u.id === id);
      if (!u) fail(404, 'Not found');
      if (!['member', 'viewer'].includes(u.role)) fail(403, 'Cannot reset owner');
      db.resets ??= [];
      db.resets.filter(r => r.userId === id && !r.used).forEach(r => { r.used = true; });
      const resetToken = token();
      const r = { id: crypto.randomUUID(), userId: id, tokenHash: digest(resetToken), expiresAt: new Date(Date.now() + 86400000).toISOString(), used: false };
      db.resets.push(r);
      return { reset: publicReset(r), resetToken };
    });
  }
  function resetIn(db, raw) {
    const r = typeof raw === 'string' && TOKEN.test(raw) && (db.resets || []).find(r => r.tokenHash === digest(raw));
    return r && !r.used && Date.parse(r.expiresAt) > Date.now() ? r : null;
  }
  async function resetPassword(body) {
    const pre = read();
    const record = resetIn(pre, body.resetToken);
    if (!record) {
      invalidResets.take(digest(typeof body.resetToken === 'string' ? body.resetToken : ''));
      fail(400, 'Invalid reset code');
    }
    attempts.take('reset:' + record.id);
    const eligible = (db, r) => {
      const u = db.users.find(u => u.id === r.userId && !u.disabled && ['member', 'viewer'].includes(u.role));
      if (!u) fail(403, 'Reset unavailable');
      return u;
    };
    eligible(pre, record);
    password(body.newPassword);
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(body.newPassword, salt);
    return transaction(db => {
      const r = resetIn(db, body.resetToken);
      if (!r || r.id !== record.id) fail(400, 'Invalid reset code');
      const u = eligible(db, r);
      Object.assign(u, { salt, passwordHash });
      r.used = true;
      db.sessions = db.sessions.filter(s => s.userId !== u.id);
      db.devices.filter(d => d.userId === u.id).forEach(d => { d.revoked = true; });
      return issue(db, u.id);
    });
  }
  async function resetOwner(name, secret) {
    name = username(name); password(secret);
    const previous = read().users.find(u => u.username === name && u.role === 'owner');
    if (!previous) fail(404, 'Not found');
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(secret, salt);
    transaction(db => {
      const u = db.users.find(u => u.id === previous.id && u.role === 'owner' && u.passwordHash === previous.passwordHash);
      if (!u) fail(409, 'Owner changed');
      Object.assign(u, { salt, passwordHash, disabled: false });
      db.sessions = db.sessions.filter(s => s.userId !== u.id);
      db.devices.filter(d => d.userId === u.id).forEach(d => { d.revoked = true; });
    });
  }
  return {
    bootstrap, login, register, access, createInvite, deviceLogin, resetOwner, rememberDevice, restoreSession, logout,
    changePassword, createReset, resetPassword, myDevices, createMyDevice, revokeMyDevice,
    projectDirectory: projectId => read().users
      .filter(u => u.role === 'owner' || u.projectIds.includes(projectId))
      .map(u => ({ id: u.id, displayName: u.displayName, role: u.role, disabled: u.disabled })),
    session: raw => sessionIn(read(), raw),
    // Hold auth before board, consistently. Revocation cannot race the board commit.
    withSession: (raw, fn) => withLock(lock, () => fn(requireSession(read(), raw))),
    revokeAllCredentials: () => transaction(db => {
      db.sessions = [];
      db.devices.forEach(d => { d.revoked = true; });
      db.invites.forEach(i => { i.revoked = true; });
      (db.resets || []).forEach(r => { r.used = true; });
    }),
    admin: raw => { const db = read(); requireSession(db, raw, true); return { users: db.users.map(publicUser), invites: db.invites.map(publicInvite), devices: db.devices.map(d => ({ ...publicDevice(d), userId: d.userId })), resets: (db.resets || []).map(publicReset) }; },
    createDevice: (raw, label) => ownerMutation(raw, (db, u) => addDevice(db, u, label)),
    revokeInvite: (raw, id) => revoke(raw, 'invites', id),
    revokeDevice: (raw, id) => revoke(raw, 'devices', id),
    localDevice: (name, label) => transaction(db => { const u = db.users.find(u => u.username === username(name) && u.role === 'owner' && !u.disabled); if (!u) fail(404, 'Not found'); return addDevice(db, u, label); }),
    restoreBackup: () => { prepare(); return withLock(lock, () => {
      const db = read(backup);
      // Recovery never resurrects an old bearer credential.
      db.sessions = []; db.invites.forEach(i => { i.revoked = true; i.role ??= 'member'; }); db.devices.forEach(d => { d.revoked = true; });
      db.resets ??= [];
      db.resets.forEach(r => { r.used = true; });
      secureWrite(file, JSON.stringify(db));
    }); },
  };
}
module.exports = { createAuth, fail, username, publicUser, csrf, createAttemptLimiter,
  authenticationCapacity: () => ({ active: Number(hashing), queued: hashQueue.length, queueLimit: HASH_QUEUE_LIMIT,
    attemptEntries: attempts.size, invalidDeviceEntries: invalidDevices.size, invalidResetEntries: invalidResets.size }) };
