# VIPTel dispatch routing — rollout and recovery runbook

This runbook covers the authorized dispatch-routing pilot with stable personal
extensions and listener-side validation of priority operations. It does not
authorize a production change by itself.

The application can enforce the control flow described here, but the PBX
topology, channel capacity, browser registration policy, and transfer sequences
remain external acceptance items. Do not mark the rollout accepted until the
Gate 0 evidence and controlled live matrix below are signed. Never place SIP,
VIPTel, database, or live-mutation credentials in this document, tickets,
screenshots, logs, or audit payloads.

## Fixed operating contract

### Identity and priority

- Extensions `20`, `21`, `22`, and `23` are browser workplace SIP identities.
  The application assigns each workplace to at most one active profile at a
  time. The current owner may choose its queue priority; changing priority
  changes queue membership, not SIP credentials.
- Provision another workplace extension before enabling a fifth simultaneous
  browser operator. Never let two application profiles own or actively use one
  extension at the same time.
- The explicitly approved `workplace_claim` pilot does not pretend that a
  provider-side SIP-secret rotation happened at every shift handoff. A fresh
  provider snapshot must instead prove that the workplace is unregistered,
  idle, outside `601`–`603`, outside every routing operation and free of pending
  commands. This prevents an active overlap but cannot revoke a static secret
  previously learned by an old browser. Provider rotation/revocation or
  short-lived credentials remain the complete mitigation for that residual
  risk.
- Queue `601` is priority 1, queue `602` is priority 2, and queue `603` is
  priority 3/final handling.
- The expected PBX route is `601` --30 seconds--> `602` --30 seconds--> `603`.
  VIPTel owns those timers and the final-loop behavior; the application must not
  reproduce or edit them.
- The priority plan selects which personal extension belongs to each queue. A
  separate, unchanged and reachable fallback must remain outside every
  destructive reorder step.
- Shared queues `601`–`603` have no insurer-specific `line_id`. Insurer identity
  comes only from an exact original public DID (or an already stored exact
  `line_id`), never from the queue number.

### DID catalog

| DID | Label | Use |
| --- | --- | --- |
| `0412289240` | Neutrálna linka | neutral inbound and PBX-enforced default outbound caller ID |
| `0412289241` | Allianz Assistance | dedicated inbound identity |
| `0412289242` | Autoklub Slovakia Assistance s.r.o. | dedicated inbound identity |
| `0412289243` | AXA Assistance CZ s.r.o. | dedicated inbound identity |
| `0412289244` | Eurocross Assistance Czech Republic s.r.o. | dedicated inbound identity |
| `0412289245` | Europ Assistance | dedicated inbound identity |
| `0412289247` | LeasePlan Slovakia s.r.o. | dedicated inbound identity |
| `0412289248` | Rezerva 1 | unassigned reserve |
| `0412289249` | Rezerva 2 | unassigned reserve |

`0412289246` is deliberately absent from the application allocation. Its missing
provisioning does not block the six-company pilot, but it must not be invented,
matched by suffix, or silently substituted. Record VIPTel's eventual answer as
separate provider evidence.

## Fail-closed live gate

Keep live mutation disabled during development, Preview review, and ordinary
read-only verification. Preview is always blocked because it uses production
data. Enabling the feature requires both server-only runtime controls:

- `VIPTEL_LIVE_MUTATIONS_ENABLED` explicitly enabled in the intended live
  runtime; and
- a separately generated `VIPTEL_LIVE_MUTATION_TOKEN` that meets the configured
  minimum length.

The token is deployment authority, not a request parameter. Never send it to a
browser or write it to logs. The gate covers provider-writing presence/catalog
sync, extension assignments, priority operations, operator queue actions,
browser SIP-session issuance, outbound calls, hangup/redirect, and DTMF transfer
intent creation. The audit-only result PATCH for an already-authorized DTMF
intent remains available after the gate is disabled, so a kill-switch change
between tone delivery and reporting cannot erase partial-delivery evidence. It
is still bound to the original actor, call, extension, and immutable command. A
disabled gate must otherwise return a clear non-success result; it must not
downgrade to an optimistic or deferred live write.

The safe order is:

1. deploy and verify with the gate disabled;
2. complete Gate 0 and capture the pre-change PBX snapshot;
3. approve a controlled service window;
4. enable the gate only in that exact live runtime;
5. pilot one personal extension and one test DID;
6. disable the gate immediately after the window if the next stage is not
   explicitly approved.

