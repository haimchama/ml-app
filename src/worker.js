import { migrate, MIGRATIONS } from './db.js';
import {
  gmailConfig, setSetting, authUrl, redirectUri, exchangeCode, profileEmail, revoke, syncGmail,
} from './gmail.js';
import {
  ValidationError, ROLES, PERMISSIONS, APPROVAL, LEAD_STAGES, EVENT_KINDS, PROCESSES,
  can, permsOf, initialApproval,
  str, email, username, date, time, oneOf, id, bool, checkPassword,
  hashPassword, verifyPassword, randomToken, randomCode, sha256, timingSafeEqual,
  maskEmail, codeEmail, addDays, todayIL,
} from './lib.js';

const COOKIE = 'ml_session';
const SESSION_HOURS = 12;
const MAX_BODY = 32 * 1024;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MIN = 15;
const CODE_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODE_MAX_SENDS = 3;
const RESEND_SECONDS = 30;
const DEFAULT_MAIL_FROM = 'no-reply@ml.tkb-pro.com';

// First IT user, created automatically on an empty database. Must change the password at first login.
const BOOTSTRAP_IT = {
  username: 'it',
  email: 'it@ml.tkb-pro.com',
  name: 'IT',
  pass: 'pbkdf2$30000$oOFag0R68x1M4Vsx+v54HQ==$Dt8FjJZ5rVlRE0btcKqO0G7G5OJ46nIgBcebEpnz2Vg=',
};

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
      await ensureBootstrapUser(env);
      return await route(request, env, url);
    } catch (e) {
      if (e instanceof ValidationError || e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'שגיאת שרת. נסו שוב.' }, 500);
    }
  },

  // Every 5 minutes (wrangler.jsonc "triggers"): bring in new e-mails from clients.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await migrate(env.DB);
      try { await syncGmail(env); } catch (e) { console.error('gmail sync', e && e.message); }
    })());
  },
};

let bootstrapped = false;
async function ensureBootstrapUser(env) {
  if (bootstrapped) return;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (row.n === 0) {
    await env.DB.prepare(`INSERT OR IGNORE INTO users (username, email, name, role, pass, must_change) VALUES (?, ?, ?, 'it', ?, 1)`)
      .bind(BOOTSTRAP_IT.username, BOOTSTRAP_IT.email, BOOTSTRAP_IT.name, BOOTSTRAP_IT.pass).run();
  }
  bootstrapped = true;
}

async function getSetting(env, key, fallback = null) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return r ? r.value : fallback;
}

async function twoFactorRequired(env) {
  return (await getSetting(env, 'require_2fa', '0')) === '1';
}

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
    `SELECT u.id, u.username, u.email, u.name, u.role, u.must_change FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.active = 1`
  ).bind(hash).first();
}

