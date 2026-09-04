# Nucleus on Vercel — installable web app, your own domain, no server to babysit

This is the same Nucleus (Safety Docs, Welding Procedures, Water Testing,
per-person logins, everything) as the `nucleus-pwa` build, adapted to run on
**Vercel** instead of a traditional always-on host like Render. Two real
differences from `nucleus-pwa`, both a consequence of how Vercel works:

- **No server process, no persistent disk.** Vercel runs your backend as
  short-lived serverless functions that can start, run one request, and
  disappear — there's nothing staying resident to hold data in memory or on
  a local file the way `server/index.js` did. So this build stores all of
  Nucleus's data in **Upstash Redis** (a managed database, connected to your
  Vercel project through Vercel's Marketplace — a few clicks, no server to
  set up yourself) instead of `state.json` on disk.
- **Deploys are triggered by pushing to GitHub**, not by a manual "New Web
  Service" click each time. Once connected, every `git push` redeploys
  automatically.

Everything else — per-person email+password logins, App Manager/Operations
Manager roles, encryption at rest, the PWA install experience, optional
Microsoft 365 SSO — works exactly the way it's described in `nucleus-pwa`'s
README, because it's the same client code (`public/index.html`) talking to
an API that behaves identically from the browser's point of view.

## Project layout

```
nucleus-vercel/
  api/router.js       the whole backend, as one Vercel serverless function
  lib/store.js         Redis persistence (Upstash) — state, users, sessions,
                        rate limiting, backups, atomic conflict-safe saves
  lib/auth.js           optional Microsoft 365 sign-in (inactive by default)
  lib/jwt.js             token verification used by auth.js
  lib/roles.js            server-side data filtering by role (Costs/Contract)
  public/index.html   the app itself (identical to nucleus-pwa's)
  public/manifest.json  the PWA manifest
  public/sw.js            the service worker — offline app-shell caching
  public/icons/             app icons
  vercel.json          routes /api/*, /auth/*, and /data/state.json to
                        api/router.js; everything else is served as a static
                        file straight out of public/
```

## Deploying it — GitHub + Vercel

### 1. Push this folder to a GitHub repo

Create a new, empty repository on GitHub (private is fine — this code will
hold nothing secret itself; real secrets live in Vercel's environment
variables, never in the repo), then from inside this folder:

```bash
cd nucleus-vercel
git init
git add .
git commit -m "Nucleus on Vercel"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

(`.gitignore` already excludes `node_modules/`, `.env`, `.vercel`, and log
files — nothing sensitive should end up in the repo.)

### 2. Import the project into Vercel

1. Create your own Vercel account (your own email/login, same reasoning as
   `nucleus-pwa`'s README: nothing about redeploying later should depend on
   someone else's schedule or access).
2. **Add New → Project**, choose **Import Git Repository**, and pick the
   repo you just pushed.
3. Vercel auto-detects this as a Node project (no framework preset needed —
   the `public/` folder is served as static files automatically, and
   `api/router.js` becomes a serverless function automatically because it's
   under `api/`). Leave the build and output settings at their defaults.
4. Don't click **Deploy** yet — first connect the database (next step) so
   the environment variables it creates are in place for the first deploy.

### 3. Connect Upstash Redis (the database)

1. From your new project's dashboard, open the **Storage** tab (or
   **Integrations → Browse Marketplace** on older Vercel dashboard layouts)
   and add **Upstash — Redis, Vector, Queue**.
2. Create a new Redis database when prompted (the smallest/free tier is
   plenty for this app's data size) and connect it to this project.
3. That's it — Vercel automatically adds `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` to your project's environment variables. You never
   type these in yourself; `lib/store.js` reads them automatically
   (`Redis.fromEnv()`).

Vercel's exact menu names shift occasionally — if "Storage" isn't where
you'd expect, search your project's settings for "Marketplace" or
"Integrations"; the underlying step (add an Upstash Redis database, connect
it to this project) is what matters, not which tab it's under today.

### 4. Set the rest of the environment variables

Still in your Vercel project → **Settings → Environment Variables**, add
(see `.env.example` for the full list and comments):

- `NUCLEUS_ADMIN_EMAIL` / `NUCLEUS_ADMIN_PASSWORD` — your own bootstrap
  login (see "Setting up your first login" below).
- `NUCLEUS_ENCRYPTION_KEY` — generate one the same way `nucleus-pwa` does:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- Leave the `AZURE_*` variables blank unless you're turning on Microsoft
  365 sign-in (see that section below).

Apply these to all three environments (Production, Preview, Development)
unless you specifically want different admin credentials per environment.

### 5. Deploy

Click **Deploy**. Vercel builds and gives you a working
`https://your-project.vercel.app` address within a minute or two — open it,
and you should see Nucleus's sign-in screen.

