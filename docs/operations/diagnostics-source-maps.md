# Private browser error diagnostics

The errors-only Sentry client is off unless `NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN` is present at build time. No Sentry account/project, retention or cost approval has been verified. Do not treat the adapter or an upload exit code as verified technical monitoring.

The adapter sends only allowlisted error classes, same-origin Next compiler chunk coordinates, immutable release and opaque error correlation ID. It discards messages, function names, request details, user data, breadcrumbs, replay, sessions and tracing. Capture works before React hydration, including anonymous login errors; anonymous events never enter the authenticated internal queue and are not buffered for a subsequent login. Without a configured Sentry DSN, anonymous crashes have no durable capture. Sentry has a two-events/minute client cap, fingerprint dedupe and the shared twelve-attempts/minute cap across both transports. There is no server Sentry SDK or automatic server error forwarding.

To prepare private source maps for an exact release:

1. Select the approved Sentry project, region, retention and budget. Keep TEST separate and use a test-only DSN.
2. In private CI, set `DEPLOYMENT_VERSION` to the immutable release (letters/digits/underscore/hyphen, max 64). This same value is compiled as `NEXT_PUBLIC_DIAGNOSTICS_BUILD_ID`.
3. Run `node scripts/diagnostics-source-maps.mjs build`. This invokes the regular repository build with browser source maps enabled, copies maps and matching compiled JS to `.context/diagnostics-source-maps/<release>`, and removes all maps from `.next/static`, including after artifact-copy failure. Deploy only this sanitized `.next` output. Never set `DIAGNOSTICS_PRIVATE_SOURCE_MAPS` on a normal Vercel build.
4. Retain that artifact privately. A separate CI step with the pinned `@sentry/cli` development dependency, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, and the identical release runs `node scripts/diagnostics-source-maps.mjs upload`. `SENTRY_CLI_PATH` can select the installed executable. Never pass the token to client configuration. Upload failure is visible and does not contact the internal diagnostic ingest or change business operations.
5. Trigger a synthetic canary crash in the authorized TEST deployment. Confirm the Sentry event uses this release and resolves to the exact source file/line. Check the internal event carries the same opaque error ID. Inspect the outbound payload for PII canaries. Check a known `.map` URL returns 404 and no map is shipped in deployment static artifacts.

## Same-build Vercel source deployment

The checked-in Vercel build gate still runs Vitest and typecheck, then calls `scripts/diagnostics-vercel-build.mjs`. Without a DSN or upload flag it runs the ordinary `pnpm build`. It rejects a DSN without the managed upload flag, and rejects directly setting `DIAGNOSTICS_PRIVATE_SOURCE_MAPS` on this ordinary path.

For an approved Sentry project, configure only the authorized Vercel target with `DIAGNOSTICS_SENTRY_UPLOAD=1`, its `NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`. The lockfile installs the exact `@sentry/cli` development dependency (3.8.0); the wrapper uses `node_modules/.bin/sentry-cli`. An optional `SENTRY_CLI_PATH` override must report that same pinned version. These scripts do not download an unpinned executable. The token is removed from the Next build subprocess environment and retained only for the upload subprocess; never prefix it with `NEXT_PUBLIC_`. Prefer the immutable `VERCEL_GIT_COMMIT_SHA` release; if explicitly setting `DEPLOYMENT_VERSION`, it must identify the exact release.

The wrapper generates maps in the cloud source build, copies maps plus their matching JS into a private artifact, removes maps from `.next/static`, then uploads before Vercel packages that same `.next` output. Artifact hashes, a successful matching-release manifest, and matching deployed JS are required for upload. A build retry clears stale private artifacts. Build failure still removes generated maps; upload failure stops this deployment while the previous deployment continues serving. The application runtime never waits for Sentry. Do not set the private-map flag globally, run a second `next build` after upload, publish `.context` as static output, or add source-map artifacts to Git.

Keep TEST DSN/project separate. Introduce the code through work branch → reviewed Preview → dev/stable TEST, verify a mapped TEST canary and private `.map` 404, then release dev → main and freshly build production with its separately approved project settings. A restricted ordinary Preview must not inherit production Sentry credentials. CLI configuration and account settings remain prerequisites; merging this wrapper does not activate Sentry.

The manual client deliberately removes `debug_meta`; retain release/URL matching (`~/_next/static`) for this upload path. Do not switch to debug-ID-only mapping without a reviewed privacy-preserving client change and another real mapped-stack check.

Production activation remains blocked until the source map check, bundle/network budget and account configuration are verified. Default `pnpm build` neither creates public source maps nor uploads anything. A fresh Vercel source build will regenerate artifacts, so an external prebuilt release pipeline must preserve the identical compiled output; preparing local maps and deploying a different rebuild does not satisfy the gate.

Sentry references: [Custom browser client](https://docs.sentry.io/platforms/javascript/configuration/tree-shaking/), [CLI source maps](https://docs.sentry.io/cli/sourcemaps/uploading/).

Build configuration references: [Vercel build command](https://vercel.com/docs/builds/configure-a-build), [Vercel prebuilt caveats](https://vercel.com/docs/cli/deploy), [Sentry mapping verification](https://docs.sentry.io/platforms/javascript/guides/hono/sourcemaps/troubleshooting_js/).
