import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/20260903100000_telnyx_telephony_foundation.sql", import.meta.url),
  "utf8",
);
const realtimeMigration = readFileSync(
  new URL("../supabase/migrations/20260915100000_telephony_realtime.sql", import.meta.url),
  "utf8",
);
const round2Migration = readFileSync(
  new URL("../supabase/migrations/20260917100000_telnyx_fixes_round2.sql", import.meta.url),
  "utf8",
);
const ringConfigMigration = readFileSync(
  new URL("../supabase/migrations/20260918100000_ring_config_rpc.sql", import.meta.url),
  "utf8",
);
const phase3Migration = readFileSync(
  new URL("../supabase/migrations/20260919100000_telnyx_phase3_fixes.sql", import.meta.url),
  "utf8",
);
const seed = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");
const seedScript = readFileSync(new URL("../scripts/seed-demo-data.mjs", import.meta.url), "utf8");

const NEW_TABLES = [
  "motorist_telnyx_webhook_events",
  "motorist_call_sessions",
  "motorist_call_legs",
  "motorist_ring_plans",
  "motorist_ring_plan_steps",
  "motorist_ring_groups",
  "motorist_ring_group_members",
  "motorist_ring_attempts",
  "motorist_business_hours",
  "motorist_business_hours_intervals",
  "motorist_business_hours_exceptions",
  "motorist_ivr_menus",
  "motorist_ivr_options",
  "motorist_callback_requests",
  "motorist_operator_devices",
  "motorist_operator_presence",
  "motorist_pause_reasons",
  "motorist_operator_telephony_settings",
  "motorist_telephony_settings",
  "motorist_telephony_daily_usage",
];

const RECREATED_TABLES = ["motorist_call_transcripts", "motorist_sms_attempts"];

const RPCS = [
  "motorist_telnyx_claim_webhook_event",
  "motorist_session_lease_acquire",
  "motorist_session_lease_release",
  "motorist_reserve_operator",
  "motorist_advance_ring_step",
];

const CONFIG_TABLES = [
  "motorist_business_hours",
  "motorist_ring_groups",
  "motorist_ring_group_members",
  "motorist_ring_plans",
  "motorist_ring_plan_steps",
  "motorist_ivr_menus",
  "motorist_ivr_options",
  "motorist_pause_reasons",
  "motorist_telephony_settings",
];

function tableBlock(name) {
  const match = migration.match(new RegExp(`create table if not exists public\\.${name} \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(match, `table ${name} is not created`);
  return match[1];
}

test("creates every new telephony table idempotently", () => {
  for (const table of [...NEW_TABLES, ...RECREATED_TABLES]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table} \\(`), table);
  }
});

test("extends the existing call, SMS and line tables", () => {
  assert.match(migration, /alter table public\.motorist_calls\n(?:\s+add column if not exists [^\n]+\n)+/);
  for (const column of ["session_id", "ring_seconds", "ring_group_id", "operator_leg_id", "raw_latest_payload"]) {
    assert.match(migration, new RegExp(`add column if not exists ${column} `), `motorist_calls.${column}`);
  }
  assert.match(migration, /add column if not exists provider_timestamp timestamptz/);
  for (const column of ["from_sender", "messaging_profile_id", "locked_at"]) {
    assert.match(migration, new RegExp(`add column if not exists ${column} `), `motorist_sms_messages.${column}`);
  }
  for (const column of ["telnyx_number_id", "partner_name", "ring_plan_id", "ivr_menu_id", "business_hours_id", "environment"]) {
    assert.match(migration, new RegExp(`add column if not exists ${column} `), `motorist_telephony_lines.${column}`);
  }
  assert.match(migration, /create unique index if not exists telephony_lines_org_number_idx\n\s+on public\.motorist_telephony_lines \(organization_id, phone_number\)/);
});