## Gate 0 — external evidence required

The project owner and Matúš/VIPTel must attach provider evidence for every row.
Accept a dated PBX export, provider response, or witnessed controlled test; a UI
assumption is not evidence.

| Evidence item | Required proof |
| --- | --- |
| DID ingress | Each selected insurer DID enters queue `601`; the original dialled DID remains exposed through overflow and transfer legs. |
| Queue topology | `601` overflows after 30 seconds to `602`; `602` overflows after 30 seconds to `603`; the exact `603` final-loop behavior is documented. |
| Skip behavior | Observed handling for busy, paused, unregistered, and empty priority queues. |
| Dynamic members | Add, remove, pause, and unpause are supported for `601`–`603`, with provider state/event confirmation. |
| Fallback | One independent registered/unpaused fallback is identified and proven reachable throughout a reorder. |
| Voice capacity | Purchased channel count `C`, maximum approved outbound load `N`, at least one inbound reserve, attended-transfer extra-leg behavior, and the expected result at `N+1`. |
| Browser SIP | Registration endpoint/policy, one-device or multi-registration behavior, and one personal credential for each enabled operator. |
| PBX dial policy | Extensions `20`–`23` may call only the approved destinations and present `0412289240` externally. |
| Transfer contract | Exact `##` blind and `*2` attended sequence, tone pacing, consultation completion, cancel/return, timeout, and recovery instructions. |
| API permissions | The production account is permitted to perform the required call and queue actions. |
| Test fixture | Approved test callers, test destinations, extensions, service window, observer, and a rule that no real assistance call is displaced. |
| Rollback source | Timestamped pre-change queue/member/PBX configuration and the named person authorized to restore it. |

Record the evidence location, observer, timestamp, and result for each row. Gate
0 passes only when every item is confirmed, the channel-reservation policy is
agreed, and a controlled live test is explicitly approved. Until then, keep
provider mutations and browser credential issuance disabled and report the
corresponding capability as **unverified**, not failed or completed.

## Pre-rollout checklist

1. Follow the dev-first release path: work branch -> Vercel Preview -> PR to
   `dev` -> verification on `dev` -> separate `dev` to `main` release PR.
2. Run the full automated quality gates for the web app, worker, and VIPTel
   listener from the exact candidate commit. Preview checks are read-only.
3. Verify `/api/telephony/health`, listener heartbeat, WebSocket connection, and
   reconciliation freshness. The web app and listener must use the same commit.
   For a listener-only Vercel/Hetzner topology, use the checksum-bound
   `activate-viptel-listener-only.sh` procedure in the listener activation
   runbook; WebSocket must be live while scheduled reconciliation remains
   explicitly disabled.
4. Confirm the live gate is disabled and prove that protected routes fail
   closed, including the SIP-session endpoint and the provider-writing presence
   refresh path.
5. Run the DID/catalog dry-run. Resolve conflicts before applying it. Confirm
   queues `601`–`603` exist with `line_id = null`; do not guess an insurer for a
   queue-only call leg.
6. Confirm that extensions `20`–`23` exist as the approved browser workplaces.
   Operators may claim and release them through the audited `workplace_claim`
   flow. A manager handoff outside that shared-workplace flow remains an
   exceptional action and requires provider-side SIP-secret rotation/revocation.
   Record only the rotation ticket or change reference, never the credential.
7. Open the manager priority dry-run. Record current plan, target plan, revision,
   actual membership, ordered diff, affected extensions, waiting calls, pending
   commands, and the independent fallback.
8. For a manager routing apply, confirm all affected extensions are offline and
   unregistered. A self-service priority-only change may keep an extension
   registered only when the fresh provider snapshot explicitly reports no
   active call, no member `inUse`, no waiting call and an unchanged registered,
   unpaused fallback. A `queued`, `sent`, `accepted`, or delivery-uncertain
   command blocks either flow.
9. Reject duplicate slots, an unowned/inactive extension, a stale revision, an
   overlapping operation, or an all-priority reorder without a fallback outside
   the destructive steps.
10. Capture the current provider state again immediately before apply.

## Workplace assignment and manager reassignment

Bootstrap in this order: create and verify the queue catalog `601`–`603`, prepare
the workplace extensions, and only then create the priority plan. A workplace
claim or release is accepted only when the exact extension is
unregistered, has no active provider call, is absent from every queue
`601`–`603`, is absent from the current/previous/target/in-flight routing state,
and has no non-terminal telephony command. An incomplete or ambiguous provider
snapshot fails closed.

