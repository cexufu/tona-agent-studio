const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { handleFeatureApi } = require('./feature-api');
const { createReminderEngine } = require('./reminder-engine');
const { SessionStore } = require('./session-store');
const { registrationMode, securityHeaders, clientAddress, createRateLimiter, probeWritableDirectory } = require('../runtime/production-guardrails');

const PORT = Number(process.env.PORT || 7360);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'teamflow.json');
const TEAMS_DIR = path.join(DATA_DIR, 'teams');
const teamContext = new AsyncLocalStorage();
const PUBLIC_DIR = path.join(__dirname, 'public');
const sessions = new SessionStore(path.join(DATA_DIR, 'sessions.json'));
const loginLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 8 });
const registerLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 5 });
const REGISTRATION_MODE = registrationMode(process.env);
const responseSecurityHeaders = securityHeaders(process.env);
if (process.env.NODE_ENV === 'production' && String(process.env.INITIAL_ADMIN_PASSWORD || '').length < 12) throw new Error('INITIAL_ADMIN_PASSWORD must be at least 12 characters in production.');

const ROLE_PERMISSIONS = {
  owner: ['team.manage', 'settings.manage', 'requirement.manage', 'task.manage', 'comment.create'],
  admin: ['team.manage', 'requirement.manage', 'task.manage', 'comment.create'],
  member: ['requirement.create', 'requirement.edit_own', 'task.manage_assigned', 'comment.create'],
  viewer: ['comment.create']
};

const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const clean = value => String(value ?? '').trim();
const dateOnly = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

function seedDatabase() {
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
  const ownerId = 'usr_owner';
  return {
    meta: { version: 1, createdAt: now() },
    settings: { teamName: '我们的小团队', reminderDays: 2 },
    users: [
      { id: ownerId, name: '林岚', email: 'admin@team.local', role: 'owner', title: '负责人', status: 'active', passwordHash: hashPassword(adminPassword), createdAt: now() },
    ],
    requirements: [],
    tasks: [],
    milestones: [],
    comments: [],
    activities: [{ id: id('act'), actorId: ownerId, action: '创建了示例需求', targetType: 'requirement', targetId: 'req_demo', createdAt: now() }]
  };
}

function futureDate(offset) {
  const value = new Date();
  value.setDate(value.getDate() + offset);
  return value.toISOString().slice(0, 10);
}

function atomicWrite(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.renameSync(temp, file);
}

function teamFile(teamId) {
  if (!/^team_[a-z0-9_]+$/i.test(String(teamId || ''))) throw new Error('Invalid team id');
  return path.join(TEAMS_DIR, teamId + '.json');
}

function initialTeamData(source, teamId) {
  return {
    meta: { version: 1, teamId, createdAt: now() },
    settings: { teamName: source.settings?.teamName || 'TeamFlow Team', reminderDays: Number(source.settings?.reminderDays || 2), teamKeyHash: source.settings?.teamKey ? hashPassword(source.settings.teamKey) : '' },
    users: source.users || [], requirements: source.requirements || [], tasks: source.tasks || [], milestones: source.milestones || [], comments: source.comments || [], activities: source.activities || [], reminderDeliveries: source.reminderDeliveries || []
  };
}

function migrateRegistry(raw) {
  if (raw.meta?.version >= 2 && Array.isArray(raw.teams) && Array.isArray(raw.users)) return raw;
  const teamId = 'team_owner';
  const team = initialTeamData(raw, teamId);
  fs.mkdirSync(TEAMS_DIR, { recursive: true });
  if (!fs.existsSync(teamFile(teamId))) atomicWrite(teamFile(teamId), team);
  return { meta: { version: 2, createdAt: raw.meta?.createdAt || now(), migratedAt: now(), migration: 'TEAMFLOW_MULTITENANT_V1' }, users: (raw.users || []).map(user => ({ id: user.id, name: user.name || '', title: user.title || '', email: user.email, passwordHash: user.passwordHash, status: user.status || 'active', teamIds: [teamId], lastTeamId: teamId, createdAt: user.createdAt || now() })), teams: [{ id: teamId, createdAt: now() }] };
}

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) { const registry = migrateRegistry(seedDatabase()); atomicWrite(DB_FILE, registry); return registry; }
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); const registry = migrateRegistry(raw); if (registry !== raw) atomicWrite(DB_FILE, registry); return registry;
}

