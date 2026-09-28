---
name: primitive-platform
description: >
  Fetches the Primitive platform's agent guides and applies them. MUST be used whenever the user
  is writing or reviewing code that uses js-bao, js-bao-wss-client, primitive-app,
  primitive-functions, or any Primitive platform feature (documents, databases, server functions,
  prompts, integrations, blobs, authentication, users/groups), and before running any `primitive`
  CLI command. All development guidance lives in the guides this skill fetches; after writing or
  modifying code that touches Primitive APIs, it cross-references the code against those guides
  and corrects mistakes. Use this skill even if the user doesn't explicitly ask for it. Also use it
  when something looks like a platform bug or missing platform capability, to record the platform
  feedback in the app's PRIMITIVE-FEEDBACK.md. Also trigger whenever the user wants to upgrade or
  update the app to a newer platform version — bumping js-bao, js-bao-wss-client, primitive-app, or
  the primitive CLI — which follows the "Upgrading Platform Libraries" workflow below.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Agent
---

# Primitive Platform

Everything about how to build on Primitive — APIs, configuration, the CLI, patterns and
pitfalls — lives in the **agent guides** the `primitive` CLI serves. This skill tells you how to
get the right guides and when to read them. It deliberately teaches nothing about the platform
itself: never write Primitive code, answer a Primitive question, or run a Primitive command from
memory or from this file. Fetch the guide.

## Getting the guides

`primitive guides` works anywhere, inside a Primitive project or not.

```bash
primitive guides list                  # every topic: description, keywords, use cases, variants
primitive guides get <topic> --language <ts|swift> --platform <web|ios|macos>
primitive guides get <topic>           # the topic's default variant
```

- **Which topics.** Read the `list` output and fetch every guide whose topic the task touches.
  A feature usually spans several (a server function that writes a database and runs a prompt
  needs all three guides). Fetch them BEFORE writing code.
- **Which variant.** Pass the project's language and platform. A `Package.swift`,
  `*.xcodeproj`, or `project.yml` means `--language swift` with `--platform ios` or `macos`; a
  web app with `package.json` and `js-bao-wss-client` means `--language ts --platform web`. The
  `COMBINATIONS` column of `list` shows what each guide offers. The flags never fail: an unknown
  value or unavailable combination falls back to the default variant, so pass your best guess,
  or omit them when you can't tell. `--language` accepts `typescript`/`javascript`/`js` for `ts`.
- **Which channel.** Outside a project the CLI serves the production guides. Inside a project it
  serves the guides matching the server the project's current environment points at, so an app
  on the alpha environment reads the alpha guides. The version follows the installed
  `js-bao-wss-client`.
- **Freshness.** Guides are cached under `~/.primitive/guides/` for 24 hours. After upgrading the
  CLI or the libraries, pass `--refresh` on the first `list` and `get`.
- **Where to start.** `configuration` covers projects, environments, and pushing config;
  `data-modeling` covers choosing where data lives; `inspecting-and-debugging` covers reading a
  running app. For a CLI command you have not used, fetch the guide for its feature first.

## Writing code

1. Fetch the guides for every feature the change touches.
2. Follow them exactly: method names, argument order, lifecycle, configuration shapes, and the
   follow-up steps they name (codegen, pushing config, typechecking).
3. Never guess an API. If the guide you have does not answer the question, fetch the related
   guides it links before inventing anything. If none does, it is a platform gap: see "The
   platform feedback doc" below.
4. Before running a `primitive` command that changes server state, read the `Env | App | Server`
   header every command prints and confirm it names the environment you intend. The
   `configuration` guide explains projects and environments.

## Reviewing code (automatic, after every change)

After writing or modifying code that touches Primitive, review it without being asked:

1. **Identify the features touched.** Imports from `js-bao`, `js-bao-wss-client`,
   `primitive-app`, or `primitive-functions`; files in the project's configuration tree; model
   definitions and schemas.
2. **Fetch those guides** in the project's language and platform.
3. **Compare the code against them.** API usage, lifecycle, access and authorization, anything
   the guide warns against, and any follow-up step the guide requires that the change skipped.
4. **Fix what's wrong.** Cite the guide section, edit the file (don't just suggest), and name any
   command the user still needs to run. If nothing is wrong, say so briefly.

## When the user is starting a new feature

1. Run `primitive guides list` and pick every relevant topic.
2. Fetch those guides in the project's language and platform.
3. Recommend a data model from the guides. If requirements are ambiguous, ask clarifying
   questions first: a data model is much easier to get right up front than to migrate.
4. Outline the implementation, citing the guide patterns it follows.
5. Write the code, then review it as above.

## When the user asks "How do I…?"

1. Find the topic with `primitive guides list`, then fetch it.
2. Answer from the guide, with its examples. Don't guess or invent APIs.
3. Point the user at the guide for more: `primitive guides get <topic>`.

## When the user is moving an app's data to another app

