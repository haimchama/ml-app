# ml-app – rules for coding agents

Office management system for the law office of Michael Litvak (ML). Built by TKB.
The UI is Hebrew, right-to-left. The office name is spelled "ליטווק" (never "ליטבק").

- Stack: one Cloudflare Worker `ml-app` (src/worker.js) serving `public/` as static assets and `/api/*`; D1 database `ml`. No build step.
- Address: https://ml.tkb-pro.com only (`workers_dev` and `preview_urls` stay false). Never touch other TKB Workers, addresses or the DNS of tkb-pro.com.
- Never run `wrangler login` / `wrangler deploy` against the studio account. Deploys happen by pushing to `release`.
- Migrations in src/db.js are append-only. Never edit a deployed migration.
- This holds confidential client data of a law office: every API route except setup/login/logout requires a session; validate and length-limit every input; insert user data in the UI only via textContent (the `h()` helper), never innerHTML; no third-party scripts, fonts, analytics or SDKs.
- 2FA (6-digit code e-mailed through the `EMAIL` send_email binding) is a setting IT switches on in the app (`settings.require_2fa`). Enabling it must stay behind a confirmed test code, so a broken mail setup can't lock the office out. `DEV_MAIL_LOG` is for local dev only.
- An empty database gets a first IT user automatically (`BOOTSTRAP_IT` in src/worker.js), who must change the password at first login.
- Users log in with an English username (`users.username`, see `username()` in lib.js); the e-mail is only for 2FA codes.
- Roles: it (everything), lawyer, secretary. Permissions live in `src/lib.js` (`can()`); check them on the server for every protected action, the UI only hides buttons.
- No secrets in the repository (`.dev.vars` is git-ignored). Optional secret: SETUP_TOKEN (not needed while the IT user is created automatically).
- Before pushing: `npm test` and `node --check` on src/worker.js and public/app.js.
