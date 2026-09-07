# Serving `apple-app-site-association` (AASA)

This file is how Apple learns that your iOS app owns this web domain. One
document at one path powers two independent features:

- **`applinks`** → **universal links**: an `https://` URL on this domain opens
  the installed iOS app instead of the browser. This is what makes ONE emailed
  sign-in link work everywhere ([#2982]): tapped on a device with the app, it
  opens the app; anywhere else — another device, the Simulator, a desktop
  browser — it is this web app's normal sign-in page.
- **`webcredentials`** → native **passkey** sign-in / registration ([#929]).

**You do not write this document — `pnpm cf-deploy` does** ([#3081]). The app id
belongs to an environment, not to the repository: an app with alpha and
production has one bundle id each, and one committed file could only ever be
right for one of them. Worse, a document naming the wrong app PARSES, so Apple
accepts it, caches it, and universal links and passkeys then fail with the
system sheet saying only that the app is not associated with the domain.

So the identifier is declared once per Primitive environment, and every deploy
writes the document for the environment it is deploying.
`apple-app-site-association.example` beside this file is a reference copy of
what gets generated; it is never served.

Work through the steps IN ORDER — step 4 is what makes Apple fetch the
document, and Apple's CDN caches what it gets.

## 1. Declare the iOS app id on the environment

Add `iosAppId` beside that environment's `webUrl` in `.primitive/config.json`:

```json
{
  "environments": {
    "prod": {
      "apiUrl": "https://api.primitiveapi.com",
      "appId": "app_…",
      "webUrl": "https://app.example.com",
      "iosAppId": "ABCDE12345.com.example.app"
    }
  }
}
```

The two go together: `webUrl` is where the web app lives, `iosAppId` is the
phone app that origin vouches for. An `iosAppId` without a `webUrl` is refused,
and so is a `webUrl` the CLI would not have stored — it must be a bare origin
(https, or http on `localhost`/`127.0.0.1`) with no path, query, fragment or
credentials, because that is the origin the document is served from and the
emailed sign-in link is built on.

The value is Apple's `<Application Identifier Prefix>.<bundle id>`:

- the **Application Identifier Prefix** is 10 characters and is *usually* your
  Team ID — a legacy app's can differ, so verify it against the signed app's
  `application-identifier` entitlement rather than assuming;
- the bundle id is the iOS client's `PRODUCT_BUNDLE_IDENTIFIER` for THIS
  environment (the Swift template keeps it in `Config/<env>.xcconfig`, which is
  why it can differ per environment in the first place).

When you are creating a new environment, `primitive env add` takes both flags:

```bash
primitive env add prod --api-url https://api.primitiveapi.com --app-id <app-id> \
  --web-url https://app.example.com --ios-app-id ABCDE12345.com.example.app
```

`env add` creates an environment; for one that already exists, edit
`.primitive/config.json`.

An environment with **no** `iosAppId` serves no association document at all —
that is the correct state for a web-only environment, and better than serving
another environment's app id.

## 2. Deploy

```bash
pnpm cf-deploy --deploy-env production --primitive-env prod
```

Before the build, the deploy writes
`public/.well-known/apple-app-site-association` naming that environment's
`iosAppId`, with the component comment recording that `scripts/deploy.mjs`
generated it and from which environment. The file is gitignored — it is a
build input regenerated per deploy, not source. Add `--check` to print the
planned action without writing anything.

The `applinks` component claims exactly the path this app serves the sign-in
callback on, `/oauth/callback` (`DEFAULT_OAUTH_CALLBACK_PATH` in
`src/config/envConfig.ts`). If `VITE_OAUTH_REDIRECT_URI` points somewhere else,
the deploy stops and says so — the document, the web route and the iOS side's
`emailSignInWebCallbackPath` name one URL, and a mismatch is a link that opens
in the browser with nothing to read.

The generated document keeps the `"?": { "magic_token": "*" }` constraint. The
same `/oauth/callback` path is where Google's OAuth redirect lands, with a
`?code=` query; a path-only claim would hand those redirects to the iOS app,
which has no page to render them.

`public/_headers` ships the `Content-Type: application/json` rule for this exact
path, which is what keeps an extensionless asset from being served as
`text/plain`.

## 3. Verify what the domain actually serves

```bash
curl -i https://<your-domain>/.well-known/apple-app-site-association
# want: 200, content-type: application/json, no redirect, the JSON body
```

Read the `comment` in the returned document: it names the Primitive environment
whose deploy wrote it. If that is not the environment you expect, this domain
was last deployed from another one.

If you get HTML back, the deploy did not take: this app's `wrangler.toml` sets
`not_found_handling = "single-page-application"`, so a path that is not a real
asset answers with `index.html`. Fix that before the next step — an entitlement
pointed at an HTML "AASA document" fails association, and the bad response can
be cached.

## 4. Only now, enable the entitlement

In the iOS client's `project.yml`, uncomment the associated-domains block and
name this domain:

```yaml
com.apple.developer.associated-domains:
  - applinks:<your-domain>
  # - webcredentials:<your-domain>   # passkeys, same file
```

It needs a real `DEVELOPMENT_TEAM` — an associated domain is checked against
the app's team and bundle id. Regenerate the Xcode project (`./run-ios.sh`),
rebuild, and reinstall the app: iOS fetches the association at install time.

## 5. Allow-list the link target

The sign-in link is a redirect target like any other, so it has to be in the
app's allow-list or the request is refused with 400 `Invalid redirect URI`:
merge `https://<your-domain>/oauth/callback` into the existing
`[auth].emailRedirectUris` array in `config/app.toml` (run
`primitive config pull --only app` first if you do not have that file yet),
then `primitive config push --only app`.

## Writing the document by hand

If your app needs a document this generator cannot produce — several appIDs, an
`appclips` section, a callback on a fixed host that is not the environment's
`webUrl` — take ownership explicitly:

1. remove the generated path from `.gitignore` — while it is ignored, `git add`
   skips your document without saying so;
2. write `public/.well-known/apple-app-site-association` yourself;
3. create `public/.well-known/apple-app-site-association.hand-authored` beside
   it (any short note as content; only its existence matters), and commit BOTH
   files — a sentinel that reaches CI or a fresh clone on its own is a deploy
   that succeeds and serves no association document at all.

With that sentinel present, the deploy leaves your document byte-identical and
never generates over it. Without it, a document this script did not write is a
hard error before the build rather than a file shipped blind — a leftover from
the old rename-the-example flow names ONE environment's app, and shipping it
from another environment is the exact silent failure this generator exists to
prevent. If an environment also declares `iosAppId`, that is two owners for one
file and the deploy stops: pick one.

[#929]: https://github.com/Primitive-Labs/js-bao-wss/issues/929
[#2982]: https://github.com/Primitive-Labs/js-bao-wss/issues/2982
[#3081]: https://github.com/Primitive-Labs/js-bao-wss/issues/3081