Fetch the `documents` guide and follow its export/import sections. A migration is two
exports into one directory and two imports out of it, in a fixed order — the documents
bundle, then the collections those documents sit in — and the guide has the commands, the
order they must run in, and what does not travel. Don't run a single export or import from
memory: the wrong order silently loses every collection's document membership.

## Upgrading Platform Libraries

When the user asks to upgrade the app to a newer platform version, follow this workflow.
An upgrade is not just a version bump: after the libraries move, workarounds built for old
platform bugs should come out, the starter template the app was scaffolded from has usually
moved too, and new platform capabilities should be considered. The refreshed guides are the
source of truth for what the platform can do now.

The backend is upgraded by the platform team, not by the app — the app only chooses which
environment it points at (see the `configuration` guide). A library upgrade against the production environment
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

### 6. Adopt template updates

The app was scaffolded by `primitive init` from a starter template —
`Primitive-Labs/primitive-vue-template` for web apps, `Primitive-Labs/primitive-swift-template`
for iOS. Those templates keep moving with the platform: config, setup, and wiring fixes
land there and never reach an app generated months earlier. Scan the template the app came
from (both, if the app has a web and an iOS client) and pull forward what applies. Fetch
the branch matching the channel you're upgrading to — `main` for production, `alpha` for
alpha:

```bash
# Vue
curl -sL https://github.com/Primitive-Labs/primitive-vue-template/archive/refs/heads/main.tar.gz \
  | tar -xz -C /tmp
# Swift
gh api repos/Primitive-Labs/primitive-swift-template/tarball/main > /tmp/swift-template.tgz
```

Then compare the template against the app file by file:

- **The app never changed it → move it over.** Where the app still carries the template's
  version unchanged, take the newer one. That includes files the template has added since
  the app was scaffolded. No need to ask.
- **The app removed it → leave it removed.** A file or block the app deleted was deleted
  on purpose. Never restore it.
- **Both changed it → ask.** Where the app has its own edits to something the template
  also changed, don't overwrite. Say what the template's change does and why it landed,
  then ask whether to merge it in. Ask once per coherent change, not per hunk.

Telling those three cases apart needs a baseline: the template commit the app last synced
from, recorded in the feedback doc (below). With it, diff baseline→template to see what
the template changed and baseline→app to see what the app changed; only files in both
sets need a question. Without a stamp you can't tell an app edit from a template edit, so
treat every differing file as "ask" — and record the stamp this time.

### 7. Adopt and suggest new features

Re-run `primitive guides list` (topics appear and grow over time) and skim the refreshed
guides for the app's feature areas. Compare against what the app actually does:

- Where a new platform capability clearly replaces app-level code (less code, same
  behavior), adopt it as part of the upgrade.
- Where a capability opens something new but needs a product decision, don't build it —
  report it as a suggestion with a pointer to the relevant guide section.

### 8. Verify and stamp

Run the app's tests, apply the post-change review above to everything modified, and
update the feedback doc's upgrade stamp (date, channel, versions, and the template
commit synced in Step 6).

### The platform feedback doc

Convention: a `PRIMITIVE-FEEDBACK.md` at the app root tracks the app's relationship to the
platform — when it was last upgraded, which workarounds exist for platform problems, and
what the app found missing or broken. This is what makes upgrades mechanical instead of
archaeological, and it is also how platform feedback reaches the platform team: **the
platform team reads this document. No issue is filed from an app.** If the app doesn't
have one, create it the first time there is something to record:

```markdown
# Platform Feedback

## Upgrade stamp
- Last upgraded: 2026-07-21
- Channel: production
- Versions: js-bao-wss-client 2.0.6, primitive-app 3.0.5, js-bao 0.5.1, primitive-admin 1.0.55
- Template: primitive-vue-template @ main 0f1c2d3

## Open items
- Symptom or missing capability. Evidence: `POST /app/x/api/databases` returns 500
  (error text below). Workaround: `src/lib/foo.ts:42` (retry loop). Remove when: the
  create returns 201 on the first call.

## Resolved
- Symptom. Workaround removed 2026-07-21.
```

**When something looks like a platform problem** — a bug in js-bao, the client library,
the CLI, or a capability the platform doesn't have — rather than a problem in the user's
app, write it into this document under **Open items**. That is the whole of what to do
with it; help the user work around the problem in the app, and record:

- **The symptom**: one line, what goes wrong or what is missing.
- **The evidence**: the exact call, config, or command and the verbatim error or
  response, in a fenced block if it is more than a line. Precision here is what lets the
  platform team reproduce it.
- **The workaround location**: `file:line` of the code the app carries because of it.
- **The condition for removing the workaround**: the observable platform behavior that
  means the workaround can come out. A later upgrade re-tests exactly this (Step 5).

Entries sometimes carry a platform issue number (Primitive-Labs members add them); items
without one are just as useful — the document is the feedback channel, not the tracker.
