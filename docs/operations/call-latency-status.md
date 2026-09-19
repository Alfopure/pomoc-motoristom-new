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
| inbound answer | 64 | 45 | **47** |
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

It also makes the shape of the remaining cost plain: the journal is the larger
part of what an inbound answer costs, and it grows with every voice command
rather than with the number of reads. That is what E2 exists to
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
| **E1a.3** read deduplication | all six done. (d) covers every command kind: the validity read is skipped under the whole `noContinuation` predicate, and a fenced PT409 refusal maps onto the superseded path for everything except teardown |
| **E1a.4** organisation cache | done — `call.active` poll 8 requests to 7, confirmed on live traffic |
| **E1a.5** instrumentation | `db_count_at_dispatch` in the command audit; failed commands now record their error |
| **E1a.6** one checkpoint per critical batch | done, critical phase only |
| **E1b-1** low-risk concurrency | both points, and .2 in full: parallel teardown, overlapping best-effort provider calls, one checkpoint per overlapping run (9 session writes to 7 on an answer) |
| **E1c** bounded webhook lease wait | done — 1200 ms, backoff 150/300/600 |
| **E1b-2.4** parallel fan-out | done, with the plan's leaning and its full test list |
| **E2.2** critical rows | done — session, legs and attempts in one call. Presence deliberately left in the reducer |
| **E2.3** journal batch | done — a ring step and a teardown run each fence and record once instead of twice per command |
| **E3(a)** consult/add-party owner | done — a colleague on their own phone is taken out of the ring plan when consulted |
| **E3(b)** mobile in the picker | done — such a colleague is reachable and shown as `Mobil` |
| **E4** polling | done — one database pass per organisation per second: 12 800 requests to 1 600 over ten minutes |

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
| **E1m** measurement | instrumentation is in place (`db_count_at_dispatch`, cost per request, `auth.token`/`auth.profile`). The 30-sample SQL A–J distributions need production traffic, not code |
| **E1b-2.3** critical batch | superseded. E1a.6 made it one checkpoint and E2.2 made it one call, which is the stronger version of the same idea |
| **E2.1** admit RPC | a decision, not a task. ~4 requests of 47, for rewiring the least forgiving path in the system |
| **E2.2** presence half | a decision. The row writes are folded; folding presence moves policy out of the reducer that owns it |
| **E2.4** projections | already deferred (`deferProjections`) and finished by the next event or cron; the further fold into one RPC buys nothing measurable |
| **E3** picker progress | a UX decision: keep the picker open with progress, or close it only when the action settles |
| **E3** mobile standby | a decision: longer foreground standby trades battery for push-to-wake latency |
| **E3** experiment B | auto-bridge on inbound, on own numbers only. Never attempted; without a positive result it is not introduced |
| **E4** auth half | instrumented, waiting on production traffic |
| **E5** measurement rounds | needs traffic |

**Configuration, not code.** Measured on the project 19 Sep: one active ring
plan with one group of three operators and **no backup number**, and **one of
fifteen** operators with a mobile number. So the queue escalation has nothing
to dial and a caller nobody answers waits out the full thirty minutes, and the
transfer-to-mobile path serves exactly one person. Both are decisions about
paid calls, which is why they are the operator's and not ours — but until they
are made, that work does nothing.

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
### The conference silence, found

Reported on 17 Sep: a third number added to a call, and after somebody left it
the remaining parties heard nobody. Confirmed live on 18 Sep — the caller hung
up out of a three-way and the added number kept working for a few seconds and
then died.

`onCustomerHangup` hung up **every** remaining leg. Right for a two-party call;
wrong for a three-way, where the operator and the number they added were
mid-conversation. It also contradicted the code beside it: when the *operator*
leaves, `handOverConference` deliberately keeps the caller and the remaining
party together.

Now the caller leaving a three-way leaves the rest talking, and the added
number is hung up only once the operator has gone too — a party alone on a
live leg is a stranger holding a silent call.

### What was checked before that

