---
name: primitive-platform
description: >
  Expert guide for building applications on the Primitive platform. MUST be used whenever the user
  is writing code that uses js-bao, js-bao-wss-client, primitive-app components, or any Primitive
  platform feature (documents, databases, workflows, prompts, integrations, blobs, authentication,
  users/groups). Also trigger whenever about to run any `primitive` CLI command (e.g., primitive sync, primitive integrations, primitive apps, primitive env) to ensure Step 0 CLI verification is performed first. After writing or modifying code that touches Primitive
  APIs, this skill cross-references the implementation against official guides and automatically
  corrects common mistakes. Use this skill even if the user doesn't explicitly ask for it —
  any Primitive-related code should be validated against current best practices. Also use it
  when something looks like a platform bug or missing platform capability, to decide whether
  (and how) to file a platform issue. Also trigger whenever the user wants to upgrade or update
  the app to a newer platform version — bumping js-bao, js-bao-wss-client, primitive-app, or the
  primitive CLI — which follows the "Upgrading Platform Libraries" workflow below.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Agent
---

# Primitive Platform Development Guide

You are an expert on the Primitive platform. Your job is to help developers write correct,
idiomatic Primitive code by leveraging the CLI's built-in guide system and enforcing best practices.

**The CLI guides are the single source of truth.** Never hardcode or memorize guide content —
always fetch the latest from the CLI.

## Step 0: Verify CLI Configuration

The Primitive CLI is **project-scoped**, and project mode is **strongly preferred** for any work
inside a repo. Each project has a `.primitive/config.json` (committed to the repo) that defines
named environments (`dev`, `prod`, `staging`, …), where each environment binds an `apiUrl` and
(optionally) an `appId`. Per-environment auth tokens live in `.primitive/credentials.json`
(gitignored). There is no global "currently active app" — the active environment determines the
server *and* the app.

The legacy global fallback (`~/.primitive/credentials.json`) exists only for one-off use outside a
project. **Inside a project, treat its absence as a setup gap to fix, not a mode to operate in.**

**Before running any CLI commands**, your *first* check is whether the project is in project mode:

```bash
ls .primitive/config.json   # exists at project root or any ancestor?
```

The two branches below are not equivalent — pick the one that matches reality and follow it.

### Branch A — `.primitive/config.json` exists (project mode)

The active environment is resolved in this order:
1. `--env <name>` flag on the command
2. `PRIMITIVE_ENV` environment variable
3. `defaultEnvironment` in `.primitive/config.json`
4. The sole environment, if exactly one is defined

Confirm you're targeting the correct environment:

1. **Read the CLI header.** Every command prints `Env | App | Server` at the top of its output —
   verify these match the project's intended target.
2. **Inspect the project config:**

   ```bash
   primitive env list           # All environments (default marked with *)
   primitive env show           # Details for the currently-resolved env
   primitive whoami             # Authenticated user + resolved server/app
   ```

**To switch environments** for a one-off command, pass `--env <name>`. To change the project
default, run `primitive env use <name>`. To switch the *app* an env points at, edit the env's
`appId` in `.primitive/config.json` (or re-run `primitive env add`). `primitive use <app>` is a
no-op when the active env already pins an `appId`.

### Branch B — no `.primitive/config.json` (project mode NOT set up)

Without project config the CLI silently falls back to global state in `~/.primitive/credentials.json`
(legacy mode). Commands run against whatever app/server happens to be globally active — which the
agent didn't set and the user may have forgotten about. **This is a footgun, not a supported way to
work inside a project.** Do not proceed silently, and do not treat the global fallback as the
default path.

**Your default action is to set up project mode.** Stop and prompt the user to create the project
config before doing anything else. Don't bury the recommendation behind an equal-weight "or proceed
against global state" option — make setting up project config the clear, recommended next step.

First gather the context you'll propose (so the prompt is concrete, not abstract):

```bash
primitive whoami   # current global server + app, if any — shows what the fallback WOULD target
```

Then prompt the user, e.g.:

