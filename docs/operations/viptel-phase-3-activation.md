# VIPTel Phase 3: activation and acceptance

Phase 3 does not require a database migration. Deploying the web application alone also does not start the durable-history services. The VIPTel listener and scheduler intentionally remain behind the existing exact-release activation gate.

## Permanent listener-only runtime

When the production web remains on Vercel and scheduled reconciliation is not
approved, use the listener-only activator from the exact release. It starts only
`viptel_listener`; it neither starts `worker` nor changes a scheduler or any row
in `motorist_job_controls`.

Before activation, build and stage a release whose manifest `gitSha` is the
exact commit deployed to production. The listener runtime must be private,
bound to that release, and initially contain both
`VIPTEL_LISTENER_ENABLED=false` and `VIPTEL_LIVE_MUTATIONS_ENABLED=false` plus a
server-only `VIPTEL_LIVE_MUTATION_TOKEN` of at least 32 non-whitespace
characters. Never print or pass the token as a command argument.

`deploy/bin/build-release.sh` refuses tracked or untracked worktree changes and
requires `EXPECTED_PRODUCTION_GIT_SHA` to equal the full current `HEAD`. Build
from a dedicated clean worktree at the production commit; do not build the
listener image from a feature-branch SHA whose tree merely appears equivalent.

```sh
/opt/motorist/releases/<current-release>/bin/activate-viptel-listener-only.sh \
  /opt/motorist/releases/<current-release> \
  <exact-40-character-production-git-sha>
```

The command verifies release checksums, manifest Git SHA, loaded image ID,
disabled job controls, and the unchanged worker runtime and container. A
canonical installed baseline may already have a running worker with a fresh
`scheduler_status=disabled` heartbeat and a running listener with a fresh
`viptel_ws_status=disabled` heartbeat; neither is treated as active work. Any
running scheduler, live WebSocket, stale/mismatched baseline, or enabled job
still fails closed. The command atomically enables the listener and its
live-mutation guard in the single private listener env file, recreates only the
listener with Compose `--no-deps`, then requires a fresh `connected` heartbeat
from the exact release. Its private append-only receipt is written under
`/opt/motorist/receipts` with mode `0600`.

If any step fails, automatic rollback atomically disables both listener flags,
stops only `viptel_listener`, verifies that the worker container and runtime
remained unchanged and scheduler-disabled, confirms that all job controls are
still disabled, and records either
`rollback_complete` or `rollback_incomplete`. Do not bypass an incomplete
receipt with manual flag editing; inspect the exact container/runtime state and
restore the listener env from the checksum-bound release evidence.

### Existing active listener from an older release

The listener-only activator is deliberately not an old-to-new handover tool. It
fails before mutation when either the running worker or listener belongs to a
different release, or when the existing listener WebSocket is already active.
In particular, do not manually stop an older listener just to make this
preflight pass: this activator's rollback can stop the selected new listener,
but it has no checksum-bound authority or runtime snapshot with which to
restore the older one.

An already-active installation needs the separate handover operation below.
It binds and validates both release inventories and image IDs, snapshots the
old listener env and container identity, proves the worker and exact existing
job-control set remain unchanged, recreates only `viptel_listener`, and
restores and health-checks the exact old listener if the new listener does not
connect. Any active topology outside its explicit preserved-state contract is
a hard fail-closed boundary, not a reason to bypass validation.

For the current active topology, where the old worker intentionally keeps
`SCHEDULER_ENABLED=true` and the only enabled job is
`telephony.viptel.reconcile`, use the dedicated two-step handover instead. The
first step stages an exact candidate without touching the running Compose
project. Prepare its private runtime source from the exact old `web.env` and
`viptel-listener.env` plus a separate mode-0600 override; the generator never
prints secret values:

These commands are an operator runbook. Adding and testing them in the
repository does not stage a release or execute a handover on Hetzner.

The candidate checksum inventory includes the runtime generator, its contract
validator, and `runtime-env-parser.mjs`, so this command runs from the uploaded
bundle and does not assume a repository checkout on the server:

```sh
node <uploaded-candidate>/bin/prepare-runtime-env.mjs \
  --base /opt/motorist/releases/<old-version>/env/web.env \
  --integrations /opt/motorist/releases/<old-version>/env/viptel-listener.env \
  --overrides /opt/motorist/private/<new-version>-overrides.env \
  --out /opt/motorist/private/<new-version>-runtime \
  --version <new-version>
```

The override must keep both listener activation flags initially `false`, set a
server-only `VIPTEL_LIVE_MUTATION_TOKEN` of at least 32 characters, and set the
independent provider-snapshot bridge explicitly:

```text
VIPTEL_LIVE_MUTATIONS_ENABLED=false
VIPTEL_LIVE_MUTATION_TOKEN=<server-only-token-at-least-32-characters>
VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED=true
VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN=<server-only-token-at-least-32-characters>
VIPTEL_DISPATCH_PERSONAL_EXTENSIONS=20,21,22,23
```

