import { migrate } from './db.js';
import {
  ValidationError, ROLES, LEAD_STAGES, EVENT_KINDS, PROCESSES,
  str, email, date, time, oneOf, id, bool, checkPassword,
  hashPassword, verifyPassword, randomToken, sha256, timingSafeEqual, addDays, todayIL,
} from './lib.js';

const COOKIE = 'ml_session';
const SESSION_HOURS = 12;
const MAX_BODY = 32 * 1024;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MIN = 15;

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      await migrate(env.DB);
      return await route(request, env, url);
    } catch (e) {
      if (e instanceof ValidationError || e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'שגיאת שרת. נסו שוב.' }, 500);
    }
  },
};

// ---------- request helpers ----------

async function body(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'סוג בקשה לא נתמך');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'הבקשה גדולה מדי');
  try {
    const data = JSON.parse(text || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new ValidationError('בקשה לא תקינה');
  }
}

function checkOrigin(request, url) {
  if (request.method === 'GET') return;
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'בקשה ממקור לא מורשה');
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function currentUser(request, env) {
  const token = getCookie(request, COOKIE);
  if (!token) return null;
  const hash = await sha256(token);
  return env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.must_change FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.active = 1`
  ).bind(hash).first();
}

function audit(env, user, action, entity, entityId, detail = '') {
  return env.DB.prepare('INSERT INTO audit (user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(user ? user.id : null, action, entity, entityId ?? null, String(detail).slice(0, 300)).run();
}

function requireAdmin(user) {
  if (user.role !== 'admin') throw new HttpError(403, 'פעולה למנהלים בלבד');
}

async function userExists(env, userId) {
  if (userId == null) return null;
  const u = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND active = 1').bind(userId).first();
  if (!u) throw new ValidationError('משתמש לא נמצא');
  return userId;
}

async function startSession(env, userId) {
  const token = randomToken();
  await env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .bind(await sha256(token), userId, `+${SESSION_HOURS} hours`).run();
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  return sessionCookie(token, SESSION_HOURS * 3600);
}

// ---------- router ----------

async function route(request, env, url) {
  checkOrigin(request, url);
  const method = request.method;
  const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const [res, rid, sub] = parts;

  // public endpoints
  if (res === 'setup' && method === 'GET') return setupNeeded(env);
  if (res === 'setup' && method === 'POST') return setup(request, env);
  if (res === 'login' && method === 'POST') return login(request, env);
  if (res === 'logout' && method === 'POST') return logout(request, env);

  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, 'יש להתחבר');

  if (res === 'me' && method === 'GET') return json({ user, roles: ROLES });
  if (res === 'me' && sub === undefined && rid === 'password' && method === 'POST') return changePassword(request, env, user);
  if (user.must_change) throw new HttpError(403, 'יש להחליף סיסמה לפני המשך העבודה');

  if (res === 'meta' && method === 'GET') return meta(env);
  if (res === 'dashboard' && method === 'GET') return dashboard(env, user);

  if (res === 'users') {
    if (method === 'GET' && !rid) return listUsers(env, user);
    if (method === 'POST' && !rid) return createUser(request, env, user);
    if (method === 'PATCH' && rid) return updateUser(request, env, user, id(rid, 'משתמש'));
  }
  if (res === 'clients') {
    if (method === 'GET' && !rid) return listClients(env, url);
    if (method === 'POST' && !rid) return createClient(request, env, user);
    if (method === 'GET' && rid) return getClient(env, id(rid, 'לקוח'));
    if (method === 'PATCH' && rid) return updateClient(request, env, user, id(rid, 'לקוח'));
  }
  if (res === 'cases') {
    if (method === 'GET' && !rid) return listCases(env, url);
    if (method === 'POST' && !rid) return createCase(request, env, user);
    if (method === 'GET' && rid && !sub) return getCase(env, id(rid, 'תיק'));
    if (method === 'PATCH' && rid && !sub) return updateCase(request, env, user, id(rid, 'תיק'));
    if (method === 'POST' && rid && sub === 'step') return setStep(request, env, user, id(rid, 'תיק'));
    if (method === 'POST' && rid && sub === 'notes') return addNote(request, env, user, id(rid, 'תיק'));
  }
  if (res === 'tasks') {
    if (method === 'GET' && !rid) return listTasks(env, url, user);
    if (method === 'POST' && !rid) return createTask(request, env, user);
    if (method === 'PATCH' && rid) return updateTask(request, env, user, id(rid, 'משימה'));
    if (method === 'DELETE' && rid) return deleteTask(env, user, id(rid, 'משימה'));
  }
  if (res === 'events') {
    if (method === 'GET' && !rid) return listEvents(env, url);
    if (method === 'POST' && !rid) return createEvent(request, env, user);
    if (method === 'PATCH' && rid) return updateEvent(request, env, user, id(rid, 'אירוע'));
    if (method === 'DELETE' && rid) return deleteEvent(env, user, id(rid, 'אירוע'));
  }
  if (res === 'audit' && method === 'GET') return listAudit(env, user);

  throw new HttpError(404, 'לא נמצא');
}

// ---------- setup & auth ----------

async function setupNeeded(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return json({ needed: row.n === 0, configured: Boolean(env.SETUP_TOKEN) });
}

async function setup(request, env) {
  const data = await body(request);
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (row.n > 0) throw new HttpError(403, 'המערכת כבר הוגדרה');
  if (!env.SETUP_TOKEN) throw new HttpError(503, 'קוד ההקמה (SETUP_TOKEN) עוד לא הוגדר בשרת');
  if (!timingSafeEqual(String(data.token || ''), env.SETUP_TOKEN)) throw new HttpError(403, 'קוד הקמה שגוי');
  const name = str(data.name, 'שם', { required: true, max: 80 });
  const mail = email(data.email, 'אימייל', { required: true });
  const pass = await hashPassword(checkPassword(data.password));
  const r = await env.DB.prepare(`INSERT INTO users (email, name, role, pass) VALUES (?, ?, 'admin', ?)`)
    .bind(mail, name, pass).run();
  const userId = r.meta.last_row_id;
  await audit(env, { id: userId }, 'setup', 'user', userId);
  return json({ ok: true }, 200, { 'Set-Cookie': await startSession(env, userId) });
}

async function login(request, env) {
  const data = await body(request);
  const mail = email(data.email, 'אימייל', { required: true });
  const password = str(data.password, 'סיסמה', { required: true, max: 200 });
  const fails = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > datetime('now', ?)`
  ).bind(mail, `-${LOGIN_WINDOW_MIN} minutes`).first();
  if (fails.n >= LOGIN_MAX_FAILURES) {
    throw new HttpError(429, `יותר מדי ניסיונות. נסו שוב בעוד ${LOGIN_WINDOW_MIN} דקות.`);
  }
  const user = await env.DB.prepare('SELECT id, pass FROM users WHERE email = ? AND active = 1').bind(mail).first();
  const ok = user ? await verifyPassword(password, user.pass) : false;
  if (!ok) {
    await env.DB.prepare('INSERT INTO login_failures (email) VALUES (?)').bind(mail).run();
    throw new HttpError(401, 'אימייל או סיסמה שגויים');
  }
  await env.DB.prepare('DELETE FROM login_failures WHERE email = ?').bind(mail).run();
  await audit(env, user, 'login', 'user', user.id);
  return json({ ok: true }, 200, { 'Set-Cookie': await startSession(env, user.id) });
}