> "This project has no `.primitive/config.json`, so the CLI isn't in project mode. I recommend
> setting up project-scoped config so this repo pins its own environment instead of relying on your
> global state (currently `<server>` / `<app from whoami>`, which I didn't set). I'll add an env
> with:
>
> ```bash
> primitive env add dev --api-url <url> --app-id <id>
> ```
>
> Does this look right, or should I adjust the env name / URL / app?"

If you need the user to pick the env name, server, or app, ask them. Confirm the values before
running `env add` — but the question to resolve is *which* project config to create, not *whether*
to create one.

`primitive env add` is additive and safe — it only writes an entry to `.primitive/config.json`
(creating the file if needed). It does not touch source code, create apps on the server, or install
dependencies.

**Only fall back to global state if the user explicitly declines project setup** after you've
recommended it. Even then, name the exact server/app the command will hit and get clear
confirmation before running anything mutating (`primitive sync push`, `primitive apps create`, etc.).
A read-only command (`whoami`, `guides list`) against global state is fine while you're still
working out the config.

Do not rely on `.env` files like `PRIMITIVE_API_URL` to control CLI targeting — those are not
read by the CLI in project mode, and the project config is the source of truth.

**Why this matters:** If the CLI is pointed at the wrong environment (e.g., prod instead of dev),
commands like `primitive sync push` will modify the wrong server. Silent fallback to global state
makes this exact mistake easy to commit. Setting up project config is the durable fix — verify and
surface before running mutating operations.

## Step 1: Discover Available Guides

Before writing or reviewing any Primitive code, run:

```bash
primitive guides list
```

This returns the full list of available guide topics with descriptions, keywords, and use cases.
The `COMBINATIONS` column shows which `(language, platform)` variants each guide is available in
(e.g. `ts; swift`). Use this output to determine which guides are relevant to the current task —
and which language/platform variant to request in Step 2.

### Determine the project's language and platform

Figure out what the project you're working in targets, then request the matching variant when
fetching guides:

- A `Package.swift`, `*.xcodeproj`, or `project.yml` → `--language swift` (plus `--platform ios`
  or `--platform macos` as appropriate).
- A Vite/React/Node web app (`package.json`, `js-bao-wss-client`) → `--language ts --platform web`.

If you can't tell, omit the flags — every guide has a default variant, so a bare
`primitive guides get <topic>` always returns something useful.

## Step 2: Fetch the Relevant Guides

For each relevant topic identified in Step 1, fetch the full guide, passing the project's
language/platform so you get the right variant:

```bash
primitive guides get <topic> --language <ts|swift> --platform <web|ios|macos>
# or, when the project's language/platform is unknown or doesn't matter:
primitive guides get <topic>
```

`--language` accepts aliases (`typescript`/`javascript`/`js` → `ts`). These flags **never fail**:
an unknown value or an unavailable combination falls back to the guide's default variant rather
than erroring, so it's always safe to pass your best guess.

**Always fetch guide(s) BEFORE writing code.** If multiple features are involved, fetch multiple
guides. The guides contain:
- Complete API documentation with method signatures
- Working code examples in the requested language (e.g. TypeScript or Swift)
- Common patterns and anti-patterns
- Configuration examples (TOML files for `primitive sync`)
- Decision frameworks for architecture choices

**Do not guess or assume API patterns.** If you're unsure about a method signature, parameter,
or pattern, fetch the guide. The guides are comprehensive and authoritative.

## Step 3: Write Code Following Guide Patterns

When writing Primitive code:

1. **Follow the patterns from the fetched guides exactly** — method names, argument order, lifecycle patterns
2. **Use `primitive sync`** for all backend configuration (workflows, prompts, integrations, databases)
3. **Configuration lives in TOML files** in version control, pushed via `primitive sync push`
4. **Run `pnpm codegen`** after creating or modifying js-bao models

## Step 4: Post-Code Review (Automatic)

After writing or modifying Primitive-related code, **automatically perform this review**:

### 4a. Identify What Was Written
Determine which Primitive features the new/modified code touches by scanning for:
- Import statements from `js-bao`, `js-bao-wss-client`, or `primitive-app`
- Primitive API calls (documents.open, databases.connect, workflows, etc.)
- Model definitions, schemas, queries
- Configuration files (TOML for sync)

### 4b. Fetch and Cross-Reference
Run `primitive guides list` to identify which guides cover the features used, then fetch each one
in the project's language/platform:
```bash
primitive guides get <topic> --language <ts|swift> --platform <web|ios|macos>
```

Compare the written code against the guide content:
- **API usage patterns** — Are methods called correctly with proper arguments?
- **Lifecycle management** — Are documents opened before queries? Is auth checked first?
- **Access control** — Are CEL expressions or permissions configured properly?
- **Anti-patterns** — Does the code do anything the guide explicitly warns against?
- **Missing steps** — Does the code need `pnpm codegen`, `primitive sync push`, or other follow-up?

### 4c. Report and Fix
If issues are found:
1. **Explain the issue** — cite the specific guide section that applies
2. **Show the fix** — provide corrected code
3. **Apply the fix** — edit the file directly (don't just suggest, actually fix it)
4. **Note any CLI commands needed** — e.g., `pnpm codegen` or `primitive sync push`

If no issues are found, briefly confirm the code follows best practices.

## CLI Quick Reference

Remind users of these essential commands when relevant:

```bash
# Verify current configuration (DO THIS FIRST)
primitive env list                 # List environments in .primitive/config.json (default marked *)
primitive env show                 # Details for the currently-resolved env (api URL, app ID)
primitive whoami                   # Authenticated user + resolved server/app

# Switching environments
primitive env use <name>           # Change the project's default environment
primitive --env <name> <command>   # One-off override for a single command
PRIMITIVE_ENV=<name> <command>     # Override via env var (useful in scripts/CI)

# Setup — existing project (most common: adopting Primitive in an existing repo)
pnpm add -g primitive-admin                             # Install CLI (pnpm preferred; npm works too)
primitive env add dev --api-url <url> --app-id <id>     # Add env to .primitive/config.json
primitive env add prod --api-url <url> --app-id <id>    # (creates the file if missing)
primitive login                                         # Authenticate (tokens stored per-env)

# Setup — brand-new project (greenfield only)
primitive init my-new-app                               # Scaffolds template, creates a new app
                                                        # on the server, runs pnpm install.
                                                        # Do NOT run inside an existing repo.

# Guides (the most important commands for development)
primitive guides list              # See all guides: topics, descriptions, available (lang,platform) combinations
primitive guides get <topic>       # Read a guide's default variant
primitive guides get <topic> --language swift --platform ios   # Read a specific language/platform variant

# Configuration as Code
primitive sync init --dir ./config # Initialize config directory
primitive sync pull --dir ./config # Pull config from server
primitive sync push --dir ./config # Push config to server
primitive sync diff --dir ./config # Preview changes before push

# Common operations
primitive apps list                # List apps on the active env's server
primitive apps create "Name"       # Create an app (does NOT auto-bind to an env;
                                   # edit .primitive/config.json or use `env add` to bind)
```

## When the User is Starting a New Feature

If the user describes a new feature they want to build:

1. **Verify CLI configuration** per Step 0 — confirm the active environment in
   `.primitive/config.json` (and its bound `apiUrl` / `appId`) match the project's intended target
   before running any commands
2. **Run `primitive guides list`** to discover available topics and their `(language, platform)` combinations
3. **Identify which guides are relevant** to their feature from the list output
4. **Fetch those guides** with `primitive guides get <topic> --language <lang> --platform <platform>`
   (using the project's language/platform; omit the flags if unknown)
5. **Recommend a data modeling approach** based on the guide content. If requirements are unclear or ambiguous, **ask the user clarifying questions before proceeding** — it's much easier to get the data model right upfront than to migrate later
6. **Outline the implementation steps** referencing specific patterns from the guides
7. **Write the code** following the patterns exactly
8. **Review automatically** per Step 4 above

## When the User Asks "How Do I...?"

For any question about Primitive platform capabilities:

1. **Run `primitive guides list`** to find the relevant topic (and its available language/platform combinations)
2. **Fetch the guide**: `primitive guides get <topic> --language <lang> --platform <platform>` (omit the flags if the language/platform is unknown)
3. **Answer from the guide content** — don't guess or make up APIs
4. **Include working code examples** from the guide
5. **Point the user to the guide** for further reading: "You can see more examples by running `primitive guides get <topic>`"

## Upgrading Platform Libraries

When the user asks to upgrade the app to a newer platform version, follow this workflow.
An upgrade is not just a version bump: after the libraries move, workarounds built for old
platform bugs should come out, and new platform capabilities should be considered. The
refreshed guides are the source of truth for what the platform can do now.

The backend is upgraded by the platform team, not by the app — the app only chooses which
environment it points at (Step 0). A library upgrade against the production environment
needs no server-side changes.

### 1. Snapshot the current state

- Read `package.json` and note the installed versions of the platform packages the app
  uses: `js-bao`, `js-bao-wss-client`, `primitive-app`, and `primitive-admin` (the CLI).
- Check what's available: `pnpm view <pkg> dist-tags` for each. Compare the target tag's
  version against what's installed — a dist-tag can lag (or even point behind another
  tag), so confirm the upgrade actually moves forward before proceeding.
- Locate the app's platform feedback doc (convention below). Note its upgrade stamp and
  the tracked workarounds — Step 5 revisits each one.

### 2. Upgrade the CLI first

```bash
pnpm add -g primitive-admin@latest   # pnpm preferred; use npm if that's how the CLI was installed
```

Upgrading the CLI first matters for two reasons:

- The CLI bundles this skill and silently refreshes the installed copy on its next run.
  After upgrading, **re-read this skill file** — the guidance itself may have changed.
- The CLI serves the guides, and guides are cached at `~/.primitive/guides/` with a
  24-hour TTL. Nothing invalidates that cache when packages update, so after any upgrade
  pass `--refresh` on the first `primitive guides list` / `primitive guides get` calls
  (or clear the cache: `rm -rf ~/.primitive/guides`). Otherwise you may be reading
  yesterday's guides against today's libraries.

### 3. Upgrade the app's libraries

```bash
# pnpm by default (use npm only if the app already uses npm), for the packages the app uses:
pnpm add js-bao@latest js-bao-wss-client@latest primitive-app@latest
```

Upgrade the libraries **before** fetching guides: the guides system selects its version
channel from the *installed* `js-bao-wss-client` major, so fetching first returns guides
for the old version. Then refetch the guides for every feature area the app uses,
passing `--refresh` on the first call.

### 4. Fix breaking changes

Run the app's typecheck/build. For every error, consult the refreshed guide for that
feature area and migrate the code to the current API — don't pin back or suppress. A
major version bump means breaking changes are expected; treat the migration as part of
the upgrade, not an optional follow-up.

### 5. Retire resolved workarounds

For each workaround tracked in the feedback doc, re-test the underlying platform
behavior against the upgraded libraries (a small repro, or the app test that covers it).
If the platform now behaves correctly, remove the workaround code and move the item to
Resolved. If not, keep it and note the version it was last checked against. Stale
workarounds are a real cost — they mask platform behavior and confuse later readers —
so default to removing them the moment they're unnecessary.

### 6. Adopt and suggest new features

Re-run `primitive guides list` (topics appear and grow over time) and skim the refreshed
guides for the app's feature areas. Compare against what the app actually does:

- Where a new platform capability clearly replaces app-level code (less code, same
  behavior), adopt it as part of the upgrade.
- Where a capability opens something new but needs a product decision, don't build it —
  report it as a suggestion with a pointer to the relevant guide section.

### 7. Verify and stamp

Run the app's tests, apply the Step 4 post-code review to everything modified, and
update the feedback doc's upgrade stamp (date, channel, versions).

### The platform feedback doc

Convention: a `PRIMITIVE-FEEDBACK.md` at the app root tracks the app's relationship to the
platform — when it was last upgraded, and which workarounds exist for platform issues.
This is what makes upgrades mechanical instead of archaeological. If the app doesn't
have one, create it during the first upgrade:

```markdown
# Platform Feedback

## Upgrade stamp
- Last upgraded: 2026-07-21
- Channel: production
- Versions: js-bao-wss-client 2.0.6, primitive-app 3.0.5, js-bao 0.5.1, primitive-admin 1.0.55

## Open items
- [#1234] Symptom or missing capability. Workaround: `src/lib/foo.ts:42` (retry loop).

## Resolved
- [#1101] Symptom. Workaround removed 2026-07-21.
```

Issue numbers refer to platform issues where known (Primitive-Labs members); items
without an issue number are fine — the doc is useful even when the issue tracker isn't
accessible.

## Filing Platform Issues

Sometimes the problem is in the platform itself — a bug in js-bao, the client library,
the CLI, or a capability the platform doesn't have — rather than in the user's app.
Platform work is tracked as GitHub issues on `Primitive-Labs/js-bao-wss`.

**Gate: only suggest filing an issue if the signed-in GitHub user is a member of the
Primitive-Labs org.** Check silently before ever raising the option:

```bash
gh api user/memberships/orgs/Primitive-Labs --jq .state 2>/dev/null
```

If this doesn't print `active` (not a member, or `gh` is missing or unauthenticated),
don't mention filing an issue at all — help the user work around the problem instead.

### Tracker hygiene (issues and comments alike)

Everything you write to the tracker — new issues and follow-up comments on existing
ones — is read by an agent pipeline and by maintainers who have none of your session's
context. What you write is all they get, and investigating is the assignee's job —
yours is to state the problem clearly.

- **Brevity and clarity win over verbosity.** Keep the prose to 1000 characters or
  less. Fenced code blocks (repro commands, config, verbatim error output) don't count
  toward the cap — precision there is what makes an issue reproducible. If the prose
  doesn't fit, you're including solution detail or context the assignee can rediscover.
- **Self-contained.** Assume the reader knows nothing about the user's app and has no
  internal knowledge of the platform. Reference related issues by number, but inline
  whatever context is needed to read the issue standalone.
- **Describe the problem, not the solution.** Don't prescribe the fix or assume a
  particular implementation.
- **Don't relitigate decisions rejected in earlier issues** — carry forward the
  discovered tradeoffs, stated neutrally.

### Bugs (an existing platform feature not working as designed)

Body template — fill each section with as much precision as possible, so the issue is
easy to reproduce on the first try:

```
## Repro steps
<numbered, precise steps: exact API calls, config, versions>

## Observed behavior
<what actually happens, with verbatim error text>

## Expected behavior
<what should happen instead>
```

Labels: `type:bug` + `stage:ready-to-implement` when the repro is precise and clearly
reproducible; otherwise `type:bug` + `stage:design`.

### Features / enhancements / platform extensions

```
## Problem
<the application-level problem being solved>

## What I tried
<existing platform features attempted, and why each falls short — omit if none apply>

## Ideas
<high-level directions as bullets, not specs>
```

Labels: `type:feature` + `stage:design`.

### Filing

Use only `type:bug` or `type:feature` (e.g. file performance problems as `type:bug`
with measurements in the repro steps). Search open issues for duplicates first:

```bash
gh issue list --repo Primitive-Labs/js-bao-wss --search "<keywords>" --state open \
  --json number,title
```

Then create the issue with labels only — **no assignee** (triage assigns sponsors;
unassigned is the correct starting state) and no priority labels:

```bash
gh issue create --repo Primitive-Labs/js-bao-wss \
  --title "<one-line symptom or need>" \
  --label "type:bug,stage:design" \
  --body "<template body>"
```

### Follow-up comments on existing issues

When the duplicate search finds an issue that already covers the problem, comment
there instead of filing. A comment is a **delta on the thread, not a fresh report** —
the hygiene rules above (1000-character prose cap, fenced blocks exempt, problem not
solution, self-contained) apply to it unchanged, plus:

- **Lead with what's new**: a repro, a counterexample, a version/deployment where the
  behavior changed, a confirmation that it no longer reproduces. Don't restate what
  the thread already establishes — reference it.
- **Evidence goes in fenced blocks**, exactly as in an issue body: numbered repro
  steps, exact commands and API calls, verbatim errors, versions and app/resource
  ids. Prose interprets the evidence; it must not be the container for it.
- **One comment, one issue's scope.** Evidence that implicates a *different* issue
  belongs in a separate comment on that issue, cross-referenced by number — not
  folded into this one.
- **State facts; leave triage to the maintainers.** Stage, priority, closure, and
  duplicate-of verdicts are theirs. If the evidence points at a next step (re-test
  after X lands, likely duplicate of #N), one closing sentence may say so — never
  more.

### Record the issue in the app

After filing, add an entry to the app's `PRIMITIVE-FEEDBACK.md` (see "The platform feedback doc"
above) under **Open items**: the issue number, a one-line symptom, and — if you built a
workaround in the app — where it lives (`file:line`). This is what lets a future upgrade
find and remove the workaround once the platform fix ships. If a workaround is added
later for an already-filed issue, update the entry then.