`src/server/telephony/conference-departure.test.ts` drives every shape of the
departure against the provider double's own model of who can hear whom. The
operator dropping, the added party hanging up, the same after a blind transfer,
and hold were all already correct — which is what left the caller's own hangup
as the only remaining candidate. The conference parameters were never at fault
either: `start_conference_on_create: true`, and `end_conference_on_exit`
defaults to false.

### One leaning the plan asked for, refused

E1b-2.4 proposes taking the offer tombstones from the session snapshot when it
shows none, instead of `cancelRevokedOffers` re-reading the row — a round trip
per operator rung.

`dispatch-pause-boundaries` refuses it, and it is right to. An operator can be
paused while their own dial is still in flight, and the fresh row is what
discovers that tombstone in time to hang the revoked leg up. The plan's
backstop — the next event re-runs the pass — is not enough here, because the
revoked leg can be answered before that event arrives.

The read stays. The saving that did land is the journal lookup: it was gated on
a continuation merely existing, and a first attempt has one, so every dial asked
the journal about a command that could not be there.

### The escalation is now the dispatcher's setting

The user's decision on the queue escalation (18 Sep): keep it, but it belongs
in settings rather than in the code — *"Ak si to nenastavil, tak je to jeho
chyba a my by sme ho maximálne mali na to vedieť upozorniť"*. No forced
behaviour; the dispatcher decides and the system says what the decision means.

The saying-what-it-means half is done: the settings page reads the ring plans,
the groups and the operators and states what a caller actually meets — whether
any phone rings, which number the queue will dial after two minutes and that it
is billed, who takes calls on their own phone, how long the caller waits.

Done. `20261002100000_queue_escalation_setting.sql` adds
`queue_escalate_after_seconds`, applied 18 Sep through the Supabase MCP server;
it is backfilled to 120, which is exactly the behaviour every row already had.
The field sits on the telephony settings tab in minutes, `0` turns the
escalation off, and the advisory block above it reads the value being typed
rather than the saved one.

`loadRoutingSettings` falls back to the built-in 120 when the column is absent,
so a deployment that runs ahead of its migration keeps the behaviour it had
instead of silently ceasing to escalate.

### 18 Sep: Vercel stopped deploying

From 10:12 UTC no deployment of any kind reached either project — production,
preview, both repositories, nothing. The `dev` → `main` merge that carries the
escalation setting (`3099013`) has no check run against it at all: the push was
never picked up, rather than picked up and failed.

78 deployments are recorded against this repository for the day, and two
projects build on every push, so the real figure is roughly double. A daily
deployment cap fits the evidence — a clean stop after a busy day, with nothing
queued and nothing failing — but it cannot be confirmed from here, since this
sandbox has no Vercel credentials.

Production therefore serves `e686722`. The escalation setting is merged and
undeployed, and the migration that goes with it **is** applied. That
combination is safe on purpose: the deployed build neither reads nor writes
`queue_escalate_after_seconds`, so the queue keeps escalating after the
built-in two minutes and the column sits at its default. There is no state
where the database and the code disagree.

### E4: one database pass per organisation per second

Every console asked the database for the same rows. Eight screens on a
three-second interval meant eight identical passes over sessions, presence,
devices, lines and legs — the answer differing only in which call is "mine".

The rows are now read once per organisation per second and the per-operator
view is built from them. Measured over ten simulated minutes, eight consoles
at the poll floor: **12 800 requests to 1 600**, an 87% reduction against a
target of 50%.

`loadActiveCalls` stays uncached and `loadActiveCallsCached` is what the route
calls, following `stats.ts` — a test that builds a world, polls it, and builds
another a millisecond later must not be served the first one's rows.

The stale-owner repair went with it. It ran its own query on every poll to find
out whether the polling operator was held by a call that had ended; the
snapshot already knows, so `ownPresenceStale` is derived from rows already
loaded and the repair runs only when there is something to repair.

One second is the whole exposure: the poll floor is three seconds and Realtime
pushes changes as they happen, so a console can be at most a second behind
something it did not do itself.

