# Primitive Template App

A production-ready Vue starter built on the Primitive platform. Ships Vue 3 + TypeScript + Vite + Tailwind 4 + shadcn-vue + Pinia + vue-router, wired to the Primitive client libraries (`primitive-app`, `js-bao`, `js-bao-wss-client`) with auth, layouts, theming, and a Cloudflare Workers deploy already in place.

For platform concepts and API reference (auth flows, models, sharing, collections, workflows, prompts, integrations, etc.), see the **Primitive Docs**: https://primitive-labs.github.io/primitive-docs/ — or use the CLI (see below).

## Install the Primitive CLI

The Primitive CLI (`primitive-admin`) is required for app setup, OAuth/origin configuration, and on-demand documentation. Install once, globally:

```bash
npm install -g primitive-admin
primitive login
primitive use "<Your App Name>"
primitive whoami    # confirm app + server endpoint
```

For platform documentation, query the CLI directly rather than searching elsewhere:

```bash
primitive guides list           # browse available topics
primitive guides get <topic>    # fetch a specific guide
```

## Quick Start

### 1. Create your app

```bash
npx create-primitive-app my-app
```

This signs you in to your Primitive account, creates the app on the platform, scaffolds this template, and pre-populates `.env` with your `VITE_APP_ID`.

### 2. Run it

```bash
cd my-app
pnpm dev
```

Visit `http://localhost:5173`.

## What's Included

### Auth — all four methods, prewired
- Magic link, OTP, passkey (WebAuthn), and OAuth (Google) — all surfaced through `<PrimitiveLogin>` on `LoginPage.vue`
- `<PrimitiveLogout>`, `<PrimitiveOauthCallback>` ready at `/logout` and `/oauth/callback`
- `EditProfile.vue` and `PasskeyManagement.vue` for in-app account management

### Tokenized invite flow
- `/invite/accept` page (`InviteAcceptPage.vue`) handles platform-issued invitation links
- Signed-in invitees are accepted in one round-trip; signed-out invitees have the token stashed in sessionStorage (`src/lib/inviteToken.ts`) and threaded through magic-link / OTP / passkey / OAuth flows by `userStore`

### Layout & chrome
- `AppLayout.vue` — collapsible sidebar (`AppSidebar.vue`) + content area for signed-in routes
- `LoginLayout.vue` — split layout for auth pages (login form + marketing carousel)
- `PrimitiveUserMenu`, `PrimitiveMobileTabBar`, `PrimitiveLoadingGate`, `PrimitiveLogoSpinner`, `DeleteConfirmationDialog` shared components
- Light/dark theme via `useTheme` composable

### UI kit
- Full shadcn-vue install under `src/components/ui/`: avatar, badge, button, card, carousel, checkbox, dialog, dropdown-menu, input, label, select, separator, sheet, sidebar, skeleton, table, textarea, tooltip
- Tailwind 4 with `tw-animate-css`

### Data layer
- `js-bao` v2 codegen wired up — edit `src/models/models.toml`, run `pnpm codegen`, import from `@/models`
- `UserPref` ships as an example model and powers user-prefs storage in `userStore`
- `useJsBaoDataLoader` composable: debounced query + auto-resubscribe on model changes