function audit(env, user, action, entity, entityId, detail = '') {
  return env.DB.prepare('INSERT INTO audit (user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(user ? user.id : null, action, entity, entityId ?? null, String(detail).slice(0, 300)).run();
}

function requirePerm(user, perm) {
  if (!can(user.role, perm)) throw new HttpError(403, 'אין לך הרשאה לפעולה הזאת');
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

function mailConfigured(env) {
  return Boolean(env.EMAIL && typeof env.EMAIL.send === 'function');
}

async function sendCode(env, url, user, code) {
  const msg = codeEmail(user.name, code, CODE_MINUTES);
  // Local development only (.dev.vars). Never set DEV_MAIL_LOG in Cloudflare.
  if (env.DEV_MAIL_LOG === '1') {
    console.log(`[dev] login code for ${user.email}: ${code}`);
    return;
  }
  if (mailConfigured(env)) {
    try {
      await env.EMAIL.send({
        to: user.email,
        from: { email: env.MAIL_FROM || DEFAULT_MAIL_FROM, name: 'משרד עו"ד מיכאל ליטווק' },
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
      return;
    } catch (e) {
      console.error('mail send failed', e && e.code, e && e.message);
      throw new HttpError(502, 'שליחת קוד האימות נכשלה. נסו שוב בעוד רגע.');
    }
  }
  throw new HttpError(503, 'שליחת מיילים עוד לא הוגדרה בשרת, ולכן אי אפשר להשלים כניסה. פנו לתמיכה.');
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
  if (res === 'login' && method === 'POST' && !rid) return login(request, env, url);
  if (res === 'login' && method === 'POST' && rid === 'verify') return verifyCode(request, env);
  if (res === 'login' && method === 'POST' && rid === 'resend') return resendCode(request, env, url);
  if (res === 'logout' && method === 'POST') return logout(request, env);
  // Google sends the browser back here; SameSite=Strict cookies are not sent on that hop,
  // so the one-time state (made by an IT user, 10 minutes) is what authorises it.
  if (res === 'gmail' && rid === 'callback' && method === 'GET') return gmailCallback(env, url);

  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, 'יש להתחבר');

  if (res === 'me' && method === 'GET' && !rid) return json({ user: { ...user, perms: permsOf(user.role) } });
  if (res === 'me' && rid === 'password' && method === 'POST') return changePassword(request, env, user);
  if (user.must_change) throw new HttpError(403, 'יש להחליף סיסמה לפני המשך העבודה');

  if (res === 'meta' && method === 'GET') return meta(env, user);
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
    if (method === 'POST' && rid && sub === 'approval') return decideClient(request, env, user, id(rid, 'לקוח'));
  }
  if (res === 'cases') {
    if (method === 'GET' && !rid) return listCases(env, url, user);
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
    if (method === 'GET' && !rid) return listEvents(env, url, user);
    if (method === 'POST' && !rid) return createEvent(request, env, user);
    if (method === 'PATCH' && rid) return updateEvent(request, env, user, id(rid, 'אירוע'));
    if (method === 'DELETE' && rid) return deleteEvent(env, user, id(rid, 'אירוע'));
  }
  if (res === 'audit' && method === 'GET') return listAudit(env, user);
  if (res === 'system' && method === 'GET') return systemStatus(env, user);
  if (res === 'system' && rid === 'revoke' && method === 'POST') return revokeSessions(request, env, user);
  if (res === 'notifications' && method === 'GET') return listNotifications(env, user);
  if (res === 'notifications' && rid === 'read' && method === 'POST') return readNotifications(request, env, user);
  if (res === 'emails' && method === 'GET' && !rid) return listEmails(env, url);
  if (res === 'emails' && method === 'GET' && rid) return getEmail(env, user, id(rid, 'מייל'));
  if (res === 'gmail' && !rid && method === 'GET') return gmailStatus(env, url, user);
  if (res === 'gmail' && rid === 'config' && method === 'POST') return gmailSaveConfig(request, env, user);
  if (res === 'gmail' && rid === 'connect' && method === 'POST') return gmailConnect(env, url, user);
  if (res === 'gmail' && rid === 'sync' && method === 'POST') return gmailSyncNow(env, user);
  if (res === 'gmail' && rid === 'disconnect' && method === 'POST') return gmailDisconnect(env, user);
  if (res === 'system' && rid === '2fa' && !sub && method === 'POST') return start2fa(request, env, url, user);
  if (res === 'system' && rid === '2fa' && sub === 'confirm' && method === 'POST') return confirm2fa(request, env, user);

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
  const login = username(data.username);
  const mail = email(data.email, 'אימייל', { required: true });
  const pass = await hashPassword(checkPassword(data.password));
  const r = await env.DB.prepare(`INSERT INTO users (username, email, name, role, pass) VALUES (?, ?, ?, 'it', ?)`)
    .bind(login, mail, name, pass).run();
  const userId = r.meta.last_row_id;
  await audit(env, { id: userId }, 'setup', 'user', userId);
  // No session here: the first login goes through the e-mail code like every other.
  return json({ ok: true });
}

// login_failures.email holds the username that was tried (the column predates usernames).
async function tooManyFailures(env, login) {
  const fails = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > datetime('now', ?)`
  ).bind(login, `-${LOGIN_WINDOW_MIN} minutes`).first();
  return fails.n >= LOGIN_MAX_FAILURES;
}

function lockedError() {
  return new HttpError(429, `יותר מדי ניסיונות. נסו שוב בעוד ${LOGIN_WINDOW_MIN} דקות.`);
}

// Step 1: e-mail + password. On success a code goes to the user's e-mail; no session yet.
async function login(request, env, url) {
  const data = await body(request);
  const login = str(data.username, 'שם משתמש', { required: true, max: 30 }).toLowerCase();
  const password = str(data.password, 'סיסמה', { required: true, max: 200 });
  if (await tooManyFailures(env, login)) throw lockedError();
  const user = await env.DB.prepare('SELECT id, name, username, email, pass FROM users WHERE username = ? AND active = 1').bind(login).first();
  const ok = user ? await verifyPassword(password, user.pass) : false;
  if (!ok) {
    await env.DB.prepare('INSERT INTO login_failures (email) VALUES (?)').bind(login).run();
    throw new HttpError(401, 'שם משתמש או סיסמה שגויים');
  }
  const mail = login;
  if (!(await twoFactorRequired(env))) {
    await env.DB.prepare('DELETE FROM login_failures WHERE email = ?').bind(mail).run();
    await audit(env, user, 'login', 'user', user.id, 'password only');
    return json({ ok: true }, 200, { 'Set-Cookie': await startSession(env, user.id) });
  }
  const challenge = randomToken();
  const code = randomCode();
  const challengeHash = await sha256(challenge);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM login_challenges WHERE user_id = ? OR expires_at < datetime('now')`).bind(user.id),
    env.DB.prepare(`INSERT INTO login_challenges (token_hash, user_id, code_hash, expires_at) VALUES (?, ?, ?, datetime('now', ?))`)
      .bind(challengeHash, user.id, await sha256(challengeHash + ':' + code), `+${CODE_MINUTES} minutes`),
  ]);
  await sendCode(env, url, user, code);
  return json({ challenge, email: maskEmail(user.email), minutes: CODE_MINUTES });
}

async function loadChallenge(env, challenge, purpose = 'login') {
  const token = str(challenge, 'אתגר', { required: true, max: 100 });
  const hash = await sha256(token);
  const ch = await env.DB.prepare(
    `SELECT c.*, u.email, u.username, u.name FROM login_challenges c JOIN users u ON u.id = c.user_id
     WHERE c.token_hash = ? AND c.expires_at > datetime('now') AND u.active = 1 AND c.purpose = ?`
  ).bind(hash, purpose).first();
  if (!ch) throw new HttpError(401, 'פג תוקף הקוד. התחברו מחדש.');
  return ch;
}