### Where the 61 requests of an answer actually are

Measured on the contract-2 harness, 18 Sep, inbound `call.answered` with three
operators and recording off. Counted by table and operation, so the next round
starts from evidence rather than from reading code.

| n | request |
| --- | --- |
| 7 | `motorist_call_legs` select |
| 7 | `motorist_call_sessions` update |
| 6 | `motorist_session_lease_renew_v2` |
| 6 | `motorist_provider_command_prepare_v2` |
| 6 | `motorist_provider_command_result_v2` |
| 4 | `motorist_call_sessions` select |
| 3 | `motorist_ring_attempts` update |
| 2 each | attempts select, presence select, `presence_transition_v1`, `motorist_calls` select, webhook events select |
| 1 each | claim, acquire, pending commands, observe dial, settings, stage transition, legs update, member touch, call update, event insert, finish, release |

No single item dominates any more, which is itself the finding: the easy
deduplications are spent. The two largest are the journal (12, two per voice
command) and the leases (6, one per command).

**One of the two is now here.**

The journal now batches for a ring step (E2.3, first half).
`prepare_batch_v2` and `result_batch_v2` are the same functions over an array:
one fence, one lock, one statement per command, a decision back per command.
`dispatchJournaledBatch` carries the single-command branches member by member,
`client.dialMany` sends a whole step, and `executeRingFanout` plans every
member, sends the group and settles each.

A three-operator step costs two round trips of journal instead of six — the
saving is two per operator beyond the first, so it grows with the group. A
whole inbound call: 159 requests to **155**.

Two properties were kept deliberately. The verdict stays **per member**, or one
bad number would take a ring step down with it. And the members are fenced
*together before any of them is sent*, so a termination committed meanwhile
stops the whole step rather than the part that had not gone out yet.

The teardown run behind a bridge went the same way: `callActionMany` sends a
stop and the losing legs' hangups as one group. Those kinds have no
post-dispatch bookkeeping — that is why they may overlap at all — so the only
per-member work left is the tolerance a hangup owes a leg that is already gone.

An answer costs **51** requests, down from 64 before any of this and 55 before
the batching. Its journal is 8 round trips instead of 12; a whole inbound call
is 155 instead of 168.

Two defects surfaced while wiring it, both caught by tests before they shipped.
The double gave the same command two fingerprints — one sent alone, another
sent in a group — because it left `commandId` inside the payload where the real
client sends it alongside; a replay would have seen a payload identity conflict
where there is none. And the first batch treated a provider's 4xx as though
nothing had come back, when a refusal is evidence and has to be recorded or the
replay tries the same doomed command again.

The six lease renewals were pure duplication, and removing them was blocked on
exactly the assumption that made the earlier measurements wrong: `prepare_v2`
fences on its own, so the renew keeps the lease alive rather than guarding the
write — but nothing in the harness could show the fence refusing anybody,
because neither provider double modelled it.

Both do now. `fenceSession` compares the ambient owner against the session row
the way `motorist_telephony_fence` compares the request headers against it —
and the headers are written from that same owner, so it is the same comparison.
Five tests were passing on a false premise (hand-built owners that held no
lease) and were corrected to hold a real one.

With the fence reproducible, the renew is throttled to one per five seconds
against a fifteen-second TTL. An answer costs **55** requests instead of 61 and
a whole inbound call 159 instead of 168; a stale owner is refused by the fence,
which three new tests assert directly — taken lease, expired lease, and the new
owner going through.

### E2.2, the half of it that is row writes

The phase that holds the caller waiting for audio wrote the session, then
looked up and updated each answered leg, then updated each ring attempt — every
one its own round trip, to a database that takes the same session lock each
time. `motorist_apply_critical_v2` writes them together: an answer costs **47**
requests instead of 51.