async function logout(request, env) {
  const token = getCookie(request, COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

async function changePassword(request, env, user) {
  const data = await body(request);
  const row = await env.DB.prepare('SELECT pass FROM users WHERE id = ?').bind(user.id).first();
  if (!(await verifyPassword(str(data.current, 'סיסמה נוכחית', { required: true }), row.pass))) {
    throw new ValidationError('הסיסמה הנוכחית שגויה');
  }
  const pass = await hashPassword(checkPassword(data.password));
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pass = ?, must_change = 0 WHERE id = ?').bind(pass, user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  await audit(env, user, 'password', 'user', user.id);
  return json({ ok: true }, 200, { 'Set-Cookie': await startSession(env, user.id) });
}

// ---------- users ----------

async function meta(env) {
  const { results } = await env.DB.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').all();
  const processes = Object.fromEntries(
    Object.entries(PROCESSES).map(([k, p]) => [k, { label: p.label, area: p.area, steps: p.steps.map((s) => s.label) }])
  );
  return json({ users: results, roles: ROLES, leadStages: LEAD_STAGES, eventKinds: EVENT_KINDS, processes, today: todayIL() });
}

async function listUsers(env, user) {
  requireAdmin(user);
  const { results } = await env.DB.prepare(
    'SELECT id, email, name, role, active, must_change, created_at FROM users ORDER BY active DESC, name'
  ).all();
  return json({ users: results });
}

async function createUser(request, env, user) {
  requireAdmin(user);
  const data = await body(request);
  const name = str(data.name, 'שם', { required: true, max: 80 });
  const mail = email(data.email, 'אימייל', { required: true });
  const role = oneOf(data.role, 'תפקיד', Object.keys(ROLES));
  const pass = await hashPassword(checkPassword(data.password));
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(mail).first();
  if (exists) throw new ValidationError('כבר קיים משתמש עם האימייל הזה');
  const r = await env.DB.prepare('INSERT INTO users (email, name, role, pass, must_change) VALUES (?, ?, ?, ?, 1)')
    .bind(mail, name, role, pass).run();
  await audit(env, user, 'create', 'user', r.meta.last_row_id, mail);
  return json({ id: r.meta.last_row_id });
}

async function updateUser(request, env, user, userId) {
  requireAdmin(user);
  const data = await body(request);
  const target = await env.DB.prepare('SELECT id, role, active FROM users WHERE id = ?').bind(userId).first();
  if (!target) throw new HttpError(404, 'משתמש לא נמצא');
  const sets = [];
  const vals = [];
  if (data.name !== undefined) { sets.push('name = ?'); vals.push(str(data.name, 'שם', { required: true, max: 80 })); }
  if (data.role !== undefined) { sets.push('role = ?'); vals.push(oneOf(data.role, 'תפקיד', Object.keys(ROLES))); }
  if (data.active !== undefined) { sets.push('active = ?'); vals.push(bool(data.active) ? 1 : 0); }
  if (data.password !== undefined) {
    sets.push('pass = ?', 'must_change = 1');
    vals.push(await hashPassword(checkPassword(data.password)));
  }
  if (!sets.length) throw new ValidationError('אין מה לעדכן');
  if (userId === user.id && (data.active !== undefined && !bool(data.active) || (data.role !== undefined && data.role !== 'admin'))) {
    throw new ValidationError('אי אפשר להסיר הרשאת מנהל או להשבית את עצמך');
  }
  const stmts = [env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, userId)];
  if (data.active !== undefined && !bool(data.active) || data.password !== undefined) {
    stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId));
  }
  await env.DB.batch(stmts);
  await audit(env, user, 'update', 'user', userId, Object.keys(data).filter((k) => k !== 'password').join(','));
  return json({ ok: true });
}