let registry = loadDb();
const teamCache = new Map();
function loadTeamDb(teamId) { if (teamCache.has(teamId)) return teamCache.get(teamId); const file = teamFile(teamId); if (!fs.existsSync(file)) throw new Error('Team workspace not found'); const value = JSON.parse(fs.readFileSync(file, 'utf8')); teamCache.set(teamId, value); return value; }
function currentTeamId() { return teamContext.getStore()?.teamId || registry.teams?.[0]?.id || 'team_owner'; }
function currentTeamDb() { return teamContext.getStore()?.db || loadTeamDb(currentTeamId()); }
function persistRegistry() { atomicWrite(DB_FILE, registry); }
function syncAccounts(teamId, teamDb) {
  const activeIds = new Set(teamDb.users.map(user => user.id));
  registry.users.forEach(account => { if (account.teamIds?.includes(teamId) && !activeIds.has(account.id)) account.teamIds = account.teamIds.filter(id => id !== teamId); });
  teamDb.users.forEach(user => { let account = registry.users.find(item => item.id === user.id); if (!account) { account = { id: user.id, createdAt: user.createdAt || now(), teamIds: [] }; registry.users.push(account); } account.name = user.name || account.name || ''; account.title = user.title || account.title || ''; account.email = user.email; account.passwordHash = user.passwordHash; if (!account.status) account.status = 'active'; account.teamIds = Array.from(new Set([...(account.teamIds || []), teamId])); });
  persistRegistry();
}
function saveDb() { const active = teamContext.getStore(); if (!active) return persistRegistry(); syncAccounts(active.teamId, active.db); atomicWrite(teamFile(active.teamId), active.db); }
const db = new Proxy({}, { get(_target, key) { return currentTeamDb()[key]; }, set(_target, key, value) { currentTeamDb()[key] = value; return true; } });
function applyOneTimeAdminReset() {
  const password = String(process.env.TEAMFLOW_ADMIN_RESET_PASSWORD || '');
  if (!password) return;
  if (password.length < 12) throw new Error('TEAMFLOW_ADMIN_RESET_PASSWORD must be at least 12 characters.');
  const account = registry.users.find(user => user.email === 'admin@team.local');
  if (!account) { console.warn('Admin reset skipped: admin@team.local does not exist.'); return; }
  const passwordHash = hashPassword(password);
  account.passwordHash = passwordHash;
  for (const teamId of account.teamIds || []) {
    const team = loadTeamDb(teamId);
    const member = team.users.find(user => user.id === account.id);
    if (member) { member.passwordHash = passwordHash; atomicWrite(teamFile(teamId), team); }
  }
  persistRegistry();
  console.warn('Admin password reset applied. Remove TEAMFLOW_ADMIN_RESET_PASSWORD and redeploy immediately.');
}
applyOneTimeAdminReset();

const reminderEngine = createReminderEngine({ getDb: () => db, saveDb });

function json(res, status, body, headers = {}) {
  res.writeHead(status, { ...responseSecurityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(v => v.trim().split('=')).filter(v => v.length === 2));
}

function sessionFor(req) {
  const token = parseCookies(req).teamflow_session || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = sessions.get(token); return !session || session.expiresAt < Date.now() ? null : session;
}
function getUser(req) {
  const session = sessionFor(req); if (!session) return null;
  const account = registry.users.find(item => item.id === session.userId && item.status === 'active'); if (!account) return null;
  const teamId = session.teamId || account.lastTeamId || account.teamIds?.[0]; if (!teamId || !account.teamIds?.includes(teamId)) return null;
  const member = loadTeamDb(teamId).users.find(user => user.id === account.id && user.status === 'active'); return member ? { ...member, _teamId: teamId } : null;
}

function can(user, permission) {
  if (!user) return false;
  return (ROLE_PERMISSIONS[user.role] || []).includes(permission);
}

function publicUser(user) {
  const { passwordHash, ...safe } = user;
  return { ...safe, permissions: ROLE_PERMISSIONS[user.role] || [] };
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('请求内容过大'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON 格式不正确')); }
    });
  });
}

