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
- `/src/models`: JS-bao model file definitions.
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
- This project uses **project mode**: a checked-in `.primitive/config.json` defines named environments (e.g. `dev`, `prod`), each binding an `apiUrl` and `appId`. Per-environment tokens live in `.primitive/credentials.json` (gitignored). `primitive init` scaffolds a `dev` environment; if the config file is missing, create it with `primitive env add dev --api-url <url> --app-id <appId>`. Select an environment with `--env <name>`, the `PRIMITIVE_ENV` env var, or `primitive env use <name>`.
- Before running other CLI commands, run `primitive whoami` to confirm the resolved environment, authenticated user, app ID, and server endpoint match this project.
- ALWAYS fetch the relevant guides before writing code that uses js-bao, js-bao-wss-client, or primitive-app — the guides are the source of truth for how the platform works and are updated more often than this file. Run `primitive guides list` to see available topics and `primitive guides get <topic>` to retrieve one.
- If using Claude Code, the `primitive-platform` skill automates the guides workflow and validates your code against them. Install it with `primitive skill install`, and make sure it's loaded into your context before starting work in this project.

### Workflow Codegen

- Typed workflow invokers are generated from the `workflows/*.toml` schemas in the sync directory (`.primitive/sync/<env>/<appId>/workflows/`). `pnpm codegen` regenerates them into `src/types/generated/workflows/` whenever any workflow TOMLs exist.
- Each generated file exports `<Key>Input`/`<Key>Output` types and a `<key>(client)` factory with typed `runSync`/`start` methods — ALWAYS call workflows through these factories instead of raw `client.workflows.start`/`runSync` with a string key. (`runSync` is only emitted for `syncCallable = true` workflows.)
- NEVER edit `*.generated.ts` files in `src/types/generated/`.