// Step 2: the 6-digit code from the e-mail.
async function verifyCode(request, env) {
  const data = await body(request);
  const ch = await loadChallenge(env, data.challenge);
  const code = str(data.code, 'קוד', { required: true, max: 10 }).replace(/\s/g, '');
  if (await tooManyFailures(env, ch.username)) throw lockedError();
  if (ch.attempts >= CODE_MAX_ATTEMPTS) {
    await env.DB.prepare('DELETE FROM login_challenges WHERE token_hash = ?').bind(ch.token_hash).run();
    throw new HttpError(401, 'יותר מדי ניסיונות קוד. התחברו מחדש.');
  }
  const ok = /^\d{6}$/.test(code) && timingSafeEqual(await sha256(ch.token_hash + ':' + code), ch.code_hash);
  if (!ok) {
    await env.DB.batch([
      env.DB.prepare('UPDATE login_challenges SET attempts = attempts + 1 WHERE token_hash = ?').bind(ch.token_hash),
      env.DB.prepare('INSERT INTO login_failures (email) VALUES (?)').bind(ch.username),
    ]);
    throw new HttpError(401, 'הקוד שגוי');
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_challenges WHERE token_hash = ?').bind(ch.token_hash),
    env.DB.prepare('DELETE FROM login_failures WHERE email = ?').bind(ch.username),
  ]);
  await audit(env, { id: ch.user_id }, 'login', 'user', ch.user_id);
  return json({ ok: true }, 200, { 'Set-Cookie': await startSession(env, ch.user_id) });
}

