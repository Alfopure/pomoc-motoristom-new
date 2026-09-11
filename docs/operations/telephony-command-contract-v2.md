# Telephony command ownership contract v2

Prepared for the separate Telnyx copy. This document is an implementation and rollout contract, not evidence of live activation or measured call latency.

The additive migration `20260929200000_fenced_telephony_commands.sql` defaults `motorist_telephony_writer_rollout.new_session_contract` to `1`. Existing sessions retain their contract. New code discovers the persisted contract and uses generation acquisition after expand; there is no environment activation flag. Activating new-session contract `2` is a separate database rollout change after compatible writers have reached all active deployments. No worker, listener or additional cron is introduced.

## Ownership and compatibility

Each invocation keeps its original token, generation and absolute work deadline in an async request scope. The admin transport attaches that identity to PostgREST requests. Database triggers lock the parent session and validate the fixed identity for every session, leg, ring attempt, presence, call projection and participant interval write. Reading a newer version never replaces the invocation's generation. The existing staging transaction and continuation checkpoints therefore inherit the same server fence, including direct writes and auxiliary writes. Presence/history/config rows without a session association retain their existing authorization and concurrency contracts.

| Writer / session | Behavior |
| --- | --- |
| Old writer / contract 1 | Legacy compatibility; no new fencing guarantee claimed. |
| New writer / contract 1 | Uses the generation lease after expand; old writers can still coexist. |
| Old writer / contract 2 | Legacy acquisition returns false; direct session/child writes are rejected. |
| New writer / contract 2 | Fixed token/generation and unexpired lease required at each protected write. |
| Old browser / new contract 2 startup | Missing request identity is rejected with `reload_required` HTTP 409 before session insertion. |

Initial outbound/internal operations carry a browser UUID, actor identity and immutable request fingerprint. A unique database index arbitrates simultaneous inserts. Their validated dial destination, caller number, SIP destination and original input are frozen with the session. A retry first recovers this session, before mutable preflight or reservation validation. A proved absence of a provider dispatch journal row permits recovery of the frozen plan under ownership. Accepted results return the same exact leg. Unknown results remain pending without creating another session or provider leg. A changed payload with the same request UUID is rejected. Callback retries forward the same identity and recover their frozen request before recalculating mutable callback/line settings.

## Command journal and evidence

The journal stores the stable internal command identity, canonical SHA-256 payload fingerprint, immutable wire payload, path/method, original dispatch token/generation, first dispatch time, raw accepted response and durable rate-limit deadline. It commits the intent before HTTP dispatch. A crash in the small intent-before-dispatch gap is conservatively unknown; a local abort cannot prove that Telnyx did not receive the command.

A response may be recorded against its original dispatch tuple after lease loss. That operation only records evidence; it cannot mutate call topology or authorize a successor command. If the evidence write also fails, replay stays unknown and cannot create a duplicate. Exact signed, correlated provider events are examined before pending-effect replay. A dial can be adopted from an exact, uniquely matching opaque client state; ambiguous matches remain unknown. Answer, hangup, bridge and supported conference observations use operation-specific matching. A conference-created event additionally verifies the exact conference ID/name with one provider GET. A shared provider session ID is never sufficient evidence.

Conference endpoints that omit `command_id` from their documented wire schema still receive an internal journal identity; the undocumented field is not sent. The existing compact client-state wire size remains unchanged.

## Retry matrix

| Used endpoint family | Accepted result / unknown outcome |
| --- | --- |
| `POST /calls` (dial) | Adopt stored exact `call_control_id`; after unknown response require exact event evidence. No blind redial at 61 seconds, 301 seconds, or earlier. |
| Call `answer`, `hangup` | Matching exact-leg provider fact can resolve unknown before replay. A definite already-gone response uses the existing endpoint-specific handling. |
| Call `bridge` | Match the exact source and command-specific client-state intent bound to the immutable target; never infer a bridge from the shared session ID. |
| Call `transfer` | Accepted response is replayed from the journal. Unknown does not automatically resend a transfer; stronger target-leg evidence is required. |
| `POST /conferences` | Adopt accepted conference ID. A matching creator leg plus exact ID/name lookup may resolve unknown; no blind create. |
| Conference `join`, `leave` | Exact conference and leg event, and only one candidate pending command, can resolve unknown. |
| Conference `hold`, `unhold`, `mute`, `unmute`, `update`, supervisor role changes | Internal command identity and stable payload, without assuming that every endpoint supports provider command deduplication. Unknown requires endpoint-specific state evidence; no generic POST retry. |
| Playback, speak, gather, stop, recording start/stop | Existing recording/privacy and continuation guards remain. Accepted responses are journaled; an unrelated saved-recording event is not proof that capture is currently active or stopped. Unknown is never converted to success by a generic retry policy. |
| Provider GET | Bounded read, no mutation journal entry. |