The self-service switch first removes the old workplace from its priority and
waits for provider confirmation, then disconnects the old browser, releases the
old ownership and claims only a still-free target. Profile and extension rows
use compare-and-set checks; losing a race leaves the actor without a second
workplace and requires a refresh. An occupied target is rejected before the old
workplace is released. Routing preview and apply are also bound to the canonical
digest of the exact saved workplace draft; a concurrent draft change fails with
`409` before a provider operation starts.

Queue metadata are covered by the legacy organization-member RLS write policy,
so a digest alone is not proof that the server created a workplace draft. Every
current-revision draft therefore carries a versioned HMAC-SHA256 envelope bound
to the organization, root queue, complete canonical draft, and a unique audit
ID. The HMAC key is domain-derived from the server-only Supabase service
credential already required by web, Preview, and listener runtimes; no key or
draft content is returned in the routing guard. The server also requires that
the audit ID, digest, and signature exactly match the newest immutable
`telephony.workplace.priority.draft` audit row for that organization/root. This
second check prevents replay of an older legitimately signed draft from the
same routing revision. The audit payload is proof-only and contains no
`selectedBy` values or raw draft. A structurally valid unsigned draft is ignored
only after a newer committed routing revision has made it stale; an unsigned,
invalid, future, or non-latest current draft fails closed before provider work.
If the audit insert fails after the root CAS, the server CAS-restores the prior
metadata; an unconfirmed rollback leaves selection blocked for administrator
inspection. Rotating the Supabase service credential intentionally invalidates
current draft signatures until they are superseded or re-signed.

Outside `workplace_claim`, never hand an occupied extension directly to another
profile. First remove it from the priority plan, disconnect the old owner, and
rotate/revoke the SIP credential in VIPTel. The manager flow stores a quarantine
marker; the next owner can be assigned only with an explicit rotation
attestation and a non-secret operational reference.

The extension row is also the no-migration concurrency interlock. Assignment,
browser-session issuance, call actions, and routing apply compete on the same
`updated_at`/owner CAS. A fresh action claim blocks assignment for a bounded
120-second registration/delivery window. This grace period is only a race
barrier: browser SIP credentials remain provider credentials after it expires.
Only provider-side rotation/revocation makes an old credential unusable, and a
quarantined extension must not be assigned to a new owner without that rotation
and its non-secret attestation.

VIPTel presence synchronization never writes through an active assignment
transition, including a malformed active marker. All updates and deactivations
of existing extension rows use the captured `updated_at` value as a CAS; losing
that race is an intentional no-op because the newer assignment/action state
wins.

An assignment transition older than five minutes is recoverable only through a
new manager assignment request. Recovery first repeats the complete live
provider, queue, routing-plan, and pending-command safety check. If a crashed
new assignment reserved the target profile before it could update the extension
row, recovery verifies that exact profile/extension pair and returns the
reservation with an `updated_at` and `phone_extension` CAS. Only then does it
remove the exact transition ID and write an audit record; the request still
returns a conflict so the manager must refresh before retrying. A recent,
malformed, owner-mismatched, or CAS-raced transition remains locked and must be
escalated—never repair assignment metadata manually.

If a new-owner assignment reserved the target profile but then lost the
extension-row CAS, the transition may be removed only after the exact profile
rollback is confirmed. A failed or ambiguous rollback deliberately keeps the
transition as the durable recovery marker; do not clear it merely to unblock
the UI.

If a process crashes after the extension was disconnected and quarantined but
before the old profile's `phone_extension` reservation was cleared, the next
manager assignment request detects the exact quarantine `previousProfileId`.
It first claims the unowned extension row, repeats the full live safety check,
clears only the matching profile/extension reservation by CAS, releases the
claim, and audits the recovery. The quarantine itself stays active because SIP
rotation is still required. The manager must refresh and retry after recovery;
malformed or mismatched quarantine data fails closed.
If the previous profile reservation is already `null`, or it now contains a
different valid personal extension, there is no orphan reservation for this
quarantined extension and recovery leaves that profile untouched.

