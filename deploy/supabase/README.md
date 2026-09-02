# Supabase dispatch migration runbook

This runbook moves the live project `jcwbiulwuwyrnmzjjbgr` to the Frankfurt
project `sjcsrygkkmersoczpunh`. It never deletes the source and it does not
perform application cutover. Target cron, HTTP queue work, and worker job
controls remain disabled throughout the migration.

Do not run `bootstrap-runtime.mjs` for this migration. Do not run a demo seed.

## Safety invariants

- Capture credentials only with the hidden interactive helper. It writes an
  atomic mode-600 file under the gitignored `.context/secrets` directory.
- Every restorable production snapshot requires a source write-freeze receipt.
  The freeze sets new source DB sessions read-only, terminates old sessions,
  disables source cron while recording the previously active job IDs, performs
  an official source project/database restart to evict managed superuser
  sessions, proves a strictly newer database-sourced postmaster timestamp, and must
  remain active until cutover. This prevents same-count updates after the
  snapshot from being lost.
- The restore accepts only a quarantined empty target and repeats that check
  under advisory and platform-table locks. Auth users, buckets, migration
  history, and Vault must all be empty before it writes.
- Schema/data restore, Vault replay, worker controls, security reconciliation,
  and exact migration-history normalization commit in one transaction. A
  failure in any phase rolls everything back.
- Password-bearing database URLs are split through stdin into a protected
  `pgpass` file and a password-free URL. Database client argv never contains a
  password.
- On macOS, `MIGRATION_DOCKER_SSH_RELAY=1` requires the source and target DB
  URLs to use direct project hostnames on local ports `15432` and `25432`, with
  `sslmode=verify-full` and the official Supabase `prod-ca-2021` certificate
  mounted read-only at `/run/secrets/supabase-ca.crt`. Migration containers map
  only those two hostnames to Docker Desktop's host gateway, while a separately
  managed SSH control connection forwards the loopback ports through Hetzner.
  This keeps CA and TLS hostname verification and does not copy database
  secrets to the server.
- Relay database sessions authenticate only as Supabase `cli_login_*` roles,
  then explicitly `SET ROLE postgres`. Before freeze, the control-plane-created
  roles are extended to an eight-hour, recorded `VALID UNTIL`; preflight
  refuses them with fewer than four hours remaining. After the source is
  frozen, source validation switches to the official read-only Management API
  query endpoint and only the target CLI role is refreshed or extended. This
  avoids a write transaction against the frozen source. Refresh cannot
  overwrite a still-valid extended role, and cleanup is receipt-bound.
- Database dump plaintext exists only while it is being encrypted and is
  removed by an exit trap. A no-manifest attempt is discarded on retry because
  an untrappable crash could have left plaintext in it. Snapshot files and
  their manifest are mode 600.
- `cron` and `net` data are not restored. Worker controls are created disabled
  and are disabled again during post-restore reconciliation.
- Storage copy is resumable, never uses a delete operation, and refuses target
  objects that are not already a valid subset of source.
- Target Storage accepts either an explicit generated S3 pair or the official
  session-token mode. The two modes are mutually exclusive; session-token mode
  requires the target project ref as access key, the legacy anon JWT as secret,
  and a service-role JWT as the session token.
- A successful database report is not a cutover approval. Storage payload,
  project config, application smoke, and operational checks remain separate
  gates.

## Rehearsal or migration sequence

From the repository root:

```zsh
deploy/supabase/manage-db-relay.zsh start
deploy/supabase/capture-migration-credentials.zsh
deploy/supabase/refresh-temporary-db-credentials.zsh --refresh-both-projects
deploy/supabase/extend-temporary-db-credentials.zsh --extend-both-to-eight-hours
deploy/supabase/manage-db-relay.zsh preflight
snapshot_id="$(date -u +%Y%m%dT%H%M%SZ)"
deploy/supabase/freeze-source-for-cutover.zsh "${snapshot_id}" --freeze-source-for-cutover
deploy/supabase/export-source-snapshot.zsh "${snapshot_id}" --require-source-write-freeze
deploy/supabase/capture-project-config-snapshot.zsh "${snapshot_id}"
deploy/supabase/restore-target-snapshot.zsh "${snapshot_id}" --restore-empty-target
deploy/supabase/validate-target-snapshot.zsh "${snapshot_id}"
deploy/supabase/validate-auth-snapshot.zsh "${snapshot_id}"
deploy/supabase/copy-storage-snapshot.zsh "${snapshot_id}" --copy-storage
deploy/supabase/apply-project-config-snapshot.zsh "${snapshot_id}" --apply-non-secret-config
deploy/supabase/capture-project-config-snapshot.zsh "${snapshot_id}" --refresh-target-after-application
deploy/supabase/validate-project-config-snapshot.zsh "${snapshot_id}"
deploy/supabase/prepare-target-runtime-credentials.zsh --prepare-frankfurt-runtime
```

