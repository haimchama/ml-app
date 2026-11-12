// Pure helpers shared by the Worker and the tests. No Cloudflare APIs here.

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export const ROLES = {
  it: 'IT – מנהל מערכת',
  lawyer: 'עורך/ת דין',
  secretary: 'מזכירות',
};

// What each role may do. "it" has everything.
export const PERMISSIONS = {
  'users.manage': 'ניהול משתמשים',
  'system.view': 'מצב המערכת וניתוק משתמשים',
  'audit.view': 'צפייה ביומן הפעולות',
  'clients.approve': 'אישור לקוחות',
  'cases.close': 'סגירה ופתיחה מחדש של תיקים',
  'events.all': 'ניהול היומן של כל עורכי הדין',
  'office.supervise': 'פיקוח על משימות המשרד',
};

const ROLE_PERMS = {
  it: Object.keys(PERMISSIONS),
  lawyer: ['audit.view', 'clients.approve', 'cases.close', 'office.supervise'],
  secretary: ['events.all'],
};

export function can(role, perm) {
  return (ROLE_PERMS[role] || []).includes(perm);
}

export function permsOf(role) {
  return [...(ROLE_PERMS[role] || [])];
}

// A client created by someone who may approve is approved at once.
export function initialApproval(role) {
  return can(role, 'clients.approve') ? 'approved' : 'pending';
}

export const APPROVAL = {
  pending: 'ממתין לאישור עו"ד',
  approved: 'מאושר',
  rejected: 'לא אושר',
};

export const LEAD_STAGES = [
  { key: 'new', label: 'פנייה חדשה' },
  { key: 'consult', label: 'פגישת ייעוץ' },
  { key: 'offer', label: 'הצעת שכר טרחה' },
  { key: 'signed', label: 'נחתם – לקוח פעיל' },
  { key: 'lost', label: 'לא התקדם' },
];

export const EVENT_KINDS = {
  hearing: 'דיון',
  filing: 'מועד הגשה',
  meeting: 'פגישה',
  deadline: 'מועד סטטוטורי',
  other: 'אחר',
};

// First process templates. Steps and their default tasks are meant to be
// refined with the office; changing them only affects new step entries.
export const PROCESSES = {
  real_estate_sale: {
    label: 'נדל"ן – עסקת מכר',
    area: 'נדל"ן',
    steps: [
      { label: 'חתימה על הסכם מכר', tasks: ['הפקת נסח טאבו עדכני', 'טיוטת הסכם מכר', 'פגישת חתימה'] },
      { label: 'דיווח למיסוי מקרקעין', tasks: ['הכנת שומה עצמית', 'הגשת הדיווח למיסוי מקרקעין'] },
      { label: 'רישום הערת אזהרה', tasks: ['החתמה על בקשה לרישום הערת אזהרה', 'הגשה ללשכת רישום המקרקעין'] },
      { label: 'קבלת תשלומים', tasks: ['מעקב תשלומים לפי ההסכם'] },
      { label: 'אישורי מסים ועירייה', tasks: ['אישור מיסוי מקרקעין', 'אישור עירייה', 'אישור היטל השבחה'] },
      { label: 'העברת בעלות', tasks: ['הגשת שטרי מכר', 'מחיקת הערת אזהרה', 'עדכון הלקוח וסגירת התיק'] },
    ],
  },
  real_estate_buy: {
    label: 'נדל"ן – עסקת רכישה',
    area: 'נדל"ן',
    steps: [
      { label: 'בדיקות מקדימות', tasks: ['הפקת נסח טאבו', 'בדיקת תיק בניין בעירייה'] },
      { label: 'משא ומתן וחתימה', tasks: ['בדיקת טיוטת ההסכם', 'פגישת חתימה'] },
      { label: 'דיווח ורישום הערת אזהרה', tasks: ['דיווח למיסוי מקרקעין', 'רישום הערת אזהרה לטובת הקונה'] },
      { label: 'משכנתא ותשלומים', tasks: ['תיאום מול הבנק המלווה'] },
      { label: 'העברת בעלות', tasks: ['רישום הבעלות', 'עדכון הלקוח וסגירת התיק'] },
    ],
  },
  litigation: {
    label: 'ליטיגציה אזרחית',
    area: 'ליטיגציה',
    steps: [
      { label: 'פתיחת תיק ולימוד', tasks: ['איסוף מסמכים מהלקוח', 'בדיקת מועדים והתיישנות'] },
      { label: 'כתבי טענות', tasks: ['הכנת כתב תביעה / הגנה'] },
      { label: 'קדם משפט', tasks: ['הכנה לדיון קדם משפט'] },
      { label: 'ראיות והוכחות', tasks: ['תצהירי עדות ראשית', 'הכנת עדים'] },
      { label: 'סיכומים', tasks: ['כתיבת סיכומים'] },
      { label: 'פסק דין', tasks: ['עדכון הלקוח בפסק הדין', 'בדיקת מועד ערעור'] },
    ],
  },
  family: {
    label: 'דיני משפחה',
    area: 'משפחה',
    steps: [
      { label: 'פגישת ייעוץ', tasks: ['איסוף פרטים ומסמכים'] },
      { label: 'משא ומתן', tasks: ['פנייה לצד השני'] },
      { label: 'טיוטת הסכם', tasks: ['ניסוח טיוטה'] },
      { label: 'חתימה', tasks: ['פגישת חתימה'] },
      { label: 'אישור בית משפט', tasks: ['הגשה לאישור', 'עדכון הלקוח וסגירת התיק'] },
    ],
  },
  wills: {
    label: 'צוואות וירושות',
    area: 'ירושות וצוואות',
    steps: [
      { label: 'פגישת ייעוץ', tasks: ['איסוף פרטי היורשים והנכסים'] },
      { label: 'טיוטה', tasks: ['ניסוח טיוטה'] },
      { label: 'חתימה', tasks: ['פגישת חתימה בפני עדים'] },
      { label: 'הפקדה וסיום', tasks: ['הפקדה / מסירת העותק ללקוח'] },
    ],
  },
  general: {
    label: 'כללי',
    area: 'כללי',
    steps: [
      { label: 'פתיחה', tasks: [] },
      { label: 'בטיפול', tasks: [] },
      { label: 'סיום', tasks: [] },
    ],
  },
};

