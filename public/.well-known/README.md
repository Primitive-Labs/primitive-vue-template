# Serving `apple-app-site-association` (AASA)

This file is how Apple learns that your iOS app owns this web domain. One
document at one path powers two independent features — keep the section you
use:

- **`applinks`** → **universal links**: an `https://` URL on this domain opens
  the installed iOS app instead of the browser. This is what makes ONE emailed
  sign-in link work everywhere ([#2982]): tapped on a device with the app, it
  opens the app; anywhere else — another device, the Simulator, a desktop
  browser — it is this web app's normal sign-in page.
- **`webcredentials`** → native **passkey** sign-in / registration ([#929]).

The shipped `apple-app-site-association.example` is **not** served: Apple
requires the exact path with no file extension, so nothing is live until you
rename it. Work through the steps IN ORDER — step 4 is what makes Apple fetch
the document, and Apple's CDN caches what it gets.

## 1. Fill in your IDs and rename the file

Replace every `TEAMID.BUNDLEID` with `<your Apple Team ID>.<your bundle id>`
(the iOS client's `PRODUCT_BUNDLE_IDENTIFIER`), delete the section you do not
use, then:

```bash
mv public/.well-known/apple-app-site-association.example \
   public/.well-known/apple-app-site-association
```

The `applinks` component must name the path this app actually serves the
sign-in callback on. It ships as `/oauth/callback`, matching
`DEFAULT_OAUTH_CALLBACK_PATH` in `src/config/envConfig.ts`; if you point
`VITE_OAUTH_REDIRECT_URI` somewhere else, move the component with it (and the
iOS side's `emailSignInWebCallbackPath` too) — the three name one URL.

**Keep the `"?": { "magic_token": "*" }` constraint.** The same
`/oauth/callback` path is where Google's OAuth redirect lands, with a `?code=`
query. A path-only claim would hand those redirects to the iOS app, which has
no page to render them; the query constraint claims only the emailed sign-in
link.

## 2. Deploy

```bash
pnpm cf-deploy --deploy-env production --primitive-env <name>
```

`public/_headers` ships the `Content-Type: application/json` rule for this
exact path, which is what keeps an extensionless asset from being served as
`text/plain`.

## 3. Verify what the domain actually serves

```bash
curl -i https://<your-domain>/.well-known/apple-app-site-association
# want: 200, content-type: application/json, no redirect, the JSON body
```

If you get HTML back, the rename or the deploy did not take: this app's
`wrangler.toml` sets `not_found_handling = "single-page-application"`, so a
path that is not a real asset answers with `index.html`. Fix that before the
next step — an entitlement pointed at an HTML "AASA document" fails
association, and the bad response can be cached.

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
then `primitive config push --only app`. Set the same origin as the Primitive
environment's `webUrl` so the iOS app sends that target: add
`"webUrl": "https://<your-domain>"` to that environment in
`.primitive/config.json`. (`primitive env add` takes `--web-url`, but it
creates an environment — it cannot edit one that already exists.)

[#929]: https://github.com/Primitive-Labs/js-bao-wss/issues/929
[#2982]: https://github.com/Primitive-Labs/js-bao-wss/issues/2982