**Presence is deliberately not in it.** Its guards read an application feature
flag and an operator's wrap-up setting, and deciding those in SQL would move
policy out of the reducer that owns it — the thing that decides whether an
operator is offered calls at all. The plan folds presence in too; that half is
not attempted here and should not be, without a way to test the policy where it
would then live.

The fold runs only from the start of an entry. A resumed one has a cursor
partway through the batch and takes the per-effect path, which knows how to
carry on from there — and the cursor still advances effect by effect either
way, so an entry staged by one writer stays resumable by the other.

Patching follows `motorist_stage_transition_v1`: `jsonb_populate_record` over
the existing row, so an absent key keeps its value and a present one is applied
with the column's own type.

### E4's auth half: what the answer depends on

The project signs its tokens with **ES256 and publishes the public key**
(verified 18 Sep through the Management API), so `getClaims()` can verify a
token locally and the plan's hypothesis holds: the network call to GoTrue on
every request is removable in principle.

It is not removed, because the gain is unmeasured and the cost is not.
`getUser()` asks GoTrue every time, so a revoked session is refused
immediately; `getClaims()` would accept it until the token expires. The profile
read keeps running either way, so a **deactivated operator** is still locked
out at once — the exposure is narrower than it looks, and it is a revoked *auth
session* on an operator whose profile is still active.

Trading that for an unmeasured gain is the wrong order, and the plan agrees:
measure the step's share first. So `auth` is now reported as its two halves,
`auth.token` and `auth.profile`. Knowing the gate costs 120 ms does not say
which half to attack, and the halves are different decisions — one about
revoked sessions, the other about deactivated operators.

The next production traffic answers it.

### Where the plan stands, and what each remaining piece costs

An inbound answer went from 64 database requests to **47** and console polling
from 12 800 to 1 600 over ten minutes. What is left is not a list of tasks so
much as three decisions, each of which trades something the measurements cannot
value on their own.

**E2.1, the admit RPC.** Folding the webhook claim, the session resolution and
the lease acquisition into one transaction saves roughly four requests of the
forty-seven. It rewires the hottest and least forgiving path in the system:
claim deduplication, deferred retry, three fallbacks for resolving a session,
and a lease-busy answer that has to stay deferrable. The ratio is poor and the
blast radius is the worst available. It is not started, and it should not be
started for eight per cent.

**The presence half of E2.2.** Its guards read an application feature flag and
an operator's wrap-up setting. Folding them into SQL moves the decision about
whether an operator is offered calls out of the reducer that owns it, into a
place where it cannot be tested the way the rest of that policy is. The row
writes are folded; this half should wait for a way to test policy where it
would then live.

**E4's auth half.** Verifiable as removable — the project signs with ES256 and
publishes the key — and now instrumented as `auth.token` and `auth.profile`.
Whether to trade immediate rejection of a revoked session for one fewer network
call is a decision for the numbers the next production traffic produces, not for
an argument.

The pattern in all three is the same, and it is the lesson of this repair: the
measurements were wrong for weeks because the harness could not reach the path
production runs. Everything above is gated on evidence rather than on reasoning
precisely because reasoning is what produced the wrong numbers.

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

   E3(a) came with it, and had to: making such a colleague reachable made an
   old hole reachable too. `appConsult` left `profile_id` null for a number
   target, so consulting a colleague on their mobile rang their phone without
   taking them out of the ring plan — they could be offered another call at the
   same moment. `appAddParty` was covered only because `executeDial` rediscovers
   the owner by reading every operator's settings; both now name the owner in
   the reducer, as the plan specifies.

   What remains is configuration, not code: personal mobile numbers are set for
   one operator out of eight, and no ring group has one as a member.
4. ~~**A failed add-party leaves no trace.**~~ Closed. A blind transfer wrote
   no audit row at all and an add-party wrote one only when it worked, so a
   destination Telnyx refused left nothing behind. All three target actions now
   write a row either way, carrying the number as typed, the number it became
   and the refusal. The error sentence names the number too, and the console
   previews the same normalisation before the click — which is where the Czech
   number typed in national form silently became a Slovak one.