From then on, every `git push` to your `main` branch redeploys
automatically — no manual step on Vercel's side.

## Setting up your first login

Identical to `nucleus-pwa`: there's no self-signup, so `NUCLEUS_ADMIN_EMAIL`
/ `NUCLEUS_ADMIN_PASSWORD` bootstrap your own working login the moment the
app is deployed with those variables set.

1. Set `NUCLEUS_ADMIN_EMAIL` / `NUCLEUS_ADMIN_PASSWORD` in Vercel's
   environment variables (step 4 above) and deploy.
2. Sign in at your `.vercel.app` address (or your custom domain, once
   connected) with that email and password.
3. Add that same email to the **Team** panel (home screen → Team), with
   your name and role set to **App Manager** — this is what's required
   before you can add anyone else to Team or create logins for them (see
   "Only an App Manager manages the team roster" below). The Team panel
   lets whoever's signed in add this very first member even before anyone
   has a role yet, so this step never locks you out.
4. For everyone else: add them to Team with their name, role, and work
   email, then click **Set login** next to their name and give them an
   initial password (tell them directly — text, Slack, in person). They
   can change it themselves afterward from the top bar → **Change
   password**.

**One thing worth deciding up front**: Nucleus keeps App Manager (adds
people, manages logins) and Operations Manager (creates jobs, assigns PMs,
sees Costs/Contract) as two separate roles, and each team member has
exactly one role. If you're running this solo, pick App Manager for
yourself if you'll be onboarding people, or hand that role to someone else
and take Operations Manager instead.

### Only an App Manager manages the team roster

Same enforcement as `nucleus-pwa`: creating or resetting a login
(`/api/accounts/set-password`) is restricted to whoever's signed in with
the **App Manager** role, enforced by the server itself — not just hidden
in the interface. Everyone can still change their own password. App
Manager has no visibility into Costs or Contract data, by design.

## Buying and connecting a domain

1. **Buy the domain** from any registrar (Cloudflare Registrar, Namecheap,
   etc.) — typically $10–20/year for a `.com`.
2. In your Vercel project → **Settings → Domains**, add the domain you
   bought. Vercel shows you exactly which DNS record to add.
3. At your registrar's DNS settings, add that record.
4. Vercel automatically issues a free TLS certificate once DNS resolves —
   usually within minutes.
5. From then on, your team opens Nucleus at your own domain, which is also
   the address to install as a PWA (see below).

## Installing it as an app (once it's live on your domain)

Same as `nucleus-pwa`:

- **iPhone/iPad (Safari only):** Share icon → **Add to Home Screen**.
- **Android (Chrome):** Chrome's automatic **Install app** banner, or ⋮
  menu → **Install app**.
- **Desktop (Chrome/Edge):** install icon in the address bar, or ⋮ menu →
  **Install Nucleus…**.

## How your data stays safe here

- **Atomic, conflict-safe saves.** Because serverless functions can run
  concurrently across separate instances, this build replaces
  `nucleus-pwa`'s in-memory write-lock with a Redis-native atomic
  compare-and-swap (a small Lua script executed by Redis itself), so two
  people saving at nearly the same instant still can't silently overwrite
  each other — the loser gets the same "someone else saved first, here's
  the latest version" conflict response the Render build always gave.
- **Automatic backups.** Every save also writes a timestamped snapshot into
  Redis (the last 30 are kept), the same policy as `nucleus-pwa`.
