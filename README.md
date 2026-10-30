# Primitive Template App

A production-ready Vue starter built on the Primitive platform. Ships Vue 3 + TypeScript + Vite + Tailwind 4 + shadcn-vue + Pinia + vue-router, wired to the Primitive client (`js-bao-wss-client`, `js-bao`) with sign-in, onboarding, an app shell and a Cloudflare Workers deploy already in place. All of it is code in this app: change it like any other source.

For platform concepts and API reference (sign-in, databases, server functions, prompts, integrations, etc.), see the **Primitive Docs**: https://primitive-labs.github.io/primitive-docs-site/ — or use the CLI (see below).

## Install the Primitive CLI

The Primitive CLI (`primitive-admin`) is required for app setup, OAuth/origin configuration, and on-demand documentation. Install once, globally:

```bash
pnpm add -g primitive-admin   # or: npm install -g primitive-admin
primitive login
primitive whoami    # confirm app + server endpoint (the app this project's environment names)
```

For platform documentation, query the CLI directly rather than searching elsewhere:

```bash
primitive guides list           # browse available topics
primitive guides get <topic>    # fetch a specific guide
```

## Quick Start

### 1. Create your app

```bash
primitive init my-app --platform web
```

This creates the app on the platform, scaffolds this template, writes `primitive/config.json` with a `dev` Primitive environment bound to the new app, and allows `http://localhost:5173` (CORS and the sign-in-link callback).

### 2. Run it

```bash
cd my-app
pnpm dev
```

Visit `http://localhost:5173` and sign in with the code from the email.

## What's Included

### Sign-in
- One email carries a 6-digit code and a sign-in link; passkeys (WebAuthn, with conditional UI) and Google sign-in — all on `LoginPage.vue` (`PrimitiveLogin.vue`)
- `/oauth/callback` (`PrimitiveSignInCallback.vue`): the page an emailed link or the Google redirect opens; an expired link offers a resend to the same address, from any tab
- The client chooses the link's target and parses the callback (`emailSignInLinkTarget()`, `handleSignInCallback()`); `src/lib/signInState.ts` adds where to continue
- `/onboarding` (`PrimitiveOnboarding.vue`): a new user's name (required) and photo, then the passkey prompt where the app offers passkeys
- `EditProfile.vue` (name, avatar) and `PasskeyManagement.vue` from the user menu; `/logout`
- The route guard (`src/router/primitiveRouter.ts`): `requireSignIn` per route, plus an optional `authCheck` with `isAdmin` and `hasRole`

### Invitations
- `/invite/accept` (`InviteAcceptPage.vue`) handles platform-issued invitation links
- Signed-in invitees accept in one step; signed-out invitees have the token stashed in sessionStorage (`src/lib/inviteToken.ts`) and carried through every sign-in method by `userStore`

### Layout & chrome
- `AppLayout.vue` — collapsible sidebar (`AppSidebar.vue`) + content area for signed-in routes
- `LoginLayout.vue` — split layout for auth pages (login form + marketing carousel)
- `PrimitiveUserMenu`, `PrimitiveMobileTabBar`, `PrimitiveLoadingGate`, `PrimitiveLogoSpinner`, `DeleteConfirmationDialog` shared components

### UI kit
- shadcn-vue components under `src/components/ui/`: avatar, button, card, carousel, dialog, dropdown-menu, input, label, separator, sheet, sidebar, skeleton, tooltip (add more with `pnpm dlx shadcn-vue@latest add <name>`)
- Tailwind 4 with `tw-animate-css`; the design tokens are in `src/style.css`