test("defines the RPCs as SECURITY DEFINER callable by the service role only", () => {
  for (const rpc of RPCS) {
    const definition = migration.match(new RegExp(`create or replace function public\\.${rpc}\\([\\s\\S]*?\\$\\$;`));
    assert.ok(definition, `${rpc} is not defined`);
    assert.match(definition[0], /security definer/, `${rpc} must be SECURITY DEFINER`);
    assert.match(definition[0], /set search_path = ''/, `${rpc} must pin search_path`);
    assert.match(migration, new RegExp(`revoke all on function public\\.${rpc}\\([^)]*\\)\\n\\s+from public, anon, authenticated;`), `${rpc} revoke`);
    assert.match(migration, new RegExp(`grant execute on function public\\.${rpc}\\([^)]*\\)\\n\\s+to service_role;`), `${rpc} grant`);
  }
});

test("claim RPC implements the ledger contract", () => {
  const definition = migration.match(/create or replace function public\.motorist_telnyx_claim_webhook_event\([\s\S]*?\$\$;/)[0];
  assert.match(definition, /on conflict \(event_id\) do nothing/);
  assert.match(definition, /outcome := 'duplicate'/);
  assert.match(definition, /outcome := 'busy'/);
  assert.match(definition, /outcome := 'claimed'/);
  assert.match(definition, /attempts = motorist_telnyx_webhook_events\.attempts \+ 1/);
});

test("reservation and step advance are compare-and-set updates", () => {
  const reserve = migration.match(/create or replace function public\.motorist_reserve_operator\([\s\S]*?\$\$;/)[0];
  assert.match(reserve, /status in \('available', 'ringing', 'after_call_work'\)/);
  assert.match(reserve, /current_session_id is null or current_session_id = p_session_id/);
  const advance = migration.match(/create or replace function public\.motorist_advance_ring_step\([\s\S]*?\$\$;/)[0];
  assert.match(advance, /current_step = p_expected_step \+ 1/);
  assert.match(advance, /and current_step = p_expected_step/);
  const lease = migration.match(/create or replace function public\.motorist_session_lease_acquire\([\s\S]*?\$\$;/)[0];
  assert.match(lease, /lease_until is null/);
  assert.match(lease, /lease_until < pg_catalog\.now\(\)/);
});

test("enables RLS with the app_private helpers and locks the webhook ledger", () => {
  for (const table of NEW_TABLES) {
    const enabledDirectly = migration.includes(`alter table public.${table} enable row level security`);
    const enabledInLoop = new RegExp(`'${table}',?\\n`).test(migration);
    assert.ok(enabledDirectly || enabledInLoop, `${table} must be listed for RLS`);
  }
  assert.match(migration, /app_private\.motorist_is_org_member\(organization_id\)/);
  assert.match(migration, /app_private\.motorist_has_org_role\(organization_id, array\[''manager'', ''admin''\]\)/);
  assert.doesNotMatch(migration, /public\.motorist_is_org_member|public\.motorist_has_org_role/);
  assert.match(migration, /revoke all on table public\.motorist_telnyx_webhook_events from public, anon, authenticated;/);
  assert.match(migration, /grant select, insert, update, delete on table public\.motorist_telnyx_webhook_events to service_role;/);
  for (const table of CONFIG_TABLES) {
    assert.ok(new RegExp(`'${table}',?\\n`).test(migration), `${table} must be in the config RLS loop`);
  }
});

test("carries the CHECK constraints and uniqueness rules from the design", () => {
  assert.match(tableBlock("motorist_ring_plan_steps"), /timeout_secs between 5 and 120/);
  assert.match(tableBlock("motorist_ring_plan_steps"), /strategy in \('all', 'ordered'\)/);
  assert.match(tableBlock("motorist_ring_group_members"), /ring_secs between 5 and 120/);
  assert.match(tableBlock("motorist_ring_group_members"), /member_kind in \('operator', 'external_number'\)/);
  assert.match(tableBlock("motorist_ring_plans"), /fallback_kind in \('external_number', 'waiting_room', 'callback_prompt', 'hangup_message'\)/);
  assert.match(tableBlock("motorist_call_sessions"), /'received', 'greeting', 'ivr', 'ringing', 'talking', 'held', 'consulting', 'conference',\n\s+'parked', 'waiting', 'wrap_up', 'after_hours', 'callback_offered', 'missed', 'failed', 'ended'/);
  assert.match(tableBlock("motorist_call_sessions"), /telnyx_session_id text unique/);
  assert.match(tableBlock("motorist_call_legs"), /telnyx_call_control_id text not null unique/);
  assert.match(tableBlock("motorist_call_legs"), /role in \('customer', 'operator', 'consult', 'supervisor', 'external'\)/);
  assert.match(tableBlock("motorist_operator_presence"), /profile_id uuid not null unique/);
  assert.match(tableBlock("motorist_operator_presence"), /status in \('available', 'ringing', 'on_call', 'after_call_work', 'paused', 'offline'\)/);
  assert.match(tableBlock("motorist_telnyx_webhook_events"), /event_id text primary key/);
  assert.match(tableBlock("motorist_telnyx_webhook_events"), /status in \('queued', 'processed', 'failed'\)/);
  assert.match(tableBlock("motorist_telephony_settings"), /organization_id uuid not null unique/);
  assert.match(tableBlock("motorist_telephony_settings"), /destination_allowlist text\[\]/);
  assert.match(tableBlock("motorist_callback_requests"), /status in \('open', 'scheduled', 'done', 'cancelled'\)/);
  assert.match(migration, /create unique index if not exists ring_attempts_profile_open_offer_idx\n\s+on public\.motorist_ring_attempts \(profile_id\)\n\s+where result = 'offered'/);
  assert.match(migration, /create unique index if not exists ring_attempts_session_step_profile_idx\n\s+on public\.motorist_ring_attempts \(session_id, step_index, profile_id\)/);
  assert.match(migration, /create unique index if not exists ring_attempts_session_step_external_idx\n\s+on public\.motorist_ring_attempts \(session_id, step_index, external_number\)/);
  assert.match(migration, /create index if not exists call_sessions_active_idx\n\s+on public\.motorist_call_sessions \(organization_id, state\)\n\s+where state not in \('ended', 'failed'\)/);
  assert.match(migration, /create index if not exists telnyx_webhook_events_session_idx\n\s+on public\.motorist_telnyx_webhook_events \(call_session_id, received_at\)\n\s+where call_session_id is not null/);
});

test("registers updated_at triggers for every table with an updated_at column", () => {
  const triggerLoop = migration.match(/-- 13\. updated_at triggers[\s\S]*?end \$\$;/)[0];
  for (const table of [...NEW_TABLES, ...RECREATED_TABLES]) {
    if (!/updated_at timestamptz/.test(tableBlock(table))) {
      continue;
    }
    assert.ok(triggerLoop.includes(`'${table}'`), `${table} needs an updated_at trigger`);
  }
});

test("broadcasts telephony changes to the private organisation topic", () => {
  const fn = realtimeMigration.match(
    /create or replace function app_private\.motorist_broadcast_telephony_change\(\)[\s\S]*?\$\$;/,
  );
  assert.ok(fn, "the broadcast trigger function is not defined");
  assert.match(fn[0], /security definer/);
  assert.match(fn[0], /set search_path = ''/);
  assert.match(fn[0], /realtime\.broadcast_changes\(/);
  assert.match(fn[0], /'org:' \|\| v_organization_id::text \|\| ':telephony'/);
  // OLD/NEW must never be touched outside their own operation.
  assert.match(fn[0], /if tg_op = 'DELETE' then\n\s+v_organization_id := old\.organization_id;/);

  for (const table of ["motorist_call_sessions", "motorist_call_legs", "motorist_operator_presence"]) {
    assert.ok(new RegExp(`'${table}',?\\n`).test(realtimeMigration), `${table} must get a broadcast trigger`);
  }
  assert.match(
    realtimeMigration,
    /create trigger %I after insert or update or delete on public\.%I for each row execute function app_private\.motorist_broadcast_telephony_change\(\)/,
  );
});

test("authorises the private topic through organisation membership only", () => {
  assert.match(realtimeMigration, /create policy motorist_telephony_broadcast_read\n\s+on realtime\.messages\n\s+for select\n\s+to authenticated/);
  assert.match(realtimeMigration, /extension = 'broadcast'/);
  assert.match(
    realtimeMigration,
    /app_private\.motorist_is_org_member\(split_part\(realtime\.topic\(\), ':', 2\)::uuid\)/,
  );
  // The uuid cast must be guarded, otherwise any other private topic raises.
  assert.match(realtimeMigration, /when realtime\.topic\(\) ~ '\^org:\[0-9a-fA-F\]\{8\}/);
  assert.match(realtimeMigration, /drop policy if exists motorist_telephony_broadcast_read on realtime\.messages/);
  // Broadcast only: `postgres_changes` publications must not be touched.
  assert.doesNotMatch(realtimeMigration, /supabase_realtime|add table/);
});

test("lease-only session writes touch neither updated_at nor the realtime doorbell", () => {
  // The lease is taken before the reducer loads its snapshot, so a lease write
  // that refreshed `updated_at` would blind the stale-session safety net, and a
  // broadcast per lease write would triple the console's refetch rate.
  for (const trigger of ["motorist_call_sessions_updated_at", "motorist_call_sessions_broadcast_update"]) {
    assert.match(round2Migration, new RegExp(`create trigger ${trigger}[\\s\\S]*?when \\(`), trigger);
  }
  for (const column of ["'lease_token'", "'lease_until'", "'updated_at'"]) {
    assert.ok(round2Migration.includes(column), `WHEN clause ignores ${column}`);
  }
  // INSERT/DELETE keep a WHEN-less trigger (WHEN may not reference the missing row).
  assert.match(round2Migration, /create trigger motorist_call_sessions_broadcast\s+after insert or delete/);
});

test("does not reference the previous provider or dropped objects", () => {
  for (const text of [migration, realtimeMigration, seed, seedScript]) {
    assert.doesNotMatch(text, /viptel/i);
    assert.doesNotMatch(text, /motorist_telephony_numbers/);
    assert.doesNotMatch(text, /sjcsrygkkmersoczpunh/);
  }
});

test("seed files populate the routing configuration", () => {
  for (const text of [seed, seedScript]) {
    assert.match(text, /Dispečing A/);
    assert.match(text, /Dispečing B/);
    assert.match(text, /\+421900000000/);
    assert.match(text, /callback_prompt/);
    assert.match(text, /2026-12-24/);
    for (const code of ["obed", "porada", "admin"]) {
      assert.match(text, new RegExp(`['"]${code}['"]`), `pause reason ${code}`);
    }
    assert.match(text, /Spätné volanie|spätné volanie/);
    assert.match(text, /motorist_telephony_settings/);
    assert.match(text, /motorist_operator_presence/);
  }
  assert.match(seed, /insert into public\.motorist_ring_plans[\s\S]*?on conflict/);
  assert.match(seed, /'Denný'/);
  assert.match(seed, /destination_allowlist/);
});

test("the routing-configuration replace RPC is transactional, org-scoped and service-role only", () => {
  const definition = ringConfigMigration.match(
    /create or replace function public\.motorist_replace_ring_plan\([\s\S]*?\$\$;/,
  );
  assert.ok(definition, "motorist_replace_ring_plan is not defined");
  assert.match(definition[0], /security definer/);
  assert.match(definition[0], /set search_path = ''/);
  assert.match(
    ringConfigMigration,
    /revoke all on function public\.motorist_replace_ring_plan\(uuid, jsonb\)\n\s+from public, anon, authenticated;/,
  );
  assert.match(
    ringConfigMigration,
    /grant execute on function public\.motorist_replace_ring_plan\(uuid, jsonb\)\n\s+to service_role;/,
  );

  // Every section is optional and everything is scoped by the organisation.
  for (const section of ["'groups'", "'plans'", "'business_hours'", "'pause_reasons'"]) {
    assert.ok(definition[0].includes(section), `section ${section} must be handled`);
  }
  assert.match(definition[0], /organization_id = p_organization_id/);

  // Guards that only a transaction can enforce.
  for (const guard of ["cross_organization", "ring_group_in_use", "ring_plan_in_use", "business_hours_in_use"]) {
    assert.ok(definition[0].includes(guard), `guard ${guard} is missing`);
  }

  // Members and steps are re-inserted (positions are unique), and the ordered
  // strategy keeps its liveness stamps.
  assert.match(definition[0], /delete from public\.motorist_ring_group_members/);
  assert.match(definition[0], /insert into public\.motorist_ring_group_members/);
  assert.match(definition[0], /last_offered_at/);
  assert.match(definition[0], /delete from public\.motorist_ring_plan_steps/);
});

test("the ring config migration does not reference the previous provider or project", () => {
  assert.doesNotMatch(ringConfigMigration, /viptel/i);
  assert.doesNotMatch(ringConfigMigration, /sjcsrygkkmersoczpunh/);
});


// ---------------------------------------------------------------------------
// Phase 3 fixes round 1
// ---------------------------------------------------------------------------

const PHASE3_LOCKED_TABLES = [
  "motorist_business_hours",
  "motorist_business_hours_intervals",
  "motorist_business_hours_exceptions",
  "motorist_ring_groups",
  "motorist_ring_group_members",
  "motorist_ring_plans",
  "motorist_ring_plan_steps",
  "motorist_ivr_menus",
  "motorist_ivr_options",
  "motorist_pause_reasons",
  "motorist_operator_telephony_settings",
  "motorist_telephony_settings",
  "motorist_telephony_lines",
];

test("routing configuration is writable only by the service role", () => {
  // Every config table is named in the lock-down loop...
  for (const table of PHASE3_LOCKED_TABLES) {
    assert.match(phase3Migration, new RegExp(`'${table}'`), `${table} must be locked down`);
  }
  // ...the loop drops both write policies and revokes DML from the session roles...
  assert.match(phase3Migration, /drop policy if exists %I on public\.%I', table_name \|\| '_manager_write'/);
  assert.match(phase3Migration, /drop policy if exists %I on public\.%I', table_name \|\| '_organization_access'/);
  assert.match(phase3Migration, /revoke insert, update, delete on table public\.%I from anon, authenticated/);
  assert.match(phase3Migration, /grant select, insert, update, delete on table public\.%I to service_role/);
  // ...and keeps only a member `select`.
  assert.match(phase3Migration, /for select using \(app_private\.motorist_is_org_member\(organization_id\)\)/);

  // No policy anywhere in this migration may hand a write back to a manager.
  assert.doesNotMatch(phase3Migration, /for all using \(app_private\.motorist_has_org_role/);
  assert.doesNotMatch(phase3Migration, /create policy[\s\S]{0,200}for (all|insert|update|delete)/);
});

test("the device identity is per organisation", () => {
  assert.match(phase3Migration, /drop constraint if exists motorist_operator_devices_profile_id_environment_key/);
  assert.match(
    phase3Migration,
    /create unique index if not exists operator_devices_org_profile_env_idx\s+on public\.motorist_operator_devices \(organization_id, profile_id, environment\)/,
  );
});

test("the replace RPC carries optimistic concurrency and every in-use guard", () => {
  const definition = phase3Migration.match(
    /create or replace function public\.motorist_replace_ring_plan\([\s\S]*?\$\$;/,
  );
  assert.ok(definition, "motorist_replace_ring_plan v2 is not defined");
  const body = definition[0];

  assert.match(phase3Migration, /drop function if exists public\.motorist_replace_ring_plan\(uuid, jsonb\);/);
  assert.match(body, /p_expected_version integer default null/);
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = ''/);

  // Serialised per organisation, version compared and bumped inside the txn.
  assert.match(body, /pg_advisory_xact_lock/);
  assert.match(body, /stale_document/);
  assert.match(body, /routing_version = routing_version \+ 1/);
  assert.match(phase3Migration, /add column if not exists routing_version integer not null default 0/);

  // Guards that only a transaction can enforce.
  for (const guard of [
    "cross_organization",
    "ring_group_in_use",
    "ring_plan_in_use",
    "business_hours_in_use",
    "pause_reason_in_use",
    "ring_group_empty",
    "position_gap",
  ]) {
    assert.ok(body.includes(guard), `guard ${guard} is missing`);
  }

  // Structural invariants re-asserted after the inserts, not only before them.
  assert.match(body, /not exists \(\s*select 1 from public\.motorist_ring_group_members/);
  assert.match(body, /having count\(\*\) <> max\(m\.position\) \+ 1/);
  assert.match(body, /having count\(\*\) <> max\(s\.step_index\) \+ 1/);

  assert.match(
    phase3Migration,
    /revoke all on function public\.motorist_replace_ring_plan\(uuid, jsonb, integer\)\n\s+from public, anon, authenticated;/,
  );
  assert.match(
    phase3Migration,
    /grant execute on function public\.motorist_replace_ring_plan\(uuid, jsonb, integer\)\n\s+to service_role;/,
  );
});

test("the phase 3 migration does not reference the previous provider or project", () => {
  assert.doesNotMatch(phase3Migration, /viptel/i);
  assert.doesNotMatch(phase3Migration, /sjcsrygkkmersoczpunh/);
});

/**
 * The lock-down is only true while no later migration hands a write back.
 *
 * Every routing write goes through the service-role client
 * (`validateRoutingReplace` → `motorist_replace_ring_plan` → audit row); a
 * `grant insert/update/delete … to authenticated` or a write policy added later
 * would let a dispatcher repoint a production number straight through PostgREST
 * again, with none of that on the way.
 */
test("no migration after the lock-down gives the session roles a routing write back", () => {
  const LOCKDOWN = "20260919100000";
  const later = readdirSync(new URL("../supabase/migrations", import.meta.url))
    .filter((name) => name.endsWith(".sql") && name.slice(0, 14) > LOCKDOWN)
    .sort();

  for (const name of later) {
    const sql = readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
    for (const table of PHASE3_LOCKED_TABLES) {
      const grant = new RegExp(`grant[^;]*\\b(insert|update|delete|all)\\b[^;]*on\\s+table\\s+public\\.${table}[^;]*to[^;]*\\b(anon|authenticated)\\b`, "is");
      assert.doesNotMatch(sql, grant, `${name} grants a write on ${table} back to a session role`);
      const policy = new RegExp(`create policy[^;]*on\\s+public\\.${table}[^;]*\\bfor\\s+(all|insert|update|delete)\\b`, "is");
      assert.doesNotMatch(sql, policy, `${name} creates a write policy on ${table}`);
    }
    assert.doesNotMatch(
      sql,
      /drop function if exists public\.motorist_replace_ring_plan\(uuid, jsonb, integer\)/,
      `${name} drops the 3-argument replace RPC the config service calls`,
    );
  }
});

/**
 * The service calls `motorist_replace_ring_plan(uuid, jsonb, integer)`. Until
 * the routing migrations are applied, every configuration `PUT` fails at
 * runtime — `config-service.ts` maps that onto a 503 that names the migration.
 *
 * The function may be redefined by a later migration (phase 4 adds the
 * `ivr_menus` section), but every definition has to keep the same signature and
 * the same service-role-only grants, and the newest one is what the database
 * ends up with.
 */
test("every definition of the three-argument replace RPC is service-role only", () => {
  const definitions = readdirSync(new URL("../supabase/migrations", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8") }))
    .filter(({ sql }) => /create or replace function public\.motorist_replace_ring_plan\([\s\S]*?p_expected_version/.test(sql));

  assert.ok(definitions.length >= 1, "the 3-argument RPC must be defined");
  for (const { name, sql } of definitions) {
    assert.match(sql, /grant execute on function public\.motorist_replace_ring_plan\(uuid, jsonb, integer\)\n\s+to service_role;/, `${name} grant`);
    assert.match(sql, /revoke all on function public\.motorist_replace_ring_plan\(uuid, jsonb, integer\)\n\s+from public, anon, authenticated;/, `${name} revoke`);
  }

  // The last definition governs, and it is the one that knows about IVR menus.
  const latest = definitions.at(-1);
  const body = latest.sql.match(/create or replace function public\.motorist_replace_ring_plan\([\s\S]*?\$\$;/)[0];
  for (const guard of ["ivr_menu_in_use", "ivr_menu_id_required", "cross_organization", "ring_plan_in_use", "stale_document", "pg_advisory_xact_lock"]) {
    assert.ok(body.includes(guard), `${latest.name}: guard ${guard} is missing`);
  }
  assert.match(body, /nullif\(p_document -> 'ivr_menus', 'null'::jsonb\)/);
  assert.match(body, /delete from public\.motorist_ivr_options o/);
});

/**
 * The Phase 4 statistics views (`20260921100000_telephony_stats_views.sql`).
 *
 * These are the wallboard's numbers. Three properties have to hold or the board
 * lies:
 *
 * 1. the views exist under the names `src/server/telephony/stats.ts` selects;
 * 2. they run with `security_invoker` and are granted to the service role only,
 *    so a session token cannot pull per-operator statistics straight out of
 *    PostgREST;
 * 3. the "the application closed this call on purpose" list in the SQL is the
 *    same list as `SYSTEM_HANDLED_END_REASONS` in
 *    `src/lib/telephony/wallboard.ts`. The fallback path in TypeScript and the
 *    view answer the same question for the same screen; a reason added to one
 *    side only would turn served callers into abandonment on whichever path
 *    happened to answer.
 */
test("the phase 4 statistics views are service-role only and agree with the TypeScript definitions", () => {
  const statsMigration = readFileSync(
    new URL("../supabase/migrations/20260921100000_telephony_stats_views.sql", import.meta.url),
    "utf8",
  );

  for (const view of ["motorist_call_stats_daily", "motorist_operator_status_durations"]) {
    assert.match(statsMigration, new RegExp(`create view public\\.${view}\\s*\\n?\\s*with \\(security_invoker = on\\)`, "i"), `${view} definition`);
    assert.match(statsMigration, new RegExp(`revoke all on table public\\.${view} from public, anon, authenticated;`), `${view} revoke`);
    assert.match(statsMigration, new RegExp(`grant select on table public\\.${view} to service_role;`), `${view} grant`);
    assert.doesNotMatch(statsMigration, new RegExp(`grant[^;]*on table public\\.${view}[^;]*to[^;]*\\b(anon|authenticated)\\b`, "is"), `${view} must not be granted to a session role`);
  }

  // Both group by the local calendar day, not by UTC: the wall clock behind the
  // display is what "dnes" means to the people reading it.
  const dayExpressions = statsMigration.match(/at time zone 'Europe\/Bratislava'\)::date/g) ?? [];
  assert.ok(dayExpressions.length >= 2, "both views must group by the local day");

  const wallboard = readFileSync(new URL("../src/lib/telephony/wallboard.ts", import.meta.url), "utf8");
  const declared = wallboard.match(/SYSTEM_HANDLED_END_REASONS[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(declared, "SYSTEM_HANDLED_END_REASONS must be a literal array");
  const reasons = [...declared[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.ok(reasons.length > 0, "at least one system-handled reason");

  const sqlLists = [...statsMigration.matchAll(/end_reason\s*(?:=|<>)\s*(?:any|all)\s*\(array\[([^\]]+)\]\)/g)];
  assert.equal(sqlLists.length, 2, "system_handled and abandoned each spell the list out");
  for (const [, list] of sqlLists) {
    const inSql = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
    assert.deepEqual(inSql, reasons, "the SQL end_reason list must match SYSTEM_HANDLED_END_REASONS");
  }

  // The service level is a product promise (< 20 s); it is spelled out in both
  // places and must not drift.
  assert.match(statsMigration, /answer_seconds <= 20\)::bigint as answered_within_20s/);
  assert.match(wallboard, /SERVICE_LEVEL_SECONDS = 20/);
});