function logActivity(actorId, action, targetType, targetId) {
  db.activities.unshift({ id: id('act'), actorId, action, targetType, targetId, createdAt: now() });
  db.activities = db.activities.slice(0, 200);
}

function enrichRequirement(requirement) {
  const tasks = db.tasks.filter(task => task.requirementId === requirement.id);
  const done = tasks.filter(task => task.status === 'done').length;
  return { ...requirement, taskCount: tasks.length, completedTaskCount: done, computedProgress: tasks.length ? Math.round(done / tasks.length * 100) : requirement.progress || 0 };
}

function dashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const soon = futureDate(Number(db.settings.reminderDays || 2));
  const activeRequirements = db.requirements.filter(item => !['done', 'cancelled'].includes(item.status));
  const openTasks = db.tasks.filter(item => item.status !== 'done');
  const reminders = openTasks.filter(item => item.dueDate && item.dueDate <= soon).map(item => ({ ...item, kind: item.dueDate < today ? 'overdue' : 'due_soon' }));
  const milestoneReminders = db.milestones.filter(item => item.status !== 'done' && item.dueDate <= soon).map(item => ({ ...item, kind: item.dueDate < today ? 'overdue' : 'due_soon', isMilestone: true }));
  return {
    stats: { activeRequirements: activeRequirements.length, openTasks: openTasks.length, overdue: [...reminders, ...milestoneReminders].filter(i => i.kind === 'overdue').length, teamMembers: db.users.filter(u => u.status === 'active').length },
    priorityRequirements: activeRequirements.sort((a, b) => a.targetDate.localeCompare(b.targetDate)).slice(0, 5).map(enrichRequirement),
    reminders: [...reminders, ...milestoneReminders].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 8),
    activities: db.activities.slice(0, 8)
  };
}

function validateRequirement(body) {
  if (!clean(body.title)) return '请填写需求标题';
  if (!['P0', 'P1', 'P2', 'P3'].includes(body.priority)) return '优先级无效';
  return '';
}

function decomposeRequirement(requirement, actorId) {
  const owner = requirement.ownerId || actorId;
  const templates = [
    ['澄清需求范围与验收标准', 'todo', 4],
    ['完成方案设计与评审', 'todo', 8],
    ['开发实现与自测', 'todo', 16],
    ['联调、验收与发布', 'todo', 8]
  ];
  const base = requirement.targetDate ? new Date(`${requirement.targetDate}T12:00:00`) : new Date(Date.now() + 14 * 86400000);
  return templates.map(([title, status, estimate], index) => {
    const due = new Date(base);
    due.setDate(due.getDate() - (templates.length - 1 - index) * 2);
    return { id: id('task'), requirementId: requirement.id, title, description: `由“${requirement.title}”自动拆解，可按实际情况调整。`, status, priority: requirement.priority, assigneeId: owner, dueDate: due.toISOString().slice(0, 10), estimate, createdBy: actorId, createdAt: now(), updatedAt: now() };
  });
}

