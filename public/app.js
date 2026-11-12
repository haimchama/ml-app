// ML office system – client. Plain ES modules, no build step.
// All user data is inserted with textContent (via h()), never innerHTML.

const app = document.getElementById('app');
let me = null;
let meta = null;

// ---------- utilities ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(paths, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) { const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}
const ICONS = {
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  edit: ['M4 20h4L19 9l-4-4L4 16v4z'],
};

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api/' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && path !== 'login') { me = null; go('#/login'); }
    throw new ApiError(res.status, data.error || 'שגיאה');
  }
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3200);
}

const MONTHS = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)}.${Number(m)}.${y}`;
}
function fmtDateTime(sqlUtc) {
  if (!sqlUtc) return '';
  const d = new Date(sqlUtc.replace(' ', 'T') + 'Z');
  return d.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function dateBox(iso) {
  const [, m, d] = iso.split('-');
  return h('div', { class: 'datebox' }, h('span', { class: 'd' }, Number(d)), h('span', { class: 'm' }, MONTHS[Number(m) - 1]));
}
function daysFrom(today, iso) {
  return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
}
function whenLabel(today, iso) {
  const n = daysFrom(today, iso);
  if (n === 0) return 'היום';
  if (n === 1) return 'מחר';
  if (n < 0) return `לפני ${-n} ימים`;
  return `בעוד ${n} ימים`;
}
function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter((w) => /^[\u0590-\u05FFa-zA-Z]/.test(w));
  return words.slice(0, 2).map((w) => w[0]).join('');
}
function stageLabel(key) { return (meta.leadStages.find((s) => s.key === key) || {}).label || key; }
function processInfo(key) { return meta.processes[key] || meta.processes.general; }
function stepLabel(proc, step) { return processInfo(proc).steps[step] || ''; }
function userOptions(empty = 'ללא') {
  return [{ value: '', label: empty }, ...meta.users.map((u) => ({ value: String(u.id), label: u.name }))];
}

function can(perm) { return Boolean(me && me.perms && me.perms.includes(perm)); }
function lawyers() { return meta.users.filter((u) => u.role === 'lawyer'); }
function lawyerOptions() {
  const list = lawyers().length ? lawyers() : meta.users;
  return list.map((u) => ({ value: String(u.id), label: u.name }));
}
function approvalPill(c) {
  if (c.approval === 'pending') return h('span', { class: 'pill gold' }, meta.approval.pending);
  if (c.approval === 'rejected') return h('span', { class: 'pill danger' }, meta.approval.rejected);
  return null;
}

function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }

// ---------- dialogs ----------

function openForm({ title, fields, submit = 'שמירה', onSubmit }) {
  const errorBox = h('div', { class: 'form-error', hidden: true });
  const inputs = {};
  const fieldEls = fields.map((f) => {
    const fid = 'f_' + f.name;
    let input;
    if (f.type === 'select') {
      input = h('select', { id: fid, name: f.name, required: f.required },
        f.options.map((o) => h('option', { value: o.value, selected: String(f.value ?? '') === String(o.value) }, o.label)));
    } else if (f.type === 'textarea') {
      input = h('textarea', { id: fid, name: f.name, required: f.required, maxlength: f.max || 4000 });
      input.value = f.value ?? '';
    } else {
      input = h('input', { id: fid, name: f.name, type: f.type || 'text', required: f.required, value: f.value ?? '',
        maxlength: f.max || 200, autocomplete: f.autocomplete || 'off', dir: f.dir, minlength: f.minlength });
    }
    inputs[f.name] = input;
    return h('div', { class: 'field' + (f.full ? ' full' : '') }, h('label', { for: fid }, f.label + (f.required ? ' *' : '')), input);
  });
  const dlg = h('dialog', {});
  const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, submit);
  const form = h('form', { class: 'dialog-body', method: 'dialog' },
    h('h2', {}, title), errorBox, h('div', { class: 'fields' }, fieldEls),
    h('div', { class: 'form-actions' }, submitBtn, h('button', { class: 'btn ghost', type: 'button', onClick: () => dlg.close() }, 'ביטול')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    for (const [k, el] of Object.entries(inputs)) values[k] = el.value;
    submitBtn.disabled = true;
    errorBox.hidden = true;
    try {
      await onSubmit(values);
      dlg.close();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
  dlg.append(form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  const first = form.querySelector('input, select, textarea');
  if (first) first.focus();
}

function nullIfEmpty(v) { return v === '' ? null : v; }

// ---------- forms used in several places ----------

function clientForm(existing, after) {
  const c = existing || {};
  openForm({
    title: existing ? 'עריכת פרטי לקוח' : 'לקוח / ליד חדש',
    fields: [
      { name: 'name', label: 'שם מלא / שם חברה', required: true, value: c.name, full: true, max: 120 },
      { name: 'kind', label: 'סוג', type: 'select', value: c.kind || 'lead',
        options: (can('clients.approve') || c.approval === 'approved')
          ? [{ value: 'lead', label: 'ליד (פנייה)' }, { value: 'client', label: 'לקוח' }]
          : [{ value: 'lead', label: 'ליד (פנייה) – יועבר לאישור עו"ד' }] },
      { name: 'stage', label: 'שלב', type: 'select', value: c.stage || 'new',
        options: meta.leadStages.filter((s) => s.key !== 'signed' || can('clients.approve') || c.approval === 'approved').map((s) => ({ value: s.key, label: s.label })) },
      { name: 'phone', label: 'טלפון', type: 'tel', value: c.phone, dir: 'ltr', max: 30 },
      { name: 'email', label: 'אימייל', type: 'email', value: c.email, dir: 'ltr' },
      { name: 'id_number', label: 'ת"ז / ח"פ', value: c.id_number, dir: 'ltr', max: 20 },
      { name: 'source', label: 'מקור הפנייה', value: c.source, max: 100 },
      { name: 'address', label: 'כתובת', value: c.address, full: true },
      { name: 'owner_id', label: 'אחראי', type: 'select', value: c.owner_id ?? me.id, options: userOptions() },
      { name: 'notes', label: 'הערות', type: 'textarea', value: c.notes, full: true },
    ],
    onSubmit: async (v) => {
      v.owner_id = nullIfEmpty(v.owner_id);
      if (existing) { await api('clients/' + existing.id, { method: 'PATCH', body: v }); toast('הפרטים נשמרו'); after && after(existing.id); }
      else {
        const r = await api('clients', { method: 'POST', body: v });
        toast(r.approval === 'pending' ? 'נשמר והועבר לאישור עורך דין' : 'נשמר');
        after && after(r.id);
      }
    },
  });
}

function caseForm(existing, { clientId, clients } = {}, after) {
  const c = existing || {};
  const fields = [];
  if (!existing && !clientId) {
    fields.push({ name: 'client_id', label: 'לקוח', type: 'select', required: true, full: true,
      options: [{ value: '', label: 'בחירת לקוח' }, ...clients.map((x) => ({ value: String(x.id), label: x.name }))] });
  }
  fields.push({ name: 'title', label: 'כותרת התיק', required: true, value: c.title, full: true, max: 160 });
  if (!existing) {
    fields.push({ name: 'process', label: 'סוג תיק ותהליך', type: 'select', value: 'general',
      options: Object.entries(meta.processes).map(([k, p]) => ({ value: k, label: p.label })) });
    fields.push({ name: 'opened_at', label: 'תאריך פתיחה', type: 'date', value: meta.today });
  }
  fields.push(
    { name: 'case_number', label: 'מספר תיק בבית משפט', value: c.case_number, dir: 'ltr', max: 60 },
    { name: 'court', label: 'ערכאה', value: c.court, max: 120 },
    { name: 'opposing_party', label: 'צד שכנגד', value: c.opposing_party, max: 160 },
    { name: 'owner_id', label: 'עו"ד אחראי', type: 'select', value: c.owner_id ?? me.id, options: userOptions() },
    { name: 'fee_type', label: 'סוג שכר טרחה', type: 'select', value: c.fee_type || '',
      options: [{ value: '', label: 'לא נקבע' }, { value: 'גלובלי', label: 'גלובלי' }, { value: 'שעתי', label: 'שעתי' }, { value: 'אחוזים', label: 'אחוזים מהזכייה' }] },
    { name: 'fee_amount', label: 'סכום / תעריף', value: c.fee_amount, max: 40 },
    { name: 'notes', label: 'הערות', type: 'textarea', value: c.notes, full: true },
  );
  openForm({
    title: existing ? 'עריכת תיק' : 'תיק חדש',
    fields,
    onSubmit: async (v) => {
      v.owner_id = nullIfEmpty(v.owner_id);
      if (existing) { await api('cases/' + existing.id, { method: 'PATCH', body: v }); toast('התיק עודכן'); after && after(existing.id); }
      else {
        if (clientId) v.client_id = clientId;
        const r = await api('cases', { method: 'POST', body: v });
        toast('התיק נפתח');
        after && after(r.id);
      }
    },
  });
}

function taskForm({ caseId, existing } = {}, after) {
  const t = existing || {};
  openForm({
    title: existing ? 'עריכת משימה' : 'משימה חדשה',
    fields: [
      { name: 'title', label: 'משימה', required: true, value: t.title, full: true },
      { name: 'due_date', label: 'תאריך יעד', type: 'date', value: t.due_date },
      { name: 'assignee_id', label: 'אחראי', type: 'select', value: t.assignee_id ?? me.id, options: meta.users.map((u) => ({ value: String(u.id), label: u.name })) },
    ],
    onSubmit: async (v) => {
      v.due_date = nullIfEmpty(v.due_date);
      if (existing) await api('tasks/' + existing.id, { method: 'PATCH', body: v });
      else await api('tasks', { method: 'POST', body: { ...v, case_id: caseId || null } });
      toast('המשימה נשמרה');
      after && after();
    },
  });
}

function eventForm({ caseId, existing, cases, lawyerId } = {}, after) {
  const e = existing || {};
  const fields = [
    { name: 'title', label: 'כותרת', required: true, value: e.title, full: true, max: 160 },
    { name: 'kind', label: 'סוג', type: 'select', value: e.kind || 'hearing', options: Object.entries(meta.eventKinds).map(([k, l]) => ({ value: k, label: l })) },
    { name: 'date', label: 'תאריך', type: 'date', required: true, value: e.date || meta.today },
    { name: 'time', label: 'שעה', type: 'time', value: e.time },
    { name: 'location', label: 'מיקום', value: e.location, max: 160 },
  ];
  if (can('events.all')) {
    fields.splice(1, 0, { name: 'lawyer_id', label: 'ביומן של', type: 'select', required: true,
      value: e.lawyer_id ?? lawyerId ?? (me.role === 'lawyer' ? me.id : lawyerOptions()[0]?.value), options: lawyerOptions() });
  }
  if (!caseId && !existing && cases) {
    fields.push({ name: 'case_id', label: 'תיק', type: 'select', full: true,
      options: [{ value: '', label: 'ללא תיק' }, ...cases.map((c) => ({ value: String(c.id), label: `${c.client_name} – ${c.title}` }))] });
  }
  fields.push({ name: 'notes', label: 'הערות', type: 'textarea', value: e.notes, full: true, max: 2000 });
  openForm({
    title: existing ? 'עריכת אירוע' : 'מועד / אירוע חדש',
    fields,
    onSubmit: async (v) => {
      v.time = nullIfEmpty(v.time);
      if (existing) await api('events/' + existing.id, { method: 'PATCH', body: v });
      else await api('events', { method: 'POST', body: { ...v, case_id: caseId || nullIfEmpty(v.case_id) } });
      toast('נשמר ביומן');
      after && after();
    },
  });
}

// ---------- layout ----------

const NAV_ICONS = {
  home: ['M3 11l9-7 9 7', 'M5 10v10h5v-6h4v6h5V10'],
  clients: ['M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M22 19v-1a4 4 0 0 0-3-3.9', 'M16 3.1a4 4 0 0 1 0 7.8'],
  cases: ['M3 7h18v13H3z', 'M8 7V4h8v3', 'M3 12h18'],
  calendar: ['M4 5h16v16H4z', 'M4 10h16', 'M9 3v4', 'M15 3v4'],
  tasks: ['M9 11l3 3 8-8', 'M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9'],
  docs: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  mail: ['M3 6h18v12H3z', 'M3 7l9 6 9-6'],
  billing: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  audit: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  system: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  password: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  chevron: ['M15 6l-6 6 6 6'],
};

function navGroups() {
  const groups = [
    [
      { href: '#/', label: 'לוח בקרה', icon: 'home', tone: 'navy', match: /^#\/?$/ },
      { href: '#/clients', label: 'לקוחות ולידים', icon: 'clients', tone: 'blue', match: /^#\/clients/ },
      { href: '#/cases', label: 'תיקים', icon: 'cases', tone: 'gold', match: /^#\/cases/ },
      { href: '#/calendar', label: 'יומן ומועדים', icon: 'calendar', tone: 'red', match: /^#\/calendar/ },
      { href: '#/tasks', label: 'משימות', icon: 'tasks', tone: 'green', match: /^#\/tasks/ },
    ],
    [
      { label: 'מסמכים', icon: 'docs', tone: 'gray', soon: true },
      { label: 'מיילים', icon: 'mail', tone: 'gray', soon: true },
      { label: 'שעות וחיוב', icon: 'billing', tone: 'gray', soon: true },
    ],
  ];
  const admin = [];
  if (can('audit.view')) admin.push({ href: '#/audit', label: 'יומן פעולות', icon: 'audit', tone: 'slate', match: /^#\/audit/ });
  if (can('users.manage')) admin.push({ href: '#/users', label: 'ניהול מערכת (IT)', icon: 'system', tone: 'slate', match: /^#\/users/ });
  if (admin.length) groups.push(admin);
  return groups;
}

function navItem(n, hash) {
  const inner = [h('span', { class: 'nav-icon tone-' + n.tone, 'aria-hidden': 'true' }, icon(NAV_ICONS[n.icon], 17)), h('span', { class: 'nav-label' }, n.label)];
  if (n.soon) return h('span', { class: 'nav-item disabled' }, inner, h('span', { class: 'soon' }, 'בקרוב'));
  const active = n.match.test(hash);
  return h('a', { href: n.href, class: 'nav-item' + (active ? ' active' : ''), 'aria-current': active ? 'page' : null, onClick: closeDrawer },
    inner, h('span', { class: 'nav-chevron', 'aria-hidden': 'true' }, icon(NAV_ICONS.chevron, 16)));
}

function openDrawer() {
  document.body.classList.add('drawer-open');
  const first = document.querySelector('.side .nav-item');
  if (first) setTimeout(() => first.focus(), 250);
}
function closeDrawer() { document.body.classList.remove('drawer-open'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

const PAGE_TITLES = [[/^#\/?$/, 'לוח בקרה'], [/^#\/clients/, 'לקוחות ולידים'], [/^#\/cases/, 'תיקים'], [/^#\/calendar/, 'יומן ומועדים'],
  [/^#\/tasks/, 'משימות'], [/^#\/audit/, 'יומן פעולות'], [/^#\/users/, 'ניהול מערכת'], [/^#\/account/, 'החשבון שלי']];

function layout(...content) {
  const hash = location.hash || '#/';
  const title = (PAGE_TITLES.find(([re]) => re.test(hash)) || [null, ''])[1];
  const nav = h('nav', { class: 'nav', 'aria-label': 'תפריט ראשי' },
    navGroups().map((g) => h('div', { class: 'nav-group' }, g.map((n) => navItem(n, hash)))));
  return h('div', { class: 'shell' },
    h('header', { class: 'topbar' },
      h('button', { class: 'topbar-btn', type: 'button', 'aria-label': 'פתיחת התפריט', onClick: openDrawer }, icon(NAV_ICONS.menu, 22)),
      h('div', { class: 'topbar-title' }, title),
      h('a', { class: 'topbar-logo', href: '#/', 'aria-label': 'לוח בקרה' }, h('img', { src: '/logo.png', alt: '' }))),
    h('div', { class: 'scrim', 'aria-hidden': 'true', onClick: closeDrawer }),
    h('aside', { class: 'side', id: 'drawer', 'aria-label': 'תפריט' },
      h('div', { class: 'drawer-head' },
        h('button', { class: 'topbar-btn drawer-close', type: 'button', 'aria-label': 'סגירת התפריט', onClick: closeDrawer }, icon(NAV_ICONS.close, 20))),
      h('div', { class: 'brand' }, h('img', { src: '/logo.png', alt: 'ML' }), h('div', { class: 'name' }, 'משרד עו"ד מיכאל ליטווק'), h('div', { class: 'rule' })),
      nav,
      h('div', { class: 'me' },
        h('div', { class: 'me-row' },
          h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(me.name)),
          h('div', { class: 'who' }, h('span', { class: 'who-name' }, me.name), h('small', {}, meta.roles[me.role] || ''))),
        h('div', { class: 'nav-group me-actions' },
          h('a', { class: 'nav-item', href: '#/account', onClick: closeDrawer },
            h('span', { class: 'nav-icon tone-gray', 'aria-hidden': 'true' }, icon(NAV_ICONS.password, 17)), h('span', { class: 'nav-label' }, 'החלפת סיסמה'),
            h('span', { class: 'nav-chevron', 'aria-hidden': 'true' }, icon(NAV_ICONS.chevron, 16))),
          h('button', { class: 'nav-item danger', type: 'button', onClick: () => { closeDrawer(); logout(); } },
            h('span', { class: 'nav-icon tone-red', 'aria-hidden': 'true' }, icon(NAV_ICONS.logout, 17)), h('span', { class: 'nav-label' }, 'יציאה'))))),
    h('main', { class: 'main', id: 'main' }, content));
}

async function logout() {
  try { await api('logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
  me = null; meta = null;
  go('#/login');
}

function header({ eyebrow, title, sub, actions }) {
  return h('header', { class: 'head' },
    h('div', { style: null }, eyebrow ? h('div', { class: 'eyebrow' }, eyebrow) : null, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null),
    actions ? h('div', { class: 'actions' }, actions) : null);
}

function searchBox(value, onSearch, placeholder) {
  const input = h('input', { type: 'search', value: value || '', placeholder, 'aria-label': placeholder });
  let timer;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => onSearch(input.value.trim()), 300); });
  return h('label', { class: 'search' }, icon(ICONS.search), input);
}

// ---------- views ----------

async function viewDashboard() {
  const d = await api('dashboard');
  const today = d.today;
  const dt = new Date(today + 'T12:00:00Z');
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }).format(new Date()));
  const greet = hour < 12 ? 'בוקר טוב' : hour < 17 ? 'צהריים טובים' : 'ערב טוב';
  const c = d.counts;
  const refresh = () => render();
  const isLawyer = me.role === 'lawyer';
  const isSecretary = me.role === 'secretary';

  const stats = isSecretary
    ? [stat('לידים חדשים', c.new_leads, 'ממתינים לטיפול'),
       stat('מועדים השבוע', c.week_events, 'ביומן כל עורכי הדין'),
       stat('משימות פתוחות שלי', c.my_open_tasks, c.overdue_tasks ? `${c.overdue_tasks} באיחור במשרד` : 'אין משימות באיחור', c.overdue_tasks > 0),
       stat('ממתינים לאישור עו"ד', c.pending_approvals, 'לקוחות שהוזנו')]
    : [stat('ממתינים לאישורך', c.pending_approvals, 'לקוחות חדשים', c.pending_approvals > 0),
       stat(isLawyer ? 'מועדים היום ביומן שלי' : 'מועדים היום', c.today_events, `${c.week_events} השבוע`),
       stat('משימות פתוחות שלי', c.my_open_tasks, 'הועברו לטיפולך'),
       stat('באיחור במשרד', c.overdue_tasks, 'משימות שעבר מועדן', c.overdue_tasks > 0)];

  const pendingCard = d.pending.length || can('clients.approve') ? h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, can('clients.approve') ? 'לקוחות לאישורך' : 'ממתינים לאישור עו"ד'),
      h('a', { href: '#/clients?approval=pending' }, 'לכל הממתינים')),
    d.pending.length ? d.pending.map((p) => h('div', { class: 'list-item' },
      h('div', { class: 'grow' }, h('a', { class: 'title', href: '#/clients/' + p.id }, p.name),
        h('span', { class: 'meta' }, [p.kind === 'lead' ? stageLabel(p.stage) : 'לקוח', p.source, p.created_by_name ? 'הוזן ע"י ' + p.created_by_name : null].filter(Boolean).join(' · '))),
      can('clients.approve') ? approveButtons(p.id, refresh) : h('span', { class: 'pill gold' }, 'ממתין'))) : h('div', { class: 'empty' }, 'אין לקוחות שממתינים לאישור.')) : null;

  const eventsCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, isLawyer ? 'היומן שלי' : 'יומן עורכי הדין'), h('a', { href: '#/calendar' }, 'ליומן המלא')),
    d.events.length ? d.events.map((e) => eventItem(e, today)) : h('div', { class: 'empty' }, 'אין מועדים קרובים ביומן.'));

  const tasksCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, isSecretary ? 'המשימות שלי' : 'הועבר לטיפולך'), h('a', { href: '#/tasks' }, 'לכל המשימות')),
    d.myTasks.length ? d.myTasks.map((t) => taskRow(t, today, refresh, true)) : h('div', { class: 'empty' }, 'אין משימות פתוחות.'));

  const casesCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, isLawyer ? 'התיקים שלי' : 'תיקים פעילים'), h('a', { href: '#/cases' + (isLawyer ? '?mine=1' : '') }, 'לכל התיקים')),
    d.cases.length ? casesTable(d.cases) : h('div', { class: 'empty' }, 'אין תיקים פתוחים.'));

  const overdueCard = d.overdue ? h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'פיקוח: באיחור במשרד'), h('a', { href: '#/tasks?scope=overdue' }, 'לכל המשימות באיחור')),
    d.overdue.length ? d.overdue.map((t) => taskRow(t, today, refresh, true)) : h('div', { class: 'empty' }, 'אין משימות באיחור. יפה.')) : null;

  const pipelineMap = Object.fromEntries(d.pipeline.map((p) => [p.stage, p.n]));
  const maxP = Math.max(1, ...d.pipeline.map((p) => p.n));
  const pipelineCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'לידים בתהליך'), h('a', { href: '#/clients?kind=lead' }, 'לכל הלידים')),
    meta.leadStages.filter((s) => s.key !== 'lost').map((s) => h('div', {},
      h('div', { class: 'card-head' }, h('span', {}, s.label), h('strong', {}, pipelineMap[s.key] || 0)),
      h('div', { class: 'bar' + (s.key === 'signed' ? ' gold' : '') }, barFill((pipelineMap[s.key] || 0) / maxP)))));

  const wide = isSecretary ? [eventsCard, casesCard] : [pendingCard, eventsCard, casesCard];
  const narrow = isSecretary ? [tasksCard, pendingCard, pipelineCard] : [tasksCard, overdueCard, pipelineCard];

  return layout(
    header({
      eyebrow: `יום ${DAYS[dt.getUTCDay()]}, ${fmtDate(today)}`,
      title: `${greet}, ${me.name.split(' ')[0]}`,
      actions: [
        h('button', { class: 'btn', type: 'button', onClick: () => eventForm({}, refresh) }, '+ מועד ביומן'),
        h('button', { class: 'btn primary', type: 'button', onClick: () => clientForm(null, (id) => go('#/clients/' + id)) }, '+ לקוח / ליד חדש'),
      ],
    }),
    h('section', { class: 'stats', 'aria-label': 'תמונת מצב' }, stats),
    h('div', { class: 'row' }, h('div', { class: 'wide' }, wide), h('div', { class: 'narrow' }, narrow)),
  );
}

function approveButtons(clientId, refresh) {
  const decide = async (decision) => {
    try {
      await api(`clients/${clientId}/approval`, { method: 'POST', body: { decision } });
      toast(decision === 'approved' ? 'הלקוח אושר' : 'הלקוח סומן כלא מאושר');
      refresh();
    } catch (e) { toast(e.message, true); }
  };
  return h('span', { class: 'actions-inline' },
    h('button', { class: 'btn small primary', type: 'button', onClick: () => decide('approved') }, 'אישור'),
    h('button', { class: 'btn small ghost', type: 'button', onClick: () => { if (confirm('לסמן את הלקוח כלא מאושר?')) decide('rejected'); } }, 'דחייה'));
}

function barFill(ratio) {
  const el = h('div', {});
  el.style.width = Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
  return el;
}

function stat(label, value, note, alert = false) {
  return h('div', { class: 'stat' + (alert ? ' alert' : '') }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, value ?? 0), h('span', { class: 'note' }, note));
}

function eventItem(e, today, actions, showLawyer = me.role !== 'lawyer') {
  const n = daysFrom(today, e.date);
  return h('div', { class: 'list-item' }, dateBox(e.date),
    h('div', { class: 'grow' },
      h('span', { class: 'title' }, e.title),
      h('span', { class: 'meta' }, [meta.eventKinds[e.kind], e.time, showLawyer && e.lawyer_name ? 'יומן ' + e.lawyer_name : null,
        e.client_name ? `${e.client_name} · ${e.case_title}` : null, e.location].filter(Boolean).join(' · '))),
    h('span', { class: 'pill ' + (n <= 3 ? 'danger' : 'gold') }, whenLabel(today, e.date)),
    actions || null);
}

function casesTable(cases) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['לקוח', 'תיק', 'תחום', 'שלב', 'אחראי'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, cases.map((c) => h('tr', { class: 'click', onClick: () => go('#/cases/' + c.id) },
      h('td', {}, h('a', { href: '#/cases/' + c.id }, c.client_name)),
      h('td', {}, c.title, c.case_number ? h('div', { class: 'meta', style: null }, c.case_number) : null),
      h('td', {}, processInfo(c.process).area),
      h('td', {}, c.status === 'closed' ? h('span', { class: 'pill muted' }, 'סגור') : h('span', { class: 'pill' }, stepLabel(c.process, c.step))),
      h('td', {}, c.owner_name || '—'))))));
}

function taskRow(t, today, refresh, showCase = false) {
  const overdue = !t.done && t.due_date && t.due_date < today;
  const cb = h('input', { type: 'checkbox', checked: t.done, 'aria-label': 'סימון כבוצעה: ' + t.title });
  cb.addEventListener('change', async () => {
    try { await api('tasks/' + t.id, { method: 'PATCH', body: { done: cb.checked } }); refresh(); }
    catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
  });
  const parts = [];
  if (t.due_date) parts.push(h('span', { class: overdue ? 'overdue' : '' }, 'יעד ' + fmtDate(t.due_date) + (overdue ? ' · באיחור' : '')));
  if (t.assignee_name) parts.push(h('span', {}, t.assignee_name));
  if (showCase && t.case_id) parts.push(h('a', { href: '#/cases/' + t.case_id }, t.client_name ? `${t.client_name} – ${t.case_title}` : t.case_title));
  const metaBits = parts.flatMap((p, i) => (i ? [' · ', p] : [p]));
  return h('div', { class: 'task' + (t.done ? ' done' : '') }, cb,
    h('div', { class: 'grow' }, h('span', { class: 't' }, t.title), metaBits.length ? h('span', { class: 'meta' }, metaBits) : null),
    h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'עריכת משימה', onClick: () => taskForm({ existing: t }, refresh) }, icon(ICONS.edit, 16)),
    h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'מחיקת משימה', onClick: async () => {
      if (!confirm('למחוק את המשימה "' + t.title + '"?')) return;
      try { await api('tasks/' + t.id, { method: 'DELETE' }); refresh(); } catch (e) { toast(e.message, true); }
    } }, icon(ICONS.trash, 16)));
}

async function viewClients(params) {
  const kind = params.get('kind') || '';
  const approval = params.get('approval') || '';
  const q = params.get('q') || '';
  const qs = new URLSearchParams();
  if (kind) qs.set('kind', kind);
  if (approval) qs.set('approval', approval);
  if (q) qs.set('q', q);
  const { clients } = await api('clients?' + qs);
  const setParam = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); go('#/clients' + (p.toString() ? '?' + p : '')); };
  return layout(
    header({ title: 'לקוחות ולידים', actions: [
      searchBox(q, (v) => setParam('q', v), 'חיפוש לפי שם, טלפון, אימייל או ת"ז'),
      h('button', { class: 'btn primary', type: 'button', onClick: () => clientForm(null, (id) => go('#/clients/' + id)) }, '+ חדש'),
    ] }),
    h('div', { class: 'tabs' },
      [['', 'הכל'], ['lead', 'לידים'], ['client', 'לקוחות']].map(([k, l]) =>
        h('a', { href: '#/clients' + (k ? '?kind=' + k : ''), class: !approval && kind === k ? 'active' : '' }, l)),
      h('a', { href: '#/clients?approval=pending', class: approval === 'pending' ? 'active' : '' }, 'ממתינים לאישור עו"ד')),
    h('section', { class: 'card' }, clients.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['שם', 'סטטוס', 'טלפון', 'אימייל', 'תיקים פתוחים', 'אחראי'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, clients.map((c) => h('tr', { class: 'click', onClick: () => go('#/clients/' + c.id) },
        h('td', {}, h('a', { href: '#/clients/' + c.id }, c.name)),
        h('td', {}, approvalPill(c) || (c.kind === 'client' ? h('span', { class: 'pill' }, 'לקוח') : h('span', { class: 'pill gold' }, stageLabel(c.stage)))),
        h('td', { dir: 'ltr', style: null }, c.phone || '—'),
        h('td', { dir: 'ltr' }, c.email || '—'),
        h('td', {}, c.open_cases),
        h('td', {}, c.owner_name || '—'))))))
      : h('div', { class: 'empty' }, q ? 'לא נמצאו תוצאות.' : 'עוד אין רשומות. מוסיפים לקוח או ליד בכפתור "+ חדש".')),
  );
}

async function viewClient(clientId) {
  const { client: c, cases } = await api('clients/' + clientId);
  const refresh = () => render();
  const stageSelect = h('select', { 'aria-label': 'שלב הליד', class: 'btn small ghost' },
    meta.leadStages.filter((s) => s.key !== 'signed' || c.approval === 'approved').map((s) => h('option', { value: s.key, selected: s.key === c.stage }, s.label)));
  stageSelect.addEventListener('change', async () => {
    try { await api('clients/' + c.id, { method: 'PATCH', body: { stage: stageSelect.value } }); toast('השלב עודכן'); refresh(); }
    catch (e) { toast(e.message, true); }
  });
  return layout(
    header({
      eyebrow: c.kind === 'client' ? 'לקוח' : 'ליד · ' + stageLabel(c.stage),
      title: c.name,
      sub: c.owner_name ? 'אחראי: ' + c.owner_name : null,
      actions: [
        c.kind === 'lead' ? stageSelect : null,
        h('button', { class: 'btn', type: 'button', onClick: () => clientForm(c, refresh) }, 'עריכת פרטים'),
        c.approval === 'approved'
          ? h('button', { class: 'btn primary', type: 'button', onClick: () => caseForm(null, { clientId: c.id }, (id) => go('#/cases/' + id)) }, '+ פתיחת תיק')
          : null,
      ],
    }),
    c.approval !== 'approved' ? h('section', { class: 'card approval-banner' + (c.approval === 'rejected' ? ' rejected' : '') },
      h('div', { class: 'card-head' },
        h('div', {}, h('h2', {}, c.approval === 'pending' ? 'ממתין לאישור עורך דין' : 'עורך דין לא אישר את הלקוח'),
          h('div', { class: 'sub' }, [c.created_by_name ? 'הוזן ע"י ' + c.created_by_name : null, c.approved_by_name && c.approval === 'rejected' ? 'נבדק ע"י ' + c.approved_by_name : null].filter(Boolean).join(' · ') || 'עד לאישור אי אפשר לפתוח תיק.')),
        can('clients.approve') ? approveButtons(c.id, refresh) : null)) : null,
    h('div', { class: 'row' },
      h('div', { class: 'wide' },
        h('section', { class: 'card' }, h('h2', {}, 'תיקים'),
          cases.length ? casesTable(cases.map((x) => ({ ...x, client_name: c.name }))) : h('div', { class: 'empty' }, c.approval === 'approved' ? 'אין תיקים. פתיחת תיק הופכת ליד ללקוח.' : 'אין תיקים.')),
        c.notes ? h('section', { class: 'card' }, h('h2', {}, 'הערות'), h('div', { class: 'note' }, h('div', { class: 'text' }, c.notes))) : null),
      h('div', { class: 'narrow' },
        h('section', { class: 'card' }, h('h2', {}, 'פרטי קשר'),
          h('div', { class: 'kv' },
            kv('טלפון', c.phone ? h('a', { href: 'tel:' + c.phone, dir: 'ltr' }, c.phone) : '—'),
            kv('אימייל', c.email ? h('a', { href: 'mailto:' + c.email, dir: 'ltr' }, c.email) : '—'),
            kv('ת"ז / ח"פ', c.id_number || '—'),
            kv('כתובת', c.address || '—'),
            kv('מקור הפנייה', c.source || '—'),
            kv('נוצר', fmtDateTime(c.created_at)),
            c.approval === 'approved' && c.approved_by_name ? kv('אושר ע"י', `${c.approved_by_name} · ${fmtDateTime(c.approved_at)}`) : null)),
      )),
  );
}

function kv(k, v) { return h('div', {}, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)); }

async function viewCases(params) {
  const status = params.get('status') || 'open';
  const q = params.get('q') || '';
  const mine = params.get('mine') === '1';
  const { cases } = await api(`cases?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}${mine ? '&mine=1' : ''}`);
  const setParam = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); go('#/cases' + (p.toString() ? '?' + p : '')); };
  const openNew = async () => {
    const { clients } = await api('clients?approval=approved');
    if (!clients.length) { toast('אין לקוחות מאושרים. קודם עורך דין מאשר את הלקוח.', true); return; }
    caseForm(null, { clients }, (id) => go('#/cases/' + id));
  };
  return layout(
    header({ title: 'תיקים', actions: [
      searchBox(q, (v) => setParam('q', v), 'חיפוש לפי לקוח, תיק, מספר או צד שכנגד'),
      h('button', { class: 'btn primary', type: 'button', onClick: openNew }, '+ תיק חדש'),
    ] }),
    h('div', { class: 'tabs' },
      [['open', 'פתוחים'], ['closed', 'סגורים'], ['all', 'הכל']].map(([k, l]) =>
        h('a', { href: '#/cases?status=' + k + (mine ? '&mine=1' : ''), class: status === k ? 'active' : '' }, l)),
      h('a', { href: '#/cases?status=' + status + (mine ? '' : '&mine=1'), class: mine ? 'active' : '' }, 'רק שלי')),
    h('section', { class: 'card' }, cases.length ? casesTable(cases) : h('div', { class: 'empty' }, 'אין תיקים להצגה.')),
  );
}

async function viewCase(caseId) {
  const { case: c, process: p, tasks, events, notes } = await api('cases/' + caseId);
  const refresh = () => render();
  const setStep = async (i) => {
    if (i === c.step) return;
    if (!confirm(`להעביר את התיק לשלב "${p.steps[i]}"?`)) return;
    try { await api(`cases/${c.id}/step`, { method: 'POST', body: { step: i } }); toast('השלב עודכן'); refresh(); }
    catch (e) { toast(e.message, true); }
  };
  const openTasks = tasks.filter((t) => !t.done);
  const doneTasks = tasks.filter((t) => t.done);
  const noteInput = h('textarea', { rows: 2, maxlength: 4000, placeholder: 'הוספת הערה, סיכום שיחה או עדכון…', 'aria-label': 'הערה חדשה' });
  const addNote = async (e) => {
    e.preventDefault();
    const text = noteInput.value.trim();
    if (!text) return;
    try { await api(`cases/${c.id}/notes`, { method: 'POST', body: { text } }); refresh(); } catch (err) { toast(err.message, true); }
  };
  const toggleStatus = async () => {
    const closing = c.status === 'open';
    if (!confirm(closing ? 'לסגור את התיק?' : 'לפתוח מחדש את התיק?')) return;
    try { await api('cases/' + c.id, { method: 'PATCH', body: { status: closing ? 'closed' : 'open' } }); refresh(); } catch (e) { toast(e.message, true); }
  };
  return layout(
    header({
      eyebrow: [p.label, c.case_number ? 'תיק ' + c.case_number : null].filter(Boolean).join(' · '),
      title: `${c.client_name} – ${c.title}`,
      sub: `אחראי: ${c.owner_name || 'לא נקבע'} · נפתח ${fmtDate(c.opened_at)}` + (c.status === 'closed' ? ' · סגור' : ''),
      actions: [
        h('a', { class: 'btn ghost', href: '#/clients/' + c.client_id }, 'כרטיס לקוח'),
        h('button', { class: 'btn', type: 'button', onClick: () => caseForm(c, {}, refresh) }, 'עריכה'),
        can('cases.close') ? h('button', { class: 'btn', type: 'button', onClick: toggleStatus }, c.status === 'open' ? 'סגירת תיק' : 'פתיחה מחדש') : null,
        h('button', { class: 'btn primary', type: 'button', onClick: () => taskForm({ caseId: c.id }, refresh) }, '+ משימה'),
      ],
    }),
    h('section', { class: 'card', 'aria-label': 'שלבי התיק', style: null },
      h('div', { class: 'card-head' }, h('h2', {}, 'תהליך התיק'), h('span', { class: 'meta', style: null }, 'לחיצה על שלב מעבירה אליו')),
      h('ol', { class: 'steps' }, p.steps.map((s, i) => {
        const cls = i < c.step ? 'done' : i === c.step ? 'now' : '';
        return h('li', { class: cls }, h('button', { type: 'button', onClick: () => setStep(i), 'aria-current': i === c.step ? 'step' : null },
          h('span', { class: 'line' }), h('span', { class: 'label' }, s), h('span', { class: 'state' }, i < c.step ? 'הושלם' : i === c.step ? 'בתהליך' : 'ממתין')));
      }))),
    h('div', { class: 'row' },
      h('div', { class: 'wide' },
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', {}, 'משימות'), h('button', { class: 'btn small', type: 'button', onClick: () => taskForm({ caseId: c.id }, refresh) }, '+ משימה')),
          openTasks.length ? openTasks.map((t) => taskRow(t, meta.today, refresh)) : h('div', { class: 'empty' }, 'אין משימות פתוחות.'),
          doneTasks.length ? h('details', {}, h('summary', {}, `בוצעו (${doneTasks.length})`), doneTasks.map((t) => taskRow(t, meta.today, refresh))) : null),
        h('section', { class: 'card' },
          h('h2', {}, 'הערות ופעילות'),
          h('form', { class: 'inline-form', onSubmit: addNote }, noteInput, h('button', { class: 'btn primary', type: 'submit' }, 'הוספה')),
          notes.length ? notes.map((n) => h('div', { class: 'note' }, h('span', { class: 'meta' }, `${n.user_name || ''} · ${fmtDateTime(n.created_at)}`), h('div', { class: 'text' }, n.text)))
            : h('div', { class: 'empty' }, 'עוד אין הערות.'))),
      h('div', { class: 'narrow' },
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', {}, 'מועדים'), h('button', { class: 'btn small', type: 'button', onClick: () => eventForm({ caseId: c.id, lawyerId: c.owner_id }, refresh) }, '+ מועד')),
          events.length ? events.map((e) => eventItem(e, meta.today, eventActions(e, refresh), true)) : h('div', { class: 'empty' }, 'אין מועדים לתיק.')),
        h('section', { class: 'card' }, h('h2', {}, 'פרטי התיק'),
          h('div', { class: 'kv' },
            kv('ערכאה', c.court || '—'),
            kv('צד שכנגד', c.opposing_party || '—'),
            kv('טלפון לקוח', c.client_phone ? h('a', { href: 'tel:' + c.client_phone, dir: 'ltr' }, c.client_phone) : '—'),
            kv('אימייל לקוח', c.client_email ? h('a', { href: 'mailto:' + c.client_email, dir: 'ltr' }, c.client_email) : '—'))),
        h('section', { class: 'card dark' }, h('h2', {}, 'שכר טרחה'),
          h('div', { class: 'kv' }, kv('סוג', c.fee_type || 'לא נקבע'), kv('סכום / תעריף', c.fee_amount || '—'))),
        c.notes ? h('section', { class: 'card' }, h('h2', {}, 'הערות לתיק'), h('div', { class: 'note' }, h('div', { class: 'text' }, c.notes))) : null)),
  );
}

function eventActions(e, refresh) {
  if (!can('events.all') && e.lawyer_id !== me.id) return null;
  return h('span', { style: null },
    h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'עריכת אירוע', onClick: () => eventForm({ existing: e }, refresh) }, icon(ICONS.edit, 16)),
    h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'מחיקת אירוע', onClick: async () => {
      if (!confirm('למחוק את "' + e.title + '" מהיומן?')) return;
      try { await api('events/' + e.id, { method: 'DELETE' }); refresh(); } catch (err) { toast(err.message, true); }
    } }, icon(ICONS.trash, 16)));
}

async function viewCalendar(params) {
  const from = params.get('from') || meta.today;
  const lawyer = params.get('lawyer') || (me.role === 'lawyer' ? 'mine' : 'all');
  const [{ events, to }, { cases }] = await Promise.all([
    api(`events?from=${encodeURIComponent(from)}&lawyer=${encodeURIComponent(lawyer)}`),
    api('cases?status=open'),
  ]);
  const refresh = () => render();
  const setParam = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); go('#/calendar' + (p.toString() ? '?' + p : '')); };
  const filter = h('select', { class: 'lawyer-filter', 'aria-label': 'איזה יומן להציג' },
    h('option', { value: 'mine', selected: lawyer === 'mine' }, 'היומן שלי'),
    h('option', { value: 'all', selected: lawyer === 'all' }, 'כל עורכי הדין'),
    lawyers().filter((u) => u.id !== me.id).map((u) => h('option', { value: String(u.id), selected: lawyer === String(u.id) }, 'היומן של ' + u.name)));
  filter.addEventListener('change', () => setParam('lawyer', filter.value));
  const byDate = new Map();
  for (const e of events) { if (!byDate.has(e.date)) byDate.set(e.date, []); byDate.get(e.date).push(e); }
  const selectedLawyer = /^\d+$/.test(lawyer) ? Number(lawyer) : lawyer === 'mine' ? me.id : undefined;
  return layout(
    header({ title: 'יומן ומועדים', sub: `${fmtDate(from)} – ${fmtDate(to)}`, actions: [
      filter,
      from !== meta.today ? h('a', { class: 'btn ghost', href: '#/calendar' }, 'להיום') : h('button', { class: 'btn ghost', type: 'button', onClick: () => setParam('from', shiftDate(meta.today, -60)) }, 'מועדים קודמים'),
      h('button', { class: 'btn primary', type: 'button', onClick: () => eventForm({ cases, lawyerId: selectedLawyer }, refresh) }, '+ מועד / אירוע'),
    ] }),
    h('section', { class: 'card' },
      events.length ? [...byDate.entries()].map(([d, list]) => [
        h('h3', {}, `יום ${DAYS[new Date(d + 'T12:00:00Z').getUTCDay()]}, ${fmtDate(d)}`),
        list.map((e) => eventItem(e, meta.today, eventActions(e, refresh), lawyer !== 'mine')),
      ]) : h('div', { class: 'empty' }, 'אין אירועים בטווח הזה.')),
  );
}

function shiftDate(iso, days) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}

async function viewTasks(params) {
  const scope = params.get('scope') || 'mine';
  const done = params.get('done') === '1' && scope !== 'overdue';
  const { tasks, today } = await api(`tasks?scope=${scope}&done=${done ? 1 : 0}`);
  const refresh = () => render();
  const link = (s, d) => `#/tasks?scope=${s}${d ? '&done=1' : ''}`;
  return layout(
    header({ title: 'משימות', actions: [h('button', { class: 'btn primary', type: 'button', onClick: () => taskForm({}, refresh) }, '+ משימה')] }),
    h('div', { class: 'tabs' },
      h('a', { href: link('mine', done), class: scope === 'mine' ? 'active' : '' }, me.role === 'secretary' ? 'שלי' : 'הועבר לטיפולי'),
      h('a', { href: link('all', done), class: scope === 'all' ? 'active' : '' }, 'כל המשרד'),
      can('office.supervise') ? h('a', { href: link('overdue', false), class: scope === 'overdue' ? 'active' : '' }, 'באיחור במשרד') : null,
      scope !== 'overdue' ? h('a', { href: link(scope, !done), class: done ? 'active' : '' }, done ? 'מציג בוצעו' : 'הצגת בוצעו') : null),
    h('section', { class: 'card' }, tasks.length ? tasks.map((t) => taskRow(t, today, refresh, true)) : h('div', { class: 'empty' }, done ? 'אין משימות שבוצעו.' : 'אין משימות פתוחות.')),
  );
}

