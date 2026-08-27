# Primitive Template App

A production-ready Vue starter built on the Primitive platform. Ships Vue 3 + TypeScript + Vite + Tailwind 4 + shadcn-vue + Pinia + vue-router, wired to the Primitive client libraries (`primitive-app`, `js-bao`, `js-bao-wss-client`) with auth, layouts, theming, and a Cloudflare Workers deploy already in place.

For platform concepts and API reference (auth flows, models, sharing, collections, workflows, prompts, integrations, etc.), see the **Primitive Docs**: https://primitive-labs.github.io/primitive-docs-site/ — or use the CLI (see below).

## Install the Primitive CLI

The Primitive CLI (`primitive-admin`) is required for app setup, OAuth/origin configuration, and on-demand documentation. Install once, globally:

```bash
pnpm add -g primitive-admin   # or: npm install -g primitive-admin
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

This signs you in to your Primitive account, creates the app on the platform, scaffolds this template, and writes `.primitive/config.json` with a `dev` Primitive environment bound to the new app.

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
- `js-bao` v2 codegen wired up — edit the schema `pnpm codegen` reads (`src/models/models.toml` here), run `pnpm codegen`, import from `@/models`
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
├── models/         models.toml (unless the app's schema is shared above this client) + *.generated.ts + barrel index.ts
├── pages/          HomePage, LoginPage, InviteAcceptPage, NotFoundPage
├── router/         routes.ts (createPrimitiveRouter), primitiveRouter.ts
├── stores/         userStore (auth + user prefs)
├── tests/          *.primitive-test.ts (registered with the test harness)
└── main.ts
```

`worker.js` is library-provided — **do not edit**.

## Adding a Model

1. Add a `[models.<name>]` section to the schema the `codegen` script names with `-i` — `src/models/models.toml` here, or a shared `models/models.toml` above this directory when this client is one of several against one Primitive app. There is one schema per app, never a copy: its TOML keys are the wire field names.
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
| `pnpm cf-deploy --deploy-env <name> --primitive-env <name>` | Build and deploy to Cloudflare Workers (see below) |
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
   code `000000` and auto-provisions a test user — the bare base address
   (`you@yourdomain.com`) is never a test account and always fails sign-in.
   Use a **stable suffix** per CI project (e.g.
   `you+primitivetest-ci@yourdomain.com`) so runs reuse one test user instead
   of creating new ones.

2. **`ws`** must be installed (it is a devDependency of this template) — the
   js-bao client needs it for WebSockets in Node.

### Running

```bash
PRIMITIVE_TEST_EMAIL="you+primitivetest-ci@yourdomain.com" pnpm test
```

To run against another environment, pass vitest's `--mode` and keep a matching
`.env.<mode>` file — **without a `--` separator**:

```bash
PRIMITIVE_TEST_EMAIL="you+primitivetest-ci@yourdomain.com" pnpm test --mode staging
```

> `pnpm test -- --mode staging` does **not** work. vitest discards every argument
> after a bare `--`, so the mode flag (and any positional test filter) is
> dropped and the run silently loads the default `.env` — the suite passes
> green against the wrong backend and writes test data there. Log
> `import.meta.env.MODE` and `import.meta.env.VITE_API_URL` from a test if you
> need to confirm which environment a run used.

For CI systems that consume JUnit output:

```bash
PRIMITIVE_TEST_EMAIL="..." pnpm vitest run --reporter=junit --outputFile=test-results.xml
```

### Notes

- The app ID and server URLs come from the selected Primitive environment in
  `.primitive/config.json`, filled in by the `primitiveEnv()` plugin and read
  through `import.meta.env` in `src/tests/primitive-tests.spec.ts`. Point a
  run at a different backend with `primitive env use <name>` or
  `PRIMITIVE_ENV=<name> pnpm test`; vitest `--mode` selects the `.env.<mode>`
  file for app behavior only.