async function api(req, res, pathname) {
  if (pathname === '/api/health') {
    const dataWritable = probeWritableDirectory(DATA_DIR);
    return json(res, dataWritable ? 200 : 503, { ok: dataWritable, service: 'teamflow-lite', dataWritable, reminder: reminderEngine.status() });
  }
  if (pathname === '/api/registration-config') return json(res, 200, { mode: REGISTRATION_MODE, canRegister: REGISTRATION_MODE !== 'closed', inviteRequired: REGISTRATION_MODE === 'invite' });
  if (pathname === '/api/login' && req.method === 'POST') {
    const address = clientAddress(req);
    const limit = loginLimiter.consume(address);
    if (!limit.allowed) return json(res, 429, { error: 'Too many login attempts. Try again later.' }, { 'Retry-After': String(limit.retryAfter) });
    const body = await readBody(req);
    const account = registry.users.find(item => item.email.toLowerCase() === clean(body.email).toLowerCase());
    if (!account || account.status !== 'active' || !verifyPassword(String(body.password || ''), account.passwordHash)) return json(res, 401, { error: '邮箱或密码不正确' });
    const token = crypto.randomBytes(24).toString('hex');
    const teamId = account.lastTeamId || account.teamIds?.[0];
    if (!teamId) return json(res, 403, { error: 'No TeamFlow workspace is assigned to this account.' });
    const user = loadTeamDb(teamId).users.find(item => item.id === account.id);
    sessions.set(token, { userId: account.id, teamId, expiresAt: Date.now() + 7 * 86400000 });
    loginLimiter.clear(address);
    return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `teamflow_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
  }
  if (pathname === '/api/register' && req.method === 'POST') {
    if (REGISTRATION_MODE === 'closed') return json(res, 403, { error: 'Registration is currently closed.' });
    const address = clientAddress(req);
    const limit = registerLimiter.consume(address);
    if (!limit.allowed) return json(res, 429, { error: 'Too many registration attempts. Try again later.' }, { 'Retry-After': String(limit.retryAfter) });
    const body = await readBody(req); const email = clean(body.email).toLowerCase(); const password = String(body.password || ''); const name = clean(body.name);
    if (REGISTRATION_MODE === 'invite') {
      const expected = String(process.env.TONA_REGISTRATION_INVITE_CODE || '');
      const supplied = String(body.inviteCode || '');
      if (!expected || expected.length !== supplied.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return json(res, 403, { error: 'A valid invitation code is required.' });
    }
    const minimumPasswordLength = process.env.NODE_ENV === 'production' ? 12 : 8;
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < minimumPasswordLength) return json(res, 400, { error: 'Name, email, and a ' + minimumPasswordLength + '-character password are required.' });
    if (registry.users.some(item => item.email.toLowerCase() === email)) return json(res, 409, { error: 'This email already has an account.' });
    const user = { id: id('usr'), name, email, role: 'owner', title: clean(body.title), status: 'active', passwordHash: hashPassword(password), createdAt: now() }; const teamId = id('team');
    const team = initialTeamData({ settings: { teamName: clean(body.teamName) || (name + "'s Team"), reminderDays: 2 }, users: [user], requirements: [], tasks: [], milestones: [], comments: [], activities: [] }, teamId);
    team.activities.unshift({ id: id('act'), actorId: user.id, action: 'Created this private TeamFlow workspace', targetType: 'team', targetId: teamId, createdAt: now() });
    registry.users.push({ id: user.id, name, title: user.title, email, passwordHash: user.passwordHash, status: 'active', teamIds: [teamId], lastTeamId: teamId, createdAt: user.createdAt }); registry.teams.push({ id: teamId, createdAt: now() }); persistRegistry(); atomicWrite(teamFile(teamId), team); teamCache.set(teamId, team);
    const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, { userId: user.id, teamId, expiresAt: Date.now() + 7 * 86400000 });
    const cookie = 'teamflow_session=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800' + (process.env.NODE_ENV === 'production' ? '; Secure' : '');
    return json(res, 201, { user: publicUser(user), teamId }, { 'Set-Cookie': cookie });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    sessions.delete(parseCookies(req).teamflow_session);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'teamflow_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  const user = getUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  return teamContext.run({ teamId: user._teamId, db: loadTeamDb(user._teamId) }, async () => {
  if (pathname === '/api/me') return json(res, 200, { user: publicUser(user), settings: db.settings });
  // TEAMFLOW_GROUP_INVITE_V1: an account owns a private workspace and may join shared groups by invite code.
  if (pathname === '/api/account/password' && req.method === 'POST') {
    const body = await readBody(req); const currentPassword = String(body.currentPassword || ''); const newPassword = String(body.newPassword || '');
    const account = registry.users.find(item => item.id === user.id);
    if (!account || !verifyPassword(currentPassword, account.passwordHash)) return json(res, 403, { error: 'Current password is incorrect.' });
    if (newPassword.length < 12) return json(res, 400, { error: 'New password must be at least 12 characters.' });
    const passwordHash = hashPassword(newPassword); account.passwordHash = passwordHash;
    for (const teamId of account.teamIds || []) { const team = loadTeamDb(teamId); const member = team.users.find(item => item.id === account.id); if (member) { member.passwordHash = passwordHash; atomicWrite(teamFile(teamId), team); } }
    persistRegistry();
    const currentTokenDigest = crypto.createHash('sha256').update(parseCookies(req).teamflow_session || '').digest('hex');
    for (const [tokenDigest, session] of sessions.entries()) if (session.userId === user.id && tokenDigest !== currentTokenDigest) sessions.deleteDigest(tokenDigest);
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/hub') {
    const account = registry.users.find(item => item.id === user.id);
    const researchOwnerEmail = clean(process.env.TONA_RESEARCH_OWNER_EMAIL).toLowerCase();
    const researchEnabled = Boolean(researchOwnerEmail)
      && clean(account?.email).toLowerCase() === researchOwnerEmail;
    const researchStudio = researchEnabled ? {
      enabled: true,
      url: clean(process.env.TONA_RESEARCH_STUDIO_URL) || 'https://tona-research-studio.fucx9501.chatgpt.site'
    } : { enabled: false };
    const teams = (account?.teamIds || []).map(teamId => { const team = loadTeamDb(teamId); return { id: teamId, name: team.settings.teamName || 'TeamFlow Team', active: teamId === user._teamId }; });
    return json(res, 200, { user: publicUser(user), aiStudioUrl: process.env.AI_STUDIO_PUBLIC_URL || '/', teamflowUrl: process.env.APP_PUBLIC_URL || '/teamflow/', researchStudio, teams });
  }
  if (pathname === '/api/hub/team-access' && req.method === 'POST') {
    const body = await readBody(req); const supplied = clean(body.teamKey);
    if (!supplied) return json(res, 400, { error: 'Enter an invitation code.' });
    let targetId = '';
    for (const entry of registry.teams || []) {
      const candidate = loadTeamDb(entry.id); const stored = String(candidate.settings.teamKeyHash || ''); const legacy = String(candidate.settings.teamKey || '');
      if ((stored && verifyPassword(supplied, stored)) || (!stored && legacy && supplied.length === legacy.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(legacy)))) { targetId = entry.id; break; }
    }
    if (!targetId) return json(res, 403, { error: 'Invitation code is invalid.' });
    const account = registry.users.find(item => item.id === user.id); const target = loadTeamDb(targetId);
    if (!target.users.some(member => member.id === user.id)) {
      target.users.push({ id: account.id, name: account.name || user.name || account.email.split('@')[0], email: account.email, role: 'member', title: account.title || '', status: 'active', passwordHash: account.passwordHash, createdAt: account.createdAt || now() });
      target.activities.unshift({ id: id('act'), actorId: account.id, action: 'Joined this team with an invitation code', targetType: 'team', targetId, createdAt: now() });
      atomicWrite(teamFile(targetId), target); teamCache.set(targetId, target);
    }
    account.teamIds = Array.from(new Set([...(account.teamIds || []), targetId])); account.lastTeamId = targetId; persistRegistry();
    const token = parseCookies(req).teamflow_session; const session = sessions.get(token); if (session) { session.teamId = targetId; session.teamAccess = true; sessions.update(); }
    return json(res, 200, { ok: true, team: { id: targetId, name: target.settings.teamName || 'TeamFlow Team' } });
  }
  if (pathname === '/api/hub/select-team' && req.method === 'POST') {
    const body = await readBody(req); const account = registry.users.find(item => item.id === user.id); const targetId = clean(body.teamId);
    if (!account?.teamIds?.includes(targetId)) return json(res, 403, { error: 'You do not belong to this team.' });
    account.lastTeamId = targetId; persistRegistry(); const token = parseCookies(req).teamflow_session; const session = sessions.get(token); if (session) { session.teamId = targetId; sessions.update(); }
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/dashboard') return json(res, 200, dashboard());
  const featureHandled = await handleFeatureApi({ req, res, pathname, user, db, json, readBody, can, clean, id, now, dateOnly, hashPassword, publicUser, enrichRequirement, logActivity, saveDb, reminderEngine });
  if (featureHandled) return;
  if (pathname === '/api/users' && req.method === 'GET') return json(res, 200, { users: db.users.map(publicUser) });
  if (pathname === '/api/users' && req.method === 'POST') {
    if (!can(user, 'team.manage')) return json(res, 403, { error: 'No member management permission.' });
    const body = await readBody(req); const email = clean(body.email).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { error: 'Enter a valid registered email.' });
    if (db.users.some(item => item.email.toLowerCase() === email)) return json(res, 409, { error: 'This account is already in this team.' });
    const account = registry.users.find(item => item.email.toLowerCase() === email && item.status === 'active');
    if (!account) return json(res, 404, { error: 'This user must create a Tona AI Hub account first.' });
    if (!['admin', 'member', 'viewer'].includes(body.role)) return json(res, 400, { error: 'Invalid team role.' });
    const member = { id: account.id, name: account.name || email.split('@')[0], email: account.email, title: clean(body.title) || account.title || '', role: body.role, status: 'active', passwordHash: account.passwordHash, createdAt: account.createdAt || now() };
    db.users.push(member); logActivity(user.id, 'Added an existing Hub account to this team', 'user', member.id); saveDb();
    return json(res, 201, { user: publicUser(member) });
  }
  const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && req.method === 'PATCH') {
    if (!can(user, 'team.manage')) return json(res, 403, { error: '没有成员管理权限' });
    const member = db.users.find(item => item.id === userMatch[1]);
    if (!member) return json(res, 404, { error: '成员不存在' });
    const body = await readBody(req);
    if (member.role === 'owner' && body.role && body.role !== 'owner') return json(res, 400, { error: '负责人角色不能直接降级' });
    if (body.role && ['admin', 'member', 'viewer'].includes(body.role)) member.role = body.role;
    if (body.status && ['active', 'disabled'].includes(body.status) && member.id !== user.id) member.status = body.status;
    if (body.title !== undefined) member.title = clean(body.title);
    logActivity(user.id, `更新了成员 ${member.name} 的权限`, 'user', member.id); saveDb();
    return json(res, 200, { user: publicUser(member) });
  }

  if (pathname === '/api/requirements' && req.method === 'GET') return json(res, 200, { requirements: db.requirements.map(enrichRequirement) });
  if (pathname === '/api/requirements' && req.method === 'POST') {
    if (!can(user, 'requirement.manage') && !can(user, 'requirement.create')) return json(res, 403, { error: '没有创建需求权限' });
    const body = await readBody(req); const error = validateRequirement(body);
    if (error) return json(res, 400, { error });
    const item = { id: id('req'), title: clean(body.title), summary: clean(body.summary), type: body.type || 'feature', priority: body.priority, status: body.status || 'draft', ownerId: body.ownerId || user.id, proposerId: user.id, targetDate: dateOnly(body.targetDate), progress: 0, createdAt: now(), updatedAt: now() };
    db.requirements.unshift(item); logActivity(user.id, `提出了需求“${item.title}”`, 'requirement', item.id); saveDb();
    return json(res, 201, { requirement: enrichRequirement(item) });
  }
  const reqMatch = pathname.match(/^\/api\/requirements\/([^/]+)$/);
  if (reqMatch && req.method === 'GET') {
    const item = db.requirements.find(r => r.id === reqMatch[1]);
    if (!item) return json(res, 404, { error: '需求不存在' });
    return json(res, 200, { requirement: enrichRequirement(item), tasks: db.tasks.filter(t => t.requirementId === item.id), milestones: db.milestones.filter(m => m.requirementId === item.id), comments: db.comments.filter(c => c.targetId === item.id) });
  }
  if (reqMatch && req.method === 'PATCH') {
    const item = db.requirements.find(r => r.id === reqMatch[1]);
    if (!item) return json(res, 404, { error: '需求不存在' });
    if (!can(user, 'requirement.manage') && !(can(user, 'requirement.edit_own') && item.proposerId === user.id)) return json(res, 403, { error: '没有编辑该需求的权限' });
    const body = await readBody(req);
    ['title', 'summary', 'type', 'priority', 'status', 'ownerId'].forEach(key => { if (body[key] !== undefined) item[key] = clean(body[key]); });
    if (body.targetDate !== undefined) item.targetDate = dateOnly(body.targetDate);
    item.updatedAt = now(); logActivity(user.id, `更新了需求“${item.title}”`, 'requirement', item.id); saveDb();
    return json(res, 200, { requirement: enrichRequirement(item) });
  }
  const decomposeMatch = pathname.match(/^\/api\/requirements\/([^/]+)\/decompose$/);
  if (decomposeMatch && req.method === 'POST') {
    if (!can(user, 'requirement.manage')) return json(res, 403, { error: '仅管理员可以自动拆解' });
    const requirement = db.requirements.find(r => r.id === decomposeMatch[1]);
    if (!requirement) return json(res, 404, { error: '需求不存在' });
    if (db.tasks.some(t => t.requirementId === requirement.id)) return json(res, 409, { error: '该需求已有任务，请先手动调整' });
    const tasks = decomposeRequirement(requirement, user.id); db.tasks.push(...tasks); requirement.status = 'planned'; requirement.updatedAt = now();
    logActivity(user.id, `自动拆解了需求“${requirement.title}”`, 'requirement', requirement.id); saveDb();
    return json(res, 201, { tasks });
  }

  if (pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, { tasks: db.tasks });
  if (pathname === '/api/tasks' && req.method === 'POST') {
    if (!can(user, 'task.manage')) return json(res, 403, { error: '没有创建任务权限' });
    const body = await readBody(req);
    if (!clean(body.title)) return json(res, 400, { error: '请填写任务标题' });
    const task = { id: id('task'), requirementId: body.requirementId || '', title: clean(body.title), description: clean(body.description), status: body.status || 'todo', priority: body.priority || 'P2', assigneeId: body.assigneeId || '', dueDate: dateOnly(body.dueDate), estimate: Number(body.estimate || 0), createdBy: user.id, createdAt: now(), updatedAt: now() };
    db.tasks.unshift(task); logActivity(user.id, `创建了任务“${task.title}”`, 'task', task.id); saveDb(); return json(res, 201, { task });
  }
  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && req.method === 'PATCH') {
    const task = db.tasks.find(t => t.id === taskMatch[1]);
    if (!task) return json(res, 404, { error: '任务不存在' });
    if (!can(user, 'task.manage') && !(can(user, 'task.manage_assigned') && task.assigneeId === user.id)) return json(res, 403, { error: '只能更新分配给自己的任务' });
    const body = await readBody(req);
    ['title', 'description', 'status', 'priority', 'assigneeId', 'requirementId'].forEach(key => { if (body[key] !== undefined) task[key] = clean(body[key]); });
    if (body.dueDate !== undefined) task.dueDate = dateOnly(body.dueDate);
    if (body.estimate !== undefined) task.estimate = Number(body.estimate || 0);
    task.updatedAt = now(); logActivity(user.id, `${task.status === 'done' ? '完成' : '更新'}了任务“${task.title}”`, 'task', task.id); saveDb(); return json(res, 200, { task });
  }

  if (pathname === '/api/milestones' && req.method === 'POST') {
    if (!can(user, 'requirement.manage')) return json(res, 403, { error: '没有节点管理权限' });
    const body = await readBody(req);
    if (!clean(body.title) || !dateOnly(body.dueDate)) return json(res, 400, { error: '请填写节点名称和日期' });
    const milestone = { id: id('mile'), requirementId: clean(body.requirementId), title: clean(body.title), dueDate: body.dueDate, status: 'pending', createdAt: now() };
    db.milestones.push(milestone); logActivity(user.id, `创建了节点“${milestone.title}”`, 'milestone', milestone.id); saveDb(); return json(res, 201, { milestone });
  }
  if (pathname === '/api/settings' && req.method === 'PATCH') {
    if (!can(user, 'settings.manage')) return json(res, 403, { error: '仅负责人可以修改设置' });
    const body = await readBody(req);
    if (body.teamName) db.settings.teamName = clean(body.teamName);
    if (body.reminderDays !== undefined) db.settings.reminderDays = Math.max(1, Math.min(30, Number(body.reminderDays) || 2));
    if (body.teamKey !== undefined && clean(body.teamKey)) { db.settings.teamKeyHash = hashPassword(clean(body.teamKey)); delete db.settings.teamKey; }
    saveDb(); return json(res, 200, { settings: db.settings });
  }
  });
  return json(res, 404, { error: '接口不存在' });
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR)) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, responseSecurityHeaders); return res.end('Not found');
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8' };
  res.writeHead(200, { ...responseSecurityHeaders, 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  try {
    if (pathname.startsWith('/api/')) await api(req, res, pathname);
    else serveStatic(req, res, pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: error.message || '服务器错误' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  reminderEngine.start();
  console.log(`TeamFlow Lite running at http://localhost:${PORT}`);
});

function shutdown() {
  reminderEngine.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server };