const AUDIT_ACTIONS = { login: 'כניסה', setup: 'הקמת המערכת', create: 'יצירה', update: 'עדכון', delete: 'מחיקה', step: 'מעבר שלב',
  password: 'החלפת סיסמה', approve: 'אישור לקוח', reject: 'דחיית לקוח', close: 'סגירת תיק', reopen: 'פתיחת תיק מחדש', revoke: 'ניתוק סשנים' };
const AUDIT_ENTITIES = { user: 'משתמש', client: 'לקוח', case: 'תיק', task: 'משימה', event: 'אירוע', session: 'סשן' };
const ENTITY_LINK = { client: '#/clients/', case: '#/cases/' };

async function viewAudit() {
  if (!can('audit.view')) return go('#/');
  const { audit } = await api('audit');
  return layout(
    header({ title: 'יומן פעולות', sub: '300 הפעולות האחרונות במערכת' }),
    h('section', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['מתי', 'מי', 'פעולה', 'על מה'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, audit.map((a) => h('tr', {},
        h('td', {}, fmtDateTime(a.at)), h('td', {}, a.user_name || '—'), h('td', {}, AUDIT_ACTIONS[a.action] || a.action),
        h('td', {}, ENTITY_LINK[a.entity] && a.entity_id
          ? h('a', { href: ENTITY_LINK[a.entity] + a.entity_id }, `${AUDIT_ENTITIES[a.entity]} #${a.entity_id}`)
          : `${AUDIT_ENTITIES[a.entity] || a.entity}${a.entity_id ? ' #' + a.entity_id : ''}`))))))),
  );
}

