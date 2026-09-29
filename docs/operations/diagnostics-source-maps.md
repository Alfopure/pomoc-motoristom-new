# Private browser error diagnostics

The errors-only Sentry client is off unless `NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN` is present at build time. No Sentry account/project, retention or cost approval has been verified. Do not treat the adapter or an upload exit code as verified technical monitoring.

The adapter sends only allowlisted error classes, same-origin Next compiler chunk coordinates, immutable release and opaque error correlation ID. It discards messages, function names, request details, user data, breadcrumbs, replay, sessions and tracing. Capture works before React hydration, including anonymous login errors; anonymous events never enter the authenticated internal queue and are not buffered for a subsequent login. Without a configured Sentry DSN, anonymous crashes have no durable capture. Sentry has a two-events/minute client cap, fingerprint dedupe and the shared twelve-attempts/minute cap across both transports. There is no server Sentry SDK or automatic server error forwarding.

To prepare private source maps for an exact release:

1. Select the approved Sentry project, region, retention and budget. Keep TEST separate and use a test-only DSN.
2. In private CI, set `DEPLOYMENT_VERSION` to the immutable release (letters/digits/underscore/hyphen, max 64). This same value is compiled as `NEXT_PUBLIC_DIAGNOSTICS_BUILD_ID`.
3. Run `node scripts/diagnostics-source-maps.mjs build`. This invokes the regular repository build with browser source maps enabled, copies maps and matching compiled JS to `.context/diagnostics-source-maps/<release>`, and removes all maps from `.next/static`, including after artifact-copy failure. Deploy only this sanitized `.next` output. Never set `DIAGNOSTICS_PRIVATE_SOURCE_MAPS` on a normal Vercel build.
4. Retain that artifact privately. A separate CI step with an explicitly installed/pinned `sentry-cli`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, and the identical release runs `node scripts/diagnostics-source-maps.mjs upload`. `SENTRY_CLI_PATH` can select the installed executable. Never pass the token to client configuration. Upload failure is visible and does not contact the internal diagnostic ingest or change business operations.
5. Trigger a synthetic canary crash in the authorized TEST deployment. Confirm the Sentry event uses this release and resolves to the exact source file/line. Check the internal event carries the same opaque error ID. Inspect the outbound payload for PII canaries. Check a known `.map` URL returns 404 and no map is shipped in deployment static artifacts.

Production activation remains blocked until the source map check, bundle/network budget and account configuration are verified. Default `pnpm build` neither creates public source maps nor uploads anything. A fresh Vercel source build will regenerate artifacts, so an external prebuilt release pipeline must preserve the identical compiled output; preparing local maps and deploying a different rebuild does not satisfy the gate.

Sentry references: [Custom browser client](https://docs.sentry.io/platforms/javascript/configuration/tree-shaking/), [CLI source maps](https://docs.sentry.io/cli/sourcemaps/uploading/).
