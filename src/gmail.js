// Gmail connection (OAuth, read-only) and the 5-minute sync that turns e-mails from known
// clients into messages, notifications and tasks. Only mail whose sender matches a client's
// e-mail is stored; for anything else only the Gmail message id is kept (so it is not fetched again).

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const MAX_MESSAGES_PER_RUN = 20; // keeps each run under the free plan's subrequest limit
const MAX_BODY_CHARS = 20000;

function endpoints(env) {
  return {
    token: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    revoke: env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
    api: (env.GMAIL_API_BASE || 'https://gmail.googleapis.com') + '/gmail/v1/users/me',
  };
}

// ---------- settings ----------

export async function getSettings(db, keys) {
  const { results } = await db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`
  ).bind(...keys).all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export function setSetting(db, key, value, userId = null) {
  if (value === null || value === undefined) return db.prepare('DELETE FROM settings WHERE key = ?').bind(key);
  return db.prepare(
    `INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`
  ).bind(key, String(value), userId);
}

const KEYS = ['gmail_client_id', 'gmail_client_secret', 'gmail_refresh_token', 'gmail_account', 'gmail_last_sync',
  'gmail_last_error', 'gmail_last_run', 'gmail_connected_at'];

export async function gmailConfig(env) {
  const s = await getSettings(env.DB, KEYS);
  return {
    clientId: env.GOOGLE_CLIENT_ID || s.gmail_client_id || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || s.gmail_client_secret || '',
    refreshToken: s.gmail_refresh_token || '',
    account: s.gmail_account || '',
    lastSync: s.gmail_last_sync ? Number(s.gmail_last_sync) : 0,
    lastError: s.gmail_last_error || '',
    lastRun: s.gmail_last_run || '',
    connectedAt: s.gmail_connected_at || '',
  };
}

export function redirectUri(origin) {
  return origin + '/api/gmail/callback';
}

export function authUrl(clientId, redirect, state) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${p}`;
}

// ---------- OAuth ----------

async function tokenRequest(env, params) {
  const res = await fetch(endpoints(env).token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `token ${res.status}`);
    err.code = data.error || String(res.status);
    throw err;
  }
  return data;
}

export async function exchangeCode(env, cfg, code, redirect) {
  return tokenRequest(env, {
    code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirect, grant_type: 'authorization_code',
  });
}

export async function accessToken(env, cfg) {
  const data = await tokenRequest(env, {
    client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: 'refresh_token',
  });
  return data.access_token;
}

export async function revoke(env, token) {
  try {
    await fetch(endpoints(env).revoke, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString(),
    });
  } catch { /* best effort */ }
}

async function gmailGet(env, token, path) {
  const res = await fetch(endpoints(env).api + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = new Error(`gmail ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function profileEmail(env, token) {
  const p = await gmailGet(env, token, '/profile');
  return String(p.emailAddress || '').toLowerCase();
}

// ---------- parsing (pure) ----------

export function parseFrom(value) {
  const v = String(value || '').trim();
  const m = v.match(/^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  if (m) {
    const name = m[1].trim().replace(/^"(.*)"$/, '$1').trim();
    return { name, email: m[2].toLowerCase() };
  }
  const bare = v.match(/[^\s<>"]+@[^\s<>"]+/);
  return { name: '', email: bare ? bare[0].toLowerCase() : '' };
}

export function header(headers, name) {
  const h = (headers || []).find((x) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value) : '';
}

export function decodeBase64Url(data) {
  const b64 = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Plain text of a Gmail "full" message payload: text/plain if there is one, else text/html stripped.
export function extractText(payload) {
  let plain = '';
  let html = '';
  const walk = (part) => {
    if (!part) return;
    const type = String(part.mimeType || '').toLowerCase();
    const isAttachment = part.filename && part.filename.length > 0;
    if (!isAttachment && part.body && part.body.data) {
      if (type === 'text/plain' && !plain) plain = decodeBase64Url(part.body.data);
      else if (type === 'text/html' && !html) html = decodeBase64Url(part.body.data);
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  const text = plain || (html ? htmlToText(html) : '');
  return text.replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY_CHARS);
}

export function attachmentNames(payload) {
  const names = [];
  const walk = (part) => {
    if (!part) return;
    if (part.filename) names.push(String(part.filename).slice(0, 200));
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return names.slice(0, 20);
}

// ---------- sync ----------

// Runs one sync. Returns { checked, stored } or throws; callers record errors.
export async function syncGmail(env, { now = Date.now() } = {}) {
  const db = env.DB;
  const cfg = await gmailConfig(env);
  if (!cfg.refreshToken || !cfg.clientId || !cfg.clientSecret) return { checked: 0, stored: 0, skipped: 'not connected' };

  let token;
  try {
    token = await accessToken(env, cfg);
  } catch (e) {
    const msg = e.code === 'invalid_grant'
      ? 'החיבור ל-Gmail פג או בוטל. יש ללחוץ "חיבור מחדש".'
      : 'קבלת הרשאה מ-Google נכשלה: ' + e.message;
    await db.batch([setSetting(db, 'gmail_last_error', msg), setSetting(db, 'gmail_last_run', new Date(now).toISOString())]);
    throw new Error(msg);
  }

  // A little overlap with the previous run; already-seen ids are skipped.
  const since = Math.max(0, Math.floor((cfg.lastSync || now) / 1000) - 120);
  const list = await gmailGet(env, token, `/messages?maxResults=${MAX_MESSAGES_PER_RUN}&q=${encodeURIComponent(`in:inbox after:${since}`)}`);
  const ids = (list.messages || []).map((m) => m.id).filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x));

  let stored = 0;
  let checked = 0;
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const [seen, have] = await db.batch([
      db.prepare(`SELECT gmail_id FROM gmail_seen WHERE gmail_id IN (${placeholders})`).bind(...ids),
      db.prepare(`SELECT gmail_id FROM emails WHERE gmail_id IN (${placeholders})`).bind(...ids),
    ]);
    const known = new Set([...seen.results, ...have.results].map((r) => r.gmail_id));
    for (const gid of ids.reverse()) { // oldest first
      if (known.has(gid)) continue;
      checked++;
      const metaMsg = await gmailGet(env, token, `/messages/${gid}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      const from = parseFrom(header(metaMsg.payload && metaMsg.payload.headers, 'From'));
      const client = from.email
        ? await db.prepare(`SELECT id, name, owner_id FROM clients WHERE lower(email) = ? ORDER BY approval = 'approved' DESC, id LIMIT 1`).bind(from.email).first()
        : null;
      if (!client) {
        await db.prepare('INSERT OR IGNORE INTO gmail_seen (gmail_id) VALUES (?)').bind(gid).run();
        continue;
      }
      const full = await gmailGet(env, token, `/messages/${gid}?format=full`);
      await storeClientEmail(db, client, from, full);
      stored++;
    }
  }

  await db.batch([
    setSetting(db, 'gmail_last_sync', String(now)),
    setSetting(db, 'gmail_last_run', new Date(now).toISOString()),
    setSetting(db, 'gmail_last_error', null),
    db.prepare(`DELETE FROM gmail_seen WHERE at < datetime('now', '-14 days')`),
  ]);
  return { checked, stored };
}