Definite non-429/non-408 HTTP 4xx is stored as rejected and is not resent unchanged. HTTP 429 retains the entire `Retry-After`; it is never truncated. A single in-request retry is allowed only when the full wait and attempt fit the remaining deadline; otherwise the durable next-attempt time controls a later attempt. HTTP 5xx, network failure and timeout remain unknown. The implementation deliberately uses no generic 5xx hedge or assumed indefinite deduplication. The [Telnyx retry guidance](https://developers.telnyx.com/docs/voice/programmable-voice/command-retries), [dial contract](https://developers.telnyx.com/api-reference/call-commands/dial), [transfer contract](https://developers.telnyx.com/api-reference/call-commands/transfer-call) and [conference-create contract](https://developers.telnyx.com/api-reference/conference-commands/create-conference) were checked separately; their schemas are not interchangeable.

## Work bounds and termination

The work section is bounded to 24 seconds. Lease TTL is 15 seconds regardless of recording flags; each provider dispatch renews ownership, and an expired generation cannot be renewed. Each database request has a four-second abort signal within the scope. Provider attempts include response-body consumption and are limited to five seconds, within a twelve-second total operation budget and the remaining work deadline. Acceptance evidence has its own bounded database request. Unrelated unscoped database writes receive no new timeout policy. Request metrics count database headers latency separately from provider body-complete attempt time and whole continuation checkpoints.

Hangup commits a durable termination intent before waiting for ownership. New provider mutation intents are refused once termination has committed, except permitted cleanup. Previously admitted, in-flight commands cannot be recalled; a late accepted dial stays journaled and is compensated by exact-leg hangup when ownership next processes the session. Termination schedules `termination_next_attempt_at` before ownership acquisition, including a crash before the first cleanup handler. Each accepted dial has an immutable cleanup checkpoint. One unknown hangup does not block another leg or incoming provider evidence; lease loss aborts the pass. Unknown/in-flight dial rows retain the obligation, late accepted HTTP/event evidence re-arms it, and a pass with no remaining obligations clears the schedule. App requests report uncertain cleanup as retryable, while the existing five-minute cron handles subsequent passes. An unresolved operation may wait for a provider event, the next request, or the existing five-minute cron. This architecture does not promise independent immediate recovery during a total provider/database outage.

## Local evidence and release gates

`tests/postgres/telephony-fencing.py` uses only loopback PostgreSQL and PostgREST, creates an isolated database and terminates its temporary HTTP process. It verifies actual concurrent row locks, stale-generation staging/checkpoints/children, mixed writer contracts, immutable command reuse, accepted evidence after takeover, unknown outcomes older than 60 seconds, rate-limit deferral, termination cleanup, 20 simultaneous initial-session inserts and real PostgREST request-header enforcement.

Provider-journal unit tests exercise the real Telnyx HTTP adapter around acceptance, lost response, evidence-write failure, takeover and changed arguments. Initial-operation tests cover frozen-plan recovery before dispatch, accepted HTTP retry, unknown startup and wrong-payload reuse. These are local correctness results. Full test gate, Preview validation, compatibility of every auxiliary entrypoint and an independent review are required before admission changes. Live audio, provider timing and production activation are separate evidence and are not inferred from these tests.

The direct-write guard permits only the recording processor’s monotonic `recording_source_revision` update (and automatic `updated_at`) without session ownership. Any other call-column change, revision decrease, INSERT or DELETE remains fenced. Scheduled contact-proof waits appear in cron `detail.scheduled`; due unfinished work, failed projections and uncertain termination remain failures.