function twoFactorCard(sys) {
  const on = sys.twoFactor;
  const toggle = async () => {
    if (on) {
      if (!confirm('לכבות את האימות הדו-שלבי? מעכשיו הכניסה תהיה עם סיסמה בלבד.')) return;
      try { await api('system/2fa', { method: 'POST', body: { enable: false } }); toast('האימות הדו-שלבי כובה'); render(); }
      catch (e) { toast(e.message, true); }
      return;
    }
    let ch;
    try { ch = await api('system/2fa', { method: 'POST', body: { enable: true } }); }
    catch (e) { toast(e.message, true); return; }
    openForm({
      title: 'הפעלת אימות דו-שלבי',
      submit: 'אישור והפעלה',
      fields: [{ name: 'code', label: `קוד שנשלח ל-${ch.email} (בתוקף ${ch.minutes} דקות)`, required: true, max: 6, dir: 'ltr', autocomplete: 'one-time-code' }],
      onSubmit: async (v) => {
        await api('system/2fa/confirm', { method: 'POST', body: { challenge: ch.challenge, code: v.code.trim() } });
        toast('האימות הדו-שלבי הופעל לכל המשתמשים');
        render();
      },
    });
  };
  return h('section', { class: 'card' + (on ? '' : ' approval-banner rejected') },
    h('div', { class: 'card-head' },
      h('h2', {}, 'אימות דו-שלבי במייל'),
      h('span', { class: 'pill ' + (on ? 'ok' : 'danger') }, on ? 'פעיל' : 'כבוי')),
    h('p', { class: 'sub' }, on
      ? 'כל כניסה דורשת סיסמה וגם קוד שנשלח לאימייל של המשתמש.'
      : 'כרגע נכנסים עם סיסמה בלבד. להפעלה צריך ששליחת המיילים תעבוד: נשלח אליך קוד בדיקה, והאימות יופעל רק אחרי שתזין אותו. ודא שהאימייל של כל משתמש אמיתי.'),
    h('button', { class: 'btn' + (on ? '' : ' primary'), type: 'button', onClick: toggle }, on ? 'כיבוי' : 'הפעלת אימות דו-שלבי'));
}

