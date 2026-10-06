# Call controls and event recovery — 6 October 2026

The owner clarified the reported delay as **button response / call connection**,
not delayed speech during an established conversation. The pre-fix TEST call
at 19:48–19:50 UTC returned successful control responses, but server processing
took 3.37 s for HOLD, 3.43 s for UNHOLD, 4.98 s for PARK and 2.79 s for pickup.
Request observations showed repeated database work without database aborts.
Overlapping database/provider spans must not be added together as wall time.

## Changes

- Reuse a positive, immutable TEST call-origin proof within one exact fenced
  ownership object, admin client, organization and provider configuration.
  Later actions prove ownership again; missing/failed proofs are not cached.
  Device enrollment, credentials, recording privacy and provider dispatch fences
  retain their checks. Independent local call proofs can run concurrently.
- Use the immediately preceding fresh session row for the contract-2 recording
  privacy check only when no asynchronous boundary intervenes. A provider call,
  checkpoint or legacy lease renewal prevents that reuse.
- Acknowledge credential-side browser callbacks only when an accepted API dial,
  exact saved operator leg, enrolled SIP identity, environment, caller and provider
  session independently establish their origin. They do not become application
  legs and do not issue provider commands. Provider-session identity alone remains
  insufficient. The existing retained owner-completion drain also handles callbacks
  that arrive before their dial result and leg are persisted.
- Recover a customer's exact early hangup after a failed inbound owner releases
  its lease. This includes the legitimate caller-cancel-before-answer ordering.
  Foreign identities, competing claims and the existing 60-second expiration
  remain enforced; historical dead letters are not revived.
- Record completion of the single existing cron in one service-only row and
  optionally require its fresh successful completion at `/api/health/ready`.
  See [monitoring configuration](monitoring-release-20261006.md). No SQL migration,
  additional scheduler, listener or worker is required by these new fixes.

## Verification and release boundary

Regression coverage reproduces the observed event ordering, all four mirrored
browser lifecycle events, exhausted fast provider retries, foreign and ambiguous
proofs, concurrent ownership, recording transitions and stale cron completion.
Local PostgreSQL/PostgREST tests exercise actual claim and fencing behavior.

The control harness measures fewer database requests with identical provider
operations and recording order. It does **not** establish the improvement in
live seconds. A new live TEST call must confirm incoming/outgoing connection,
HOLD/resume, park/pickup, transfer, hangup and the resulting recording. Capture
the test time so server timings and any alerts can be matched to that call.

The TEST and production alerts during the earlier trial had separate causes:
unmatched browser mirror callbacks on TEST, and a 560 ms caller cancellation
whose early hangup was not drained on production. Those failures are distinct
from Sentry's previously measured delayed missing-check-in detection.

Production release remains a separate owner-approved operation. The production
package also contains the earlier security, polling and monitoring changes and
three separately authorized production SQL candidates; this fix does not apply
them. Do not deploy an old Vercel build or bulk-apply pending migrations.
