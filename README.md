# ML – מערכת ניהול משרד עו"ד מיכאל ליטווק

מערכת ניהול למשרד: לקוחות ולידים, תיקים עם תהליך לפי סוג תיק, משימות, יומן מועדים, משתמשים ויומן פעולות.
נבנתה ומתוחזקת על ידי TKB. כתובת: https://ml.tkb-pro.com

## מבנה

| נתיב | מה זה |
|---|---|
| `public/` | הממשק: HTML/CSS/JS בלי שלב build, פונטים מקומיים (בלי בקשות לשרתים חיצוניים) |
| `src/worker.js` | ה-API ‏(`/api/*`) ב-Cloudflare Worker בשם `ml-api` |
| `src/db.js` | מיגרציות D1 (append-only, רצות לבד בבקשה הראשונה) |
| `src/lib.js` | ולידציה, תבניות תהליכים, הצפנת סיסמאות (PBKDF2) |
| `tests/` | `npm test` |

## הרצה מקומית

```
npm install
echo SETUP_TOKEN=any-local-token > .dev.vars
npm run dev            # http://127.0.0.1:8787
npm test
```

בכניסה הראשונה המערכת מבקשת קוד הקמה (SETUP_TOKEN) ויוצרת את משתמש המנהל. משם מוסיפים את שאר הצוות מתוך "משתמשים".

## הקמה ב-Cloudflare (פעם אחת, הבעלים)

1. ליצור D1 בשם `ml` ולשים את ה-`database_id` ב-`wrangler.jsonc`.
2. לחבר את הריפו ל-Workers Builds כ-Worker בשם `ml-api`: production branch `release`, build `npm ci && npm test`, deploy `npx wrangler deploy`.
3. להגדיר secret בשם `SETUP_TOKEN` (קוד חד-פעמי להקמת המנהל הראשון).
4. הכתובת `ml.tkb-pro.com` מוגדרת ב-`wrangler.jsonc` כ-custom domain ונוצרת בפריסה הראשונה.

## פרסום

`main` לעבודה שוטפת. push ל-`release` מפרסם לאוויר.

## אבטחה ופרטיות

- כניסה עם אימייל וסיסמה (לפחות 10 תווים), נעילה אחרי 5 ניסיונות כושלים ל-15 דקות.
- עוגיית סשן HttpOnly + Secure + SameSite=Strict, תוקף 12 שעות; הטוקן נשמר במסד רק כ-hash.
- בדיקת Origin ו-Content-Type בכל בקשה שמשנה נתונים, CSP קשיח, בלי סקריפטים או פונטים חיצוניים.
- כל פעולה נרשמת ביומן הפעולות (למנהלים).
- אין אנליטיקס, פרסומות או SDK חיצוני. הנתונים נשמרים ב-Cloudflare D1 בחשבון של TKB.