function permissionsCard() {
  const roles = Object.keys(meta.roles);
  const mark = (yes) => (yes ? h('span', { class: 'perm-yes', 'aria-label': 'כן' }, '✓') : h('span', { class: 'perm-no', 'aria-label': 'לא' }, '—'));
  const head = h('tr', {}, h('th', { scope: 'col' }, 'הרשאה'), roles.map((r) => h('th', { scope: 'col' }, meta.roles[r])));
  const rows = Object.entries(meta.permissions).map(([p, label]) =>
    h('tr', {}, h('td', {}, label), roles.map((r) => h('td', {}, mark(meta.rolePerms[r].includes(p))))));
  return h('section', { class: 'card' },
    h('h2', {}, 'הרשאות לפי תפקיד'),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, head), h('tbody', {}, rows))),
    h('p', { class: 'sub' }, 'כל התפקידים יכולים לנהל לקוחות, לידים, תיקים, משימות והערות. מזכירות מזינה לקוחות, ועורך דין מאשר אותם לפני פתיחת תיק.'));
}

async function viewUsers() {
  if (!can('users.manage')) return go('#/');
  const [{ users }, sys] = await Promise.all([api('users'), api('system')]);
  const refresh = async () => { meta = await api('meta'); render(); };
  const roleOptions = Object.entries(meta.roles).map(([k, l]) => ({ value: k, label: l }));
  const addUser = () => openForm({
    title: 'משתמש חדש',
    fields: [
      { name: 'name', label: 'שם', required: true, max: 80 },
      { name: 'email', label: 'אימייל (אליו יישלחו קודי הכניסה)', type: 'email', required: true, dir: 'ltr' },
      { name: 'role', label: 'תפקיד', type: 'select', value: 'secretary', options: roleOptions },
      { name: 'password', label: 'סיסמה זמנית (10+ תווים, אותיות וספרות)', type: 'text', required: true, dir: 'ltr', minlength: 10 },
    ],
    onSubmit: async (v) => { await api('users', { method: 'POST', body: v }); toast('המשתמש נוסף. בכניסה הראשונה יתבקש להחליף סיסמה.'); await refresh(); },
  });
  const editUser = (u) => openForm({
    title: 'עריכת משתמש – ' + u.name,
    fields: [
      { name: 'name', label: 'שם', required: true, value: u.name, max: 80 },
      { name: 'email', label: 'אימייל (שם המשתמש, ולשם נשלחים הקודים)', type: 'email', required: true, value: u.email, dir: 'ltr' },
      { name: 'role', label: 'תפקיד', type: 'select', value: u.role, options: roleOptions },
      { name: 'active', label: 'סטטוס', type: 'select', value: u.active ? '1' : '0', options: [{ value: '1', label: 'פעיל' }, { value: '0', label: 'מושבת' }] },
      { name: 'password', label: 'סיסמה זמנית חדשה (ריק = ללא שינוי)', type: 'text', dir: 'ltr' },
    ],
    onSubmit: async (v) => {
      const body = { name: v.name, email: v.email, role: v.role, active: v.active === '1' };
      if (v.password) body.password = v.password;
      await api('users/' + u.id, { method: 'PATCH', body });
      toast('נשמר');
      if (u.id === me.id) me = null;
      await refresh();
    },
  });
  const revoke = async (body, label) => {
    if (!confirm(label)) return;
    try { await api('system/revoke', { method: 'POST', body }); toast('הסשנים נותקו'); render(); } catch (e) { toast(e.message, true); }
  };
  const ok = (b) => h('span', { class: 'pill ' + (b ? 'ok' : 'danger') }, b ? 'תקין' : 'לא מוגדר');
  return layout(
    header({ title: 'ניהול מערכת', sub: 'משתמשים, הרשאות ומצב טכני', actions: [h('button', { class: 'btn primary', type: 'button', onClick: addUser }, '+ משתמש')] }),
    h('section', { class: 'card' }, h('h2', {}, 'משתמשים'), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['שם', 'אימייל', 'תפקיד', 'סטטוס', 'כניסה אחרונה', 'מחוברים', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', {}, u.name), h('td', { dir: 'ltr' }, u.email), h('td', {}, meta.roles[u.role] || u.role),
        h('td', {}, u.active ? (u.must_change ? h('span', { class: 'pill gold' }, 'ממתין להחלפת סיסמה') : h('span', { class: 'pill ok' }, 'פעיל')) : h('span', { class: 'pill muted' }, 'מושבת')),
        h('td', {}, u.last_login ? fmtDateTime(u.last_login) : '—'),
        h('td', {}, u.sessions),
        h('td', {}, h('span', { class: 'actions-inline' },
          h('button', { class: 'btn small ghost', type: 'button', onClick: () => editUser(u) }, 'עריכה'),
          u.sessions && u.id !== me.id ? h('button', { class: 'btn small ghost', type: 'button', onClick: () => revoke({ user_id: u.id }, `לנתק את ${u.name} מכל המכשירים?`) }, 'ניתוק') : null)))))))),
    permissionsCard(),
    h('div', { class: 'row' },
      h('div', { class: 'wide' },
        twoFactorCard(sys),
        h('section', { class: 'card' }, h('h2', {}, 'מצב המערכת'),
          h('div', { class: 'kv' },
            kv('שליחת קודי כניסה במייל', ok(sys.mail.configured)),
            kv('כתובת שולח', h('span', { dir: 'ltr' }, sys.mail.from)),
            kv('גרסת מסד נתונים', `${sys.schema.current} / ${sys.schema.latest}`),
            kv('משתמשים פעילים', sys.counts.users),
            kv('סשנים פעילים', sys.counts.sessions),
            kv('לקוחות / תיקים', `${sys.counts.clients} / ${sys.counts.cases}`),
            kv('משימות / אירועים', `${sys.counts.tasks} / ${sys.counts.events}`)),
          h('button', { class: 'btn', type: 'button', onClick: () => revoke({ all: true }, 'לנתק את כל המשתמשים (חוץ ממך) מכל המכשירים?') }, 'ניתוק כל המשתמשים'))),
      h('div', { class: 'narrow' },
        h('section', { class: 'card' }, h('h2', {}, 'ניסיונות כניסה כושלים (24 שעות)'),
          sys.loginFailures.length ? sys.loginFailures.map((f) => h('div', { class: 'list-item' },
            h('div', { class: 'grow' }, h('span', { class: 'title', dir: 'ltr' }, f.email), h('span', { class: 'meta' }, 'אחרון: ' + fmtDateTime(f.last))),
            h('span', { class: 'pill ' + (f.n >= 5 ? 'danger' : 'gold') }, f.n))) : h('div', { class: 'empty' }, 'אין.')))),
  );
}

