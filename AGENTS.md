## Project Stack

- This project uses vite, typescript, vue, vue-router, tailwind, shadcn-vue, primitive-app and js-bao. Do not deviate from this stack. If there are additional foundational components required, ask the user before installing them.

## Project Organization

- `/src/assets`: Static images/assets
- `/src/components`: Vue Components. Organized by area.
- `/src/components/ui`: Installation location for base shadcn-vue components.
- `/src/config`: Config options for primitive app
- `/src/lib`: Shared business logic, not Vue specific -- pure typescript code only.
- `/src/composables`: Vue composables (useJsBaoDataLoader, useTheme).
- `/src/layouts`: Vue layout components. Used directly by the router to render different layouts for different types of pages based on route
- `/src/models`: JS-bao model file definitions, generated from the schema `pnpm codegen` names with `-i` — `src/models/models.toml` here, or a shared `models/models.toml` above this directory when this client is one of several sharing one Primitive app. ONE schema per app either way: its TOML keys are the wire field names, so a second copy that drifts orphans the other one's records. Never edit the `*.generated.ts` files.
- `/src/pages`: Top level Vue components that map to a route.
- `/src/router`: Vue-router configuration
- `/src/stores`: Pinia stores (userStore). The template ships only `userStore` for identity and user prefs. Document, sharing, and collection state should be managed by the app — call `client.documents.*`, `client.collections.*`, etc. directly or build a small store that suits your app's data model. The demo app under `primitive-app-demo` shows examples for each surface.
- `/src/tests`: Tests registered with the primitive-app test harness.

## General Coding Guidelines

- ALWAYS Fail early. Don't mask missing required inputs with inline fallbacks or try to recover from errors caused by improper usage or bad input. Expose the errors directly.
- ALWAYS use strong typing and invariants over scattered defensive code.
- ALWAYS run pnpm codegen and pnpm type-check after making changes and fix any errors.
- NEVER modify worker.js. This is a library provided file and should not be edited.

## Using the Primitive Platform

- The Primitive CLI (`primitive-admin` on npm) is required for working with the Primitive platform. Install it globally with `pnpm add -g primitive-admin` (or `npm install -g primitive-admin` if you use npm — pick one manager, not both), then authenticate with `primitive login`.
- This project uses **project mode**: the nearest ancestor `.primitive/config.json` — found by walking up from this directory the way git finds `.git` — defines named Primitive environments (e.g. `dev`, `prod`), each binding an `apiUrl` and `appId`. It is the SINGLE source of truth for the backend URL and app ID — NEVER author `VITE_APP_ID`, `VITE_API_URL`, `VITE_WS_URL` or `VITE_APP_NAME` in a `.env` file; the `primitiveEnv()` Vite plugin fills them from the resolved environment, and a deploy refuses to run when it finds one. Per-environment tokens live in `.primitive/credentials.json` and this machine's selection in `.primitive/local.json` (both gitignored). `primitive init` scaffolds a `dev` environment. It may sit in this directory or, when this client is one of several sharing one Primitive app, at the repo root above it — either way there is exactly ONE, and every `primitive` command run from anywhere inside the tree resolves it, so no command needs a path flag. If no config exists in this directory or any parent, create one with `primitive env add dev --api-url <url> --app-id <appId>`.
- Select the Primitive environment with `primitive env use <name>` (writes the gitignored local selection — no tracked file changes), or per command with `--env <name>` / `PRIMITIVE_ENV`. Resolution order: `--env` → `PRIMITIVE_ENV` → `.primitive/local.json` → the committed `defaultEnvironment` → the sole environment.
- Deploying names two independent things and neither defaults: `pnpm cf-deploy --deploy-env <name> --primitive-env <name>`. The DEPLOY environment is the front end (Vite mode + the `wrangler.toml` `[env.<name>]` section); the PRIMITIVE environment is the backend/app pair. Say "deploy environment" or "Primitive environment" — never a bare "environment". Add `--check` to print the resolved pair and the exact commands without running them.
- Before running other CLI commands, run `primitive whoami` to confirm the resolved environment, authenticated user, app ID, and server endpoint match this project.
- ALWAYS fetch the relevant guides before writing code that uses js-bao, js-bao-wss-client, or primitive-app — the guides are the source of truth for how the platform works and are updated more often than this file. Run `primitive guides list` to see available topics and `primitive guides get <topic>` to retrieve one.
- If using Claude Code, the `primitive-platform` skill automates the guides workflow and validates your code against them. Install it with `primitive skill install`, and make sure it's loaded into your context before starting work in this project.

### Workflow Codegen

- Typed workflow invokers are generated from the `workflows/*.toml` schemas in the sync directory beside the project config (`<project root>/.primitive/sync/<env>/<appId>/workflows/`). `pnpm codegen` regenerates them into `src/types/generated/workflows/` whenever any workflow TOMLs exist.
- Each generated file exports `<Key>Input`/`<Key>Output` types and a `<key>(client)` factory with typed `runSync`/`start` methods — ALWAYS call workflows through these factories instead of raw `client.workflows.start`/`runSync` with a string key. (`runSync` is only emitted for `syncCallable = true` workflows.)
- NEVER edit `*.generated.ts` files in `src/types/generated/`.