A routing claim is stricter: it remains exclusive for the whole persisted
operation and is removed only by an exact terminal release. A degraded
operation keeps its claims until recovery; do not clear extension metadata by
hand unless the recorded operation and provider state have been reconciled.
There is one bounded crash exception: a claim captured before the root operation
could be persisted is considered orphaned only when no root operation contains
the same operation ID and exact guard. Such a claim remains locked for 120
seconds, then a new CAS action may replace it. If the root state cannot be read,
the claim stays locked; a real persisted operation never expires by age.

## Manager priority operation

### Dry-run

Dry-run is mandatory and must not enqueue a provider command. The manager checks
the personal profile and extension together for:

- queue `601` / **Prvý**;
- queue `602` / **Druhý**;
- queue `603` / **Tretí/slučka**.

The manager must see every exact provider step (`action`, queue, extension).
The server returns a digest of that ordered diff; Apply recomputes live provider
state and returns a conflict unless the digest still matches the reviewed
dry-run. An unchanged form or step count alone does not approve a changed diff.

If the displayed actual membership does not match VIPTel, stop and refresh. Do
not let an ordinary page load silently repair it.

### Apply

Apply is allowed only in the approved service window. The durable operation must
carry its operation ID, base/target revision, previous/target plan, ordered
steps, current step, actor, timestamps, and unchanged fallback. New availability
actions for affected queues/extensions remain frozen during the operation.
Before the root-plan CAS (including a no-op diff), every previous, target and
fallback personal extension receives a persisted assignment-generation/action
claim. The operation stores these exact guards. A concurrent call/session or
assignment conflict stops apply; an in-flight step whose owner, generation or
claim changed is rejected before provider I/O.

Use make-before-break where possible. Immediately before every VIPTel REST
action, the listener must reload the authoritative plan and provider state and
verify all of the following:

- this is still the active operation, revision, and current step;
- every stored extension assignment guard still has the exact extension,
  profile owner, generation and action claim;
- affected extensions remain offline/unregistered and queues have no waiting
  call;
- the recorded fallback remains registered, unpaused, reachable, and untouched;
- no older related command remains unresolved;
- the observed membership still matches the step precondition.

A failed precondition refuses the provider call and leaves the operation visibly
degraded. A step advances only after the exact provider action is confirmed. Do
not display the target plan as current before the full reconciliation completes.

`releasePending` is a cleanup phase, not an override. It is valid only for a
`degraded` operation after the root revision and current plan already equal the
operation's target revision and target plan. It must contain either an explicit
zero-step cleanup (`steps: []`, `currentStep: 0`) or only confirmed steps with
`currentStep` at the final step. Any other stored shape is treated as corrupted
metadata; recovery must not release guards or access the provider.
Every assignment guard must also carry the exact same routing operation ID;
a missing or foreign operation binding blocks cleanup before any guard release.

### Resume and recovery

On any failure or uncertainty:

1. stop issuing further steps and keep the independent fallback unchanged;
2. preserve the operation and command audit records;
3. freeze affected availability actions;
4. refresh actual VIPTel membership and terminate/reconcile the ambiguous step;
5. choose **Resume** only if every current-step precondition is again true;
6. otherwise calculate recovery from fresh actual state, not from the intended
   state shown before the failure.

Never enqueue an inverse action while an earlier step is `queued`, `sent`,
`accepted`, or delivery-uncertain. A stale or overlapping manager edit receives
a conflict and must refresh.

## Browser calls and transfers

- The authenticated profile may receive a SIP session only for its assigned
  personal extension. Session responses are private and `no-store`.
- Each browser phone supports one active call. Concurrent calls require separate
  people/extensions and enough purchased voice channels; the DID count is not
  the channel count.
- The server serializes `call.create` per personal extension and the browser
  refuses a new SIP INVITE without a live SIP session. This prevents an
  accidental second intent; it does not prove purchased channel capacity.
- Destination validation in the UI is supplemental. VIPTel must enforce allowed
  external dialing and caller ID because a browser-held SIP credential can act
  outside the UI.
- Use provider-confirmed `call.redirect` for an eligible, registered, unpaused,
  idle colleague and for a validated external telephone number. VIPTel's
  WebSocket specification documents `destination` as either an extension or a
  telephone number; typed short extensions remain blocked so they cannot bypass
  the colleague availability check.
- Guided blind (`##<destination>`) and attended (`*2<destination>`) transfer
  remain available as an advanced browser-phone fallback and are audited as `call.transfer.dtmf` with
  `transport=browser_dtmf` and `confirmationModel=unconfirmed`. Creating and
  sending the intent does not prove that VIPTel completed the transfer.
