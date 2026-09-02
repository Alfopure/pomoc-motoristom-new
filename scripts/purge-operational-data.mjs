import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const EXPECTED_PROJECT_REF = "sjcsrygkkmersoczpunh";
const ACTIVE_CALL_STATUSES = ["incoming", "ringing_agent", "answered", "outbound"];
const IN_FLIGHT_COMMAND_STATUSES = ["queued", "sent", "accepted"];
const HISTORY_FLOOR_KEY = "call_history_not_before";
const ACTIVE_CALL_SAFETY_WINDOW_MS = 6 * 60 * 60 * 1000;
const CASE_ATTACHMENTS_BUCKET = "motorist-case-attachments";
const RECORDINGS_BUCKET = "motorist-call-recordings";
const PAGE_SIZE = 500;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv(path.join(rootDir, ".env.local"));

const execute = process.argv.includes("--execute");
const confirmation = argumentValue("--confirm");
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
// Prefer the current sb_secret_* key. Some local environments intentionally
// keep a retired legacy service-role value for deployment compatibility.
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const projectRef = projectRefFromUrl(supabaseUrl);

if (!supabaseUrl || !serviceKey) fail("Missing Supabase URL or service-role key in .env.local.");
if (projectRef !== EXPECTED_PROJECT_REF) {
  fail(`Refusing project ${projectRef || "unknown"}; expected the production project ${EXPECTED_PROJECT_REF}.`);
}
if (execute && confirmation !== `PURGE_OPERATIONAL_DATA_${EXPECTED_PROJECT_REF}`) {
  fail(`Execution requires --confirm=PURGE_OPERATIONAL_DATA_${EXPECTED_PROJECT_REF}.`);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const organizations = await fetchAll("motorist_organizations", "id, slug, name", (query) => query.eq("active", true));
if (organizations.length === 0) fail("No active organization found; nothing was changed.");

console.log(`Target: ${EXPECTED_PROJECT_REF} (${organizations.length} active organization(s))`);
console.log(execute ? "Mode: EXECUTE" : "Mode: DRY RUN (no writes)");

for (const organization of organizations) {
  await purgeOrganization(organization);
}

async function purgeOrganization(organization) {
  const organizationId = organization.id;
  const label = `${organization.name} (${organization.slug})`;
  const [
    cases,
    locationSubmissions,
    recordings,
    calls,
    telephonyCommands,
    locations,
  ] = await Promise.all([
    fetchAll(
      "motorist_cases",
      "id, contact_id, pickup_location_id, destination_location_id, attachments_metadata",
      (query) => query.eq("organization_id", organizationId),
    ),
    fetchAll(
      "motorist_location_submissions",
      "id, location_id",
      (query) => query.eq("organization_id", organizationId),
    ),
    fetchAll(
      "motorist_call_recordings",
      "id, storage_bucket, storage_path",
      (query) => query.eq("organization_id", organizationId),
    ),
    fetchAll(
      "motorist_calls",
      "id, status, started_at, created_at, updated_at",
      (query) => query.eq("organization_id", organizationId).order("started_at", { ascending: false }),
    ),
    fetchAll(
      "motorist_telephony_commands",
      "id, call_id, command_type, status, created_at, updated_at",
      (query) => query.eq("organization_id", organizationId),
    ),
    fetchAll(
      "motorist_locations",
      "id",
      (query) => query.eq("organization_id", organizationId),
    ),
  ]);

  const counts = await tableCounts(organizationId);
  const activeCalls = calls.filter((call) => ACTIVE_CALL_STATUSES.includes(call.status));
  const freshActiveCalls = activeCalls.filter((call) => {
    const timestamp = Date.parse(call.started_at ?? call.updated_at ?? "");
    return Number.isFinite(timestamp) && Date.now() - timestamp < ACTIVE_CALL_SAFETY_WINDOW_MS;
  });
  const callCommands = telephonyCommands.filter((command) =>
    command.call_id || command.command_type.startsWith("call."),
  );
  const inFlightCallCommands = callCommands.filter((command) => {
    if (!IN_FLIGHT_COMMAND_STATUSES.includes(command.status)) return false;
    const timestamp = Date.parse(command.created_at ?? command.updated_at ?? "");
    return Number.isFinite(timestamp) && Date.now() - timestamp < ACTIVE_CALL_SAFETY_WINDOW_MS;
  });
  console.log(`\n${label}`);
  for (const [table, count] of Object.entries(counts)) console.log(`- ${table}: ${count}`);
  console.log(`- case attachment objects: ${caseAttachmentObjects(cases).length}`);
  console.log(`- call recording objects: ${recordingObjects(recordings).length}`);
  console.log(`- active call rows: ${activeCalls.length} (${freshActiveCalls.length} fresh enough to block deletion)`);
  console.log(`- unfinished call command safety check: ${inFlightCallCommands.length}`);
  console.log(`- call-related telephony commands: ${callCommands.length}`);
  console.log(`- newest call started at: ${calls[0]?.started_at ?? calls[0]?.created_at ?? "none"}`);

  if (!execute) return;
  if (freshActiveCalls.length > 0 || inFlightCallCommands.length > 0) {
    fail(
      `Refusing to purge ${label}: ${freshActiveCalls.length} recently active call row(s), ` +
        `${inFlightCallCommands.length} unfinished call command(s).`,
    );
  }

  const purgeStartedAt = new Date().toISOString();
  await setViptelHistoryFloor(organizationId, purgeStartedAt);
  await pauseViptelCdrReconciliation();

  await removeStorageObjects(caseAttachmentObjects(cases));
  await removeStorageObjects(recordingObjects(recordings));

  // Explicit child-first order keeps the operation understandable even where
  // a foreign key also has ON DELETE CASCADE.
  await deleteOrganizationRows("motorist_notifications", organizationId);
  await deleteOrganizationRows("motorist_task_reminders", organizationId);
  await deleteOrganizationRows("motorist_location_submissions", organizationId);
  await deleteOrganizationRows("motorist_location_share_links", organizationId);
  await deleteOrganizationRows("motorist_call_transcripts", organizationId);
  await deleteOrganizationRows("motorist_call_recordings", organizationId);
  await deleteOrganizationRows("motorist_call_events", organizationId);
  await deleteOrganizationRows("motorist_sms_attempts", organizationId);
  await deleteOrganizationRows("motorist_sms_messages", organizationId);
  await deleteOrganizationRows("motorist_route_estimates", organizationId);
  await deleteIds("motorist_telephony_commands", organizationId, callCommands.map((command) => command.id));
  await deleteFilteredRows(
    "motorist_integration_raw_events",
    (query) => query.eq("organization_id", organizationId).in("provider", ["viptel", "viptel_sms"]),
  );
  await deleteFilteredRows(
    "motorist_audit_log",
    (query) => query
      .eq("organization_id", organizationId)
      .in("entity_type", [
        "motorist_cases",
        "motorist_case_tasks",
        "motorist_task_reminders",
        "motorist_notifications",
        "motorist_calls",
        "motorist_call_recordings",
        "motorist_sms_messages",
      ]),
  );
  await deleteOrganizationRows("motorist_cases", organizationId);
  // Small batches avoid the hosted statement timeout caused by repeated FK
  // checks on this historical table. The operation remains idempotent.
  await deleteIds("motorist_calls", organizationId, calls.map((call) => call.id), 10);
  await deleteOrganizationRows("motorist_vehicles", organizationId);

  await deleteFilteredRows(
    "motorist_contacts",
    (query) => query.eq("organization_id", organizationId).eq("role", "client"),
  );

  const candidateLocationIds = unique([
    ...locations.map((row) => row.id),
    ...cases.flatMap((row) => [row.pickup_location_id, row.destination_location_id]),
    ...locationSubmissions.map((row) => row.location_id),
  ]);
  await deleteUnreferencedLocations(organizationId, candidateLocationIds);

  const remaining = await tableCounts(organizationId);
  const nonEmpty = Object.entries(remaining).filter(([, count]) => count !== 0);
  if (nonEmpty.length > 0) {
    fail(`Purge verification failed for ${label}: ${JSON.stringify(Object.fromEntries(nonEmpty))}`);
  }
  console.log(`Purge verified at ${purgeStartedAt}. Preserved users, fleet, workplaces, PBX and settings.`);
  console.log("telephony.viptel.reconcile remains paused until the history-floor code is deployed to the Hetzner worker.");
}

async function tableCounts(organizationId) {
  const tables = [
    "motorist_cases",
    "motorist_case_tasks",
    "motorist_task_reminders",
    "motorist_notifications",
    "motorist_case_events",
    "motorist_location_share_links",
    "motorist_location_submissions",
    "motorist_calls",
    "motorist_call_events",
    "motorist_call_recordings",
    "motorist_call_transcripts",
    "motorist_sms_messages",
    "motorist_sms_attempts",
    "motorist_route_estimates",
  ];
  const entries = await Promise.all(tables.map(async (table) => [table, await countRows(table, organizationId)]));
  return Object.fromEntries(entries);
}

async function countRows(table, organizationId) {
  const result = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  if (result.error) throw new Error(`${table} count failed: ${result.error.message}`);
  return result.count ?? 0;
}

async function fetchAll(table, columns, filter) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    query = filter(query);
    const result = await query;
    if (result.error) throw new Error(`${table} read failed: ${result.error.message}`);
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < PAGE_SIZE) return rows;
  }
}