async function storeClientEmail(db, client, from, msg) {
  const headers = (msg.payload && msg.payload.headers) || [];
  const subject = (header(headers, 'Subject') || '(ללא נושא)').slice(0, 300);
  const internal = Number(msg.internalDate) || Date.now();
  const receivedAt = new Date(internal).toISOString().replace('T', ' ').slice(0, 19);
  const body = extractText(msg.payload);
  const attachments = attachmentNames(msg.payload);
  const snippet = String(msg.snippet || body.slice(0, 200)).slice(0, 300);

  const kase = await db.prepare(
    `SELECT id, title, owner_id FROM cases WHERE client_id = ? AND status = 'open' ORDER BY updated_at DESC LIMIT 1`
  ).bind(client.id).first();
  const lawyerId = (kase && kase.owner_id) || client.owner_id || null;

  const ins = await db.prepare(
    `INSERT OR IGNORE INTO emails (gmail_id, thread_id, client_id, case_id, from_email, from_name, subject, snippet, body, attachments, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(msg.id, msg.threadId || '', client.id, kase ? kase.id : null, from.email, from.name.slice(0, 200), subject, snippet, body,
    JSON.stringify(attachments), receivedAt).run();
  if (!ins.meta.changes) return;
  const emailId = ins.meta.last_row_id;

  // Who hears about it: the responsible lawyer and every active secretary.
  const { results: secretaries } = await db.prepare(`SELECT id FROM users WHERE role = 'secretary' AND active = 1`).all();
  const recipients = new Set(secretaries.map((u) => u.id));
  if (lawyerId) recipients.add(lawyerId);

  const title = `מייל חדש מ${client.name}`;
  const stmts = [...recipients].map((uid) => db.prepare(
    `INSERT INTO notifications (user_id, kind, title, body, link, email_id) VALUES (?, 'email', ?, ?, ?, ?)`
  ).bind(uid, title, subject, `#/emails/${emailId}`, emailId));

  if (lawyerId) {
    stmts.push(db.prepare(
      `INSERT INTO tasks (case_id, title, due_date, assignee_id, created_by, email_id) VALUES (?, ?, date('now'), ?, NULL, ?)`
    ).bind(kase ? kase.id : null, `לטפל במייל מ${client.name}: ${subject}`.slice(0, 200), lawyerId, emailId));
  }
  if (kase) {
    stmts.push(db.prepare(`INSERT INTO notes (case_id, user_id, text) VALUES (?, NULL, ?)`).bind(kase.id, `התקבל מייל מ${client.name}: ${subject}`.slice(0, 4000)));
    stmts.push(db.prepare(`UPDATE cases SET updated_at = datetime('now') WHERE id = ?`).bind(kase.id));
  }
  stmts.push(db.prepare(`UPDATE clients SET updated_at = datetime('now') WHERE id = ?`).bind(client.id));
  stmts.push(db.prepare(`INSERT INTO audit (user_id, action, entity, entity_id, detail) VALUES (NULL, 'email', 'client', ?, ?)`).bind(client.id, String(emailId)));
  await db.batch(stmts);
}