function passwordForm(forced) {
  const err = h('div', { class: 'form-error', hidden: true });
  const cur = h('input', { id: 'cur', type: 'password', required: true, autocomplete: 'current-password' });
  const p1 = h('input', { id: 'p1', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
  const p2 = h('input', { id: 'p2', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'החלפת סיסמה');
  const form = h('form', { class: 'card', style: null },
    h('h2', {}, forced ? 'בחירת סיסמה אישית' : 'החלפת סיסמה'),
    forced ? h('p', { class: 'sub', style: null }, 'לפני תחילת העבודה צריך להחליף את הסיסמה הזמנית.') : null,
    err,
    h('div', { class: 'fields' },
      h('div', { class: 'field full' }, h('label', { for: 'cur' }, forced ? 'הסיסמה הזמנית' : 'סיסמה נוכחית'), cur),
      h('div', { class: 'field' }, h('label', { for: 'p1' }, 'סיסמה חדשה (לפחות 10 תווים)'), p1),
      h('div', { class: 'field' }, h('label', { for: 'p2' }, 'שוב, לאימות'), p2)),
    h('div', { class: 'form-actions' }, btn));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (p1.value !== p2.value) { err.textContent = 'הסיסמאות לא זהות'; err.hidden = false; return; }
    btn.disabled = true;
    try {
      await api('me/password', { method: 'POST', body: { current: cur.value, password: p1.value } });
      toast('הסיסמה הוחלפה');
      me = null; go('#/');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    finally { btn.disabled = false; }
  });
  return form;
}

function viewAccount() {
  return layout(header({ title: 'החשבון שלי', sub: me.email }), h('div', { style: null }, passwordForm(false)));
}

function authPage(...content) {
  return h('div', { class: 'auth' }, h('div', { class: 'box' },
    h('div', { class: 'brand' }, h('img', { src: '/logo.png', alt: 'ML – משרד עו"ד מיכאל ליטווק' }), h('div', { class: 'name' }, 'משרד עו"ד מיכאל ליטווק'), h('div', { class: 'rule' })),
    content));
}

function authForm({ title, fields, submit, onSubmit, hint }) {
  const err = h('div', { class: 'form-error', hidden: true });
  const inputs = {};
  const btn = h('button', { class: 'btn primary', type: 'submit' }, submit);
  const form = h('form', { class: 'card' }, h('h2', {}, title), err,
    h('div', { class: 'fields' }, fields.map((f) => {
      const el = h('input', { id: 'a_' + f.name, name: f.name, type: f.type || 'text', required: true, autocomplete: f.autocomplete, dir: f.dir, minlength: f.minlength });
      inputs[f.name] = el;
      return h('div', { class: 'field' }, h('label', { for: 'a_' + f.name }, f.label), el);
    })),
    h('div', { class: 'form-actions' }, btn));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    btn.disabled = true;
    const v = {};
    for (const [k, el] of Object.entries(inputs)) v[k] = el.value;
    try { await onSubmit(v); } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { btn.disabled = false; }
  });
  return [form, hint ? h('p', { class: 'hint' }, hint) : null];
}

