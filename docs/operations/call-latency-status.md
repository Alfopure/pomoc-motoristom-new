# Call latency repair — where we are

Running status of the repair described in `plan/call-latency-repair-2026-09-16`
(`docs/plans/call-latency-2026-09-16/plan-v5.md`). Updated as stages land, so a
session that starts cold can see what is done, what is measured and what is
deliberately left.

Last updated: 17 Sep 2026.

## Measured on the contract-2 harness

Database requests per action, on the path production runs (contract 2:
generation leases and the fenced provider journal).

| action | before 17 Sep | after 17 Sep | true cost |
| --- | --- | --- | --- |
| inbound answer | 64 | 45 | **63** |
| hold | 40 | 35 | **44** |
| unhold | 36 | 33 | **36** |
| blind transfer | 47 | 41 | **50** |
| hangup | 39 | 32 | **42** |

`src/server/telephony/state/contract-two-command-cost.test.ts` holds the last
column as bounds, with two requests of headroom for the throttled incident
read.

**The third column is the correction, not a regression.** Until 18 Sep the
provider double implemented `TelnyxClient` method by method rather than over
HTTP, so it never reached `prepareProviderRequest` — and the journal costs two
database round trips per voice command, `prepare_v2` before and `result_v2`
after. Every number measured before then, including the reductions this repair
claimed, understated production by roughly that much. The reductions are real;
they were just measured against a smaller total than production pays.

It also makes the shape of the remaining cost plain: the journal is 18 of the
63 requests an inbound answer costs, close to a third, and it grows with every
voice command rather than with the number of reads. That is what E2 exists to
change, and no amount of read deduplication in the application will touch it.

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
| **E1a.1** lean context | done — accepting an offer no longer loads the whole route |
| **E1a.2** bridge first | done |
| **E1a.3** read deduplication | (a) (b) (c) (e) (f) done; **(d) only for `hangup`** — no longer blocked, the harness reaches the fence now |
| **E1a.4** organisation cache | done — `call.active` poll 8 requests to 7, confirmed on live traffic |
| **E1a.5** instrumentation | `db_count_at_dispatch` in the command audit; failed commands now record their error |
| **E1a.6** one checkpoint per critical batch | done, critical phase only |
| **E1b-1** low-risk concurrency | both points: parallel teardown, overlapping best-effort provider calls |
| **E1c** bounded webhook lease wait | done — 1200 ms, backoff 150/300/600 |
| **E1b-2.4** parallel fan-out | done — a ring step claims, persists and dials its members together instead of one after another |

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
| **E1a.3(d)** in full | maps a fenced PT409 refusal onto the superseded path for every command kind, not only `hangup`. Was blocked on the harness; writable now |
| **E1b-1.2** group checkpoint | one checkpoint per overlapping group instead of one per command. No longer blocked |
| **E1m** measurement | partly: cost per request and `db_count_at_dispatch` are in place; the 30-sample SQL A-J distributions are not |
| **E1b-2** rest | .4 done; the rest superseded by E2 if E2 is approved |
| **E2** migrations | not started. The step change: bridge chain to 5-6 requests, fanout to 6 + N |
| **E3** controls, mobile, transfer | not started. Includes making a colleague's mobile reachable at all |
| **E4** polling and auth | not started |
| **E5** measurement rounds | not started |

### What parallel fan-out changes

A ring step with three operators used to run three times in a row: claim the
member, write the token, dial, record the leg — then start the second member
from scratch. On a production call the `ring_fanout` effect took 4.1 s and the
`call.answered` handler 8.4 s, and the third operator's phone was the last to
make a sound.

The step now does the same work in three passes over the whole group: insert
every attempt row, claim every member and persist all their tokens in **one**
fenced write, then dial everybody at once. The tokens still land before any leg
exists, so a replayed webhook still recognises its own offer.

The one write matters more than it looks. Claiming per member under concurrency
is not merely slower — `src/server/telephony/state/parallel-fanout.test.ts`
reproduces it: three compare-and-sets racing on one session row lose a member
outright, and only two of the three phones ring.

Request count is unchanged; this is latency, not cost. It should show up as the
gap between the caller being answered and the first phone ringing, and it is
worth one verification call to confirm.
## Known gaps that are not in the plan

Found during testing on 17 Sep; none of them is a latency problem and the plan
does not address any of them.

1. ~~**The harness cannot drive the provider journal.**~~ Closed. The
   fenced-dispatch protocol now lives in one place (`dispatchJournaled`) and
   both the real client and the double go through it, so `prepare_v2` /
   `result_v2` and the branches that depend on them are reachable: a command
   already accepted, one the fence refused, one whose outcome was never
   recorded. This unblocks E1a.3(d) in full, E1b-1.2 and E2.3, and it is what
   turned up the true request cost above.
2. **Capacity is invisible.** Three simultaneous callers met one reachable
   operator; two waited seven and eight minutes. The ring plan behaved
   correctly. Both halves are now closed: "ring exhausted" and "nobody could be
   rung" are reported separately, and a queue that finds nobody for two minutes
   rings the backup numbers once and says so on the board. What is still open
   is the decision this leaves: when even the backup numbers have been tried,
   the caller still waits out the full `park_max_minutes` before the callback
   offer. Shortening that is a call behaviour change and wants a live test.
3. **A colleague's mobile is unreachable.** Half closed. The ring plan already
   honoured `delivery_mode: "personal_mobile"`; transfer, consult and add-party
   did not, so a colleague who works from their phone was permanently
   untransferable — refused with "Kolega nemá pripojený telefón" for a browser
   phone they do not have by design. They are now reachable, and the picker
   shows them as `Mobil` rather than green or absent.

   What remains is configuration, not code: personal mobile numbers are set for
   one operator out of eight, and no ring group has one as a member.
4. ~~**A failed add-party leaves no trace.**~~ Closed. A blind transfer wrote
   no audit row at all and an add-party wrote one only when it worked, so a
   destination Telnyx refused left nothing behind. All three target actions now
   write a row either way, carrying the number as typed, the number it became
   and the refusal. The error sentence names the number too, and the console
   previews the same normalisation before the click — which is where the Czech
   number typed in national form silently became a Slovak one.