async function setViptelHistoryFloor(organizationId, timestamp) {
  const current = await supabase
    .from("motorist_organization_integrations")
    .select("id, config")
    .eq("organization_id", organizationId)
    .eq("provider", "viptel")
    .maybeSingle();
  if (current.error) throw new Error(`VIPTel integration read failed: ${current.error.message}`);
  if (!current.data) throw new Error("VIPTel integration is missing; refusing a call-history purge without a CDR floor.");
  const config = isRecord(current.data.config) ? current.data.config : {};
  const updated = await supabase
    .from("motorist_organization_integrations")
    .update({ config: { ...config, [HISTORY_FLOOR_KEY]: timestamp } })
    .eq("id", current.data.id);
  if (updated.error) throw new Error(`VIPTel history floor update failed: ${updated.error.message}`);
}

async function pauseViptelCdrReconciliation() {
  const result = await supabase
    .from("motorist_job_controls")
    .update({ enabled: false, updated_by: "operational_data_purge" })
    .eq("job_name", "telephony.viptel.reconcile");
  if (result.error) throw new Error(`VIPTel reconciliation could not be paused: ${result.error.message}`);
}

function caseAttachmentObjects(cases) {
  const objects = [];
  for (const row of cases) {
    if (!Array.isArray(row.attachments_metadata)) continue;
    for (const attachment of row.attachments_metadata) {
      if (!isRecord(attachment) || typeof attachment.storagePath !== "string") continue;
      objects.push({
        bucket: typeof attachment.storageBucket === "string" ? attachment.storageBucket : CASE_ATTACHMENTS_BUCKET,
        path: attachment.storagePath,
      });
    }
  }
  return uniqueObjects(objects);
}