async function viewLogin() {
  const s = await api('setup');
  if (s.needed) return go('#/setup');
  return authPage(authForm({
    title: 'כניסה למערכת',
    submit: 'המשך',
    fields: [
      { name: 'email', label: 'אימייל', type: 'email', autocomplete: 'username', dir: 'ltr' },
      { name: 'password', label: 'סיסמה', type: 'password', autocomplete: 'current-password' },
    ],
    hint: 'אם האימות הדו-שלבי פעיל, אחרי הסיסמה יישלח קוד לאימייל שלך. שכחת סיסמה? מנהל המערכת (IT) יגדיר לך סיסמה זמנית.',
    onSubmit: async (v) => {
      const r = await api('login', { method: 'POST', body: v });
      if (!r.challenge) { me = null; meta = null; go('#/'); return; }
      app.replaceChildren(codeStep(r));
    },
  }));
}

function codeStep(ch) {
  const err = h('div', { class: 'form-error', hidden: true });
  const input = h('input', { id: 'code', class: 'code-input', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: 6, required: true });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'כניסה');
  const resend = h('button', { class: 'linkbtn', type: 'button' }, 'שליחת קוד חדש');
  const form = h('form', { class: 'card' },
    h('h2', {}, 'אימות דו-שלבי'),
    h('p', { class: 'sub' }, `שלחנו קוד בן 6 ספרות לכתובת `, h('span', { dir: 'ltr' }, ch.email), `. הקוד בתוקף ${ch.minutes} דקות.`),
    err,
    h('div', { class: 'field' }, h('label', { for: 'code' }, 'קוד אימות'), input),
    h('div', { class: 'form-actions' }, btn, h('a', { class: 'btn ghost', href: '#/login', onClick: (e) => { e.preventDefault(); render(); } }, 'חזרה')),
    resend);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    btn.disabled = true;
    try {
      await api('login/verify', { method: 'POST', body: { challenge: ch.challenge, code: input.value.trim() } });
      me = null; meta = null;
      go('#/');
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      input.value = ''; input.focus();
    } finally { btn.disabled = false; }
  });
  resend.addEventListener('click', async () => {
    resend.disabled = true;
    try { await api('login/resend', { method: 'POST', body: { challenge: ch.challenge } }); toast('נשלח קוד חדש'); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
    finally { setTimeout(() => { resend.disabled = false; }, 30000); }
  });
  setTimeout(() => input.focus(), 0);
  return authPage(form);
}

