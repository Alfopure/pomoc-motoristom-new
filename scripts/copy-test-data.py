#!/usr/bin/env python3
"""Guarded production-read-only -> isolated TEST database snapshot/refill.

Uses only Python's standard library. No network activity occurs on import.
Requires SUPABASE_ACCESS_TOKEN. Run snapshot, prepare, import, verify explicitly.
Private snapshots live under .context/isolation by default (override with
TEST_COPY_WORKSPACE). The TEST destination and both organization IDs are pinned.
The import is a transaction and validates every foreign key before committing.
Refilling existing TEST data requires --replace-existing-test-data and invalidates
TEST login sessions. Production is accessed only through read-only SQL/API calls.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request
import uuid

REPOSITORY = Path(__file__).resolve().parents[1]
HERE = Path(os.environ.get("TEST_COPY_WORKSPACE", REPOSITORY / ".context" / "isolation")).expanduser().resolve()
SOURCE = "ifpaeegaesdmljfkdvcn"
TEST_REF = "nzpnqdstvkfncflgqlny"
SOURCE_ORG = "reqzkjhaquxbbhhalcmm"
TEST_ORG = "rwhghkvusmdnaexjvrum"
FORBIDDEN = "sjcsrygkkmersoczpunh"
PAGE_SIZE = 100
INLINE_REQUEST_LIMIT = 4 * 1024 * 1024
STAGE_REQUEST_LIMIT = 512 * 1024
STAGE_INSERT = "INSERT INTO test_copy_stage.pages(batch_id,table_name,page,payload) VALUES ($1::uuid,$2::text,$3::integer,$4::jsonb) RETURNING page;"
SNAPSHOT = HERE / "database-snapshot.private.json"
PREPARED = HERE / "database-import.private.json"
API_BASE = "https://api.supabase.com/v1"

# Excluded tables are counted but their rows are never downloaded.
EXCLUSIONS = {
    "public.motorist_job_runs": "Plan exclusion: queued/background work and run log",
    "public.motorist_telnyx_webhook_events": "Plan exclusion: live provider webhook ledger",
    "public.motorist_call_events": "Plan exclusion: provider event history",
    "public.motorist_audit_log": "Plan exclusion: audit history",
    "public.motorist_ai_demo_attempts": "Plan exclusion: live AI/provider session IDs and cleanup work",
    "public.motorist_provider_commands": "Plan exclusion: durable outbound provider commands",
    "public.motorist_push_subscriptions": "Live browser push endpoints and credentials",
    "public.motorist_operator_devices": "Live Telnyx SIP/device credentials",
    "public.motorist_operator_mobile_devices": "Live Telnyx mobile SIP/device credentials",
    "public.motorist_call_processing_jobs": "Queued/provider recording and AI processing work",
    "public.motorist_worker_status": "Live worker heartbeats",
    "public.motorist_handoff_sessions": "Existing bearer sessions for public handoffs",
    "public.motorist_case_editor_sessions": "Ephemeral editor presence/session tokens",
    "public.motorist_case_draft_previews": "Ephemeral draft previews referencing omitted editor sessions",
    "public.motorist_fleet_position_samples": "Historical GPS sample log; current positions and trips retained",
    "public.motorist_fleet_sync_runs": "Fleet synchronization run log; current fleet state retained",
    "public.motorist_integration_raw_events": "Raw integration response log; normalized external vehicle records retained",
}
SCHEMA_FILTER = "(n.nspname='public' or (n.nspname='auth' and c.relname in ('users','identities')))"


class CopyError(RuntimeError):
    pass


def private_json(path: Path, value) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")
    os.chmod(temp, 0o600)
    os.replace(temp, path)


def read_json(path: Path):
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def ident(name: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise CopyError(f"Unexpected SQL identifier: {name!r}")
    return '"' + name + '"'


def relation(name: str) -> str:
    parts = name.split(".")
    if len(parts) != 2 or parts[0] not in ("public", "auth"):
        raise CopyError("Unexpected SQL relation")
    return ".".join(ident(part) for part in parts)


def literal(text: str) -> str:
    # Explicit E strings avoid dependence on standard_conforming_strings.
    return "E'" + text.replace("\\", "\\\\").replace("'", "''") + "'"


def api(method: str, path: str, body=None):
    # Never make ANY request touching the unrelated retired project.
    if FORBIDDEN in path or (body is not None and FORBIDDEN in str(body.get("project_ref", ""))):
        raise CopyError("Forbidden project rejected")
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
    if not token:
        # Supports the initial provisioner's private credentials without ever
        # requiring them to be written by this reusable utility.
        private_credentials = HERE / "credentials.json"
        if private_credentials.exists():
            token = read_json(private_credentials).get("supabase", "")
    if not isinstance(token, str) or not token:
        raise CopyError("Set SUPABASE_ACCESS_TOKEN to a Supabase management token")
    payload = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        API_BASE + path,
        data=payload,
        method=method,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    try:
        timeout = 300 if body is not None and body.get("read_only") is False else 30
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        # SQL errors may contain user values/password hashes: never print them.
        error_path = HERE / "database-last-api-error.private.json"
        private_json(error_path, {"status": exc.code, "path": path,
                                  "response": exc.read().decode("utf-8", "replace")})
        raise CopyError(f"Management API HTTP {exc.code}; private detail: {error_path}") from None
    except urllib.error.URLError as exc:
        raise CopyError(f"Management API transport failure ({type(exc.reason).__name__}); no automatic write retry") from None
    except TimeoutError:
        raise CopyError("Management API request timed out; no automatic retry") from None


def target_ref() -> str:
    # An env var or leftover state file cannot silently retarget a refill.
    state_file = HERE / "state.json"
    if state_file.exists() and read_json(state_file).get("test_ref") != TEST_REF:
        raise CopyError("Local state does not match the pinned TEST project")
    if TEST_REF in (SOURCE, FORBIDDEN):
        raise CopyError("Invalid pinned TEST project")
    return TEST_REF


def assert_project(ref: str, writing: bool = False) -> dict:
    if writing and ref != target_ref():
        raise CopyError("Write target does not equal asserted test_ref")
    if ref not in (SOURCE, target_ref()):
        raise CopyError("Unexpected project reference")
    project = api("GET", f"/projects/{ref}")
    actual_ref = project.get("id", project.get("ref"))
    expected_org = SOURCE_ORG if ref == SOURCE else TEST_ORG
    actual_org = project.get("organization_id")
    if actual_org is None and isinstance(project.get("organization"), dict):
        actual_org = project["organization"].get("id")
    if actual_ref != ref or actual_org != expected_org:
        raise CopyError("Project identity/organization mismatch; refusing database access")
    if writing and project.get("status") != "ACTIVE_HEALTHY":
        raise CopyError("TEST project is not ACTIVE_HEALTHY")
    return project


def query(ref: str, sql: str, *, write: bool = False, parameters: list | None = None):
    if ref not in (SOURCE, target_ref()) or (write and (ref == SOURCE or ref != target_ref())):
        raise CopyError("Database target guard rejected the operation")
    if not write:
        # Two independent layers: API read_only and PostgreSQL transaction mode.
        # Keep each production request small and bounded. A previous giant
        # all-table JSON aggregate exhausted the small source instance.
        sql = ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=''; "
               "SET LOCAL statement_timeout='5s'; SET LOCAL jit=off;\n" + sql + ";\nCOMMIT;")
    body = {"query": sql, "read_only": not write}
    if parameters is not None:
        body["parameters"] = parameters
    return api("POST", f"/projects/{ref}/database/query", body)


def request_bytes(sql: str, parameters: list | None = None) -> int:
    body = {"query": sql, "read_only": False}
    if parameters is not None:
        body["parameters"] = parameters
    return len(json.dumps(body).encode("utf-8"))


def one_json(result, key: str):
    if isinstance(result, list):
        matches = [row[key] for row in result if isinstance(row, dict) and key in row]
        if len(matches) == 1:
            value = matches[0]
            return json.loads(value) if isinstance(value, str) else value
    raise CopyError(f"Unexpected Management API result shape for {key}; no data skipped")


def catalog_expr() -> str:
    return f"""(
      SELECT jsonb_object_agg(n.nspname||'.'||c.relname,
        jsonb_build_object(
          'columns',(SELECT jsonb_agg(jsonb_build_object(
            'name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
            'not_null',a.attnotnull,'generated',a.attgenerated,'identity',a.attidentity,
            'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'ordinal',a.attnum
          ) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
            LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
            WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
          'constraints',coalesce((SELECT jsonb_agg(jsonb_build_object(
            'name',k.conname,'type',k.contype,'definition',pg_catalog.pg_get_constraintdef(k.oid,false),
            'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,
            'reference',CASE WHEN k.confrelid<>0 THEN k.confrelid::regclass::text ELSE NULL END
          ) ORDER BY k.conname) FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),'[]'::jsonb),
          'triggers',coalesce((SELECT jsonb_agg(jsonb_build_object(
            'name',t.tgname,'enabled',t.tgenabled
          ) ORDER BY t.tgname) FROM pg_catalog.pg_trigger t
            WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'[]'::jsonb)
        ) ORDER BY n.nspname,c.relname)
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND {SCHEMA_FILTER}
    )"""


def get_catalog(ref: str) -> dict:
    return one_json(query(ref, f"SELECT {catalog_expr()} AS catalog"), "catalog")


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def table_count(ref: str, name: str) -> int:
    return int(one_json(query(ref, f"SELECT jsonb_build_object('count',count(*)) AS stats FROM {relation(name)}"), "stats")["count"])


def primary_key_columns(table: dict) -> list[str]:
    keys = [item for item in table["constraints"] if item["type"] == "p"]
    if len(keys) != 1:
        raise CopyError("A stable primary key is required for bounded row pagination")
    matched = re.fullmatch(r"PRIMARY KEY \(([^)]+)\)(?: DEFERRABLE(?: INITIALLY DEFERRED)?)?", keys[0]["definition"])
    if not matched:
        raise CopyError("Unrecognized primary-key definition; refusing unstable pagination")
    columns = [part.strip().strip('"') for part in matched.group(1).split(",")]
    for column in columns:
        ident(column)
    return columns


def read_table(ref: str, name: str, table: dict, columns: list[str] | None = None) -> tuple[list, dict]:
    """Sequential keyset pages; each query has a hard five-second SQL timeout.

    This deliberately is NOT one database-wide MVCC snapshot. Record its time
    window and refuse a changing row count; FK validation protects the import
    against a relationship changing between independently captured tables.
    """
    started = now_iso()
    expected = table_count(ref, name)
    if expected == 0:
        return [], {"started_at": started, "finished_at": now_iso(), "count": 0, "pages": 0}
    keys = primary_key_columns(table)
    if columns is not None and not set(keys).issubset(columns):
        raise CopyError("Pagination key missing from selected columns: " + name)
    rows, last, pages = [], None, 0
    projection = "t.*" if columns is None else ",".join("t." + ident(col) for col in columns)
    while len(rows) < expected:
        boundary, predicate = "", ""
        if last is not None:
            key_json = literal(json.dumps({key: last[key] for key in keys}, ensure_ascii=False, separators=(",", ":")))
            boundary = f", pg_catalog.jsonb_populate_record(NULL::{relation(name)}, {key_json}::jsonb) AS boundary"
            predicate = " WHERE ROW(" + ",".join("t." + ident(key) for key in keys) + ") > ROW(" \
                        + ",".join("boundary." + ident(key) for key in keys) + ")"
        order = ",".join("t." + ident(key) for key in keys)
        statement = ("SELECT coalesce(jsonb_agg(to_jsonb(page)),'[]'::jsonb) AS rows FROM (SELECT "
                     f"{projection} FROM {relation(name)} t{boundary}{predicate} ORDER BY {order} LIMIT {PAGE_SIZE}) page")
        page = one_json(query(ref, statement), "rows")
        if not isinstance(page, list) or not page or len(page) > PAGE_SIZE:
            raise CopyError("Unexpected or missing page during capture: " + name)
        if last is not None and all(page[-1][key] == last[key] for key in keys):
            raise CopyError("Pagination did not advance: " + name)
        rows.extend(page)
        last = page[-1]
        pages += 1
        if len(page) < PAGE_SIZE:
            break
    after = table_count(ref, name)
    if len(rows) != expected or after != expected:
        raise CopyError("Row count changed during bounded capture: " + name + "; stop and review before retry")
    return rows, {"started_at": started, "finished_at": now_iso(), "count": expected, "pages": pages}


def snapshot() -> None:
    assert_project(SOURCE)
    started = now_iso()
    catalog = get_catalog(SOURCE)
    private_json(HERE / "database-source-catalog.private.json", catalog)
    if not catalog or "auth.users" not in catalog or "public.motorist_cases" not in catalog:
        raise CopyError("Required source relations missing")
    unknown_public = [name for name in catalog if name.startswith("public.") and not name.startswith("public.motorist_")]
    if unknown_public:
        raise CopyError("Unreviewed public relations: " + ", ".join(unknown_public))
    selected = sorted(set(catalog) - set(EXCLUSIONS))
    value = {"source_ref": SOURCE, "capture_started_at": started, "catalog": catalog,
             "tables": {}, "counts": {}, "table_capture_windows": {}, "exclusions": EXCLUSIONS,
             "consistency": "Sequential bounded read-only pages; approximate time-window copy, not one database-wide MVCC snapshot"}
    for name in sorted(catalog):
        if name in EXCLUSIONS:
            value["counts"][name] = table_count(SOURCE, name)
        else:
            rows, window = read_table(SOURCE, name, catalog[name])
            expected_columns = {col["name"] for col in catalog[name]["columns"]}
            if any(set(row) != expected_columns for row in rows):
                raise CopyError("Source columns changed during capture: " + name)
            value["tables"][name] = rows
            value["counts"][name] = len(rows)
            value["table_capture_windows"][name] = window
            private_json(HERE / "database-snapshot-tables" / (name + ".private.json"), {"rows": rows, "capture": window})
        print(json.dumps({"captured_table": name, "rows": value["counts"][name], "excluded": name in EXCLUSIONS}), flush=True)
    # These metadata-only counts are separate small queries too.
    value["auth_mfa_factors"] = table_count(SOURCE, "auth.mfa_factors")
    value["storage_objects"] = int(one_json(query(SOURCE, "SELECT jsonb_build_object('count',count(*)) AS stats FROM storage.objects"), "stats")["count"])
    value["capture_finished_at"] = now_iso()
    value["captured_at"] = value["capture_finished_at"]
    # MFA factors are intentionally not copied, but that limitation must not be silent.
    if value["auth_mfa_factors"]:
        raise CopyError("Source has MFA factors; preserving login requires a reviewed MFA transfer strategy")
    private_json(SNAPSHOT, value)
    private_json(HERE / "database-snapshot-summary.json", {
        "source_ref": SOURCE, "captured_at": value["captured_at"],
        "capture_started_at": started, "capture_finished_at": value["capture_finished_at"],
        "consistency": value["consistency"], "table_capture_windows": value["table_capture_windows"],
        "counts": value["counts"], "excluded": EXCLUSIONS,
        "storage_objects_not_copied": value["storage_objects"],
        "auth_mfa_factors": value["auth_mfa_factors"],
    })
    print(json.dumps({"snapshot": str(SNAPSHOT), "copied_tables": len(selected),
                      "copied_rows": sum(len(rows) for rows in value["tables"].values()),
                      "cases": value["counts"]["public.motorist_cases"],
                      "auth_users": value["counts"]["auth.users"]}))


def compatible_columns(source: dict, target: dict) -> tuple[dict, list]:
    if set(source) != set(target):
        raise CopyError("Source/TEST table mismatch: source-only=" + repr(sorted(set(source)-set(target)))
                        + "; TEST-only=" + repr(sorted(set(target)-set(source))))
    writable, differences = {}, []
    for name, table in source.items():
        old = {col["name"]: col for col in table["columns"]}
        new = {col["name"]: col for col in target[name]["columns"]}
        if name.startswith("public.") and set(old) != set(new):
            raise CopyError("Public column mismatch: " + name)
        for column in sorted(set(old) | set(new)):
            if column not in new:
                if not old[column]["generated"]:
                    raise CopyError("Source auth column missing in TEST: " + name + "." + column)
                differences.append({"table": name, "column": column, "reason": "source-only generated column omitted"})
                continue
            if column not in old:
                if new[column]["not_null"] and new[column]["default"] is None and not new[column]["generated"]:
                    raise CopyError("Required TEST auth column absent from source: " + name + "." + column)
                differences.append({"table": name, "column": column, "reason": "new TEST auth column uses server default"})
                continue
            for field in ("type", "generated", "identity"):
                if old[column][field] != new[column][field]:
                    raise CopyError("Column schema mismatch: " + name + "." + column + " (" + field + ")")
            if name.startswith("public.") and old[column]["not_null"] != new[column]["not_null"]:
                raise CopyError("Public nullability mismatch: " + name + "." + column)
        writable[name] = [col["name"] for col in target[name]["columns"]
                          if col["name"] in old and not col["generated"]]
        if name.startswith("public."):
            left = {(item["name"], item["type"], item["definition"], item["validated"]) for item in table["constraints"]}
            right = {(item["name"], item["type"], item["definition"], item["validated"]) for item in target[name]["constraints"]}
            if left != right:
                private_json(HERE / "database-schema-difference.private.json", {"table": name, "source": sorted(left), "target": sorted(right)})
                raise CopyError("Public constraint mismatch: " + name + "; detail in database-schema-difference.private.json")
    return writable, differences


def transform_rows(tables: dict, captured_at: str) -> tuple[dict, dict]:
    result = copy.deepcopy(tables)
    differences = {}

    def change(name, predicate, patch, reason):
        changed = 0
        for row in result.get(name, []):
            if not predicate(row):
                continue
            values = patch(row) if callable(patch) else patch
            # Only existing columns are changed; misspelled required columns fail later.
            for column, value in values.items():
                if column in row and row[column] != value:
                    row[column] = value
                    changed += 1
        if changed:
            differences.setdefault(name, []).append({"reason": reason, "changed_values": changed})

    always = lambda _: True
    change("public.motorist_telephony_settings", always,
           {"live_calls_enabled": False, "sms_live_sends": False}, "Disable calls and SMS")
    change("public.motorist_job_controls", always, {"enabled": False}, "Disable all background jobs")
    change("public.motorist_organization_integrations", always,
           {"enabled": False, "status": "disabled", "secret_ref": None}, "Disable copied integrations and secret references")
    change("public.motorist_call_recording_policies", always,
           {"recording_enabled": False, "transcription_enabled": False, "analysis_enabled": False, "quality_enabled": False},
           "Disable external recording/transcription/analysis processing")
    change("public.motorist_ai_agent_settings", always, {"sms_enabled": False}, "Disable AI SMS permission")
    change("public.motorist_call_sessions", always, {
        "lease_token": None, "lease_until": None, "pending_effects": None,
        "effects_next_attempt_at": None, "cancellations_next_attempt_at": None,
        "termination_requested_at": None, "termination_next_attempt_at": None,
    }, "Clear live ownership and deferred outbound effect work")
    change("public.motorist_call_sessions", lambda r: r.get("state") not in ("ended", "failed"),
           lambda r: {"state": "ended", "ended_at": r.get("ended_at") or captured_at}, "Close active source sessions in TEST")
    change("public.motorist_call_legs", lambda r: r.get("state") not in ("ended", "failed"),
           lambda r: {"state": "ended", "ended_at": r.get("ended_at") or captured_at}, "Close active source call legs in TEST")
    change("public.motorist_ring_attempts", lambda r: r.get("result") in ("pending", "offered"),
           lambda r: {"result": "cancelled", "ended_at": r.get("ended_at") or captured_at}, "Cancel active source ring offers")
    change("public.motorist_sms_messages", lambda r: r.get("direction") == "outbound" and r.get("status") == "queued",
           {"status": "failed", "error": "Cancelled during isolated TEST copy", "next_attempt_at": None}, "Cancel queued outbound SMS")
    change("public.motorist_task_reminders", lambda r: r.get("status") in ("pending", "processing"),
           {"status": "cancelled", "channels": ["in_app"]}, "Cancel copied pending notification delivery")
    change("public.motorist_task_assignment_deliveries", lambda r: r.get("status") in ("pending", "processing"),
           {"status": "cancelled", "lease_id": None}, "Cancel copied pending assignment delivery")
    change("public.motorist_location_share_links", always,
           lambda r: {"token_hash": hashlib.sha256(("isolated-test:" + r["id"] + ":" + captured_at).encode()).hexdigest(),
                      **({"status": "revoked", "revoked_at": captured_at} if r.get("status") == "active" else {})},
           "Invalidate copied public location bearer links")
    change("public.motorist_case_handoffs", always,
           lambda r: {"token_hash": hashlib.sha256(("isolated-test:" + r["id"] + ":" + captured_at).encode()).hexdigest(),
                      **({"status": "cancelled"} if r.get("status") in ("offered", "accepted", "en_route", "arrived") else {})},
           "Invalidate copied public handoff grants")
    # Retain account IDs, password hashes, confirmed state and profile binding.
    # Drop active password reset, verification and pending identity change tokens.
    for row in result.get("auth.users", []):
        changed = 0
        for column in tuple(row):
            if "token" in column and not column.endswith("_sent_at"):
                if row[column] not in (None, ""):
                    row[column] = ""
                    changed += 1
        for column in ("email_change", "phone_change"):
            if column in row and row[column] not in (None, ""):
                row[column] = ""
                changed += 1
        if "email_change_confirm_status" in row and row["email_change_confirm_status"] != 0:
            row["email_change_confirm_status"] = 0
            changed += 1
        if changed:
            differences.setdefault("auth.users", []).append({"reason": "Clear active account action/change tokens", "changed_values": changed})
    return result, differences


def prepared_data(snapshot_value: dict, target_catalog: dict) -> dict:
    if snapshot_value.get("source_ref") != SOURCE:
        raise CopyError("Snapshot source mismatch")
    columns, schema_notes = compatible_columns(snapshot_value["catalog"], target_catalog)
    for name in ("auth.users", "auth.identities"):
        if target_catalog[name]["triggers"]:
            # These tables belong to supabase_auth_admin, so do not assume an
            # ALTER/DISABLE privilege or let an unreviewed signup hook run.
            raise CopyError("Unreviewed auth user triggers in TEST: " + name + "; refusing import")
    expected_tables = set(snapshot_value["catalog"]) - set(EXCLUSIONS)
    missing_tables = expected_tables - set(snapshot_value["tables"])
    unexpected_tables = set(snapshot_value["tables"]) - set(snapshot_value["catalog"])
    if missing_tables or unexpected_tables:
        raise CopyError("Snapshot table inventory mismatch; missing=" + repr(sorted(missing_tables))
                        + "; unexpected=" + repr(sorted(unexpected_tables)))
    # A newly reviewed explicit exclusion may tighten an earlier snapshot; do
    # not silently lose any table outside the current documented policy.
    selected_tables = {name: rows for name, rows in snapshot_value["tables"].items() if name in expected_tables}
    tables, differences = transform_rows(selected_tables, snapshot_value["captured_at"])
    for name, rows in tables.items():
        allowed = set(columns[name])
        tables[name] = [{key: val for key, val in row.items() if key in allowed} for row in rows]
    expected = {name: len(tables.get(name, [])) for name in target_catalog}
    return {"target_ref": target_ref(), "source_ref": SOURCE, "captured_at": snapshot_value["captured_at"],
            "capture_started_at": snapshot_value.get("capture_started_at"),
            "capture_finished_at": snapshot_value.get("capture_finished_at"),
            "consistency": snapshot_value.get("consistency"),
            "source_counts": snapshot_value["counts"], "expected_counts": expected,
            "target_catalog": target_catalog, "columns": columns, "tables": tables,
            "differences": differences, "schema_notes": schema_notes, "exclusions": EXCLUSIONS}


def report_for(prepared: dict) -> dict:
    return {key: value for key, value in prepared.items() if key not in ("tables", "columns", "target_catalog")}


def prepare() -> None:
    ref = target_ref()
    assert_project(ref)
    value = prepared_data(read_json(SNAPSHOT), get_catalog(ref))
    preview_sql = build_import_sql(value, replace_existing=True)
    value["estimated_import_sql_bytes"] = len(preview_sql.encode("utf-8"))
    value["estimated_import_http_bytes"] = request_bytes(preview_sql)
    value["staging_required"] = value["estimated_import_http_bytes"] > INLINE_REQUEST_LIMIT
    private_json(PREPARED, value)
    private_json(HERE / "database-copy-report.json", report_for(value))
    print(json.dumps({"prepared": str(PREPARED), "copied_rows": sum(value["expected_counts"].values()),
                      "tables_with_safety_changes": sorted(value["differences"]), "schema_notes": value["schema_notes"],
                      "estimated_import_sql_bytes": value["estimated_import_sql_bytes"],
                      "estimated_import_http_bytes": value["estimated_import_http_bytes"],
                      "staging_required": value["staging_required"]}))


def staging_pages(prepared: dict, batch_id: str) -> list[dict]:
    """Pure bounded page planner; never stages excluded snapshot rows."""
    batch_id = str(uuid.UUID(batch_id))
    pages = []
    for name, rows in sorted(prepared["tables"].items()):
        if name in EXCLUSIONS:
            raise CopyError("Excluded table reached staging planner: " + name)
        page_rows, page_number = [], 0

        def make_page(values, number):
            parameters = [batch_id, name, number, json.dumps(values, ensure_ascii=False, separators=(",", ":"))]
            return {"table": name, "page": number, "rows": len(values), "parameters": parameters,
                    "request_bytes": request_bytes(STAGE_INSERT, parameters)}

        for row in rows:
            candidate = make_page(page_rows + [row], page_number)
            if page_rows and (len(page_rows) >= PAGE_SIZE or candidate["request_bytes"] > STAGE_REQUEST_LIMIT):
                pages.append(make_page(page_rows, page_number))
                page_number += 1
                page_rows = []
                candidate = make_page([row], page_number)
            if candidate["request_bytes"] > STAGE_REQUEST_LIMIT:
                raise CopyError("Single row exceeds bounded staging request size: " + name)
            page_rows.append(row)
        if page_rows:
            pages.append(make_page(page_rows, page_number))
    return pages


def stage_data(ref: str, prepared: dict) -> dict:
    if ref != target_ref() or ref in (SOURCE, FORBIDDEN):
        raise CopyError("Private staging can only write the pinned TEST project")
    assert_project(ref, writing=True)
    batch_id = str(uuid.uuid4())
    pages = staging_pages(prepared, batch_id)
    manifest = {"target_ref": ref, "batch_id": batch_id, "schema": "test_copy_stage",
                "pages": len(pages), "rows": sum(page["rows"] for page in pages),
                "max_request_bytes": max((page["request_bytes"] for page in pages), default=0),
                "completed_pages": 0}
    private_json(HERE / "database-staging.json", manifest)
    setup = """BEGIN; SET LOCAL jit=off; SET LOCAL statement_timeout='15s';
      CREATE SCHEMA IF NOT EXISTS test_copy_stage;
      REVOKE ALL ON SCHEMA test_copy_stage FROM PUBLIC,anon,authenticated,service_role;
      CREATE TABLE IF NOT EXISTS test_copy_stage.pages (
        batch_id uuid NOT NULL, table_name text NOT NULL, page integer NOT NULL CHECK(page>=0),
        payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='array'),
        PRIMARY KEY(batch_id,table_name,page)
      );
      REVOKE ALL ON TABLE test_copy_stage.pages FROM PUBLIC,anon,authenticated,service_role;
      COMMIT;"""
    query(ref, setup, write=True)
    for page in pages:
        query(ref, STAGE_INSERT, write=True, parameters=page["parameters"])
        manifest["completed_pages"] += 1
        private_json(HERE / "database-staging.json", manifest)
        print(json.dumps({"staged_table": page["table"], "page": page["page"], "rows": page["rows"]}), flush=True)
    return manifest


def build_import_sql(prepared: dict, replace_existing: bool = False, stage_batch_id: str | None = None) -> str:
    target = prepared["target_catalog"]
    public = sorted(name for name in target if name.startswith("public."))
    if stage_batch_id is not None:
        stage_batch_id = str(uuid.UUID(stage_batch_id))
    sql = ["BEGIN; SET LOCAL search_path=''; SET LOCAL jit=off; SET LOCAL statement_timeout='240s'; SET LOCAL lock_timeout='10s';"]
    sql.append("SELECT pg_catalog.pg_advisory_xact_lock(721349166102::bigint);")
    if not replace_existing:
        safe_seed = {"public.motorist_job_controls", "public.motorist_telephony_writer_rollout"}
        checks = [f"EXISTS(SELECT 1 FROM {relation(name)})" for name in target if name not in safe_seed]
        sql.append("DO $guard$ BEGIN IF " + " OR ".join(checks)
                   + " THEN RAISE EXCEPTION 'TEST import requires fresh tables; explicit replace-existing-test-data needed'; END IF; END $guard$;")
    for name in public:
        sql.append(f"ALTER TABLE {relation(name)} DISABLE TRIGGER USER;")
    # Dropping and re-adding in this ONE transaction validates all copied FKs
    # before commit; unlike replica mode, no silently unvalidated references.
    foreign_keys = [(name, constraint) for name in public for constraint in target[name]["constraints"] if constraint["type"] == "f"]
    for name, constraint in foreign_keys:
        sql.append(f"ALTER TABLE {relation(name)} DROP CONSTRAINT {ident(constraint['name'])};")
    # No CASCADE: unexpected dependencies outside the reviewed set abort safely.
    sql.append("TRUNCATE TABLE " + ",".join(relation(name) for name in public) + ";")
    if replace_existing:
        sql += ["DELETE FROM auth.identities;", "DELETE FROM auth.users;"]
    ordered = ["auth.users", "auth.identities"] + public
    for name in ordered:
        rows = prepared["tables"].get(name, [])
        if not rows:
            continue
        columns = prepared["columns"][name]
        column_sql = ",".join(ident(col) for col in columns)
        if stage_batch_id is None:
            payload = literal(json.dumps(rows, ensure_ascii=False, separators=(",", ":")))
            sql.append(f"INSERT INTO {relation(name)} ({column_sql}) OVERRIDING SYSTEM VALUE SELECT {column_sql} "
                       f"FROM pg_catalog.jsonb_populate_recordset(NULL::{relation(name)},{payload}::jsonb);")
        else:
            projected = ",".join("imported." + ident(column) for column in columns)
            sql.append(f"INSERT INTO {relation(name)} ({column_sql}) OVERRIDING SYSTEM VALUE SELECT {projected} "
                       f"FROM test_copy_stage.pages staged CROSS JOIN LATERAL "
                       f"pg_catalog.jsonb_populate_recordset(NULL::{relation(name)},staged.payload) imported "
                       f"WHERE staged.batch_id={literal(stage_batch_id)}::uuid AND staged.table_name={literal(name)} ORDER BY staged.page;")
    for name, constraint in foreign_keys:
        definition = constraint["definition"]
        # A historically NOT VALID constraint is fully checked here too.
        definition = re.sub(r"\s+NOT VALID$", "", definition)
        sql.append(f"ALTER TABLE {relation(name)} ADD CONSTRAINT {ident(constraint['name'])} {definition};")
    # Restore exact pre-import trigger states, including disabled/replica/always.
    mode = {"O": "ENABLE", "D": "DISABLE", "R": "ENABLE REPLICA", "A": "ENABLE ALWAYS"}
    for name in public:
        for trigger in target[name]["triggers"]:
            sql.append(f"ALTER TABLE {relation(name)} {mode[trigger['enabled']]} TRIGGER {ident(trigger['name'])};")
    for name, count in prepared["expected_counts"].items():
        sql.append(f"DO $count$ BEGIN IF (SELECT count(*) FROM {relation(name)}) <> {int(count)} "
                   f"THEN RAISE EXCEPTION 'Imported row count mismatch: {name}'; END IF; END $count$;")
    sql.append("DO $safety$ BEGIN "
               "IF EXISTS(SELECT 1 FROM public.motorist_telephony_settings WHERE live_calls_enabled OR sms_live_sends) "
               "OR EXISTS(SELECT 1 FROM public.motorist_job_controls WHERE enabled) "
               "THEN RAISE EXCEPTION 'TEST outbound safety switches failed'; END IF; END $safety$;")
    # No public sequence columns exist in the reviewed schema; reject additions
    # instead of claiming a copy while leaving counters inconsistent.
    for name in public:
        for column in target[name]["columns"]:
            if column["identity"] or "nextval(" in (column["default"] or ""):
                raise CopyError("Unreviewed sequence reset required for " + name + "." + column["name"])
    if stage_batch_id is not None:
        sql.append(f"DELETE FROM test_copy_stage.pages WHERE batch_id={literal(stage_batch_id)}::uuid;")
    sql.append("NOTIFY pgrst, 'reload schema'; COMMIT; SELECT jsonb_build_object('committed',true) AS import_result;")
    return "\n".join(sql)


def import_data(replace_existing: bool) -> None:
    ref = target_ref()
    assert_project(ref, writing=True)
    value = prepared_data(read_json(SNAPSHOT), get_catalog(ref))
    private_json(PREPARED, value)
    private_json(HERE / "database-copy-report.json", report_for(value))
    statement = build_import_sql(value, replace_existing)
    value["inline_import_sql_bytes"] = len(statement.encode("utf-8"))
    value["inline_import_http_bytes"] = request_bytes(statement)
    if value["inline_import_http_bytes"] > INLINE_REQUEST_LIMIT:
        value["staging"] = stage_data(ref, value)
        statement = build_import_sql(value, replace_existing, value["staging"]["batch_id"])
    value["final_import_sql_bytes"] = len(statement.encode("utf-8"))
    value["final_import_http_bytes"] = request_bytes(statement)
    if value["final_import_http_bytes"] > INLINE_REQUEST_LIMIT:
        raise CopyError("Final transaction request exceeds bounded import size")
    private_json(PREPARED, value)
    private_json(HERE / "database-copy-report.json", report_for(value))
    # Persist reviewable SQL before execution; it contains hashes/private data.
    sql_path = HERE / "database-import.private.sql"
    fd = os.open(sql_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(statement)
    result = query(ref, statement, write=True)
    private_json(HERE / "database-import-result.json", result)
    print(json.dumps({"target_ref": ref, "import_request_completed": True,
                      "expected_rows": sum(value["expected_counts"].values())}))
    verify()


def normalized_rows(rows: list[dict]) -> list[str]:
    return sorted(json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":")) for row in rows)


def verify() -> None:
    value = read_json(PREPARED)
    ref = target_ref()
    if value["target_ref"] != ref:
        raise CopyError("Prepared import target mismatch")
    assert_project(ref)
    target = value["target_catalog"]
    selected = sorted(value["tables"])
    actual = {"catalog": get_catalog(ref), "counts": {}, "tables": {}}
    for name in selected:
        rows, _ = read_table(ref, name, target[name], value["columns"][name])
        actual["tables"][name] = rows
        actual["counts"][name] = len(rows)
    for name in sorted(set(target) - set(selected)):
        actual["counts"][name] = table_count(ref, name)
    actual["auth_sessions"] = table_count(ref, "auth.sessions")
    actual["auth_refresh_tokens"] = table_count(ref, "auth.refresh_tokens")
    actual["storage_objects"] = int(one_json(query(ref, "SELECT jsonb_build_object('count',count(*)) AS stats FROM storage.objects"), "stats")["count"])
    errors = []
    if actual["counts"] != value["expected_counts"]:
        for name, expected in value["expected_counts"].items():
            if actual["counts"].get(name) != expected:
                errors.append({"table": name, "expected_count": expected, "actual_count": actual["counts"].get(name)})
    for name, rows in value["tables"].items():
        if normalized_rows(rows) != normalized_rows(actual["tables"].get(name, [])):
            errors.append({"table": name, "reason": "Imported column values differ from prepared safe snapshot"})
    fk_count = 0
    for name, table in actual["catalog"].items():
        expected_fks = {item["name"] for item in target[name]["constraints"] if item["type"] == "f"}
        actual_fks = {item["name"] for item in table["constraints"] if item["type"] == "f"}
        if expected_fks != actual_fks:
            errors.append({"table": name, "reason": "FK constraint inventory differs from pre-import catalog"})
        for constraint in table["constraints"]:
            if constraint["type"] == "f":
                fk_count += 1
                if not constraint["validated"]:
                    errors.append({"table": name, "constraint": constraint["name"], "reason": "FK not validated"})
        if table["triggers"] != target[name]["triggers"]:
            errors.append({"table": name, "reason": "Trigger state differs from pre-import catalog"})
    summary = {"target_ref": ref, "verified_at": dt.datetime.now(dt.timezone.utc).isoformat(),
               "counts": actual["counts"], "validated_foreign_keys": fk_count,
               "auth_sessions": actual["auth_sessions"], "auth_refresh_tokens": actual["auth_refresh_tokens"],
               "storage_objects": actual["storage_objects"], "errors": errors, "ok": not errors}
    private_json(HERE / "database-verification.json", summary)
    if errors:
        raise CopyError("TEST verification failed; see database-verification.json (no private row content)")
    print(json.dumps({"verified": True, "target_ref": ref, "foreign_keys": fk_count,
                      "copied_tables": len(selected), "copied_rows": sum(value["expected_counts"].values()),
                      "cases": actual["counts"].get("public.motorist_cases"),
                      "contacts": actual["counts"].get("public.motorist_contacts"),
                      "auth_users": actual["counts"].get("auth.users")}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("snapshot", "prepare", "import", "verify"))
    parser.add_argument("--replace-existing-test-data", action="store_true",
                        help="Explicitly replace existing TEST data/account sessions; never affects SOURCE")
    args = parser.parse_args()
    if args.command != "import" and args.replace_existing_test_data:
        parser.error("--replace-existing-test-data applies only to import")
    if args.command == "snapshot":
        snapshot()
    elif args.command == "prepare":
        prepare()
    elif args.command == "import":
        import_data(args.replace_existing_test_data)
    else:
        verify()


if __name__ == "__main__":
    try:
        main()
    except (CopyError, KeyError, ValueError, FileNotFoundError) as exc:
        print("ERROR: " + str(exc), file=sys.stderr)
        sys.exit(1)