The bridge gate is not the live-mutation gate. Staging and handover require the
bridge to remain explicitly enabled with its own valid token, while handover
atomically changes only `VIPTEL_LISTENER_ENABLED` and
`VIPTEL_LIVE_MUTATIONS_ENABLED`. No `NEXT_PUBLIC_VIPTEL_PROVIDER_SNAPSHOT_*`
key is permitted. Production Vercel must separately have the corresponding
server-only bridge configuration with its own independent token before the
test UI requests a live snapshot; the two local authority tokens are never
authenticated through the database. Each authority token must be identical in
`web.env` and `viptel-listener.env`; the live-mutation token and snapshot-bridge
token must remain two different secrets.

Run staging from the uploaded, not-yet-installed candidate bundle. The target
`/opt/motorist/releases/<new-version>` must not exist:

```sh
<uploaded-candidate>/bin/stage-viptel-listener-handover.sh \
  <uploaded-candidate> \
  /opt/motorist/private/<new-version>-runtime \
  <exact-production-web-git-sha>
```

Staging validates and privately captures the exact bundle and all four runtime
files, validates Compose configuration, loads and verifies the immutable image,
then atomically renames the candidate into the canonical release directory. It
does not start, stop, or recreate any service.

After reviewing the mode-0600 staging receipt, run the handover from the staged
new release:

```sh
/opt/motorist/releases/<new-version>/bin/handover-viptel-listener-only.sh \
  /opt/motorist/releases/<old-version> \
  /opt/motorist/releases/<new-version> \
  <exact-old-release-git-sha> \
  <exact-production-web-git-sha>
```

This operation checksum-binds both releases and images, captures the exact old
worker container/mount/runtime and old listener runtime, and requires the
existing scheduler heartbeat plus the exact preserved job set
`[telephony.viptel.reconcile]`. It recreates only `viptel_listener`. Success
requires a fresh connected heartbeat from the new release while the worker,
scheduler, job controls, old runtime, and web deployment remain unchanged. A
failure restores and health-checks the exact old listener image and env; an
unproven restore is recorded as `rollback_incomplete`.

This command covers the current one-time co-versioned baseline, where the old
worker and old listener both originate from `<old-version>`. After a successful
handover the worker intentionally remains old while the listener is new, so do
not reuse this two-release interface for a later listener upgrade.

### Later listener-only upgrade with a preserved older worker

After the first handover, use the dedicated three-release upgrade interface.
It requires three distinct canonical release directories and three exact Git
SHAs: the still-running worker, the currently running listener used for
rollback, and the newly staged listener matching the production web:

```sh
/opt/motorist/releases/<new-listener-version>/bin/upgrade-viptel-listener-only.sh \
  /opt/motorist/releases/<worker-version> \
  /opt/motorist/releases/<old-listener-version> \
  /opt/motorist/releases/<new-listener-version> \
  <exact-worker-git-sha> \
  <exact-old-listener-git-sha> \
  <exact-production-web-git-sha>
```

The command checksum-binds all three immutable releases, images, private
runtime files, and the exact running container mounts before changing
anything. It preserves the complete worker container snapshot, the running
scheduler, and the exact enabled job set
`[telephony.viptel.reconcile]`. Its only Compose mutation is a forced recreate
of `viptel_listener` with `--no-deps`.

Success requires a connected listener heartbeat from the new release that is
newer than the recreate boundary; a merely recent row left by an earlier
attempt is not accepted. On failure, the candidate flags are returned to their
exact disabled fingerprint, its running process is stopped, and only then may
the command recreate the old listener from its own image and env. If restore
fails, bounded stop/kill containment runs again and the candidate must remain
stopped. Rollback is complete only after a fresh connected old-release heartbeat
newer than the rollback boundary and another proof that the worker, scheduler,
controls, and all release bindings stayed unchanged. The private mode-0600
JSONL receipt records all three identities and either `upgrade_complete`,
`rollback_complete`, or `rollback_incomplete`. The last complete, valid
hash-chained record is authoritative; a corrective rollback record may therefore
follow a fully written success record when the original durable append reported
an I/O failure.

Do not substitute the worker or old-listener path with the new release, and do
not manually stop the active listener. If the three live bindings do not match,
the command must fail before mutation and the mismatch must be investigated.

After success, verify as an authenticated manager that
`/api/telephony/health` reports the WebSocket as live. After disabled-baseline
listener-only activation, reconciliation remains `disabled` because no
scheduler or job was enabled. After the explicit old-to-new handover,
reconciliation remains enabled because the existing worker and exact
`telephony.viptel.reconcile` control were deliberately preserved. Listener
connect may also perform its configured one-time reconciliation when
`VIPTEL_RECONCILE_ON_CONNECT=true`.