- A failure before the first tone may be recorded as failed/retryable. After one
  or more tones, keep the command accepted/unconfirmed with
  `deliveryUncertain=true`, the sent-tone count and failed index; never retry it
  automatically. Show only the recovery/cancel instruction approved in Gate 0.
- A call/extension pair permits only one unresolved or non-retryable guided DTMF
  intent. A new intent is atomically fenced and is accepted only after the
  previous immutable result proves a zero-tone retryable failure.
- CDR/provider events may later supply terminal evidence. Never relabel a DTMF
  attempt as provider-confirmed merely because all tones were sent. The manual
  keypad remains the emergency fallback.

## Controlled live acceptance

Run only with approved test callers during the service window. Record timestamps,
provider IDs (never credentials), expected/actual behavior, observer, and result.

1. Call each of the six insurer DIDs; verify the insurer and original dialled
   number before answer and in history.
2. Answer in priority 1. Then repeat with a measured timeout from `601` to `602`
   and from `602` to `603`; observe the final loop.
3. Repeat routing with priority 1 busy, paused, offline, and unregistered.
4. Confirm an unknown DID and a queue-only leg show **Neznáma linka**, never a
   guessed insurer.
5. Apply one idle reorder. Confirm the listener rejects a deliberately stale
   step and stops when a new call/registration or fallback loss violates the
   precondition. Confirm a second manager edit is rejected while the operation
   is unresolved.
6. Reconcile one deliberately ambiguous command before recovery, then prove
   Resume or Roll back uses freshly observed membership and retains the fallback.
7. Register separate browsers for the enabled personal extensions. Verify
   internal and approved external calls, caller ID `0412289240`, load `N`, one
   reserved inbound call at that load, and documented behavior at `N+1`.
8. Test provider-confirmed internal blind redirect plus the Gate 0-approved
   external blind, internal attended, and external attended scenarios. Verify a
   zero-tone error and a partial-tone error are reported differently and that
   partial delivery cannot be automatically retried.
9. Verify one logical history entry preserves caller, original DID, insurer,
   queue progression, final extension/operator, and transfer evidence.
10. Confirm health, heartbeat, reconciliation, and command audit remain fresh.

Any unproven provider behavior remains an open acceptance item. It must not be
converted into a software-success claim.

## Rollout stages

1. **Read-only release:** gate disabled; inspect Preview and `dev`; verify no
   provider/data mutation or SIP credential issuance is possible.
2. **Single-extension pilot:** after Gate 0, enable one assigned personal
   extension and one approved test DID in the controlled window.
3. **Priority pilot:** apply one manager reorder with a proven independent
   fallback and listener-side step revalidation.
4. **DID expansion:** verify each remaining insurer DID individually.
5. **Operator expansion:** enable the remaining personal extensions only while
   the channel-reservation policy continues to hold.
6. **Production acceptance:** release through `dev` to `main` only after signed
   evidence covers routing, calls, transfers, audit, and rollback.

Stop between stages if any operation is degraded, listener/health state is
stale, the fallback is unavailable, or the gate cannot be proven fail-closed.

## Rollback

1. Disable live mutations and browser SIP exposure in runtime configuration.
2. Freeze new priority and availability commands. Do not enqueue compensating
   work while a previous delivery is unresolved or uncertain.
3. Refresh provider state, reconcile the in-flight command, and preserve all
   append-only calls, raw events, and command evidence.
4. Recompute provider membership from actual state versus the recorded previous
   plan. Restore it only after the listener revalidates each rollback step and
   the independent fallback remains reachable.
5. If recovery through the application is unsafe, have the named VIPTel operator
   restore the captured PBX/member snapshot and verify it independently.
6. Fall back to the known physical-phone and manual-transfer procedure.
7. Revert the application and listener from the same reviewed release. Do not
   delete audit evidence.
8. For an exceptional ownership change, rotate/revoke the old SIP credential at
   VIPTel; changing only the profile assignment is not a complete rollback or
   offboarding action.

Related operational references:

- [Unified command behavior](./viptel-phase-4-unified-commands.md)
- [Listener activation and acceptance](./viptel-phase-3-activation.md)
- [Hetzner release handoff](./dispecing-hetzner-handoff.md)
- [VIPTel data contract](../viptel-data-contract.md)