// ---------- dashboard ----------

async function dashboard(env, user) {
  const today = todayIL();
  const week = addDays(today, 7);
  const [counts, events, pipeline, cases, myTasks] = await env.DB.batch([
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM cases WHERE status = 'open') AS open_cases,
              (SELECT COUNT(*) FROM events WHERE date >= ?1 AND date <= ?2) AS week_events,
              (SELECT COUNT(*) FROM tasks WHERE done = 0 AND assignee_id = ?3) AS my_open_tasks,
              (SELECT COUNT(*) FROM tasks WHERE done = 0 AND due_date IS NOT NULL AND due_date < ?1) AS overdue_tasks,
              (SELECT COUNT(*) FROM clients WHERE kind = 'lead' AND stage = 'new') AS new_leads`
    ).bind(today, week, user.id),
    env.DB.prepare(
      `SELECT e.id, e.title, e.kind, e.date, e.time, e.case_id, c.title AS case_title, cl.name AS client_name
       FROM events e LEFT JOIN cases c ON c.id = e.case_id LEFT JOIN clients cl ON cl.id = c.client_id
       WHERE e.date >= ? ORDER BY e.date, e.time LIMIT 6`
    ).bind(today),
    env.DB.prepare(`SELECT stage, COUNT(*) AS n FROM clients WHERE kind = 'lead' GROUP BY stage`),
    env.DB.prepare(
      `SELECT c.id, c.title, c.process, c.step, cl.name AS client_name, u.name AS owner_name
       FROM cases c JOIN clients cl ON cl.id = c.client_id LEFT JOIN users u ON u.id = c.owner_id
       WHERE c.status = 'open' ORDER BY c.updated_at DESC LIMIT 8`
    ),
    env.DB.prepare(
      `SELECT t.id, t.title, t.due_date, t.case_id, c.title AS case_title FROM tasks t LEFT JOIN cases c ON c.id = t.case_id
       WHERE t.done = 0 AND t.assignee_id = ? ORDER BY t.due_date IS NULL, t.due_date LIMIT 8`
    ).bind(user.id),
  ]);
  return json({
    today,
    counts: counts.results[0],
    events: events.results,
    pipeline: pipeline.results,
    cases: cases.results,
    myTasks: myTasks.results,
  });
}

// ---------- clients ----------

function clientFields(data, partial) {
  const out = {};
  const f = (k, fn) => { if (!partial || data[k] !== undefined) out[k] = fn(data[k]); };
  f('name', (v) => str(v, 'שם', { required: true, max: 120 }));
  f('kind', (v) => oneOf(v ?? 'lead', 'סוג', ['lead', 'client']));
  f('stage', (v) => oneOf(v ?? 'new', 'שלב', LEAD_STAGES.map((s) => s.key)));
  f('id_number', (v) => str(v, 'ת"ז / ח"פ', { max: 20 }));
  f('phone', (v) => str(v, 'טלפון', { max: 30 }));
  f('email', (v) => email(v));
  f('address', (v) => str(v, 'כתובת', { max: 200 }));
  f('source', (v) => str(v, 'מקור הפנייה', { max: 100 }));
  f('notes', (v) => str(v, 'הערות', { max: 4000 }));
  if (!partial || data.owner_id !== undefined) out.owner_id = id(data.owner_id, 'אחראי', { required: false });
  if (out.stage === 'signed') out.kind = 'client';
  return out;
}

async function listClients(env, url) {
  const kind = url.searchParams.get('kind');
  const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
  const where = [];
  const vals = [];
  if (kind === 'lead' || kind === 'client') { where.push('cl.kind = ?'); vals.push(kind); }
  if (q) { where.push('(cl.name LIKE ? OR cl.phone LIKE ? OR cl.email LIKE ? OR cl.id_number LIKE ?)'); vals.push(...Array(4).fill(`%${q}%`)); }
  const { results } = await env.DB.prepare(
    `SELECT cl.id, cl.kind, cl.stage, cl.name, cl.phone, cl.email, cl.source, cl.updated_at, u.name AS owner_name,
            (SELECT COUNT(*) FROM cases c WHERE c.client_id = cl.id AND c.status = 'open') AS open_cases
     FROM clients cl LEFT JOIN users u ON u.id = cl.owner_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY cl.updated_at DESC LIMIT 300`
  ).bind(...vals).all();
  return json({ clients: results });
}

async function createClient(request, env, user) {
  const f = clientFields(await body(request), false);
  await userExists(env, f.owner_id);
  const r = await env.DB.prepare(
    `INSERT INTO clients (kind, stage, name, id_number, phone, email, address, source, notes, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(f.kind, f.stage, f.name, f.id_number, f.phone, f.email, f.address, f.source, f.notes, f.owner_id).run();
  await audit(env, user, 'create', 'client', r.meta.last_row_id);
  return json({ id: r.meta.last_row_id });
}

async function getClient(env, clientId) {
  const [client, cases, notes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT cl.*, u.name AS owner_name FROM clients cl LEFT JOIN users u ON u.id = cl.owner_id WHERE cl.id = ?`
    ).bind(clientId),
    env.DB.prepare(
      `SELECT c.id, c.title, c.process, c.step, c.status, c.case_number, u.name AS owner_name
       FROM cases c LEFT JOIN users u ON u.id = c.owner_id WHERE c.client_id = ? ORDER BY c.status = 'closed', c.updated_at DESC`
    ).bind(clientId),
    env.DB.prepare(
      `SELECT n.id, n.text, n.created_at, u.name AS user_name FROM notes n LEFT JOIN users u ON u.id = n.user_id
       WHERE n.client_id = ? ORDER BY n.created_at DESC LIMIT 50`
    ).bind(clientId),
  ]);
  if (!client.results[0]) throw new HttpError(404, 'לקוח לא נמצא');
  return json({ client: client.results[0], cases: cases.results, notes: notes.results });
}

async function updateClient(request, env, user, clientId) {
  const f = clientFields(await body(request), true);
  const keys = Object.keys(f);
  if (!keys.length) throw new ValidationError('אין מה לעדכן');
  if (f.owner_id !== undefined) await userExists(env, f.owner_id);
  const r = await env.DB.prepare(
    `UPDATE clients SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...keys.map((k) => f[k]), clientId).run();
  if (!r.meta.changes) throw new HttpError(404, 'לקוח לא נמצא');
  await audit(env, user, 'update', 'client', clientId, keys.join(','));
  return json({ ok: true });
}

// ---------- cases ----------

function caseFields(data, partial) {
  const out = {};
  const f = (k, fn) => { if (!partial || data[k] !== undefined) out[k] = fn(data[k]); };
  f('title', (v) => str(v, 'כותרת התיק', { required: true, max: 160 }));
  f('case_number', (v) => str(v, 'מספר תיק', { max: 60 }));
  f('court', (v) => str(v, 'ערכאה', { max: 120 }));
  f('opposing_party', (v) => str(v, 'צד שכנגד', { max: 160 }));
  f('fee_type', (v) => str(v, 'סוג שכר טרחה', { max: 40 }));
  f('fee_amount', (v) => str(v, 'סכום שכר טרחה', { max: 40 }));
  f('notes', (v) => str(v, 'הערות', { max: 4000 }));
  if (!partial || data.owner_id !== undefined) out.owner_id = id(data.owner_id, 'אחראי', { required: false });
  if (partial && data.status !== undefined) out.status = oneOf(data.status, 'סטטוס', ['open', 'closed']);
  return out;
}

async function stepTasksStatements(env, user, caseId, processKey, step, ownerId) {
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE case_id = ? AND step = ?').bind(caseId, step).first();
  if (existing.n > 0) return [];
  const tasks = PROCESSES[processKey].steps[step].tasks;
  return tasks.map((t) => env.DB.prepare(
    'INSERT INTO tasks (case_id, step, title, assignee_id, created_by) VALUES (?, ?, ?, ?, ?)'
  ).bind(caseId, step, t, ownerId, user.id));
}

async function listCases(env, url) {
  const status = url.searchParams.get('status') || 'open';
  const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
  const where = [];
  const vals = [];
  if (status === 'open' || status === 'closed') { where.push('c.status = ?'); vals.push(status); }
  if (q) { where.push('(c.title LIKE ? OR c.case_number LIKE ? OR cl.name LIKE ? OR c.opposing_party LIKE ?)'); vals.push(...Array(4).fill(`%${q}%`)); }
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.title, c.process, c.step, c.status, c.case_number, c.opened_at, cl.id AS client_id, cl.name AS client_name,
            u.name AS owner_name
     FROM cases c JOIN clients cl ON cl.id = c.client_id LEFT JOIN users u ON u.id = c.owner_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.updated_at DESC LIMIT 300`
  ).bind(...vals).all();
  return json({ cases: results });
}

async function createCase(request, env, user) {
  const data = await body(request);
  const f = caseFields(data, false);
  const clientId = id(data.client_id, 'לקוח');
  const process = oneOf(data.process ?? 'general', 'סוג תהליך', Object.keys(PROCESSES));
  const opened = date(data.opened_at, 'תאריך פתיחה') || todayIL();
  const client = await env.DB.prepare('SELECT id, kind FROM clients WHERE id = ?').bind(clientId).first();
  if (!client) throw new ValidationError('לקוח לא נמצא');
  await userExists(env, f.owner_id);
  const r = await env.DB.prepare(
    `INSERT INTO cases (client_id, title, process, case_number, court, opposing_party, fee_type, fee_amount, notes, owner_id, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(clientId, f.title, process, f.case_number, f.court, f.opposing_party, f.fee_type, f.fee_amount, f.notes, f.owner_id, opened).run();
  const caseId = r.meta.last_row_id;
  const stmts = await stepTasksStatements(env, user, caseId, process, 0, f.owner_id);
  if (client.kind === 'lead') {
    stmts.push(env.DB.prepare(`UPDATE clients SET kind = 'client', stage = 'signed', updated_at = datetime('now') WHERE id = ?`).bind(clientId));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await audit(env, user, 'create', 'case', caseId);
  return json({ id: caseId });
}

async function getCase(env, caseId) {
  const [kase, tasks, events, notes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT c.*, cl.name AS client_name, cl.phone AS client_phone, cl.email AS client_email, u.name AS owner_name
       FROM cases c JOIN clients cl ON cl.id = c.client_id LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?`
    ).bind(caseId),
    env.DB.prepare(
      `SELECT t.id, t.title, t.due_date, t.done, t.step, t.assignee_id, u.name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.case_id = ? ORDER BY t.done, t.due_date IS NULL, t.due_date, t.id`
    ).bind(caseId),
    env.DB.prepare('SELECT id, kind, title, date, time, location, notes FROM events WHERE case_id = ? ORDER BY date, time').bind(caseId),
    env.DB.prepare(
      `SELECT n.id, n.text, n.created_at, u.name AS user_name FROM notes n LEFT JOIN users u ON u.id = n.user_id
       WHERE n.case_id = ? ORDER BY n.created_at DESC LIMIT 100`
    ).bind(caseId),
  ]);
  const c = kase.results[0];
  if (!c) throw new HttpError(404, 'תיק לא נמצא');
  const p = PROCESSES[c.process] || PROCESSES.general;
  return json({
    case: c,
    process: { key: c.process, label: p.label, steps: p.steps.map((s) => s.label) },
    tasks: tasks.results,
    events: events.results,
    notes: notes.results,
  });
}

async function updateCase(request, env, user, caseId) {
  const f = caseFields(await body(request), true);
  const keys = Object.keys(f);
  if (!keys.length) throw new ValidationError('אין מה לעדכן');
  if (f.owner_id !== undefined) await userExists(env, f.owner_id);
  const r = await env.DB.prepare(
    `UPDATE cases SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...keys.map((k) => f[k]), caseId).run();
  if (!r.meta.changes) throw new HttpError(404, 'תיק לא נמצא');
  await audit(env, user, 'update', 'case', caseId, keys.join(','));
  return json({ ok: true });
}

async function setStep(request, env, user, caseId) {
  const data = await body(request);
  const c = await env.DB.prepare('SELECT id, process, step, owner_id FROM cases WHERE id = ?').bind(caseId).first();
  if (!c) throw new HttpError(404, 'תיק לא נמצא');
  const p = PROCESSES[c.process] || PROCESSES.general;
  const step = Number(data.step);
  if (!Number.isInteger(step) || step < 0 || step >= p.steps.length) throw new ValidationError('שלב לא תקין');
  const stmts = [env.DB.prepare(`UPDATE cases SET step = ?, updated_at = datetime('now') WHERE id = ?`).bind(step, caseId)];
  if (step > c.step) stmts.push(...(await stepTasksStatements(env, user, caseId, c.process in PROCESSES ? c.process : 'general', step, c.owner_id)));
  stmts.push(env.DB.prepare('INSERT INTO notes (case_id, user_id, text) VALUES (?, ?, ?)').bind(caseId, user.id, `התיק עבר לשלב: ${p.steps[step].label}`));
  await env.DB.batch(stmts);
  await audit(env, user, 'step', 'case', caseId, String(step));
  return json({ ok: true });
}

async function addNote(request, env, user, caseId) {
  const data = await body(request);
  const text = str(data.text, 'הערה', { required: true, max: 4000 });
  const c = await env.DB.prepare('SELECT id FROM cases WHERE id = ?').bind(caseId).first();
  if (!c) throw new HttpError(404, 'תיק לא נמצא');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO notes (case_id, user_id, text) VALUES (?, ?, ?)').bind(caseId, user.id, text),
    env.DB.prepare(`UPDATE cases SET updated_at = datetime('now') WHERE id = ?`).bind(caseId),
  ]);
  return json({ ok: true });
}

// ---------- tasks ----------

async function listTasks(env, url, user) {
  const scope = url.searchParams.get('scope') || 'mine';
  const done = url.searchParams.get('done') === '1' ? 1 : 0;
  const where = ['t.done = ?'];
  const vals = [done];
  if (scope === 'mine') { where.push('t.assignee_id = ?'); vals.push(user.id); }
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.due_date, t.done, t.case_id, c.title AS case_title, cl.name AS client_name, u.name AS assignee_name
     FROM tasks t LEFT JOIN cases c ON c.id = t.case_id LEFT JOIN clients cl ON cl.id = c.client_id
     LEFT JOIN users u ON u.id = t.assignee_id
     WHERE ${where.join(' AND ')} ORDER BY t.due_date IS NULL, t.due_date, t.id DESC LIMIT 300`
  ).bind(...vals).all();
  return json({ tasks: results, today: todayIL() });
}

async function createTask(request, env, user) {
  const data = await body(request);
  const title = str(data.title, 'משימה', { required: true, max: 200 });
  const due = date(data.due_date, 'תאריך יעד');
  const caseId = id(data.case_id, 'תיק', { required: false });
  const assignee = id(data.assignee_id, 'אחראי', { required: false }) ?? user.id;
  await userExists(env, assignee);
  if (caseId && !(await env.DB.prepare('SELECT id FROM cases WHERE id = ?').bind(caseId).first())) throw new ValidationError('תיק לא נמצא');
  const r = await env.DB.prepare('INSERT INTO tasks (case_id, title, due_date, assignee_id, created_by) VALUES (?, ?, ?, ?, ?)')
    .bind(caseId, title, due, assignee, user.id).run();
  await audit(env, user, 'create', 'task', r.meta.last_row_id);
  return json({ id: r.meta.last_row_id });
}

async function updateTask(request, env, user, taskId) {
  const data = await body(request);
  const sets = [];
  const vals = [];
  if (data.title !== undefined) { sets.push('title = ?'); vals.push(str(data.title, 'משימה', { required: true, max: 200 })); }
  if (data.due_date !== undefined) { sets.push('due_date = ?'); vals.push(date(data.due_date, 'תאריך יעד')); }
  if (data.assignee_id !== undefined) { sets.push('assignee_id = ?'); vals.push(await userExists(env, id(data.assignee_id, 'אחראי', { required: false }))); }
  if (data.done !== undefined) {
    const d = bool(data.done);
    sets.push('done = ?', `done_at = ${d ? "datetime('now')" : 'NULL'}`);
    vals.push(d ? 1 : 0);
  }
  if (!sets.length) throw new ValidationError('אין מה לעדכן');
  const r = await env.DB.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, taskId).run();
  if (!r.meta.changes) throw new HttpError(404, 'משימה לא נמצאה');
  await audit(env, user, 'update', 'task', taskId, Object.keys(data).join(','));
  return json({ ok: true });
}

async function deleteTask(env, user, taskId) {
  const r = await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(taskId).run();
  if (!r.meta.changes) throw new HttpError(404, 'משימה לא נמצאה');
  await audit(env, user, 'delete', 'task', taskId);
  return json({ ok: true });
}

// ---------- events ----------

function eventFields(data, partial) {
  const out = {};
  const f = (k, fn) => { if (!partial || data[k] !== undefined) out[k] = fn(data[k]); };
  f('title', (v) => str(v, 'כותרת', { required: true, max: 160 }));
  f('kind', (v) => oneOf(v ?? 'meeting', 'סוג', Object.keys(EVENT_KINDS)));
  f('date', (v) => date(v, 'תאריך', { required: true }));
  f('time', (v) => time(v, 'שעה'));
  f('location', (v) => str(v, 'מיקום', { max: 160 }));
  f('notes', (v) => str(v, 'הערות', { max: 2000 }));
  return out;
}

async function listEvents(env, url) {
  const from = date(url.searchParams.get('from'), 'מתאריך') || todayIL();
  const to = date(url.searchParams.get('to'), 'עד תאריך') || addDays(from, 90);
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.kind, e.title, e.date, e.time, e.location, e.notes, e.case_id, c.title AS case_title, cl.name AS client_name
     FROM events e LEFT JOIN cases c ON c.id = e.case_id LEFT JOIN clients cl ON cl.id = c.client_id
     WHERE e.date >= ? AND e.date <= ? ORDER BY e.date, e.time LIMIT 500`
  ).bind(from, to).all();
  return json({ events: results, from, to });
}

async function createEvent(request, env, user) {
  const data = await body(request);
  const f = eventFields(data, false);
  const caseId = id(data.case_id, 'תיק', { required: false });
  if (caseId && !(await env.DB.prepare('SELECT id FROM cases WHERE id = ?').bind(caseId).first())) throw new ValidationError('תיק לא נמצא');
  const r = await env.DB.prepare(
    'INSERT INTO events (case_id, kind, title, date, time, location, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(caseId, f.kind, f.title, f.date, f.time, f.location, f.notes, user.id).run();
  await audit(env, user, 'create', 'event', r.meta.last_row_id);
  return json({ id: r.meta.last_row_id });
}

async function updateEvent(request, env, user, eventId) {
  const f = eventFields(await body(request), true);
  const keys = Object.keys(f);
  if (!keys.length) throw new ValidationError('אין מה לעדכן');
  const r = await env.DB.prepare(`UPDATE events SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map((k) => f[k]), eventId).run();
  if (!r.meta.changes) throw new HttpError(404, 'אירוע לא נמצא');
  await audit(env, user, 'update', 'event', eventId, keys.join(','));
  return json({ ok: true });
}

async function deleteEvent(env, user, eventId) {
  const r = await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(eventId).run();
  if (!r.meta.changes) throw new HttpError(404, 'אירוע לא נמצא');
  await audit(env, user, 'delete', 'event', eventId);
  return json({ ok: true });
}

// ---------- audit ----------

async function listAudit(env, user) {
  requireAdmin(user);
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.detail, a.at, u.name AS user_name
     FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300`
  ).all();
  return json({ audit: results });
}