The combined cutover gate reruns Storage through
`validate-storage-rest.zsh`. It uses read-only Management API inventory plus
authenticated Storage REST streaming, so revoked source S3 credentials stay
revoked. It never copies or deletes objects, compares every source payload with
the target by SHA-256 and size, and permits target-only growth only in the
continuity policy's live bucket.

If the original extended roles expire while the source remains frozen, do not
unfreeze it and do not use the two-project refresh command. Confirm the freeze
through the read-only Management API, refresh only the target role, extend it,
and repeat the relay preflight:

```zsh
deploy/supabase/refresh-target-db-credential-after-source-freeze.zsh \
  --refresh-target-with-source-readonly-api
deploy/supabase/extend-target-db-credential-after-source-freeze.zsh \
  --extend-target-to-eight-hours
deploy/supabase/manage-db-relay.zsh preflight
```

After the target runtime environment and release bundle exist, consolidate all
database, Auth, Storage, config, application, live freeze, disabled-job, image,
and runtime-environment evidence into one fail-closed predeployment gate:

```zsh
deploy/supabase/validate-cutover-gate.zsh \
  "${snapshot_id}" \
  "${DEPLOYMENT_VERSION}"
```

The generated `cutover-gate-<snapshot>.json` contains status-only evidence and
explicitly records that no production cutover has happened. A pass authorizes
only reversible server staging; DNS and production installation still require
the final operational gate. Its `validated_at_utc` is the oldest component
timestamp, not the time when the final JSON was written. The gate rejects a run
or any DB/Auth/Storage/config/image/operational component older than 30 minutes
and records the start, completion, duration, maximum component age, and exact
component count. The server independently checks that evidence window and
rejects malformed, future, or older-than-30-minute timestamps in both probe and
install mode. Generate a fresh gate immediately before each server action; a
previously passing gate is not reusable after it expires.

The private server check is intentionally non-production:

```bash
deploy/bin/install-release.sh RELEASE_DIR RUNTIME_ENV_DIR CUTOVER_GATE \
  --probe-candidate-only
```

It binds the candidate only to a loopback port, removes the candidate after the
checks, and creates no production receipt. After authoritative DNS points to
the server, the one-shot production action is:

```bash
deploy/bin/install-release.sh RELEASE_DIR RUNTIME_ENV_DIR CUTOVER_GATE \
  --install-after-dns-cutover
```

The production action refuses an existing stack or receipt and creates a
mode-600 append-only operational JSONL receipt under
`/opt/motorist/receipts`. Copy the successful receipt without changing it to
the gitignored `.context/migration/cutover-receipts` directory before cleanup.

The runtime credential helper reads the target's existing default publishable
and secret keys through the Management API and atomically writes only a
mode-600, gitignored override file. It also overwrites every supported legacy
Supabase environment alias with the Frankfurt values, so an older base env
cannot leak source-project credentials into the release. It never creates a
new API key and never prints key values.

Build the production bundle with the target guard explicitly enabled:

```zsh
EXPECTED_SUPABASE_PROJECT_REF=sjcsrygkkmersoczpunh \
EXPECTED_PRODUCTION_GIT_SHA="<exact-40-character-production-git-sha>" \
BUILD_OVERRIDES_FILE=.context/secrets/runtime-overrides.env \
DEPLOYMENT_VERSION="hetzner-$(date -u +%Y%m%dT%H%M%SZ)" \
deploy/bin/build-release.sh
```

This single-image blue/green layout uses the 32-byte Server Actions encryption
key generated and embedded by Next.js during `next build`; runtime env
generation deliberately excludes `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` so it
cannot override that image-bound key. A future deployment that mixes multiple
independently built images behind one load balancer must inject one shared key
at build time through a BuildKit secret, never a Docker build argument or a
runtime-only value.

Every release also creates a mode-600, gitignored build-input contract under
`.context/migration/build-input-contracts`. Its canonical digest binds every
exact public Docker build argument to the manifest, application report, gate,
installer, and cutover receipt. The gate recomputes that digest against the
approved runtime target aliases. Both local smoke validation and the server
installer scan the compiled browser assets: the Frankfurt project ref must be
present and the source project ref must be absent. A changed repository input,
public build argument, or runtime alias requires a new release.

