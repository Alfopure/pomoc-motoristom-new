# Recorded call controls — 7 October 2026

The owner reported slow button responses on TEST, not continuous voice delay.
Two recorded incoming calls on `2b66e4ef43a6251840fb62356e84d1b484221e7b`
showed server HOLD/UNHOLD/PARK durations of 3.00–5.14 seconds. Matched browser
durations added 54–93 ms. Database waiting varied substantially between actions.
The sampled production calls used an unrecorded bridge, so their faster times
are not a comparison of the same recording workflow.

## Change

- Read participant identity, legs and open intervals concurrently. Group equal
  interval updates in batches of at most 100 IDs; run at most four writes at a
  time, and drain every started request before returning. Complete closes before
  opening the next epoch. Keep inserts separate so one duplicate cannot discard
  another participant's evidence.
- Reuse only a positive call identity within the same contract-2 execution,
  database client, organization and session. Every recording START still runs
  fresh admission authorization.
- Read the current history projection and skip an UPDATE only when all computed
  fields already match. Session heartbeat, lease and recovery writes remain.
- Reuse the immediately returned successful command checkpoint for the next
  command's validity checks once, under the same owner and without an intervening
  await. Privacy checks and provider-journal termination fencing remain.
- Combine only the final idempotent history projection cursor with the awaited
  audit/final checkpoint. An interrupted save replays projection and the unique
  audit; concurrent obligations and incomplete audit work are retained.

Recording STOP/START acknowledgements, admission and the 600 ms START settle
remain. There is no new SQL, worker, scheduler, provider operation or background
continuation after the response.

## Reproducible local evidence

The existing recorded-call fixture retains identical provider commands and
STOP-before-HOLD / START-before-UNHOLD assertions.

| Action | Database requests before → after | Dependent request waves before → after |
| --- | ---: | ---: |
| HOLD | 59 → 53 | 47 → 39 |
| UNHOLD | 46 → 43 | 38 → 34 |
| PARK | 80 → 71 | 66 → 55 |

Three runs per version with an artificial 25 ms delay per database request gave
median elapsed reductions of 17.0%, 10.4% and 16.5%, respectively. Provider HTTP
was mocked and recorder settling used the harness clock. These are controlled
round-trip measurements, not a prediction of hosted seconds or live audio.

## Verify on stable TEST

Use `https://test.dispecing.linkapomoci.sk`, record the deployed commit from
`/api/health/live` and the time of a fresh recorded call. Repeat HOLD/UNHOLD and
PARK/pickup, then check the recording and terminal state. Compare matched browser
and server action timings; health and build success do not establish live audio.

`request-performance.steps` now includes bounded `control.staging`,
`control.recording.admission`, `control.recording.ack`, `control.participants`,
`control.projection`, `control.audit` and `control.finalize` aggregates with
`count`, `ms`, `dbCount` and `dbMs`. Recording acknowledgement measures its normal
successful acknowledgement path; exception recovery still appears in total DB
metrics. Stage durations also appear in Server-Timing. Overlapping request/DB
durations must not be summed or subtracted to infer server CPU or database load.
No customer payloads or extra network requests are added by these measurements.

Hosted performance acceptance remains dependent on that fresh live TEST call.