- Because the two are independent, `PRIMITIVE_ENV=dev pnpm test --mode alpha`
  is a run against `dev` with alpha's app behavior — and it signs in and writes
  data there. If a mode's keys only make sense against one backend, declare
  `VITE_EXPECTED_PRIMITIVE_ENV` in its `.env.<mode>` (see
  [Pinning a mode to a Primitive environment](#pinning-a-mode-to-a-primitive-environment))
  and a mismatched run stops at config time, before sign-in.
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

## Configuration

Two files, two different jobs.

### Identity: `.primitive/config.json`

The backend URL and app ID are typed **once**, here. `primitive init` writes
it; every `primitive` command reads it; and the `primitiveEnv()` Vite plugin
fills `VITE_APP_ID`, `VITE_API_URL`, `VITE_WS_URL`, `VITE_APP_NAME` and
`VITE_PRIMITIVE_ENV` into the build from it (`VITE_WS_URL` is derived from the
API URL by scheme swap — never authored).

```bash
primitive env list                 # what this project knows about
primitive env use prod             # point THIS machine at one
primitive env add alpha --api-url https://alpha.primitiveapi.com --app-id app_...
```

`primitive env use` writes `.primitive/local.json`, which is gitignored — your
choice of backend never shows up as a file change. The committed
`defaultEnvironment` stays the team default a fresh clone resolves.

Name entries after the backend/app pair they point at (`prod`, `prod-test`,
`alpha`), not after a build stage — the build stage is the other axis.

### App behavior: `.env` files

The template ships `.env` (development) and `.env.production`. These carry no
identity at all:

| Variable | Purpose |
|---|---|
| `VITE_OAUTH_REDIRECT_URI` | OAuth callback URL — must match what's configured with the OAuth provider and the Primitive admin |
| `VITE_ENABLE_AUTH_PROXY` | Enable the auth proxy (recommended `false` in dev, `true` in prod) |
| `VITE_LOG_LEVEL` | One of `debug`, `info`, `warn`, `error` |
| `VITE_BASE_URL` | Public base URL — used to generate links (e.g. invitation URLs) |

Setting an identity key here still wins for local dev (with a warning), as an
escape hatch for CI. A deploy rejects it outright.

### Pinning a mode to a Primitive environment

The two axes are independent on purpose — a production front end against the
alpha backend is a real combination. But when a mode's keys are only correct
against one backend (a per-environment resource ID, a shared database ULID),
the wrong pairing is silent: the app runs one backend's identity with another
backend's configuration and simply misbehaves.

Say which environment the mode belongs to, in that mode's `.env` file:

```dotenv
# .env.alpha
VITE_EXPECTED_PRIMITIVE_ENV=alpha
```

Any run whose Primitive environment resolves to something else now fails at
startup, naming both halves and where each came from — `pnpm dev`, `pnpm
build`, `pnpm cf-deploy`, and `pnpm test` alike, because all four resolve the
environment through the same plugin:

```
PRIMITIVE_ENV=dev pnpm test --mode alpha    # stops before signing in
```

- **Opt-in.** No declaration (the default) keeps the axes fully independent.
- A value in the base `.env` is the default for every mode; `.env.<mode>`
  overrides it, and an empty value there switches the check off for that mode.
- `VITE_EXPECTED_PRIMITIVE_ENV=<name>` in the shell wins over the files — which
  is how you run a cross-wired pair on purpose: state it and the environment
  together, `VITE_EXPECTED_PRIMITIVE_ENV=dev PRIMITIVE_ENV=dev pnpm test --mode
  alpha`.
- The pure-env CI hatch still applies: a build that supplies both
  `VITE_APP_ID` and `VITE_API_URL` itself resolves nothing, so there is nothing
  to check. Overriding just one of them does *not* skip the check — the other
  half still comes from the resolved environment.
- `pnpm cf-deploy` checks the declaration against `--primitive-env` before it
  builds or prints a plan. It reads `.env*` from the project root; if you have
  moved Vite's `envDir`, a real deploy still fails inside the build, but
  `--check` will not see the declaration.

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

The template deploys to Cloudflare Workers via `wrangler.toml` +
`scripts/deploy.mjs`. A deploy names **two independent things**, and neither
is inferred from the other:

| Flag | Selects | Which means |
|---|---|---|
| `--deploy-env <name>` | the deploy environment | the Vite mode (`.env.<name>`) **and** the `[env.<name>]` block in `wrangler.toml` |
| `--primitive-env <name>` | the Primitive environment | the backend/app pair in `.primitive/config.json` |

They cross in practice — a production front end against the alpha backend, or
dev and prod builds that both hit `primitiveapi.com` with different app IDs —
so omitting either is an error. The app ID and API origin reach the worker as
`--var APP_ID:...` / `--var API_ORIGIN:...`, read from the Primitive
environment rather than from any `.env` file.

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

### 3. Edit `.env.production` (app behavior only)

```bash
VITE_OAUTH_REDIRECT_URI=https://my-app-prod.your-subdomain.workers.dev/oauth/callback
VITE_BASE_URL=https://my-app-prod.your-subdomain.workers.dev
VITE_ENABLE_AUTH_PROXY="true"
```

Do **not** add `VITE_APP_ID` / `VITE_API_URL` / `VITE_WS_URL` /
`VITE_APP_NAME` here. The deploy refuses to run when it finds one, in a `.env`
file or in your shell — the app ID comes from the Primitive environment you
name with `--primitive-env`. (If this app was scaffolded by an older CLI,
deleting those lines is the whole migration.)

### 4. Register the production URL with Primitive

```bash
primitive apps origins add https://my-app-prod.your-subdomain.workers.dev
# and update Google OAuth callback URL if applicable
```

### 5. Deploy

```bash
pnpm cf-deploy --deploy-env production --primitive-env prod
```

Print the resolved pair and the exact commands without running them:

```bash
pnpm cf-deploy --deploy-env production --primitive-env prod --check
```

Pass extra wrangler flags after `--`:

```bash
pnpm cf-deploy --deploy-env production --primitive-env prod -- --dry-run
```

## Adding More Environments

The two axes are extended separately.

### A new deploy environment (another front end)

1. Add a block to `wrangler.toml`:

   ```toml
   [env.test]
   name = "my-app-test"

   [env.test.vars]
   REFRESH_PROXY_COOKIE_MAX_AGE = "604800"
   REFRESH_PROXY_COOKIE_PATH = "/proxy/"
   ```

2. Create `.env.test` with app behavior for that build (no identity keys).

3. Deploy it against whichever backend you want:

   ```bash
   pnpm cf-deploy --deploy-env test --primitive-env prod
   ```

### A new Primitive environment (another backend/app)

```bash
primitive env add alpha --api-url https://alpha.primitiveapi.com --app-id app_...
primitive env use alpha            # for local dev
pnpm cf-deploy --deploy-env production --primitive-env alpha
```

Nothing in `wrangler.toml` or `.env.*` changes for a new backend.