async function resendCode(request, env, url) {
  const data = await body(request);
  const ch = await loadChallenge(env, data.challenge);
  if (ch.sends >= CODE_MAX_SENDS) throw new HttpError(429, 'נשלחו כבר מספיק קודים. התחברו מחדש.');
  const recent = await env.DB.prepare(
    `SELECT 1 AS r FROM login_challenges WHERE token_hash = ? AND last_sent_at > datetime('now', ?)`
  ).bind(ch.token_hash, `-${RESEND_SECONDS} seconds`).first();
  if (recent) throw new HttpError(429, `אפשר לבקש קוד חדש אחרי ${RESEND_SECONDS} שניות.`);
  const code = randomCode();
  await env.DB.prepare(
    `UPDATE login_challenges SET code_hash = ?, attempts = 0, sends = sends + 1, last_sent_at = datetime('now'),
     expires_at = datetime('now', ?) WHERE token_hash = ?`
  ).bind(await sha256(ch.token_hash + ':' + code), `+${CODE_MINUTES} minutes`, ch.token_hash).run();
  await sendCode(env, url, { name: ch.name, email: ch.email }, code);
  return json({ ok: true });
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

// ---------- meta & users ----------

async function meta(env, user) {
  const { results } = await env.DB.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').all();
  const processes = Object.fromEntries(
    Object.entries(PROCESSES).map(([k, p]) => [k, { label: p.label, area: p.area, steps: p.steps.map((s) => s.label) }])
  );
  return json({
    users: results,
    roles: ROLES,
    permissions: PERMISSIONS,
    rolePerms: Object.fromEntries(Object.keys(ROLES).map((r) => [r, permsOf(r)])),
    approval: APPROVAL,
    leadStages: LEAD_STAGES,
    eventKinds: EVENT_KINDS,
    processes,
    today: todayIL(),
    perms: permsOf(user.role),
  });
}

async function listUsers(env, user) {
  requirePerm(user, 'users.manage');
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.name, u.role, u.active, u.must_change, u.created_at,
            (SELECT MAX(at) FROM audit a WHERE a.user_id = u.id AND a.action = 'login') AS last_login,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS sessions
     FROM users u ORDER BY u.active DESC, u.name`
  ).all();
  return json({ users: results });
}

async function createUser(request, env, user) {
  requirePerm(user, 'users.manage');
  const data = await body(request);
  const name = str(data.name, 'שם', { required: true, max: 80 });
  const login = username(data.username);
  const mail = email(data.email, 'אימייל', { required: true });
  const role = oneOf(data.role, 'תפקיד', Object.keys(ROLES));
  const pass = await hashPassword(checkPassword(data.password));
  if (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(login).first()) throw new ValidationError('שם המשתמש הזה כבר תפוס');
  if (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(mail).first()) throw new ValidationError('כבר קיים משתמש עם האימייל הזה');
  const r = await env.DB.prepare('INSERT INTO users (username, email, name, role, pass, must_change) VALUES (?, ?, ?, ?, ?, 1)')
    .bind(login, mail, name, role, pass).run();
  await audit(env, user, 'create', 'user', r.meta.last_row_id, `${login} ${role}`);
  return json({ id: r.meta.last_row_id });
}

async function updateUser(request, env, user, userId) {
  requirePerm(user, 'users.manage');
  const data = await body(request);
  const target = await env.DB.prepare('SELECT id, role, active FROM users WHERE id = ?').bind(userId).first();
  if (!target) throw new HttpError(404, 'משתמש לא נמצא');
  const sets = [];
  const vals = [];
  if (data.name !== undefined) { sets.push('name = ?'); vals.push(str(data.name, 'שם', { required: true, max: 80 })); }
  if (data.username !== undefined) {
    const login = username(data.username);
    const other = await env.DB.prepare('SELECT id FROM users WHERE username = ? AND id != ?').bind(login, userId).first();
    if (other) throw new ValidationError('שם המשתמש הזה כבר תפוס');
    sets.push('username = ?'); vals.push(login);
  }
  if (data.email !== undefined) {
    const mail = email(data.email, 'אימייל', { required: true });
    const other = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?').bind(mail, userId).first();
    if (other) throw new ValidationError('כבר קיים משתמש עם האימייל הזה');
    sets.push('email = ?'); vals.push(mail);
  }
  if (data.role !== undefined) { sets.push('role = ?'); vals.push(oneOf(data.role, 'תפקיד', Object.keys(ROLES))); }
  if (data.active !== undefined) { sets.push('active = ?'); vals.push(bool(data.active) ? 1 : 0); }
  if (data.password !== undefined && data.password !== '') {
    sets.push('pass = ?', 'must_change = 1');
    vals.push(await hashPassword(checkPassword(data.password)));
  }
  if (!sets.length) throw new ValidationError('אין מה לעדכן');
  const deactivating = data.active !== undefined && !bool(data.active);
  if (userId === user.id && (deactivating || (data.role !== undefined && data.role !== 'it'))) {
    throw new ValidationError('אי אפשר להסיר הרשאת IT או להשבית את עצמך');
  }
  const stmts = [env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, userId)];
  const roleChanged = data.role !== undefined && data.role !== target.role;
  if (deactivating || (data.password !== undefined && data.password !== '') || roleChanged) {
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
  const isLawyer = user.role === 'lawyer';
  const supervise = can(user.role, 'office.supervise');
  const approve = can(user.role, 'clients.approve');
  // A lawyer sees his own calendar and cases; the office (secretary, IT) sees everyone's.
  const evFilter = isLawyer ? 'AND e.lawyer_id = ?3' : '';
  const caseFilter = isLawyer ? 'AND c.owner_id = ?1' : '';
  const queries = [
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM cases WHERE status = 'open' ${isLawyer ? 'AND owner_id = ?3' : ''}) AS open_cases,
              (SELECT COUNT(*) FROM events e WHERE e.date >= ?1 AND e.date <= ?2 ${evFilter}) AS week_events,
              (SELECT COUNT(*) FROM events e WHERE e.date = ?1 ${evFilter}) AS today_events,
              (SELECT COUNT(*) FROM tasks WHERE done = 0 AND assignee_id = ?3) AS my_open_tasks,
              (SELECT COUNT(*) FROM tasks WHERE done = 0 AND due_date IS NOT NULL AND due_date < ?1) AS overdue_tasks,
              (SELECT COUNT(*) FROM clients WHERE approval = 'pending') AS pending_approvals,
              (SELECT COUNT(*) FROM clients WHERE kind = 'lead' AND stage = 'new') AS new_leads`
    ).bind(today, week, user.id),
    env.DB.prepare(
      `SELECT e.id, e.title, e.kind, e.date, e.time, e.location, e.case_id, e.lawyer_id, l.name AS lawyer_name,
              c.title AS case_title, cl.name AS client_name
       FROM events e LEFT JOIN cases c ON c.id = e.case_id LEFT JOIN clients cl ON cl.id = c.client_id
       LEFT JOIN users l ON l.id = e.lawyer_id
       WHERE e.date >= ?1 ${evFilter.replace('?3', '?2')} ORDER BY e.date, e.time LIMIT 8`
    ).bind(today, ...(isLawyer ? [user.id] : [])),
    env.DB.prepare(`SELECT stage, COUNT(*) AS n FROM clients WHERE kind = 'lead' GROUP BY stage`),
    env.DB.prepare(
      `SELECT c.id, c.title, c.process, c.step, c.status, cl.name AS client_name, u.name AS owner_name
       FROM cases c JOIN clients cl ON cl.id = c.client_id LEFT JOIN users u ON u.id = c.owner_id
       WHERE c.status = 'open' ${caseFilter} ORDER BY c.updated_at DESC LIMIT 8`
    ).bind(...(isLawyer ? [user.id] : [])),
    env.DB.prepare(
      `SELECT t.id, t.title, t.due_date, t.done, t.case_id, c.title AS case_title, cl.name AS client_name, cr.name AS created_by_name
       FROM tasks t LEFT JOIN cases c ON c.id = t.case_id LEFT JOIN clients cl ON cl.id = c.client_id
       LEFT JOIN users cr ON cr.id = t.created_by
       WHERE t.done = 0 AND t.assignee_id = ? ORDER BY t.due_date IS NULL, t.due_date LIMIT 10`
    ).bind(user.id),
    env.DB.prepare(
      `SELECT cl.id, cl.name, cl.kind, cl.stage, cl.phone, cl.source, cl.created_at, cr.name AS created_by_name
       FROM clients cl LEFT JOIN users cr ON cr.id = cl.created_by WHERE cl.approval = 'pending' ORDER BY cl.created_at LIMIT 10`
    ),
  ];
  if (supervise) {
    queries.push(env.DB.prepare(
      `SELECT t.id, t.title, t.due_date, t.done, t.case_id, c.title AS case_title, cl.name AS client_name, u.name AS assignee_name
       FROM tasks t LEFT JOIN cases c ON c.id = t.case_id LEFT JOIN clients cl ON cl.id = c.client_id
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.done = 0 AND t.due_date IS NOT NULL AND t.due_date < ? ORDER BY t.due_date LIMIT 10`
    ).bind(today));
  }
  const [counts, events, pipeline, cases, myTasks, pending, overdue] = await env.DB.batch(queries);
  return json({
    today,
    role: user.role,
    counts: counts.results[0],
    events: events.results,
    pipeline: pipeline.results,
    cases: cases.results,
    myTasks: myTasks.results,
    pending: approve || user.role === 'secretary' ? pending.results : [],
    overdue: overdue ? overdue.results : null,
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
  const approval = url.searchParams.get('approval');
  const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
  const where = [];
  const vals = [];
  if (kind === 'lead' || kind === 'client') { where.push('cl.kind = ?'); vals.push(kind); }
  if (approval && APPROVAL[approval]) { where.push('cl.approval = ?'); vals.push(approval); }
  if (q) { where.push('(cl.name LIKE ? OR cl.phone LIKE ? OR cl.email LIKE ? OR cl.id_number LIKE ?)'); vals.push(...Array(4).fill(`%${q}%`)); }
  const { results } = await env.DB.prepare(
    `SELECT cl.id, cl.kind, cl.stage, cl.approval, cl.name, cl.phone, cl.email, cl.source, cl.updated_at, u.name AS owner_name,
            (SELECT COUNT(*) FROM cases c WHERE c.client_id = cl.id AND c.status = 'open') AS open_cases
     FROM clients cl LEFT JOIN users u ON u.id = cl.owner_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY cl.updated_at DESC LIMIT 300`
  ).bind(...vals).all();
  return json({ clients: results });
}

async function createClient(request, env, user) {
  const f = clientFields(await body(request), false);
  await userExists(env, f.owner_id);
  const approval = initialApproval(user.role);
  if (approval !== 'approved' && f.kind === 'client') f.kind = 'lead';
  if (approval !== 'approved' && f.stage === 'signed') f.stage = 'offer';
  const r = await env.DB.prepare(
    `INSERT INTO clients (kind, stage, name, id_number, phone, email, address, source, notes, owner_id, approval, approved_by, approved_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${approval === 'approved' ? "datetime('now')" : 'NULL'}, ?)`
  ).bind(f.kind, f.stage, f.name, f.id_number, f.phone, f.email, f.address, f.source, f.notes, f.owner_id,
    approval, approval === 'approved' ? user.id : null, user.id).run();
  await audit(env, user, 'create', 'client', r.meta.last_row_id);
  return json({ id: r.meta.last_row_id, approval });
}

async function getClient(env, clientId) {
  const [client, cases] = await env.DB.batch([
    env.DB.prepare(
      `SELECT cl.*, u.name AS owner_name, a.name AS approved_by_name, cr.name AS created_by_name
       FROM clients cl LEFT JOIN users u ON u.id = cl.owner_id LEFT JOIN users a ON a.id = cl.approved_by
       LEFT JOIN users cr ON cr.id = cl.created_by WHERE cl.id = ?`
    ).bind(clientId),
    env.DB.prepare(
      `SELECT c.id, c.title, c.process, c.step, c.status, c.case_number, u.name AS owner_name
       FROM cases c LEFT JOIN users u ON u.id = c.owner_id WHERE c.client_id = ? ORDER BY c.status = 'closed', c.updated_at DESC`
    ).bind(clientId),
  ]);
  if (!client.results[0]) throw new HttpError(404, 'לקוח לא נמצא');
  return json({ client: client.results[0], cases: cases.results });
}

async function updateClient(request, env, user, clientId) {
  const f = clientFields(await body(request), true);
  const current = await env.DB.prepare('SELECT approval FROM clients WHERE id = ?').bind(clientId).first();
  if (!current) throw new HttpError(404, 'לקוח לא נמצא');
  // Becoming a client needs a lawyer's approval first.
  if (current.approval !== 'approved' && (f.kind === 'client' || f.stage === 'signed')) {
    throw new ValidationError('לפני שליד הופך ללקוח צריך אישור של עורך דין');
  }
  const keys = Object.keys(f);
  if (!keys.length) throw new ValidationError('אין מה לעדכן');
  if (f.owner_id !== undefined) await userExists(env, f.owner_id);
  await env.DB.prepare(
    `UPDATE clients SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...keys.map((k) => f[k]), clientId).run();
  await audit(env, user, 'update', 'client', clientId, keys.join(','));
  return json({ ok: true });
}

async function decideClient(request, env, user, clientId) {
  requirePerm(user, 'clients.approve');
  const data = await body(request);
  const decision = oneOf(data.decision, 'החלטה', ['approved', 'rejected']);
  const r = await env.DB.prepare(
    `UPDATE clients SET approval = ?, approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).bind(decision, user.id, clientId).run();
  if (!r.meta.changes) throw new HttpError(404, 'לקוח לא נמצא');
  await audit(env, user, decision === 'approved' ? 'approve' : 'reject', 'client', clientId);
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

async function listCases(env, url, user) {
  const status = url.searchParams.get('status') || 'open';
  const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
  const mine = url.searchParams.get('mine') === '1';
  const where = [];
  const vals = [];
  if (status === 'open' || status === 'closed') { where.push('c.status = ?'); vals.push(status); }
  if (mine) { where.push('c.owner_id = ?'); vals.push(user.id); }
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
  const client = await env.DB.prepare('SELECT id, kind, approval FROM clients WHERE id = ?').bind(clientId).first();
  if (!client) throw new ValidationError('לקוח לא נמצא');
  if (client.approval !== 'approved') throw new ValidationError('אפשר לפתוח תיק רק ללקוח שעורך דין אישר');
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
    env.DB.prepare(
      `SELECT e.id, e.kind, e.title, e.date, e.time, e.location, e.notes, e.lawyer_id, l.name AS lawyer_name
       FROM events e LEFT JOIN users l ON l.id = e.lawyer_id WHERE e.case_id = ? ORDER BY e.date, e.time`
    ).bind(caseId),
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
  if (f.status !== undefined) requirePerm(user, 'cases.close');
  const keys = Object.keys(f);
  if (!keys.length) throw new ValidationError('אין מה לעדכן');
  if (f.owner_id !== undefined) await userExists(env, f.owner_id);
  const r = await env.DB.prepare(
    `UPDATE cases SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...keys.map((k) => f[k]), caseId).run();
  if (!r.meta.changes) throw new HttpError(404, 'תיק לא נמצא');
  await audit(env, user, f.status ? (f.status === 'closed' ? 'close' : 'reopen') : 'update', 'case', caseId, keys.join(','));
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
  if (scope === 'overdue') { where.push('t.due_date IS NOT NULL AND t.due_date < ?'); vals.push(todayIL()); }
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.due_date, t.done, t.case_id, t.assignee_id, c.title AS case_title, cl.name AS client_name,
            u.name AS assignee_name, cr.name AS created_by_name
     FROM tasks t LEFT JOIN cases c ON c.id = t.case_id LEFT JOIN clients cl ON cl.id = c.client_id
     LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN users cr ON cr.id = t.created_by
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

// ---------- events (each lawyer has his own calendar) ----------

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

// Whose calendar an event goes into. Without "events.all" a user manages only his own.
async function resolveLawyer(env, user, value) {
  if (!can(user.role, 'events.all')) return user.id;
  const lawyerId = id(value, 'יומן של', { required: false }) ?? user.id;
  return userExists(env, lawyerId);
}

async function loadEventForEdit(env, user, eventId) {
  const e = await env.DB.prepare('SELECT id, lawyer_id FROM events WHERE id = ?').bind(eventId).first();
  if (!e) throw new HttpError(404, 'אירוע לא נמצא');
  if (!can(user.role, 'events.all') && e.lawyer_id !== user.id) throw new HttpError(403, 'אפשר לערוך רק אירועים ביומן שלך');
  return e;
}

async function listEvents(env, url, user) {
  const from = date(url.searchParams.get('from'), 'מתאריך') || todayIL();
  const to = date(url.searchParams.get('to'), 'עד תאריך') || addDays(from, 90);
  const lawyer = url.searchParams.get('lawyer') || (user.role === 'lawyer' ? 'mine' : 'all');
  const where = ['e.date >= ?', 'e.date <= ?'];
  const vals = [from, to];
  if (lawyer === 'mine') { where.push('e.lawyer_id = ?'); vals.push(user.id); }
  else if (lawyer !== 'all') { where.push('e.lawyer_id = ?'); vals.push(id(lawyer, 'יומן של')); }
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.kind, e.title, e.date, e.time, e.location, e.notes, e.case_id, e.lawyer_id, l.name AS lawyer_name,
            c.title AS case_title, cl.name AS client_name
     FROM events e LEFT JOIN cases c ON c.id = e.case_id LEFT JOIN clients cl ON cl.id = c.client_id
     LEFT JOIN users l ON l.id = e.lawyer_id
     WHERE ${where.join(' AND ')} ORDER BY e.date, e.time LIMIT 500`
  ).bind(...vals).all();
  return json({ events: results, from, to, lawyer });
}

async function createEvent(request, env, user) {
  const data = await body(request);
  const f = eventFields(data, false);
  const caseId = id(data.case_id, 'תיק', { required: false });
  const lawyerId = await resolveLawyer(env, user, data.lawyer_id);
  if (caseId && !(await env.DB.prepare('SELECT id FROM cases WHERE id = ?').bind(caseId).first())) throw new ValidationError('תיק לא נמצא');
  const r = await env.DB.prepare(
    'INSERT INTO events (case_id, lawyer_id, kind, title, date, time, location, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(caseId, lawyerId, f.kind, f.title, f.date, f.time, f.location, f.notes, user.id).run();
  await audit(env, user, 'create', 'event', r.meta.last_row_id);
  return json({ id: r.meta.last_row_id });
}

async function updateEvent(request, env, user, eventId) {
  const data = await body(request);
  await loadEventForEdit(env, user, eventId);
  const f = eventFields(data, true);
  if (data.lawyer_id !== undefined) f.lawyer_id = await resolveLawyer(env, user, data.lawyer_id);
  const keys = Object.keys(f);
  if (!keys.length) throw new ValidationError('אין מה לעדכן');
  await env.DB.prepare(`UPDATE events SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map((k) => f[k]), eventId).run();
  await audit(env, user, 'update', 'event', eventId, keys.join(','));
  return json({ ok: true });
}

async function deleteEvent(env, user, eventId) {
  await loadEventForEdit(env, user, eventId);
  await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(eventId).run();
  await audit(env, user, 'delete', 'event', eventId);
  return json({ ok: true });
}

// ---------- audit & system (IT) ----------

async function listAudit(env, user) {
  requirePerm(user, 'audit.view');
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.detail, a.at, u.name AS user_name
     FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300`
  ).all();
  return json({ audit: results });
}

async function systemStatus(env, user) {
  requirePerm(user, 'system.view');
  const [ver, counts, fails] = await env.DB.batch([
    env.DB.prepare('SELECT MAX(version) AS v FROM schema_version'),
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users WHERE active = 1) AS users,
              (SELECT COUNT(*) FROM sessions WHERE expires_at > datetime('now')) AS sessions,
              (SELECT COUNT(*) FROM clients) AS clients,
              (SELECT COUNT(*) FROM cases) AS cases,
              (SELECT COUNT(*) FROM tasks) AS tasks,
              (SELECT COUNT(*) FROM events) AS events`
    ),
    env.DB.prepare(
      `SELECT email AS username, COUNT(*) AS n, MAX(at) AS last FROM login_failures WHERE at > datetime('now', '-1 day') GROUP BY email ORDER BY n DESC LIMIT 20`
    ),
  ]);
  return json({
    schema: { current: ver.results[0].v, latest: MIGRATIONS.length },
    mail: { configured: mailConfigured(env) && env.DEV_MAIL_LOG !== '1', from: env.MAIL_FROM || DEFAULT_MAIL_FROM },
    setupTokenSet: Boolean(env.SETUP_TOKEN),
    twoFactor: await twoFactorRequired(env),
    counts: counts.results[0],
    loginFailures: fails.results,
  });
}

async function revokeSessions(request, env, user) {
  requirePerm(user, 'system.view');
  const data = await body(request);
  if (data.all === true) {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id != ?').bind(user.id).run();
    await audit(env, user, 'revoke', 'session', null, 'all');
  } else {
    const target = id(data.user_id, 'משתמש');
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target).run();
    await audit(env, user, 'revoke', 'session', target);
  }
  return json({ ok: true });
}

// Turning 2FA on sends a code to the IT user who asks, and switches on only after that code
// comes back, so a broken mail setup can never lock the office out. Turning it off is immediate.
async function start2fa(request, env, url, user) {
  requirePerm(user, 'system.view');
  const data = await body(request);
  if (data.enable === false) {
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_by) VALUES ('require_2fa', '0', ?)
       ON CONFLICT(key) DO UPDATE SET value = '0', updated_by = excluded.updated_by, updated_at = datetime('now')`
    ).bind(user.id).run();
    await audit(env, user, 'update', 'setting', null, 'require_2fa=0');
    return json({ ok: true, enabled: false });
  }
  if (!mailConfigured(env) && env.DEV_MAIL_LOG !== '1') {
    throw new HttpError(503, 'שליחת מיילים עוד לא הוגדרה בשרת. קודם מגדירים את Email Sending ב-Cloudflare.');
  }
  const challenge = randomToken();
  const code = randomCode();
  const challengeHash = await sha256(challenge);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM login_challenges WHERE (user_id = ? AND purpose = 'enable_2fa') OR expires_at < datetime('now')`).bind(user.id),
    env.DB.prepare(`INSERT INTO login_challenges (token_hash, user_id, code_hash, expires_at, purpose) VALUES (?, ?, ?, datetime('now', ?), 'enable_2fa')`)
      .bind(challengeHash, user.id, await sha256(challengeHash + ':' + code), `+${CODE_MINUTES} minutes`),
  ]);
  await sendCode(env, url, user, code);
  return json({ challenge, email: maskEmail(user.email), minutes: CODE_MINUTES });
}

async function confirm2fa(request, env, user) {
  requirePerm(user, 'system.view');
  const data = await body(request);
  const ch = await loadChallenge(env, data.challenge, 'enable_2fa');
  if (ch.user_id !== user.id) throw new HttpError(403, 'קוד לא שייך למשתמש הזה');
  const code = str(data.code, 'קוד', { required: true, max: 10 }).replace(/\s/g, '');
  if (ch.attempts >= CODE_MAX_ATTEMPTS) {
    await env.DB.prepare('DELETE FROM login_challenges WHERE token_hash = ?').bind(ch.token_hash).run();
    throw new HttpError(401, 'יותר מדי ניסיונות. מתחילים מחדש.');
  }
  const ok = /^\d{6}$/.test(code) && timingSafeEqual(await sha256(ch.token_hash + ':' + code), ch.code_hash);
  if (!ok) {
    await env.DB.prepare('UPDATE login_challenges SET attempts = attempts + 1 WHERE token_hash = ?').bind(ch.token_hash).run();
    throw new HttpError(401, 'הקוד שגוי');
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_challenges WHERE token_hash = ?').bind(ch.token_hash),
    env.DB.prepare(
      `INSERT INTO settings (key, value, updated_by) VALUES ('require_2fa', '1', ?)
       ON CONFLICT(key) DO UPDATE SET value = '1', updated_by = excluded.updated_by, updated_at = datetime('now')`
    ).bind(user.id),
  ]);
  await audit(env, user, 'update', 'setting', null, 'require_2fa=1');
  return json({ ok: true, enabled: true });
}

// ---------- notifications & e-mails ----------

async function listNotifications(env, user) {
  const [list, count] = await env.DB.batch([
    env.DB.prepare(
      `SELECT n.id, n.kind, n.title, n.body, n.link, n.email_id, n.read_at, n.created_at, e.from_email, e.snippet, c.name AS client_name, e.client_id
       FROM notifications n LEFT JOIN emails e ON e.id = n.email_id LEFT JOIN clients c ON c.id = e.client_id
       WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 60`
    ).bind(user.id),
    env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').bind(user.id),
  ]);
  return json({ notifications: list.results, unread: count.results[0].n });
}

async function readNotifications(request, env, user) {
  const data = await body(request);
  if (data.all === true) {
    await env.DB.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`).bind(user.id).run();
  } else {
    const nid = id(data.id, 'התראה');
    await env.DB.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ?`).bind(nid, user.id).run();
  }
  return json({ ok: true });
}

async function listEmails(env, url) {
  const clientId = id(url.searchParams.get('client_id'), 'לקוח', { required: false });
  const caseId = id(url.searchParams.get('case_id'), 'תיק', { required: false });
  const where = [];
  const vals = [];
  if (clientId) { where.push('e.client_id = ?'); vals.push(clientId); }
  if (caseId) { where.push('e.case_id = ?'); vals.push(caseId); }
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.client_id, e.case_id, e.from_email, e.from_name, e.subject, e.snippet, e.received_at, c.name AS client_name
     FROM emails e LEFT JOIN clients c ON c.id = e.client_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.received_at DESC LIMIT 200`
  ).bind(...vals).all();
  return json({ emails: results });
}

