# Call latency repair — where we are

Running status of the repair described in `plan/call-latency-repair-2026-09-16`
(`docs/plans/call-latency-2026-09-16/plan-v5.md`). Updated as stages land, so a
session that starts cold can see what is done, what is measured and what is
deliberately left.

Last updated: 17 Sep 2026.

## Measured on the contract-2 harness

Database requests per action, on the path production runs (contract 2:
generation leases and the fenced provider journal).

| action | before 17 Sep | now |
| --- | --- | --- |
| inbound answer | 64 | 53 |
| hold | 40 | 38 |
| unhold | 36 | 34 |
| blind transfer | 47 | 43 |
| hangup | 39 | 32 |

`src/server/telephony/state/contract-two-command-cost.test.ts` holds these as
bounds, with one request of headroom for the throttled incident read.

## Measured on production calls

| | before | after |
| --- | --- | --- |
| webhook deliveries per event | 5.3x | 3.7x |
| webhook processing lag, median | 271 s | 8 s |
| webhook processing lag, p90 | 677 s | 12-306 s (load dependent) |
| failed webhooks, heaviest call | 23 of 55 | 0 of 440 |
| `bridge` dispatched after | ~40 requests | **19 requests** |
| answer to bridge | 4.4-7.0 s | 2.7 s |
| handler p95 | ~11 s | 6.9-8.8 s |

Per-action handler medians from the 17 Sep client test: blind transfer 10.1 s,
complete transfer 7.2 s, hangup 7.0 s, pickup 6.8 s, consult 6.5 s, add party
5.6 s, hold 4.9 s.

Cost of one database request, from production `request-performance`: **~95 ms**
(the plan assumed 150-250 ms).

## Done

| stage | state |
| --- | --- |
| **E0** cron and firewall | hotfix, then the allowlist inverted to a denylist of the 291 pre-boundary deployments. A release no longer needs a manual edit. Runbook carries the post-deploy gate. |
| **E1a.2** bridge first | done |
| **E1a.3** read deduplication | (a) (b) (c) (e) (f) done; **(d) only for `hangup`** |
| **E1a.4** organisation cache | done — `call.active` poll 8 requests to 7, confirmed on live traffic |
| **E1a.5** instrumentation | `db_count_at_dispatch` in the command audit; failed commands now record their error |
| **E1a.6** one checkpoint per critical batch | done, critical phase only |
| **E1b-1** low-risk concurrency | both points: parallel teardown, overlapping best-effort provider calls |
| **E1c** bounded webhook lease wait | done — 1200 ms, backoff 150/300/600 |

Outside the plan, from what the testing turned up:

- `webhook_timeout_secs` on the Telnyx application raised 10 to 30
- the waiting music a blind transfer starts is now stopped before the caller is
  bridged in (it never was, and a failed transfer stacked a second loop)
- a transferred operator gets its own audio confirmation window, so a late
  `call.bridged` no longer greys out the whole phone bar
- the device heartbeat reports whether the browser has a remote stream and
  whether it refused to play it
- a colleague whose browser phone is gone reads `Nepripojený · 20 min` instead
  of a green `Dostupný`, in the picker and the roster alike

## Not done

| stage | why it is still open |
| --- | --- |
| **E0** permanent | done as the denylist; nothing left |
| **E1a.1** lean context | not started. Last item of E1a |
| **E1a.3(d)** in full | needs the harness to drive the provider journal: the wider version maps a fenced PT409 refusal onto the superseded path, and that branch is unreachable in every test we have |
| **E1b-1.2** group checkpoint | same reason. One checkpoint per overlapping group instead of one per command |
| **E1m** measurement | partly: cost per request and `db_count_at_dispatch` are in place; the 30-sample SQL A-J distributions are not |
| **E1b-2** | superseded by E2 if E2 is approved |
| **E2** migrations | not started. The step change: bridge chain to 5-6 requests, fanout to 6 + N |
| **E3** controls, mobile, transfer | not started. Includes making a colleague's mobile reachable at all |
| **E4** polling and auth | not started |
| **E5** measurement rounds | not started |

## Known gaps that are not in the plan

Found during testing on 17 Sep; none of them is a latency problem and the plan
does not address any of them.

1. **The harness cannot drive the provider journal.** The fake provider client
   never calls `prepareProviderRequest`, so `prepare_v2` / `result_v2` and every
   branch that depends on them are unreachable in tests. This blocks E1a.3(d),
   E1b-1.2 and all of E2.3. It should be closed before E2 is written.
2. **Capacity is invisible.** Three simultaneous callers met one reachable
   operator; two waited seven and eight minutes. The ring plan behaved
   correctly. What is missing is that "ring exhausted" is reported both when
   everybody declined and when there was nobody to ring, and the queue re-offers
   the same unresponsive operator indefinitely instead of escalating.
3. **A colleague's mobile is unreachable.** Both the ring plan and every
   transfer read `motorist_operator_devices` (web) only. Personal mobile numbers
   are configured for one operator out of eight, and no ring group has one as a
   member.
4. ~~**A failed add-party leaves no trace.**~~ Closed. A blind transfer wrote
   no audit row at all and an add-party wrote one only when it worked, so a
   destination Telnyx refused left nothing behind. All three target actions now
   write a row either way, carrying the number as typed, the number it became
   and the refusal. The error sentence names the number too, and the console
   previews the same normalisation before the click — which is where the Czech
   number typed in national form silently became a Slovak one.
