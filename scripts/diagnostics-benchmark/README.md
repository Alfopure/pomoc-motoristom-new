# Local browser diagnostics benchmark

From the repository root:

```sh
node scripts/diagnostics-benchmark/run.mjs
node scripts/diagnostics-benchmark/summarize.mjs
node scripts/diagnostics-benchmark/sentry-wire.mjs
```

Requires installed repository dependencies and Chrome at `/usr/bin/google-chrome`. The scripts start a localhost fixture server; all operation and diagnostic responses are synthetic. The Sentry check overrides its DSN with a local fake ingest. It does not contact Supabase, Telnyx, a real Sentry account or any production service.

Raw output and summaries go to `.context/ralph-monitor/performance/`. `run.mjs --load-only` reuses the existing latency runs and refreshes accelerated load/heap results; it requires a completed earlier full run. Full runs use three alternating OFF/ON cycles, 100 warmups and 500 measured requests for save/pickup/hangup per cycle. The business path uses the real `diagnosticJson` helper around a mock fetch; it does not execute DispatchConsole state transitions, the telephony request adapter, database writes or WebRTC audio.

Playwright's clock is shared by every page in a context. The load phase pauses it and advances it once per context, measuring attempts by sliding 60-second windows. The healthy phase simulates eight hours at one explicit operation/minute; virtual time does not establish an eight-hour memory-leak or real-network guarantee.

`summary.json` reports bootstrap intervals (2,000 resamples stratified by cycle). Shared-host timing can be noisy. These tests support local regression review; they do not replace hosted TEST, live-audio, exact-release source-map or bundle acceptance gates.