async function viewSetup() {
  const s = await api('setup');
  if (!s.needed) return go('#/login');
  return authPage(authForm({
    title: 'הקמת המערכת',
    submit: 'יצירת משתמש IT',
    fields: [
      { name: 'token', label: 'קוד הקמה (מ-TKB)', type: 'password', autocomplete: 'off', dir: 'ltr' },
      { name: 'name', label: 'שם מלא', autocomplete: 'name' },
      { name: 'email', label: 'אימייל (לקודי הכניסה)', type: 'email', autocomplete: 'username', dir: 'ltr' },
      { name: 'password', label: 'סיסמה (10+ תווים, אותיות וספרות)', type: 'password', autocomplete: 'new-password', minlength: 10 },
    ],
    hint: s.configured ? 'המשתמש הראשון הוא משתמש IT עם כל ההרשאות. אחריו מוסיפים את שאר הצוות מתוך "ניהול מערכת".' : 'קוד ההקמה עוד לא הוגדר בשרת.',
    onSubmit: async (v) => { await api('setup', { method: 'POST', body: v }); toast('המשתמש נוצר. עכשיו נכנסים עם קוד במייל.'); go('#/login'); },
  }));
}

// ---------- router ----------

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const raw = location.hash || '#/';
  const [path, query] = raw.slice(1).split('?');
  const params = new URLSearchParams(query || '');
  const parts = path.split('/').filter(Boolean);
  let view;
  try {
    if (parts[0] === 'login') view = await viewLogin();
    else if (parts[0] === 'setup') view = await viewSetup();
    else {
      if (!me) {
        try { me = (await api('me')).user; meta = null; } catch (e) { if (e.status === 401) return go('#/login'); throw e; }
      }
      if (me.must_change) view = authPage(passwordForm(true));
      else {
        if (!meta) meta = await api('meta');
        if (parts.length === 0) view = await viewDashboard();
        else if (parts[0] === 'clients' && parts[1]) view = await viewClient(parts[1]);
        else if (parts[0] === 'clients') view = await viewClients(params);
        else if (parts[0] === 'cases' && parts[1]) view = await viewCase(parts[1]);
        else if (parts[0] === 'cases') view = await viewCases(params);
        else if (parts[0] === 'calendar') view = await viewCalendar(params);
        else if (parts[0] === 'tasks') view = await viewTasks(params);
        else if (parts[0] === 'users') view = await viewUsers();
        else if (parts[0] === 'audit') view = await viewAudit();
        else if (parts[0] === 'account') view = viewAccount();
        else view = layout(header({ title: 'הדף לא נמצא' }), h('a', { href: '#/' }, 'חזרה ללוח הבקרה'));
      }
    }
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e.status === 401) return;
    view = me && meta
      ? layout(header({ title: 'משהו השתבש' }), h('div', { class: 'form-error' }, e.message), h('a', { href: '#/' }, 'חזרה ללוח הבקרה'))
      : authPage(h('div', { class: 'form-error' }, e.message || 'שגיאה בטעינה'));
  }
  if (seq !== renderSeq || !view) return;
  closeDrawer();
  const keepScroll = window.scrollY;
  app.replaceChildren(view);
  if (renderSeq === seq && sameRoute(raw)) window.scrollTo(0, keepScroll); else window.scrollTo(0, 0);
  lastRoute = raw;
}
let lastRoute = null;
function sameRoute(raw) { return raw === lastRoute; }

window.addEventListener('hashchange', render);
render();