- **No deploy ever touches your data.** Because the data lives in Upstash
  Redis, not in the deployed code or a disk attached to a function
  instance, redeploying your code (a `git push`) can never wipe or roll
  back your team's data — there's no "forgot to mount a persistent disk"
  failure mode here at all, unlike traditional hosts.
- **Encryption at rest**, once `NUCLEUS_ENCRYPTION_KEY` is set — same as
  `nucleus-pwa`: without it, data is stored as plain readable JSON in
  Redis, fine for trying this out, not fine for real financial data.
- **Costs/Contract access enforced server-side**, same role-resolution
  logic as `nucleus-pwa`, ported unchanged (`lib/roles.js`).
- The **"Backup data"** button in Nucleus's top bar still works exactly the
  same way — a one-click full JSON download to whatever device you're
  using, independent of everything above.

## Optional: real per-person sign-in with Microsoft 365

Identical to `nucleus-pwa` — `lib/auth.js` is the same Entra ID (Azure AD)
OAuth2/PKCE implementation, unchanged. Off by default; set all four of
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and
`APP_BASE_URL` (your deployed domain) in Vercel's environment variables to
turn it on. See `.env.example` for where to get each value.

## Push notifications

When someone gets a Nucleus notification — a cost impact reported, a
request assigned to them — they can also get a real phone/tablet alert for
it, even if Nucleus isn't open, the same as the Render build. Identical
implementation (`lib/webpush.js` is a byte-for-byte copy of the Render
build's `server/webpush.js` — Node's own `crypto`/`https` only, no npm
dependency, RFC 8291/8292), with subscriptions stored in Redis instead of a
local file.

Turn it on:

1. Run `node generate-vapid-keys.js` once, from this project's folder
   (locally, with Node — this isn't a deploy step).
2. Add the two lines it prints (`NUCLEUS_VAPID_PUBLIC_KEY` /
   `NUCLEUS_VAPID_PRIVATE_KEY`) to this project's Vercel environment
   variables (see `.env.example`).
3. Redeploy (or wait for your next deploy — env var changes apply to new
   deployments).

One-time setup for the whole deployment — once it's on, anyone signed in
can turn on notifications for their own device from inside Nucleus. Leave
both env vars unset to keep push notifications off; nothing else depends
on them. Keep the private key as secret as `NUCLEUS_ENCRYPTION_KEY`.

## Cost

Vercel's free (Hobby) tier is realistically enough to start on: it covers
personal/small-team use with generous function-call and bandwidth limits.
Upstash Redis also has a free tier sized for small datasets like this app's.
If your team outgrows either free tier, Vercel Pro starts around $20/month
and Upstash's paid tier is usage-based and typically a few dollars/month at
this app's scale — separate from the domain itself. Prices change; check
Vercel's and Upstash's current pricing pages before committing.

## What was verified, and what's still on you

**Verified without deploying anything to Vercel itself** (no way to do a
live deploy from inside this conversation): the conflict-safe save logic —
the actual novel, risk-bearing piece of this port — was tested directly
against a real local Redis server, including under simulated concurrent
writes from ten simultaneous "clients," and confirmed exactly one save wins
while the other nine correctly receive the same conflict response
`nucleus-pwa` gives. The route logic in `api/router.js` was ported
line-by-line from `nucleus-pwa/server/index.js` (same checks, same order,
same response shapes) and reviewed against the original rather than
rewritten from scratch, to keep the two builds behaviorally identical.

**Not verified, because it needs a real Vercel project and a connected
Upstash database, neither of which exist yet from here:** an actual
end-to-end deploy (push to GitHub → Vercel build → live URL), the Upstash
Marketplace connection flow exactly as Vercel's current UI presents it, and
the install/offline flow on a real phone or desktop against a live
`.vercel.app` or custom domain. None of this is exotic — it's standard
Vercel/Upstash behavior — but this README won't claim it as confirmed
working until you've done it once. After your first deploy, a quick pass
worth doing: open the live URL, log in, create a test job, refresh, and
confirm the job is still there (proves Redis is actually wired up), then
push a trivial code change and confirm the job survives that redeploy too.

## Support

This is Claude-built and Claude-maintained — if something here doesn't work
as described, or you want a change, just ask in the same conversation (or
project) this was built in.