async function getEmail(env, user, emailId) {
  const e = await env.DB.prepare(
    `SELECT e.*, c.name AS client_name, k.title AS case_title FROM emails e LEFT JOIN clients c ON c.id = e.client_id
     LEFT JOIN cases k ON k.id = e.case_id WHERE e.id = ?`
  ).bind(emailId).first();
  if (!e) throw new HttpError(404, 'מייל לא נמצא');
  await env.DB.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE email_id = ? AND user_id = ? AND read_at IS NULL`).bind(emailId, user.id).run();
  let attachments = [];
  try { attachments = JSON.parse(e.attachments || '[]'); } catch { /* ignore */ }
  return json({ email: { ...e, attachments } });
}

// ---------- Gmail admin (IT) ----------

async function gmailStatus(env, url, user) {
  requirePerm(user, 'system.view');
  const cfg = await gmailConfig(env);
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM emails').first();
  return json({
    hasClient: Boolean(cfg.clientId && cfg.clientSecret),
    clientId: cfg.clientId,
    connected: Boolean(cfg.refreshToken),
    account: cfg.account,
    connectedAt: cfg.connectedAt,
    lastRun: cfg.lastRun,
    lastError: cfg.lastError,
    redirectUri: redirectUri(url.origin),
    emails: count.n,
  });
}

async function gmailSaveConfig(request, env, user) {
  requirePerm(user, 'system.view');
  const data = await body(request);
  const clientId = str(data.client_id, 'Client ID', { required: true, max: 200 });
  const clientSecret = str(data.client_secret, 'Client secret', { required: true, max: 200 });
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new ValidationError('Client ID צריך להסתיים ב-.apps.googleusercontent.com');
  await env.DB.batch([
    setSetting(env.DB, 'gmail_client_id', clientId, user.id),
    setSetting(env.DB, 'gmail_client_secret', clientSecret, user.id),
  ]);
  await audit(env, user, 'update', 'setting', null, 'gmail client');
  return json({ ok: true });
}

async function gmailConnect(env, url, user) {
  requirePerm(user, 'system.view');
  const cfg = await gmailConfig(env);
  if (!cfg.clientId || !cfg.clientSecret) throw new ValidationError('קודם שומרים Client ID ו-Client secret');
  const state = randomToken(24);
  await env.DB.batch([
    setSetting(env.DB, 'gmail_oauth_state', `${await sha256(state)}|${Date.now() + 10 * 60 * 1000}|${user.id}`, user.id),
  ]);
  return json({ url: authUrl(cfg.clientId, redirectUri(url.origin), state) });
}

function redirectHome(status) {
  return new Response(null, { status: 302, headers: { Location: `/#/users?gmail=${encodeURIComponent(status)}`, ...SECURITY_HEADERS } });
}

