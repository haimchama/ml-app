# ml-app – rules for coding agents

Office management system for the law office of Michael Litvak (ML). Built by TKB.
The UI is Hebrew, right-to-left. The office name is spelled "ליטווק" (never "ליטבק").

- Stack: one Cloudflare Worker `ml-app` (src/worker.js) serving `public/` as static assets and `/api/*`; D1 database `ml`. No build step.
- Address: https://ml.tkb-pro.com only (`workers_dev` and `preview_urls` stay false). Never touch other TKB Workers, addresses or the DNS of tkb-pro.com.
- Never run `wrangler login` / `wrangler deploy` against the studio account. Deploys happen by pushing to `release`.
- Migrations in src/db.js are append-only. Never edit a deployed migration.
- This holds confidential client data of a law office: every API route except setup/login/logout requires a session; validate and length-limit every input; insert user data in the UI only via textContent (the `h()` helper), never innerHTML; no third-party scripts, fonts, analytics or SDKs.
- Login is two-step: password, then a 6-digit code e-mailed through the `EMAIL` (send_email) binding. Never add a way to skip the code. `DEV_MAIL_LOG` is for local dev only.
- Roles: it (everything), lawyer, secretary. Permissions live in `src/lib.js` (`can()`); check them on the server for every protected action, the UI only hides buttons.
- No secrets in the repository (`.dev.vars` is git-ignored). Secrets: SETUP_TOKEN.
- Before pushing: `npm test` and `node --check` on src/worker.js and public/app.js.