export function str(value, name, { max = 200, required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new ValidationError(`${name}: ערך לא תקין`);
  const v = String(value).trim();
  if (required && !v) throw new ValidationError(`${name}: שדה חובה`);
  if (v.length > max) throw new ValidationError(`${name}: ארוך מדי (עד ${max} תווים)`);
  return v;
}

export function email(value, name = 'אימייל', { required = false } = {}) {
  const v = str(value, name, { max: 200, required }).toLowerCase();
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new ValidationError(`${name}: כתובת לא תקינה`);
  return v;
}

// Login name: English letters, digits and . _ - ; starts with a letter; stored lower-case.
export function username(value, name = 'שם משתמש', { required = true } = {}) {
  const v = str(value, name, { max: 30, required }).toLowerCase();
  if (!v && !required) return '';
  if (!/^[a-z][a-z0-9._-]{2,29}$/.test(v)) {
    throw new ValidationError(`${name}: 3–30 תווים באנגלית (אותיות, ספרות, נקודה, מקף או קו תחתון), שמתחיל באות`);
  }
  return v;
}

export function date(value, name, { required = false } = {}) {
  const v = str(value, name, { max: 10, required });
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) {
    throw new ValidationError(`${name}: תאריך לא תקין`);
  }
  return v;
}

export function time(value, name) {
  const v = str(value, name, { max: 5 });
  if (!v) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new ValidationError(`${name}: שעה לא תקינה`);
  return v;
}

export function oneOf(value, name, allowed, { required = true } = {}) {
  const v = str(value, name, { max: 40, required });
  if (!v && !required) return null;
  if (!allowed.includes(v)) throw new ValidationError(`${name}: ערך לא מוכר`);
  return v;
}

export function id(value, name, { required = true } = {}) {
  if ((value === undefined || value === null || value === '') && !required) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${name}: מזהה לא תקין`);
  return n;
}

export function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new ValidationError('הסיסמה צריכה להיות לפחות 10 תווים');
  if (pw.length > 200) throw new ValidationError('הסיסמה ארוכה מדי');
  if (!/[^0-9]/.test(pw) || !/[0-9]/.test(pw)) throw new ValidationError('הסיסמה צריכה לכלול גם אותיות וגם ספרות');
  if (new Set(pw).size < 5) throw new ValidationError('הסיסמה פשוטה מדי');
  return pw;
}

// 6-digit one-time code, uniform (rejection sampling, no modulo bias).
export function randomCode() {
  const a = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / 1000000) * 1000000;
  do { crypto.getRandomValues(a); } while (a[0] >= limit);
  return String(a[0] % 1000000).padStart(6, '0');
}

export function maskEmail(mail) {
  const [user, domain] = String(mail).split('@');
  if (!domain) return '';
  const shown = user.length <= 2 ? user[0] : user.slice(0, 2);
  return `${shown}${'•'.repeat(Math.max(2, user.length - shown.length))}@${domain}`;
}

export function codeEmail(name, code, minutes) {
  const subject = `קוד הכניסה שלך: ${code}`;
  const text = `שלום ${name},\n\nקוד הכניסה למערכת משרד עו"ד מיכאל ליטווק: ${code}\nהקוד בתוקף ${minutes} דקות.\n\nאם לא ניסית להתחבר, אל תמסור את הקוד לאיש ופנה מיד למנהל המערכת.`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = `<!doctype html><html lang="he" dir="rtl"><body style="margin:0;background:#FAFAF8;font-family:Arial,sans-serif;color:#1A1F2E">
<div style="max-width:480px;margin:32px auto;background:#fff;border:1px solid #EEEDE8;border-radius:18px;padding:32px;text-align:right">
<div style="font-size:18px;font-weight:bold;color:#1E2F5C">משרד עו"ד מיכאל ליטווק</div>
<div style="width:40px;height:1px;background:#B8995F;margin:12px 0 24px"></div>
<p>שלום ${esc(name)},</p><p>קוד הכניסה שלך למערכת:</p>
<div style="font-size:34px;letter-spacing:8px;font-weight:bold;color:#1E2F5C;background:#F6F4EE;border-radius:12px;padding:16px;text-align:center;direction:ltr">${esc(code)}</div>
<p style="color:#5B6275;font-size:14px">הקוד בתוקף ${minutes} דקות.</p>
<p style="color:#8A3A14;font-size:14px">אם לא ניסית להתחבר, אל תמסור את הקוד לאיש ופנה מיד למנהל המערכת.</p>
</div></body></html>`;
  return { subject, text, html };
}

// ---- crypto (Web Crypto: available in Workers and in Node 20+) ----

export const PBKDF2_ITERATIONS = 30000;

export function toB64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toB64(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toB64(d);
}

// Stored form: pbkdf2$<iterations>$<salt b64>$<hash b64>
export async function hashPassword(password, iterations = PBKDF2_ITERATIONS, saltBytes) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2$${iterations}$${toB64(salt)}$${toB64(bits)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const again = await hashPassword(password, Number(parts[1]), fromB64(parts[2]));
  return timingSafeEqual(again, stored);
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Israel local date (the office's day), independent of the server's zone.
export function todayIL(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
}