async function gmailCallback(env, url) {
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const stored = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'gmail_oauth_state'`).first();
  await env.DB.prepare(`DELETE FROM settings WHERE key = 'gmail_oauth_state'`).run(); // single use
  if (!stored) return redirectHome('expired');
  const [hash, expires, userId] = stored.value.split('|');
  if (!state || Date.now() > Number(expires) || !timingSafeEqual(await sha256(state), hash)) return redirectHome('expired');
  if (url.searchParams.get('error') || !code) return redirectHome('denied');
  const cfg = await gmailConfig(env);
  try {
    const tokens = await exchangeCode(env, cfg, code, redirectUri(url.origin));
    if (!tokens.refresh_token) return redirectHome('no_refresh');
    if (!String(tokens.scope || '').includes('gmail.readonly')) return redirectHome('scope');
    const account = await profileEmail(env, tokens.access_token);
    await env.DB.batch([
      setSetting(env.DB, 'gmail_refresh_token', tokens.refresh_token, Number(userId) || null),
      setSetting(env.DB, 'gmail_account', account, Number(userId) || null),
      setSetting(env.DB, 'gmail_connected_at', new Date().toISOString(), Number(userId) || null),
      setSetting(env.DB, 'gmail_last_sync', String(Date.now()), Number(userId) || null),
      setSetting(env.DB, 'gmail_last_error', null),
    ]);
    await audit(env, { id: Number(userId) || null }, 'connect', 'gmail', null, account);
    return redirectHome('connected');
  } catch (e) {
    console.error('gmail callback', e && e.message);
    return redirectHome('failed');
  }
}

async function gmailSyncNow(env, user) {
  requirePerm(user, 'system.view');
  try {
    const r = await syncGmail(env);
    return json({ ok: true, ...r });
  } catch (e) {
    throw new HttpError(502, e.message);
  }
}

async function gmailDisconnect(env, user) {
  requirePerm(user, 'system.view');
  const cfg = await gmailConfig(env);
  if (cfg.refreshToken) await revoke(env, cfg.refreshToken);
  await env.DB.batch(['gmail_refresh_token', 'gmail_account', 'gmail_connected_at', 'gmail_last_error'].map((k) => setSetting(env.DB, k, null)));
  await audit(env, user, 'disconnect', 'gmail', null, cfg.account);
  return json({ ok: true });
}