### Data
- No data model ships: declare a db3 type in `primitive/<env>/db3-types/` and `pnpm codegen` generates its models (see [Adding a Database Type](#adding-a-database-type))
- `useJsBaoDataLoader` composable: loads a view's data and reloads on model changes and when a db3 becomes ready, gone or evicted
- db3s are kept on the device, in the browser's origin-private file system (OPFS), so they survive a reload and open offline; a second tab reaches the same copy. `src/config/storage.ts` wires up the storage engine, its worker and its tab-sharing broker, with nothing to configure

### Tests
- `pnpm test` runs vitest in Node, signed in as your test account (`src/tests/support/signIn.ts`); `src/tests/example.spec.ts` is the starting point — see [Tests](#tests)

### Deploy
- Cloudflare Workers via `wrangler.toml` + `worker.js` + `scripts/deploy.mjs`
- Multi-environment via `.env.{environment}` files

## Project Structure

```
primitive/
└── dev/db3-types/  Your db3 type files (one per type)
src/
├── assets/         Static images
├── components/
│   ├── auth/       Login / logout / sign-in callback / onboarding / profile / passkeys
│   ├── shared/     User menu, loading gate, mobile tab bar, etc.
│   ├── ui/         shadcn-vue components
│   └── AppSidebar.vue
├── composables/    useJsBaoDataLoader
├── config/         envConfig.ts — environment config and the client options; storage.ts — where db3s are kept on the device
├── layouts/        AppLayout, LoginLayout
├── lib/            client, signInState, inviteToken, logger, routeOrUrl, utils
├── models/         Generated by `pnpm codegen`: index.ts (allModels) + one directory per db3 type
├── pages/          HomePage, LoginPage, InviteAcceptPage, NotFoundPage
├── router/         routes.ts (createPrimitiveRouter), primitiveRouter.ts
├── stores/         userStore (sign-in, profile, passkeys)
├── tests/          example.spec.ts + support/signIn.ts
└── main.ts
```

`worker.js` is library-provided — **do not edit**.

## Adding a Database Type

1. Declare the type in `primitive/<env>/db3-types/<type>.toml` (beside `primitive/config.json`):

   ```toml
   [type]
   name = "notes"

   [models.notes]
   class_name = "Note"

   [models.notes.fields.id]
   type = "id"
   auto_assign = true
   indexed = true
   required = true

   [models.notes.fields.title]
   type = "string"
   ```

2. `primitive config push` to create the type on the platform.
3. `pnpm codegen` generates `src/models/notes/` and adds its models to `allModels` in `src/models/index.ts`, which the client is initialized with.
4. Import the models from `@/models/notes` and read them in a view with `useJsBaoDataLoader`.

Generated files are committed; never edit them. For field options, records and access: `primitive guides get databases`.

## Available Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Run codegen, then start the Vite dev server |
| `pnpm build` | Run codegen, type-check, and build for production |
| `pnpm build-only` | Vite build only (skips type-check) |
| `pnpm test` | Run codegen, then the `src/tests/` specs under vitest, signed in as `PRIMITIVE_TEST_EMAIL` |
| `pnpm preview` | Serve the production build locally |
| `pnpm codegen` | Regenerate the models from `primitive/<env>/db3-types/` and the function invokers from `functions/` |
| `pnpm type-check` | `vue-tsc --build` |
| `pnpm lint` | ESLint with `--fix --cache`, using the type-aware `recommendedTypeChecked` preset (unhandled promises, `async` without `await`, redundant assertions); findings are fixed in source, not suppressed. Also warns on every use of a deprecated platform API |
| `pnpm format` / `pnpm format:check` | Prettier write / check |
| `pnpm cf-deploy --deploy-env <name> --primitive-env <name>` | Build and deploy to Cloudflare Workers (see below) |
| `pnpm child:up <slug> [--port <n>]` | Create or resume a child app for this line of work, run `scripts/child-app-init`, push the tree into it, allow the dev port and select it (see below) |
| `pnpm child:down <slug> [--skip-teardown]` | Run `scripts/child-app-teardown`, then delete the child app |
| `pnpm clean` / `pnpm clean-modules` | Remove `dist/` / `node_modules` + lockfile |

## Tests

`pnpm test` runs the `.spec.ts` files under `src/tests/` with vitest in Node,
against the app's Primitive server. `signIn()` from `src/tests/support/signIn.ts`
signs in your test account and returns a client:

```ts
const { client, email } = await signIn();
const profile = await client.me.get();
await signOut(client);
```

### One-time setup

The test account signs in with the fixed code `000000`, which works only for a
`+primitivetest` address whose base your app lists in `testAccountBaseEmails`.
Add your base address to `primitive/<env>/app.toml`:

```toml
[app]
testAccountBaseEmails = ["you@yourdomain.com"]
```

then `primitive config push`. Any `you+primitivetest-<suffix>@yourdomain.com`
now signs in with `000000` (no email is sent) and is provisioned on first
sign-in; the bare base address is never a test account. Use a stable suffix per
machine or CI project so runs reuse one test user. An invite-only app admits
the address only once it is invited: `primitive users invite <app-id> <address>`.

### Running

```bash
PRIMITIVE_TEST_EMAIL="you+primitivetest-ci@yourdomain.com" pnpm test
```

Without `PRIMITIVE_TEST_EMAIL` the run fails, naming the variable.

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

### Gotchas

- The app ID and server URLs come from the selected Primitive environment in
  `primitive/config.json`, through the `primitiveEnv()` plugin. Point a run at
  a different backend with `primitive env use <name>` or
  `PRIMITIVE_ENV=<name> pnpm test`; vitest `--mode` selects the `.env.<mode>`
  file for app behavior only. If a mode's keys only make sense against one
  backend, declare `VITE_EXPECTED_PRIMITIVE_ENV` in its `.env.<mode>` (see
  [Pinning a mode to a Primitive environment](#pinning-a-mode-to-a-primitive-environment)).
- The test session lives about 30 minutes; split a longer suite.
- Specs build their own client (`signIn()`), which keeps db3s in memory, and
  never import the app's client options: Node has no browser storage. If a spec
  imports `src/config/envConfig.ts`, it gets the storage options as plain URL
  strings and starts no worker.

## Configuration

Two files, two different jobs.

### Identity: `primitive/config.json`

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
- A child app's machine-local environment pairs with the mode that declares
  its tree: under `VITE_EXPECTED_PRIMITIVE_ENV=alpha`, a child of `alpha` runs,
  a child of `dev` is refused.
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

## Child Apps for Parallel Work

When several agents or git worktrees work on this app at once, give each line
of work its own child app — a copy of the selected environment's app that
shares its `primitive/<env>/` tree — so a `config push` from one branch never
reaches the others. With the parent environment selected:

```bash
pnpm child:up feature-x --port 5174
pnpm dev --port 5174
# ... work, push, test ...
pnpm child:down feature-x
```

`child:up` creates the child (or attaches or resumes one that exists), checks
that it is the environment it acts on, runs your `scripts/child-app-init`,
pushes the tree into it, allows `http://localhost:<port>` (default 5173) and
selects it. Rerun it to resume an interrupted run. `child:down` runs your
`scripts/child-app-teardown`, then deletes the child and its local state.

The template ships neither hook: what a fresh child needs is your app's call.
Add them as executable files:

- `scripts/child-app-init` — seed the child: test users, databases, its own
  config vars (`primitive config set vars KEY=value`). It runs before the first
  push and on every `child:up`, so make it safe to repeat.
- `scripts/child-app-teardown` — revoke or delete anything the child created
  outside the platform (third-party connections, webhooks). Deleting the child
  doesn't reach those, so this is your app's responsibility;
  `child:down --skip-teardown` skips the hook and leaves them behind.

Both run from the project root with `PRIMITIVE_ENV` (the child), `CHILD_APP_ID`,
`CHILD_APP_SLUG` and `PARENT_ENV` set; address the child through
`PRIMITIVE_ENV`, not the selected environment. A slug must not be the name of
a committed environment. See `primitive guides get configuration` ("Child
apps") for the rest of the workflow.

## Optional: Set Up Git

```bash
cd my-app
git init
git add .
git commit -m "Initial commit from the Primitive template"
```

Then create a repo on GitHub (without README/.gitignore/license) and:

```bash
git remote add origin https://github.com/your-username/my-app.git
git branch -M main
git push -u origin main
```

## Sign-In Methods

`primitive init` leaves a new app ready for email sign-in from
`http://localhost:5173`: the email carries a code, and a link to
`/oauth/callback` because init put that URL in the app's
`[auth].emailRedirectUris`. Everything else is a setting in
`primitive/<env>/app.toml`, then `primitive config push`:

- **Email links on another origin** (a deployed site, another port): add that
  origin's `/oauth/callback` to `[auth].emailRedirectUris` and the origin to
  `[cors].allowedOrigins`. A link target missing from a non-empty list is
  refused; with the list empty the email carries the code alone.
- **Passkeys**: `passkeyEnabled = true` under `[auth]` and a relying-party
  entry for your domain in `[auth.passkeys]` (`primitive guides get
  authentication`). The login form then offers passkeys, onboarding asks new
  users to add one, and the user menu shows Manage Passkeys.
- **Google**: below.

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
| `--primitive-env <name>` | the Primitive environment | the backend/app pair in `primitive/config.json`, or a child app's machine-local environment |

They cross in practice — a production front end against the alpha backend, or
dev and prod builds that both hit `primitiveapi.com` with different app IDs —
so omitting either is an error. The app ID and API origin reach the worker as
`--var APP_ID:...` / `--var API_ORIGIN:...`, read from the Primitive
environment rather than from any `.env` file.

### 1. Prerequisites

- Cloudflare account with Workers access
- `wrangler` is installed as a dev dependency (no separate install needed).
  The deploy runs that pinned copy through `pnpm exec`, so no
  `pnpm approve-builds` step is needed either.

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

In `primitive/<env>/app.toml` for the Primitive environment you deploy
against, add the production origin to `[cors].allowedOrigins` and its
`/oauth/callback` to `[auth].emailRedirectUris` (and to the Google client's
redirect URIs if you use Google), then push:

```bash
primitive config push --env prod
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

### Preview a branch against a child app

A child app (`primitive apps children create feature-x`) is a copy of the
parent app for a branch. To run the branch's front end against it, upload a
preview version of the worker under an alias instead of deploying:

```bash
pnpm cf-deploy --deploy-env production --primitive-env feature-x --preview-alias feature-x
```

The script uploads the version with the child's app ID, prints the preview URL
(`https://feature-x-my-app-prod.your-subdomain.workers.dev`), and registers
that origin on the child, so the child's CORS and email sign-in checks accept
it. The live worker is untouched. Run the same command again after a change;
the alias URL stays the same. `--check` prints the upload and the registration
without running them.

- Against a committed environment a preview registers nothing. To sign in from
  it, add the preview origin to `[cors].allowedOrigins` and
  `[auth].emailRedirectUris` in `primitive/<env>/app.toml` and push.
- Registration runs the `primitive` CLI. If it fails, the upload stays and the
  script prints the command to run by hand.
- A deploy to a child **without** `--preview-alias` prints a warning and
  continues: it replaces the live worker of that deploy environment for
  everyone.

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