### Test harness
- `primitiveDevTools` plugin registered in `vite.config.ts`
- Tests live in `src/tests/*.primitive-test.ts`
- Open the runner in dev with **Cmd+Shift+L** (configurable in `vite.config.ts`)
- The same tests also run headlessly for CI via `pnpm test` — see
  [Running harness tests headlessly (CI)](#running-harness-tests-headlessly-ci)

### Deploy
- Cloudflare Workers via `wrangler.toml` + `worker.js` + `scripts/deploy.mjs`
- Multi-environment via `.env.{environment}` files

## Project Structure

```
src/
├── assets/         Static images
├── components/
│   ├── auth/       Login / logout / OAuth callback / profile / passkeys
│   ├── shared/     User menu, loading gate, mobile tab bar, etc.
│   ├── ui/         shadcn-vue components
│   └── AppSidebar.vue
├── composables/    useJsBaoDataLoader, useTheme
├── config/         envConfig.ts — read VITE_* vars
├── layouts/        AppLayout, LoginLayout
├── lib/            inviteToken, logger, routeOrUrl, utils
├── models/         models.toml + *.generated.ts + barrel index.ts
├── pages/          HomePage, LoginPage, InviteAcceptPage, NotFoundPage
├── router/         routes.ts (createPrimitiveRouter), primitiveRouter.ts
├── stores/         userStore (auth + user prefs)
├── tests/          *.primitive-test.ts (registered with the test harness)
└── main.ts
```

`worker.js` is library-provided — **do not edit**.

## Adding a Model

1. Add a `[models.<name>]` section to `src/models/models.toml`.
2. Run `pnpm codegen` to regenerate the `*.generated.ts` files.
3. Register the new class in `src/models/index.ts` (the barrel uses `attachAndRegisterModel` to bind each class to its TOML schema).
4. Import from `@/models` anywhere — the barrel registers all models as a side effect on first import.

For TOML field options, types, and codegen conventions: `primitive guides get models` (or browse `primitive guides list`).

## Available Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Run codegen, then start the Vite dev server |
| `pnpm build` | Run codegen, type-check, and build for production |
| `pnpm build-only` | Vite build only (skips type-check) |
| `pnpm test` | Run codegen, then run the registered harness tests headlessly under vitest |
| `pnpm preview` | Serve the production build locally |
| `pnpm codegen` | Regenerate `*.generated.ts` from `models.toml` |
| `pnpm type-check` | `vue-tsc --build` |
| `pnpm lint` | ESLint with `--fix --cache` |
| `pnpm format` / `pnpm format:check` | Prettier write / check |
| `pnpm cf-deploy <env>` | Build and deploy to Cloudflare Workers (see below) |
| `pnpm clean` / `pnpm clean-modules` | Remove `dist/` / `node_modules` + lockfile |

## Running Harness Tests Headlessly (CI)

`pnpm test` runs every registered `src/tests/*.primitive-test.ts` group under
vitest in Node — the exact same groups the in-browser Test Harness panel
(Cmd+Shift+L) runs — so registered tests can gate merges in CI. No browser or
headless-browser stack is involved: the js-bao client drives the full
document/model lifecycle natively in Node.

### Prerequisites

1. **Whitelist a test sign-in email for your app.** The headless run signs in
   through the OTP test bypass (code `000000`), which only works for emails
   whose base address the app owner has whitelisted:

   ```bash
   primitive apps update <your-app-id> --test-account-bases "you@yourdomain.com"
   ```

   Then any `you+primitivetest-<suffix>@yourdomain.com` address signs in with
   code `000000` and auto-provisions a test user. Use a **stable suffix** per
   CI project (e.g. `you+primitivetest-ci@yourdomain.com`) so runs reuse one
   test user instead of creating new ones.

2. **`ws`** must be installed (it is a devDependency of this template) — the
   js-bao client needs it for WebSockets in Node.

### Running

```bash
PRIMITIVE_TEST_EMAIL="you+primitivetest-ci@yourdomain.com" pnpm test
```

For CI systems that consume JUnit output:

```bash
PRIMITIVE_TEST_EMAIL="..." pnpm vitest run --reporter=junit --outputFile=test-results.xml
```

### Notes

- App IDs and server URLs come from `.env` (`VITE_APP_ID`, `VITE_API_URL`,
  `VITE_WS_URL`) via `src/tests/primitive-tests.spec.ts`; override per run
  with vitest `--mode` and the matching `.env.<mode>` file.
- Tests that return a score (`"passed/total (pct%)"`) fail the run when below
  a full score, so parity-style suites actually gate CI. The browser panel
  shows the same result as "scored" without failing.
- Invite-only, domain-restricted, and waitlist apps reject test-account
  provisioning like any other signup — the run fails with a clear auth error.
- The bypass token lives ~30 minutes. If a single suite runs longer, split it
  or re-run per shard.
- A test file that fails to load (import error, wrong default export) surfaces
  as a failing test — never a silent skip.
- A test that needs browser APIs (canvas, MediaRecorder, …) should declare
  `environment: "browser"` on the test — or on the whole `TestGroup` — so the
  headless run reports it as skipped instead of failing. Node-only tests can
  symmetrically declare `environment: "node"` and the browser panel skips
  them. Tests without the flag run in both contexts.

## Configuration: `.env` Files

App settings live in environment-specific `.env` files. The template ships with `.env` (development) and `.env.production`.

| Variable | Purpose |
|---|---|
| `VITE_APP_ID` | Your Primitive app ID. Pre-populated by `create-primitive-app`. |
| `VITE_API_URL` | Primitive API origin (default `https://primitiveapi.com`) |
| `VITE_WS_URL` | Primitive WebSocket origin (default `wss://primitiveapi.com`) |
| `VITE_APP_NAME` | App name shown in the UI (login page, browser tab) |
| `VITE_OAUTH_REDIRECT_URI` | OAuth callback URL — must match what's configured with the OAuth provider and the Primitive admin |
| `VITE_ENABLE_AUTH_PROXY` | Enable the auth proxy (recommended `false` in dev, `true` in prod) |
| `VITE_LOG_LEVEL` | One of `debug`, `info`, `warn`, `error` |
| `VITE_BASE_URL` | Public base URL — used to generate links (e.g. invitation URLs) |

To add a new environment (e.g. `staging`), copy `.env.production` to `.env.staging` and edit the values.

## Optional: Set Up Git

```bash
cd my-app
git init
git add .
git commit -m "Initial commit from primitive-app template"
```

Then create a repo on GitHub (without README/.gitignore/license) and:

```bash
git remote add origin https://github.com/your-username/my-app.git
git branch -M main
git push -u origin main
```

## Setting Up Google Sign-In

Google OAuth is optional. Disable it by removing the OAuth section in your Primitive app config; otherwise:

### 1. Configure a Google OAuth client

In the [Google Cloud Console OAuth page](https://console.cloud.google.com/auth/clients):
- **Authorized JavaScript origins**: `http://localhost:5173` (and your production domain)
- **Authorized redirect URIs**: `http://localhost:5173/oauth/callback` (and your production callback)

Note the **Client ID** and **Client Secret**.

### 2. Register them with Primitive

**Via CLI:**

```bash
primitive apps oauth set-google --client-id YOUR_CLIENT_ID --client-secret YOUR_CLIENT_SECRET
primitive apps origins add http://localhost:5173
primitive apps origins add https://your-production-domain.com
```

**Via dashboard:** open your app at https://admin.primitiveapi.com/login → Google OAuth section → enable, paste credentials, add origins/callback URLs.

## Deploying to Production

The template deploys to Cloudflare Workers via `wrangler.toml` + `scripts/deploy.mjs`. App config (`VITE_APP_ID`, `VITE_API_URL`) is read from `.env.{environment}` and forwarded to the worker as `--var APP_ID:...` / `--var API_ORIGIN:...` at deploy time, so there's a single source of truth across dev and prod.

### 1. Prerequisites

- Cloudflare account with Workers access
- `wrangler` is installed as a dev dependency (no separate install needed)

### 2. Set the worker name in `wrangler.toml`

The shipping `wrangler.toml` uses `YOUR APP NAME HERE` as a placeholder. Replace both occurrences:

```toml
name = "my-app"

[env.production]
name = "my-app-prod"
```

By default this deploys to `my-app-prod.<your-subdomain>.workers.dev`. To use a custom domain, uncomment and edit the `[[env.production.routes]]` block:

```toml
[[env.production.routes]]
pattern = "your-domain.com"
custom_domain = true
```

### 3. Edit `.env.production`

Set at least:

```bash
VITE_APP_ID=your_production_app_id
VITE_OAUTH_REDIRECT_URI=https://my-app-prod.your-subdomain.workers.dev/oauth/callback
VITE_BASE_URL=https://my-app-prod.your-subdomain.workers.dev
VITE_ENABLE_AUTH_PROXY="true"
```

The deploy script will refuse to deploy if `VITE_APP_ID` still equals the `YOUR_APP_ID_GOES_HERE` placeholder.

### 4. Register the production URL with Primitive

```bash
primitive apps origins add https://my-app-prod.your-subdomain.workers.dev
# and update Google OAuth callback URL if applicable
```

### 5. Deploy

```bash
pnpm cf-deploy production
```

Pass extra wrangler flags after `--`:

```bash
pnpm cf-deploy production -- --dry-run
```

## Adding More Environments

1. Add an environment block to `wrangler.toml`:

   ```toml
   [env.test]
   name = "my-app-test"

   [env.test.vars]
   REFRESH_PROXY_COOKIE_MAX_AGE = "604800"
   REFRESH_PROXY_COOKIE_PATH = "/proxy/"
   ```

2. Create `.env.test` with the test configuration.

3. Deploy:

   ```bash
   pnpm cf-deploy test
   ```

The deploy script reads `.env.{environment}` and uses the matching `[env.{environment}]` block.
