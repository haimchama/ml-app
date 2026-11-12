// Append-only migrations. Never edit one that was deployed; add a new one.
export const MIGRATIONS = [
  // 1: initial schema
  [
    `CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'secretary',
      pass TEXT NOT NULL,
      must_change INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE login_challenges (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      sends INTEGER NOT NULL DEFAULT 1,
      last_sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    )`,
    `CREATE TABLE login_failures (
      email TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX login_failures_email ON login_failures(email, at)`,
    `CREATE TABLE clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'lead',
      stage TEXT NOT NULL DEFAULT 'new',
      name TEXT NOT NULL,
      id_number TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      owner_id INTEGER REFERENCES users(id),
      approval TEXT NOT NULL DEFAULT 'pending',
      approved_by INTEGER REFERENCES users(id),
      approved_at TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX clients_approval ON clients(approval)`,
    `CREATE TABLE cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      title TEXT NOT NULL,
      process TEXT NOT NULL DEFAULT 'general',
      step INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      case_number TEXT NOT NULL DEFAULT '',
      court TEXT NOT NULL DEFAULT '',
      opposing_party TEXT NOT NULL DEFAULT '',
      fee_type TEXT NOT NULL DEFAULT '',
      fee_amount TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      owner_id INTEGER REFERENCES users(id),
      opened_at TEXT NOT NULL DEFAULT (date('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX cases_client ON cases(client_id)`,
    `CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER REFERENCES cases(id),
      client_id INTEGER REFERENCES clients(id),
      step INTEGER,
      title TEXT NOT NULL,
      due_date TEXT,
      assignee_id INTEGER REFERENCES users(id),
      done INTEGER NOT NULL DEFAULT 0,
      done_at TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX tasks_case ON tasks(case_id)`,
    `CREATE INDEX tasks_open ON tasks(done, due_date)`,
    `CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER REFERENCES cases(id),
      lawyer_id INTEGER REFERENCES users(id),
      kind TEXT NOT NULL DEFAULT 'meeting',
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT,
      location TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX events_date ON events(date)`,
    `CREATE INDEX events_lawyer ON events(lawyer_id, date)`,
    `CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER REFERENCES cases(id),
      client_id INTEGER REFERENCES clients(id),
      user_id INTEGER REFERENCES users(id),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id INTEGER,
      detail TEXT NOT NULL DEFAULT '',
      at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ],
  // 2: system settings (2FA on/off is switched from inside the app by IT)
  [
    `CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `ALTER TABLE login_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login'`,
  ],
  // 3: log in with an English username instead of the e-mail address
  [
    `ALTER TABLE users ADD COLUMN username TEXT`,
    `UPDATE users SET username = lower(substr(email, 1, instr(email, '@') - 1))`,
    `UPDATE users SET username = username || id
     WHERE EXISTS (SELECT 1 FROM users u2 WHERE u2.username = users.username AND u2.id < users.id)`,
    `CREATE UNIQUE INDEX users_username ON users(username)`,
  ],
  // 4: Gmail – client e-mails, notifications, seen ids
  [
    `CREATE TABLE emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gmail_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL DEFAULT '',
      client_id INTEGER REFERENCES clients(id),
      case_id INTEGER REFERENCES cases(id),
      from_email TEXT NOT NULL,
      from_name TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      attachments TEXT NOT NULL DEFAULT '[]',
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX emails_client ON emails(client_id, received_at)`,
    `CREATE INDEX emails_case ON emails(case_id, received_at)`,
    `CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',
      email_id INTEGER REFERENCES emails(id),
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX notifications_user ON notifications(user_id, read_at, id)`,
    `CREATE TABLE gmail_seen (
      gmail_id TEXT PRIMARY KEY,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `ALTER TABLE tasks ADD COLUMN email_id INTEGER REFERENCES emails(id)`,
  ],
];

let migrated = false;

export async function migrate(db) {
  if (migrated) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)').run();
  const row = await db.prepare('SELECT MAX(version) AS v FROM schema_version').first();
  let current = (row && row.v) || 0;
  while (current < MIGRATIONS.length) {
    const stmts = MIGRATIONS[current].map((sql) => db.prepare(sql));
    stmts.push(db.prepare('INSERT INTO schema_version (version) VALUES (?)').bind(current + 1));
    await db.batch(stmts);
    current++;
  }
  migrated = true;
}
