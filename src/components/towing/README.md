The office and driver screens use only the towing DTOs and `client.ts` adapter. Server pages verify the feature flag and towing membership before rendering. The driver screen never loads the dispatch repository or telephony.

Inputs save explicitly. Command identifiers remain stable after an unconfirmed reply; a matching server acknowledgement clears the attempt. Payments, corrections, handovers and document versions get fresh identifiers only after a confirmed operation. Conflicts preserve edited order fields and require a deliberate comparison before saving against a newer revision. Provider acceptance is displayed only for the explicit `accepted` delivery state.

Run the synthetic browser harnesses after the normal production build, which supplies the actual CSS for the offline layout test:

```sh
pnpm exec playwright test --config playwright.towing.config.ts
```

In a VM with an existing Chromium binary:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/tmp/chromium pnpm exec playwright test --config playwright.towing.config.ts
```

The eight cases use synthetic contacts, a mocked session and mocked HTTP endpoints. The offline case uses real browser IndexedDB, reloads pending work, and confirms foreground synchronization order. Screenshots and runner artifacts go under `.context`. They establish desktop Chromium behavior at a 360px viewport, not physical Android or iPhone PWA acceptance, live TEST integration, or deployment readiness.