function recordingObjects(recordings) {
  return uniqueObjects(recordings.flatMap((row) =>
    typeof row.storage_path === "string" && row.storage_path
      ? [{ bucket: row.storage_bucket || RECORDINGS_BUCKET, path: row.storage_path }]
      : [],
  ));
}

async function removeStorageObjects(objects) {
  const byBucket = new Map();
  for (const object of objects) {
    if (!byBucket.has(object.bucket)) byBucket.set(object.bucket, []);
    byBucket.get(object.bucket).push(object.path);
  }
  for (const [bucket, paths] of byBucket) {
    for (const values of chunks(paths, 100)) {
      const result = await supabase.storage.from(bucket).remove(values);
      if (result.error) throw new Error(`${bucket} storage cleanup failed: ${result.error.message}`);
    }
  }
}

async function deleteOrganizationRows(table, organizationId) {
  await deleteFilteredRows(table, (query) => query.eq("organization_id", organizationId));
}

async function deleteFilteredRows(table, filter) {
  const result = await filter(supabase.from(table).delete());
  if (result.error) throw new Error(`${table} delete failed: ${result.error.message}`);
}

async function deleteIds(table, organizationId, ids, batchSize = 100) {
  for (const values of chunks(unique(ids), batchSize)) {
    const result = await supabase.from(table).delete().eq("organization_id", organizationId).in("id", values);
    if (result.error) throw new Error(`${table} delete failed: ${result.error.message}`);
  }
}

async function deleteUnreferencedLocations(organizationId, candidateIds) {
  if (candidateIds.length === 0) return;
  const [branches, assets, providerVehicles] = await Promise.all([
    fetchAll("motorist_branches", "location_id", (query) => query.eq("organization_id", organizationId)),
    fetchAll("motorist_fleet_assets", "current_location_id", (query) => query.eq("organization_id", organizationId)),
    fetchAll("motorist_fleet_provider_vehicles", "latest_location_id", (query) => query.eq("organization_id", organizationId)),
  ]);
  const preservedIds = new Set(unique([
    ...branches.map((row) => row.location_id),
    ...assets.map((row) => row.current_location_id),
    ...providerVehicles.map((row) => row.latest_location_id),
  ]));
  await deleteIds("motorist_locations", organizationId, candidateIds.filter((id) => !preservedIds.has(id)));
}

function projectRefFromUrl(value) {
  try {
    return new URL(value).hostname.split(".")[0];
  } catch {
    return null;
  }
}

function argumentValue(name) {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function loadDotenv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function uniqueObjects(values) {
  return [...new Map(values.map((value) => [`${value.bucket}:${value.path}`, value])).values()];
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