## Temporary Vercel web + Hetzner telephony runtime

When scheduled CDR reconciliation is separately approved, an exact current
release may run both background `worker` and `viptel_listener` services on
Hetzner. Use
`deploy/bin/activate-telephony-background.sh` from that release. This path:

- starts Compose with `--no-deps`, so Caddy and both web containers remain stopped;
- requires all 11 job controls to be disabled before startup;
- enables only `telephony.viptel.reconcile` after both runtime heartbeats are fresh
  and the VIPTel WebSocket reports `connected`;
- writes an append-only private activation receipt;
- disables only the reconciliation job and stops both services if activation fails.

The runtime files must be private, target-only, initially disabled, and bound to
the exact release version before this command runs. Never reuse an old release
manifest or activate the July 2026 staged web release for this purpose.

```sh
/opt/motorist/releases/<current-release>/bin/activate-telephony-background.sh \
  /opt/motorist/releases/<current-release>
```

This is a temporary topology. A later full Hetzner web cutover must use the normal
cutover and activation gates and deliberately adopt or stop these two containers.

## Prerequisites

- Disabled-baseline and full activation require the same release/image for the
  Hetzner worker and listener. The explicit handover above instead preserves
  and validates the old worker while moving only the listener to the new
  release, so its split versions are intentional.
- The listener runtime has the production Supabase and VIPTel credentials.
- VIPTel permits the Hetzner public IP for REST and WebSocket access.
- `motorist_telephony_extensions.profile_id` contains the operator assignments from Phase 2.
- `motorist_telephony_lines` contains the public received numbers and `motorist_telephony_queues.external_id` contains the PBX queue numbers. A queue should reference its public line through `line_id`.

Missing line/queue configuration does not discard a call. Provider IDs, raw events and CDR numbers are still stored, but the friendly line/queue labels cannot be correlated.

## Full Hetzner web cutover only

This section is not part of the permanent listener-only topology above. Use it
only when the complete Hetzner web cutover and scheduled reconciliation have
been separately approved. Do not run `activate-after-cutover.sh` to activate a
standalone listener: it intentionally enables the full pre-approved job set.

For a full cutover, use the existing receipt-bound Hetzner release workflow. Do
not manually edit the listener env or only flip
`motorist_job_controls.enabled`; that bypasses the release, one-shot and
rollback evidence.

The final operation is `deploy/bin/activate-after-cutover.sh` from the exact installed production release. Its contract requires the complete pre-approved job set and `--enable-viptel-listener` in one gated operation. The required cutover receipt, activation gate and one-shot receipt directory are produced by the deployment runbook in `docs/operations/dispecing-hetzner-handoff.md`.

After activation:

- `VIPTEL_LISTENER_ENABLED=true` must be active only in the listener runtime.
- `telephony.viptel.reconcile` must be enabled in `motorist_job_controls`.
- `/api/telephony/health` should report the WebSocket listener and CDR reconciliation as live.
- the listener heartbeat should remain fresh and reconciliation should succeed at least every two minutes.

## Production telephony acceptance

Run these calls after either listener-only activation or an approved full
cutover. In listener-only mode, a connected WebSocket and the optional
one-time-on-connect reconcile are expected, but the scheduled reconciliation
job must remain disabled. The two-minute fallback mentioned below applies only
to the full-cutover topology where that job was deliberately enabled.

Before placing calls, verify dynamic workplace recovery with two test
operators. Each operator must be able to claim any offline workplace, connect
its browser phone, select queue priority 601, 602, or 603, move to another
offline workplace, and release it. If a routing command failed before reaching
VIPTel, reloading the page must resume the exact saved operation without a
second provider mutation. A command with uncertain delivery must remain
blocked for explicit administrative reconciliation.

Run at least these calls using test numbers:

1. Answer one inbound queue call on a physical phone.
2. Answer one inbound queue call in the browser.
3. Let one inbound queue call leave unanswered.
4. Make one outbound call.

Verify:

- every call appears once in the call-center history;
- history refreshes automatically after the call ends;
- unanswered queue calls are `abandoned_queue`, while direct unanswered inbound calls are `missed`;
- `received_number` is the public number that was dialled and `destination_number` is the final extension/recipient;
- the matching line, queue, extension and operator IDs are populated when their configuration exists;
- call and queue commands have a non-null `requested_by`;
- listener reconnect and the next CDR reconcile do not create duplicate logical calls.

WebSocket history should normally appear within the UI's ten-second history
poll. In the full-cutover topology only, the two-minute CDR reconciliation is
the fallback if an event was missed during a disconnect.

If live tests show duplicate API-created calls because VIPTel changes `unique_id` without exposing a correlatable parent/random ID, capture only the involved provider IDs and event types. That is the evidence threshold for the small provider-ID alias table; it is not a reason to redesign telephony storage.