The config application step is drift-checked and idempotent after a partial
failure. It applies only the reviewed Auth/PostgREST/Storage/Realtime fields
that differ in the immutable snapshot. It never copies JWT, provider, SMTP,
SMS, captcha, hook, password, token, or key credentials.

The relay uses strict host-key checking, a pinned local identity, disabled
agent forwarding, loopback-only forwards, and keepalives. Never start the
source freeze unless the authenticated TLS preflight passes for both projects.
The stop command refuses while any receipt is `preparing`,
`restart_requested`, or `frozen`.

If the relay drops while a freeze receipt is `preparing`, restart the exact
same forwards and use the explicit abort command before retrying with a new
snapshot ID. If it drops during export, the next export attempt discards the
no-manifest directory before starting again so plaintext is never archived. If a
connection drops around the target transaction commit, treat the outcome as
indeterminate: reconnect, inspect the target with the empty guard/validation,
and retry restore only when the target is confirmed empty. Never assume a
client-side connection error means the server rolled the transaction back.

The freeze command starts the production maintenance window. Before typing its
exact confirmation, stop external writers and enable application maintenance
mode. Restore, database validation, Storage copy, config validation, smoke
tests, and cutover must all use the same snapshot ID while the source receipt
remains unchanged and the source reports read-only with zero active cron jobs.
If migration is aborted before cutover, restore source writes and exactly the
previously active source cron IDs with:

```zsh
deploy/supabase/abort-source-freeze.zsh "${snapshot_id}" --abort-migration-and-unfreeze-source
deploy/supabase/revoke-extended-db-credentials.zsh --revoke-after-abort
```

Do not use the abort command after a successful cutover unless the explicit
decision is to roll production back to the source.

After a successful cutover, keep the source frozen and revoke only the target
CLI role by presenting the copied successful receipt:

```zsh
deploy/supabase/revoke-extended-db-credentials.zsh \
  --revoke-after-cutover \
  "$PWD/.context/migration/cutover-receipts/cutover-RELEASE.jsonl"
```

The database snapshot contains:

- custom roles, application schema, Auth/application/Storage metadata data,
- source migration-history schema plus encrypted history evidence (source rows
  are not replayed),
- an aggregate-only baseline with no row values or object names,
- a Vault replay payload that is encrypted before plaintext cleanup.

The target migration history is normalized to the exact repository migration
version set in the same transaction as restore and security reconciliation.

## Required manual validation before cutover

The encrypted config snapshot covers project metadata, Auth, PostgREST,
Storage, Realtime, Postgres tuning, Supavisor pooler, SSL enforcement, network
restrictions, and readonly state. Compare and deliberately apply source
settings to the target through the Supabase Management API or Dashboard. Do
not blindly copy masked OAuth, SMTP, CAPTCHA, SMS, or hook secrets; enter
required values through a hidden credential flow and validate external
callback URLs. Then run the explicit target refresh: it appends new encrypted
`target-final` artifacts without overwriting the immutable source/initial-target
baseline, and remains bound to the same live freeze receipt. Validation refuses
the stale initial target capture. A missing or mismatched config report keeps
cutover blocked.

Before changing any production application environment variable, verify:

- Auth site URL, redirect allow-list, email/password behavior, SMTP/templates,
  enabled providers, rate limits, session policy, and password policy;
- Data API schemas/grants and Realtime publication/config;
- Postgres tuning, Supavisor pool mode/size, SSL enforcement, network CIDRs,
  readonly state, target Frankfurt region, and connection-path capacity;
- all expected extensions and both Vault secrets;
- all six Storage buckets, content checks, public/private flags, limits, MIME
  restrictions, and signed/public download behavior;
- target security/performance advisors and application read/write smoke tests;
- all target/Hetzner scheduler controls are still disabled;
- the source freeze receipt hash still matches the DB, Storage, and config
  reports, and a fresh source connection is still read-only with zero active
  cron jobs;
- users can sign in again. Password hashes migrate, but old JWTs are invalid
  because the new project has different signing keys.

Only after every gate is recorded as passing may the Vercel/Hetzner Supabase
URL and keys be changed. Keep jobs disabled during the first application smoke
window and retain the source project, still frozen, for rollback. Unfreeze it
only as part of an explicit rollback; never allow both source and target to
accept production writes.
